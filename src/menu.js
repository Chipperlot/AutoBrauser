import path from 'node:path';
import { ConsoleInput, readTask } from './input.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent, tools } from './agent.js';
import { BrowserController, installedBrowser } from './browser.js';
import { findCodexCli, listModels } from './environment.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = path.join(root, 'chats');
const browsers = new Map();
const color = (r, g, b, text) => process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m` : text;
const lime = text => color(182, 246, 111, text);
const cyan = text => color(111, 219, 213, text);
const violet = text => color(170, 158, 251, text);
const muted = text => color(131, 151, 165, text);
const red = text => color(255, 150, 133, text);
const bright = text => color(238, 247, 249, text);
const short = (text, length = 70) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, length);
const callsText = count => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'вызов' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'вызова' : 'вызовов'}`;
function wrapped(text, width = 71) {
  const lines = [];
  let line = '';
  for (const word of String(text || '').replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines;
}
const folder = id => path.join(dataDir, id);

function save(chat) {
  chat.updatedAt = new Date().toISOString();
  mkdirSync(folder(chat.id), { recursive: true });
  const file = path.join(folder(chat.id), 'state.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(chat, null, 2));
  renameSync(`${file}.tmp`, file);
}
function loadChats() {
  mkdirSync(dataDir, { recursive: true });
  const chats = [];
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f\d-]{36}$/.test(entry.name)) continue;
    try {
      const chat = JSON.parse(readFileSync(path.join(folder(entry.name), 'state.json'), 'utf8'));
      chat.keepBrowser ??= true;
      if (chat.status === 'running') { chat.status = 'paused'; save(chat); }
      chats.push(chat);
    } catch { /* Ignore incomplete chat folders. */ }
  }
  return chats;
}
function createChat(model) {
  const now = new Date().toISOString();
  const chat = { id: randomUUID(), title: 'Новый чат', model, modelHistory: [model], threadId: '', status: 'idle',
    createdAt: now, updatedAt: now, messages: [], toolCount: 0, lastUrl: '', keepBrowser: true };
  save(chat);
  return chat;
}
function headline(label) {
  const heading = short(label, 72);
  console.log(cyan('  ╭' + '─'.repeat(76) + '╮'));
  console.log(cyan('  │') + `  ${bright(heading)}` + ' '.repeat(74 - heading.length) + cyan('│'));
  console.log(cyan('  ╰' + '─'.repeat(76) + '╯'));
}
function clear() { if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H'); else console.log('\n'); }
function logo() {
  console.log(lime('     ◢█◣    AUTO') + bright('BRAUSER') + muted('  /  STUDIO 04'));
  console.log(lime('    ◢███◣   ') + muted('Browser Intelligence Workspace'));
  console.log(muted('    ▔▔▔▔▔   ') + cyan('CODEX  ×  PLAYWRIGHT  ×  LIVE CHROME'));
  console.log('');
}
function status(value) {
  if (value === 'done') return lime('● готово');
  if (value === 'paused') return violet('● пауза');
  if (value === 'error') return red('● ошибка');
  if (value === 'running') return cyan('● работа');
  return muted('○ новый');
}
function title(chat) { return short(chat.title, 43).padEnd(43); }
function modelName(model) { return model.toUpperCase(); }
function eventLine(type, data) {
  if (type === 'browser') return `${lime('● CHROME')} ${muted('видимое окно · отдельный профиль чата')}`;
  if (type === 'search') return `${cyan('◎ SEARCH')} ${muted(data.reason)}`;
  if (type === 'tool') return `${violet('◆ TOOL')}   ${bright(data.name)} ${muted((data.args?.actions || []).map(a => `${a.type} ${a.ref || ''}`).join(' → '))}`;
  if (type === 'action') return `${cyan('↳ ACTION')} ${bright(data.type)} ${muted(short(data.target || data.ref, 48))} ${data.risk === 'confirm' ? red('подтверждение') : ''}`;
  if (type === 'observe') return `${lime('◉ PAGE')}   ${muted(short(data.url, 39))} ${cyan(`${data.refs}/${data.pageItems} элементов`)}`;
  if (type === 'result') return `${muted('✓ RESULT')} ${bright(data.name)} ${muted(`${data.chars} символов`)}`;
  if (type === 'recovery') return `${violet('↺ RECOVER')} ${muted(short(data.reason, 55))}`;
  if (type === 'turn') return `${cyan('◇ TURN')}   ${muted(`${data.status} · ${callsText(data.tools)}`)}`;
  if (type === 'model') return `${lime('✦ MODEL')}  ${muted(short(data.text, 47))}`;
  return '';
}
function printEvent(type, data, at = new Date().toISOString()) {
  if (type === 'error') {
    const lines = wrapped(data.message, 64);
    console.log(`  ${muted(new Date(at).toLocaleTimeString('ru-RU'))}  ${red('! ERROR')}  ${red(lines[0] || '')}`);
    for (const line of lines.slice(1)) console.log(`             ${red(line)}`);
    return;
  }
  const line = eventLine(type, data);
  if (line) console.log(`  ${muted(new Date(at).toLocaleTimeString('ru-RU'))}  ${line}`);
}
function record(chat, type, data) {
  const event = { at: new Date().toISOString(), type, ...data };
  appendFileSync(path.join(folder(chat.id), 'events.jsonl'), JSON.stringify(event) + '\n');
  if (data.url) chat.lastUrl = data.url;
  if (type === 'tool') chat.toolCount++;
  printEvent(type, data, event.at);
}
function recentEvents(chat) {
  const file = path.join(folder(chat.id), 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').slice(-28).filter(Boolean).map(line => JSON.parse(line));
}

async function pickModel(input, models, current) {
  clear(); logo(); headline('ВЫБОР МОДЕЛИ');
  if (!models.length) {
    console.log(red('  Каталог моделей сейчас недоступен. Остаётся текущая модель: ') + bright(current));
    await input.question(muted('\n  Enter — вернуться ')); return current;
  }
  console.log(muted('  Модели получены из локального Codex app-server.\n'));
  models.forEach((model, i) => {
    const mark = model.id === current ? lime('◆') : muted('◇');
    console.log(`  ${mark} ${String(i + 1).padStart(2)}  ${bright(model.name.padEnd(19))} ${muted(short(model.description, 48))}`);
  });
  console.log(muted('\n  0 — назад'));
  const choice = Number((await input.question(lime('\n  Выберите номер › '))).trim());
  return Number.isInteger(choice) && choice >= 1 && choice <= models.length ? models[choice - 1].id : current;
}
async function showTools(input, chat) {
  clear(); logo(); headline('ИНСТРУМЕНТЫ АГЕНТА · 6');
  tools.forEach((tool, i) => {
    console.log(`  ${lime(String(i + 1).padStart(2))}  ${bright(tool.name)}`);
    for (const line of wrapped(tool.description, 67)) console.log(`      ${muted(line)}`);
    console.log('');
  });
  if (chat) {
    console.log(cyan('  ИСТОРИЯ МОДЕЛЕЙ ЧАТА') + '  ' + chat.modelHistory.map(model => violet(modelName(model))).join(muted(' → ')));
    console.log(muted('\n  Последние действия (полная лента: /log):'));
    for (const event of recentEvents(chat).slice(-5)) printEvent(event.type, event, event.at);
  }
  await input.question(muted('\n  Enter — вернуться '));
}
async function showLog(input, chat) {
  clear(); logo(); headline(`ЛЕНТА ДЕЙСТВИЙ · ${chat.title}`);
  const events = recentEvents(chat);
  if (!events.length) console.log(muted('  Действий пока нет.'));
  for (const event of events) printEvent(event.type, event, event.at);
  await input.question(muted('\n  Enter — вернуться '));
}
async function showHistory(input, chat) {
  clear(); logo(); headline(`ИСТОРИЯ · ${chat.title}`);
  for (const message of chat.messages) {
    console.log(`\n  ${message.role === 'user' ? cyan('ВЫ') : lime('АГЕНТ')} ${muted(new Date(message.at).toLocaleString('ru-RU'))} ${message.model ? violet(modelName(message.model)) : ''}`);
    for (const line of wrapped(message.text, 71)) console.log(`  ${bright(line)}`);
  }
  await input.question(muted('\n  Enter — вернуться '));
}
async function runTask(input, chat, task, cli) {
  if (chat.title === 'Новый чат') chat.title = short(task, 48);
  chat.messages.push({ role: 'user', text: task, at: new Date().toISOString(), model: chat.model });
  chat.status = 'running'; save(chat);
  clear(); logo(); headline(`LIVE RUN · ${modelName(chat.model)} · ${short(chat.title, 34)}`);
  console.log(muted(`  Задача: ${short(task, 64)}\n`));
  let browser, agent, stopped = false;
  input.control = line => {
    if (line.trim() !== '/stop') return false;
    stopped = true; input.cancel(); agent?.stop();
    if (browser) browser.stopped = true;
    console.log(violet('\n  Останавливаю задачу…'));
    return true;
  };
  console.log(muted('  /stop + Enter или Ctrl+C — остановить и выйти в меню'));
  try {
    browser = browsers.get(chat.id);
    if (!browser?.context?.pages().length) browser = await new BrowserController({ profile: path.join(folder(chat.id), 'profile'),
      trace: (type, data) => record(chat, type, data),
      confirm: async message => /^да$/i.test((await input.question(red(`\n  ${message}\n  Напишите «да» для выполнения › `))).trim()),
    }).start();
    browsers.set(chat.id, browser);
    browser.trace = (type, data) => record(chat, type, data);
    browser.confirm = async message => /^да$/i.test((await input.question(message + ' Напишите «да» › ')).trim());
    browser.stopped = stopped;
    if (stopped) throw new Error('Остановлено пользователем');
    agent = new Agent({ browser, cli, model: chat.model, threadId: chat.threadId, persistent: true,
      resumeUrl: browser.current() !== 'about:blank' ? browser.current() : chat.lastUrl,
      onThread: id => { chat.threadId = id; save(chat); },
      trace: (type, data) => record(chat, type, data),
      manual: async reason => {
        console.log(violet(`\n  Нужно ручное действие в Chrome: ${reason}`));
        return (await input.question(muted('  Сделайте его и нажмите Enter; «стоп» — пауза › '))).trim().toLowerCase() !== 'стоп';
      },
    });
    const outcome = await agent.run(task);
    chat.status = outcome.status;
    chat.messages.push({ role: 'assistant', text: outcome.answer || 'Нет результата.', at: new Date().toISOString(),
      calls: outcome.calls, durationMs: outcome.durationMs });
    console.log(''); headline(outcome.status === 'done' ? 'РЕЗУЛЬТАТ ПОДТВЕРЖДЁН' : 'ЗАДАЧА ЗАВЕРШЕНА');
    wrapped(outcome.answer || 'Нет результата.').forEach((line, i) => console.log(`  ${i === 0 ? outcome.status === 'done' ? lime('●') : violet('●') : ' '} ${bright(line)}`));
    console.log(muted(`\n  ${callsText(outcome.calls)} · ${(outcome.durationMs / 1000).toFixed(1)} с · ${short(chat.lastUrl || 'нет URL', 55)}`));
  } catch (error) {
    chat.status = stopped ? 'paused' : 'error';
    chat.messages.push({ role: 'assistant', text: `Ошибка: ${error.message}`, at: new Date().toISOString() });
    record(chat, 'error', { message: error.message });
  } finally {
    input.control = null;
    if (browser && !browser.page?.isClosed()) chat.lastUrl = browser.current();
    if (!chat.keepBrowser) { await browser?.close().catch(() => {}); browsers.delete(chat.id); }
    save(chat);
  }
  if (stopped) return true;
  await input.question(muted('\n  Enter — вернуться в чат '));
}
async function chatMenu(input, chat, models, cli) {
  while (true) {
    clear(); logo(); headline(`ЧАТ · ${chat.title}`);
    console.log(`  ${status(chat.status)}   ${cyan(modelName(chat.model))}   ${muted(`${chat.messages.length} сообщений · ${callsText(chat.toolCount)} инструментов`)}`);
    if (chat.lastUrl) console.log(muted(`  Последняя страница: ${short(chat.lastUrl, 74)}`));
    console.log(muted('  ' + '─'.repeat(76)));
    for (const message of chat.messages.slice(-4)) {
      const role = message.role === 'user' ? cyan('ВЫ') : lime('АГЕНТ');
      console.log(`  ${role}  ${bright(short(message.text, 62))}${message.text.length > 62 ? muted('…') : ''}`);
      if (message.calls) console.log(muted(`         ${callsText(message.calls)} инструментов · ${(message.durationMs / 1000).toFixed(1)} с`));
    }
    if (!chat.messages.length) console.log(muted('  История пуста. Отправьте первую задачу.'));
    console.log(cyan('  [' + (chat.keepBrowser ? '✓' : ' ') + '] Оставлять Chrome открытым · /keep · /browser — открыть окно'));
    console.log(muted('  Вставьте текст; /send на отдельной строке — отправить, /cancel — отменить'));
    console.log(muted('  /history · /model · /tools · /log · /back'));
    const task = await readTask(input);
    if (!task) continue;
    if (task === '/back') {
      const browser = browsers.get(chat.id);
      if (browser?.context?.pages().length) { chat.lastUrl = browser.current(); save(chat); }
      return;
    }
    if (task === '/keep') {
      chat.keepBrowser = !chat.keepBrowser; save(chat);
      if (!chat.keepBrowser) {
        const browser = browsers.get(chat.id);
        if (browser?.context?.pages().length) { chat.lastUrl = browser.current(); save(chat); }
        await browser?.close(); browsers.delete(chat.id);
      }
      continue;
    }
    if (task === '/browser') {
      let browser = browsers.get(chat.id);
      if (!browser?.context?.pages().length) {
        browser = await new BrowserController({ profile: path.join(folder(chat.id), 'profile') }).start();
        browsers.set(chat.id, browser);
        if (chat.lastUrl) await browser.open(chat.lastUrl).catch(() => {});
      }
      await browser.page.bringToFront(); continue;
    }
    if (task === '/history') { await showHistory(input, chat); continue; }
    if (task === '/log') { await showLog(input, chat); continue; }
    if (task === '/tools') { await showTools(input, chat); continue; }
    if (task === '/model') {
      const model = await pickModel(input, models, chat.model);
      if (model !== chat.model) { chat.model = model; chat.modelHistory.push(model); save(chat); }
      continue;
    }
    if (!cli) { console.log(red('  Codex CLI не найден. Проверьте npm run doctor.')); await input.question(muted('  Enter — продолжить ')); continue; }
    if (await runTask(input, chat, task, cli)) return;
  }
}

export async function runMenu() {
  const input = new ConsoleInput();
  const cli = findCodexCli();
  let models = [];
  if (cli) { try { models = await listModels(cli); } catch (error) { console.log(red(`Каталог моделей: ${error.message}`)); } }
  const chats = loadChats();
  let preferredModel = models.find(model => model.id === 'gpt-6-luna')?.id || models.find(model => model.isDefault)?.id || models[0]?.id || 'gpt-6-luna';
  for (const chat of chats) {
    if (models.length && !models.some(model => model.id === chat.model)) {
      chat.model = preferredModel;
      chat.modelHistory = [...(chat.modelHistory || []), preferredModel];
      save(chat);
    }
  }
  let page = 0;
  try {
    while (true) {
      clear(); logo(); headline('ЦЕНТР УПРАВЛЕНИЯ');
      console.log(`  ${lime('● Система готова')}  ${muted('│')}  ${cyan(`${tools.length} инструментов`)}  ${muted('│')}  ${violet(`${chats.length} чатов`)}  ${muted('│')}  ${bright(modelName(preferredModel))}`);
      console.log(muted(`  ${installedBrowser() ? 'Chrome/Edge найден' : 'Chrome/Edge не найден'} · ${cli ? 'Codex CLI подключён' : 'Codex CLI не найден'} · история хранится локально`));
      console.log('');
      console.log(lime('  [N]  НОВЫЙ ЧАТ') + muted('    Выберите модель и поставьте задачу'));
      console.log(cyan('  [M]  МОДЕЛИ') + muted('       Каталог доступных моделей'));
      console.log(violet('  [T]  ИНСТРУМЕНТЫ') + muted('  Все 6 функций браузерного агента'));
      console.log(muted('  ' + '─'.repeat(76)));
      console.log(bright('  ИСТОРИЯ ЧАТОВ') + muted(`  ${chats.length ? `${page + 1} / ${Math.ceil(chats.length / 8)}` : 'пока пусто'}`));
      const sorted = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const visible = sorted.slice(page * 8, page * 8 + 8);
      visible.forEach((chat, i) => console.log(`  ${lime(String(i + 1))}  ${title(chat)} ${violet(modelName(chat.model).padEnd(12))} ${status(chat.status)}`));
      if (!visible.length) console.log(muted('  Ваши чаты появятся здесь после первого запуска.'));
      console.log(muted('\n  [>] следующая страница   [<] предыдущая   [Q] выход'));
      const choice = (await input.question(lime('\n  Выберите действие › '))).trim().toLowerCase();
      if (choice === 'q') return;
      if (choice === 'n') { const chat = createChat(preferredModel); chats.push(chat); await chatMenu(input, chat, models, cli); page = 0; continue; }
      if (choice === 'm') { preferredModel = await pickModel(input, models, preferredModel); continue; }
      if (choice === 't') { await showTools(input); continue; }
      if (choice === '>' && (page + 1) * 8 < sorted.length) { page++; continue; }
      if (choice === '<' && page > 0) { page--; continue; }
      const index = Number(choice) - 1;
      if (Number.isInteger(index) && index >= 0 && index < visible.length) await chatMenu(input, visible[index], models, cli);
    }
  } finally {
    input.close();
    for (const chat of chats) {
      const browser = browsers.get(chat.id);
      if (browser?.context?.pages().length) { chat.lastUrl = browser.current(); save(chat); }
    }
    await Promise.allSettled([...browsers.values()].map(browser => browser.close()));
    browsers.clear();
  }
}
