import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ConsoleInput, readTask } from '../src/input.js';

test('pasted multiline prompt preserves blank lines and a long paragraph', async () => {
  const stream = new PassThrough(), output = new PassThrough();
  const input = new ConsoleInput(stream, output);
  const paragraph = 'Проверить магазин. '.repeat(10000);
  stream.write(`Первая строка\r\n\r\n${paragraph}\r\n/send\r\n`);
  assert.equal(await readTask(input), `Первая строка\n\n${paragraph}`.trim());
  input.close();
});
test('control command cancels a pending question without becoming a prompt', async () => {
  const stream = new PassThrough(), input = new ConsoleInput(stream, new PassThrough());
  input.control = line => { if (line !== '/stop') return false; input.cancel(); return true; };
  const pending = input.question('');
  stream.write('/stop\n');
  await assert.rejects(pending, /Ввод закрыт/);
  input.control = null;
  stream.write('/back\n');
  assert.equal(await readTask(input), '/back');
  stream.write('/cancel\n');
  assert.equal(await readTask(input), '');
  input.close();
});
