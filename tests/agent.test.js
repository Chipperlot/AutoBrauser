import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, actionRisk, initialUrl, startingUrl } from '../src/guard.js';
import { Agent, tools } from '../src/agent.js';

test('URL boundary and initial domain', () => {
  assert.equal(initialUrl('Открой hh.ru и найди работу'), 'https://hh.ru');
  assert.equal(initialUrl('Открой https://developer.mozilla.org/en-US/: найди поиск'), 'https://developer.mozilla.org/en-US/');
  assert.equal(safeUrl('https://hh.ru'), 'https://hh.ru/');
  for (const url of ['http://127.0.0.1', 'http://192.168.1.1', 'file:///etc/passwd', 'http://[::1]']) assert.throws(() => safeUrl(url));
  assert.equal(safeUrl('http://127.0.0.1:3000', true), 'http://127.0.0.1:3000/');
  assert.equal(startingUrl('зайди в ДНС и найди видеокарту 5060 ти'), 'https://www.bing.com/');
  assert.equal(startingUrl('Через поисковик найди официальный сайт Node.js'), 'https://www.bing.com/');
  assert.equal(startingUrl('на текущей странице найди отзывы', 'https://example.com/'), 'https://example.com/');
  assert.equal(startingUrl('открой https://example.com/', 'https://other.example/'), 'https://example.com/');
});
test('independent safety checks', () => {
  assert.equal(actionRisk({ type: 'fill' }, { type: 'password' }), 'manual');
  assert.equal(actionRisk({ type: 'fill' }, { name: 'Код подтверждения' }), 'manual');
  assert.equal(actionRisk({ type: 'click' }, { name: 'Удалить письмо' }), 'confirm');
  assert.equal(actionRisk({ type: 'click', risk: 'consequential' }, { name: 'Continue' }), 'confirm');
  assert.equal(actionRisk({ type: 'click' }, { name: 'Поиск' }), 'safe');
  assert.equal(actionRisk({ type: 'click' }, { name: 'Books', href: '/books' }), 'safe');
  assert.equal(actionRisk({ type: 'click' }, { tag: 'a', name: 'Видеокарты купить в DNS', href: 'https://www.dns-shop.ru/catalog/' }), 'safe');
  assert.equal(actionRisk({ type: 'click' }, { tag: 'a', name: 'Удалить аккаунт', href: '/account/delete' }), 'confirm');
});
test('small universal tool surface, no site steps', () => {
  assert.equal(tools.length, 6);
  assert.equal(JSON.stringify(tools).includes('hh.ru'), false);
  assert.ok(JSON.stringify(tools).length < 4500);
});
test('runner refuses stale completion and enforces budget', async () => {
  let n = 0;
  const browser = { observe: async () => { n++; return '{"text":"Готово"}'; }, act: async () => 'ok', tabs: () => [] };
  const agent = new Agent({ browser, cli: {}, maxCalls: 3 }); agent.start = Date.now();
  assert.equal((await agent.call('complete', { result: 'x', evidence: 'Нет такого' })).success, false);
  assert.equal((await agent.call('browser_observe', {})).success, true);
  assert.equal(n, 2);
  assert.equal((await agent.call('complete', { result: 'x', evidence: 'Готово' })).success, true);
  assert.equal(n, 3);
  assert.equal(agent.status, 'done');
  assert.equal((await agent.call('browser_observe', {})).success, false);
});

test('stop prevents queued actions and a late completion from reporting success', async () => {
  let resolveObservation, acted = false, closed = false;
  const browser = { observe: () => new Promise(resolve => { resolveObservation = resolve; }), act: () => { acted = true; } };
  const agent = new Agent({ browser, cli: {} }); agent.start = Date.now();
  agent.rpc = { close: () => { closed = true; } };
  const completion = agent.call('complete', { evidence: 'Done', result: 'Done' });
  agent.stop(); resolveObservation('{"text":"Done"}');
  assert.equal((await completion).success, false);
  assert.equal((await agent.call('browser_act', { actions: [{ type: 'click', ref: '@1' }] })).success, false);
  assert.equal(acted, false); assert.equal(closed, true);
  assert.equal(agent.status, 'paused');
});
