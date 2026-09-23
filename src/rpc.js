import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class Rpc extends EventEmitter {
  constructor(command, args, options = {}) {
    super(); this.pending = new Map(); this.id = 0; this.stderr = '';
    this.child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const m = JSON.parse(line);
          if (m.method) this.emit('message', m);
          else if (this.pending.has(m.id)) {
            const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
            m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
          }
        } catch { /* diagnostic line */ }
      }
    });
    this.child.stderr.on('data', x => { this.stderr = (this.stderr + x).slice(-3000); });
    this.child.on('error', e => this.fail(e));
    this.child.on('close', code => this.fail(new Error(`Codex завершился (${code}): ${this.stderr.slice(-900)}`)));
  }
  send(obj) { if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n'); }
  request(method, params = {}, timeout = 60000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Codex уже закрыт'));
      const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Таймаут ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  fail(error) {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
  close() { this.fail(new Error('Остановлено')); this.child.stdin.end(); this.child.kill(); }
}
