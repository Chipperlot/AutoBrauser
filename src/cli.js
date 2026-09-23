import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { BrowserController, installedBrowser } from './browser.js';
import { Agent } from './agent.js';
import { findCodexCli } from './environment.js';
import { runMenu } from './menu.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback = '') => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] || fallback; };
function doctor() {
  const browser = installedBrowser(), codex = findCodexCli();
  console.log(`Node: ${process.version} ${Number(process.versions.node.split('.')[0]) >= 24 ? 'OK' : 'требуется 24+'}`);
  console.log(`Playwright Core: ${existsSync(path.join(root, 'node_modules/playwright-core/package.json')) ? 'OK' : 'ОШИБКА; выполните npm ci'}`);
  console.log(`Chrome/Edge: ${browser || 'не найден; задайте AUTOBRAUSER_CHROME'}`);
  console.log(`Codex CLI: ${codex ? 'OK' : 'не найден; установите @openai/codex'}`);
  if (codex) {
    const s = spawnSync(codex.command, [...codex.prefix, 'login', 'status'], { encoding: 'utf8', timeout: 12000 });
    console.log(`Авторизация: ${s.status === 0 ? 'OK' : 'выполните codex login'}`);
  }
  return Boolean(browser && codex && Number(process.versions.node.split('.')[0]) >= 24);
}
if (args.includes('--doctor')) { process.exitCode = doctor() ? 0 : 1; }
else if (!args.includes('--task')) await runMenu();
else {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  let browser;
  try {
    const task = option('--task') || await input.question('Задача браузеру: ');
    if (!task.trim()) throw new Error('Пустая задача');
    const codex = findCodexCli(); if (!codex) throw new Error('Codex CLI не найден. Выполните npm install -g @openai/codex и codex login.');
    const profile = option('--profile', path.join(root, 'profile'));
    const logs = path.join(root, 'runs'); mkdirSync(logs, { recursive: true });
    const logFile = path.join(logs, `run-${new Date().toISOString().replaceAll(':', '-')}.jsonl`);
    const trace = (type, data) => {
      const event = { at: new Date().toISOString(), type, ...data };
      appendFileSync(logFile, JSON.stringify(event) + '\n');
      if (['tool', 'action', 'observe', 'error', 'browser', 'search', 'result', 'turn'].includes(type)) console.log(`[${type}] ${JSON.stringify(data).slice(0, 350)}`);
    };
    browser = await new BrowserController({ profile, allowLocal: args.includes('--allow-local'), trace,
      confirm: async prompt => /^да$/i.test((await input.question(`\n${prompt} Ответьте «да» для выполнения: `)).trim()),
    }).start();
    const agent = new Agent({ browser, cli: codex, model: option('--model', 'gpt-6-luna'), trace,
      manual: async reason => {
        console.log(`\nНужно ручное действие в открытом браузере: ${reason}`);
        const answer = await input.question('Завершите его и нажмите Enter для продолжения; напишите «стоп» для паузы: ');
        return answer.trim().toLowerCase() !== 'стоп';
      },
    });
    const outcome = await agent.run(task);
    console.log(`\n${outcome.status}: ${outcome.answer || 'Нет результата'}\nИнструментов: ${outcome.calls}; время: ${(outcome.durationMs / 1000).toFixed(1)} с\nТрасса: ${logFile}`);
  } catch (e) { console.error(`Ошибка: ${e.message}`); process.exitCode = 1; }
  finally { await browser?.close(); input.close(); }
}
