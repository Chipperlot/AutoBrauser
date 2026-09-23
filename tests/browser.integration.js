import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserController, installedBrowser } from '../src/browser.js';

const executable = process.env.AUTOBRAUSER_TEST_CHROME || installedBrowser();
test('real browser: form, navigation, dynamic refs, confirmation, secret, persistent cookie', { skip: !executable && 'Chrome/Edge отсутствует' }, async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/') return res.end(`<title>Task portal</title><h1>Project portal</h1><form action="/results"><label>Project search <input name="q" placeholder="Project search"></label><button>Search projects</button></form><demo-search></demo-search><script>customElements.define('demo-search',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<input placeholder="Shadow query">'}})</script><input type="password" placeholder="Password">`);
    if (req.url.startsWith('/results')) { res.setHeader('Set-Cookie', 'session=manual-login-demo; Max-Age=86400; SameSite=Lax'); return res.end(`<title>Search results</title><h1>Results for ${new URL(req.url, 'http://local').searchParams.get('q')}</h1><p>1.<br>Project detail</p><a href="/detail">Open detail</a>`); }
    return res.end('<title>Detail</title><h1>Project detail</h1><button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<b>Deleted</b>\')">Delete record</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = mkdtempSync(path.join(os.tmpdir(), 'ab-profile-'));
  let confirmations = 0;
  const create = () => new BrowserController({ profile, executable, headed: false, allowLocal: true, confirm: async () => { confirmations++; return false; } });
  let browser = create();
  try {
    await browser.start();
    let state = JSON.parse(await browser.open(origin));
    const input = state.items.find(x => x.tag === 'input' && x.name === 'Project search');
    const search = state.items.find(x => x.tag === 'button' && x.name === 'Search projects');
    const shadow = state.items.find(x => x.placeholder === 'Shadow query');
    assert.ok(input && search && shadow);
    assert.doesNotMatch(await browser.act([{ type: 'fill', ref: shadow.ref, value: 'shadow' }, { type: 'press', value: 'Tab' }]), /ACTION_FAILED/);
    state = JSON.parse(await browser.observe());
    const freshInput = state.items.find(x => x.tag === 'input' && x.name === 'Project search');
    assert.match(await browser.act([{ type: 'fill', ref: freshInput.ref, value: 'Luna' }, { type: 'press', ref: freshInput.ref, value: 'ENTER' }]), /Results for Luna/);
    state = JSON.parse(await browser.observe());
    assert.match(state.url, /\/results\?q=Luna/);
    assert.match(await browser.observe({ query: '1. Project detail' }), /1\. Project detail/);
    state = JSON.parse(await browser.observe());
    const detail = state.items.find(x => x.name === 'Open detail');
    assert.match(await browser.act([{ type: 'click', ref: detail.ref }]), /Project detail/);
    state = JSON.parse(await browser.observe());
    const del = state.items.find(x => x.name === 'Delete record');
    assert.match(await browser.act([{ type: 'click', ref: del.ref }]), /HUMAN_REQUIRED/);
    assert.equal(confirmations, 1);
    assert.doesNotMatch(await browser.observe(), /Deleted/);
    await browser.open(origin);
    state = JSON.parse(await browser.observe());
    const password = state.items.find(x => x.type === 'password');
    assert.match(await browser.act([{ type: 'fill', ref: password.ref, value: 'should-never-appear' }]), /HUMAN_REQUIRED/);
    await browser.close(); browser = create(); await browser.start();
    const cookies = await browser.context.cookies(origin);
    assert.equal(cookies.find(x => x.name === 'session')?.value, 'manual-login-demo');
  } finally { await browser.close().catch(() => {}); server.close(); rmSync(profile, { recursive: true, force: true }); }
});
