import readline from 'node:readline';

// A permanent listener preserves every line of a pasted prompt.
export class ConsoleInput {
  constructor(stream = process.stdin, output = process.stdout) {
    this.output = output;
    this.lines = [];
    this.rl = readline.createInterface({ input: stream, output });
    this.rl.on('line', line => {
      if (this.control?.(line)) return;
      if (this.pending) { const resolve = this.pending; this.pending = null; resolve(line); }
      else this.lines.push(line);
    });
    this.rl.on('close', () => { this.closed = true; this.pending?.(null); this.pending = null; });
    this.rl.on('SIGINT', () => { if (!this.control?.('/stop')) this.close(); });
  }
  async question(prompt) {
    this.output.write(prompt);
    if (this.lines.length) return this.lines.shift();
    if (this.closed) throw new Error('Ввод закрыт');
    const line = await new Promise(resolve => { this.pending = resolve; });
    if (line === null) throw new Error('Ввод закрыт');
    return line;
  }
  cancel() { this.lines.length = 0; this.pending?.(null); this.pending = null; }
  close() { this.rl.close(); }
}

export async function readTask(input) {
  const first = await input.question('\n  › ');
  if (['/send', '/cancel'].includes(first.trim())) return '';
  if (first.startsWith('/') && first.trim() !== '/send') return first.trim();
  const lines = [first];
  while (true) {
    const line = await input.question('');
    if (line.trim() === '/cancel') return '';
    if (line.trim() === '/send') return lines.join('\n').trim();
    lines.push(line);
  }
}
