import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { actionRisk, safeUrl } from './guard.js';

export function installedBrowser(env = process.env, platform = process.platform) {
  const root = platform === 'win32' ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean) : ['/usr/bin', '/opt/google/chrome'];
  const names = platform === 'win32' ? ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'] : ['google-chrome', 'microsoft-edge', 'chromium', 'chromium-browser', 'chrome'];
  const candidates = [env.AUTOBRAUSER_CHROME, ...root.flatMap(r => names.map(n => path.join(r, n))), chromium.executablePath()].filter(Boolean);
  return candidates.find(existsSync) || '';
}

const clip = (s, n = 180) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
export class BrowserController {
  constructor({ profile, executable = installedBrowser(), headed = true, proxy = process.env.AUTOBRAUSER_PROXY || '', testProxyTls = false, allowLocal = false, confirm = async () => false, trace = () => {} } = {}) {
    this.profile = profile || path.resolve('profile'); this.executable = executable; this.allowLocal = allowLocal;
    this.headed = headed; this.proxy = proxy; this.testProxyTls = testProxyTls; this.confirm = confirm; this.trace = trace; this.epoch = 0; this.refs = new Map(); this.history = [];
  }
  async start() {
    if (!this.executable) throw new Error('Chrome/Edge не найден. Установите Chrome/Edge или задайте AUTOBRAUSER_CHROME=полный_путь_к_exe');
    mkdirSync(this.profile, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profile, {
      executablePath: this.executable, headless: !this.headed, viewport: { width: 1360, height: 900 },
      args: process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [],
      ...(this.proxy ? { proxy: { server: this.proxy, bypass: 'localhost,127.0.0.1' } } : {}),
      ignoreHTTPSErrors: this.testProxyTls,
      acceptDownloads: false, serviceWorkers: 'block',
    });
    if (!this.allowLocal) await this.context.route('**/*', route => {
      const url = route.request().url();
      if (/^(about|data|blob):/.test(url)) return route.continue();
      try { safeUrl(url); return route.continue(); } catch { this.trace('blocked-url', { url: url.slice(0, 140) }); return route.abort(); }
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.context.on('page', p => { this.page = p; this.trace('tab', { url: p.url() }); });
    this.page.setDefaultTimeout(10000);
    this.trace('browser', { headed: this.headed, profile: this.profile, executable: this.executable });
    return this;
  }
  current() {
    if (this.page.isClosed()) this.page = this.context.pages().at(-1) || this.page;
    return this.page.url();
  }
  async open(url) {
    const href = safeUrl(url, this.allowLocal);
    await this.page.goto(href, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await this.page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    return this.observe();
  }
  async observe({ query = '', limit = 60 } = {}) {
    const page = this.page; const epoch = ++this.epoch; this.refs.clear();
    const snapshot = () => page.evaluate(({ epoch, query, limit }) => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const clean = (s, n = 130) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
      const selectors = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[contenteditable="true"]';
      const nodes = [];
      const visit = root => {
        for (const e of root.querySelectorAll('*')) {
          if (e.matches(selectors) && visible(e)) nodes.push(e);
          if (e.shadowRoot) visit(e.shadowRoot);
          if (nodes.length >= 1000) return;
        }
      };
      visit(document);
      const q = query.toLocaleLowerCase();
      const rows = nodes.map((e, i) => {
        const label = e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || '';
        const name = clean(label || e.innerText || e.value && e.tagName === 'BUTTON' && e.value || e.getAttribute('name') || '');
        const surrounding = clean(e.closest('label')?.innerText || e.parentElement?.innerText || '', 90);
        const ref = `ab-${epoch}-${i}`; e.setAttribute('data-ab-ref', ref);
        return { ref: `@${epoch}-${i}`, tag: e.tagName.toLowerCase(), type: e.getAttribute('type') || '', name,
          placeholder: clean(e.getAttribute('placeholder')), autocomplete: e.getAttribute('autocomplete') || '',
          text: clean(e.innerText), ariaLabel: clean(e.getAttribute('aria-label')), context: surrounding,
          href: e.getAttribute('href')?.slice(0, 140) || '' };
      });
      const matching = q ? rows.filter(x => `${x.name} ${x.placeholder} ${x.context} ${x.href}`.toLocaleLowerCase().includes(q)) : rows;
      const chosen = (q && matching.length ? matching : rows).slice(0, Math.max(1, Math.min(limit, 80)));
      const body = document.body?.innerText || '';
      let text = q ? body.split('\n').filter(line => line.toLocaleLowerCase().includes(q)).slice(0, 20).join('\n') : body.slice(0, 2200);
      if (q && !text) {
        const flat = body.replace(/\s+/g, ' ').trim();
        const at = flat.toLocaleLowerCase().indexOf(q);
        if (at >= 0) text = flat.slice(Math.max(0, at - 100), at + q.length + 100);
      }
      return { title: document.title, url: location.href, total: rows.length, items: chosen, text: clean(text, 2400) };
    }, { epoch, query, limit });
    let data;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { data = await snapshot(); break; }
      catch (error) {
        if (!/Execution context was destroyed|navigation/i.test(error.message) || attempt === 2) throw error;
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      }
    }
    // Keep the output bounded even on pages with long accessible labels.
    while (JSON.stringify(data).length > 11200 && data.items.length > 8) data.items.pop();
    if (JSON.stringify(data).length > 11200) data.text = data.text.slice(0, 800);
    for (const item of data.items) this.refs.set(item.ref, item);
    const output = JSON.stringify(data);
    this.history.push({ url: data.url, title: data.title, count: data.items.length }); this.history = this.history.slice(-8);
    this.trace('observe', { query, refs: data.items.length, pageItems: data.total, chars: output.length, url: data.url });
    return output;
  }
  async act(actions = []) {
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 6) throw new Error('От 1 до 6 действий в одном вызове');
    for (const [i, a] of actions.entries()) {
      if (this.stopped) return 'HUMAN_REQUIRED: Остановлено пользователем.';
      if (!['click', 'fill', 'press', 'select', 'check', 'scroll', 'back'].includes(a.type)) throw new Error(`Неизвестное действие ${a.type}`);
      if ((['click', 'fill', 'select', 'check'].includes(a.type) || a.type === 'press' && a.ref) && !this.refs.has(a.ref)) throw new Error(`Ссылка ${a.ref} устарела. Сначала browser_observe.`);
      const info = this.refs.get(a.ref) || {};
      const risk = actionRisk(a, info);
      if (risk === 'manual') return 'HUMAN_REQUIRED: секретное поле вводит пользователь в видимом браузере; затем повторите browser_observe.';
      if (risk === 'confirm' && !await this.confirm(`Подтвердить ${a.type} «${info.name || info.text}» на ${this.current()}?`)) return 'HUMAN_REQUIRED: действие отклонено пользователем.';
      if (this.stopped) return 'HUMAN_REQUIRED: Остановлено пользователем.';
      const before = this.current();
      this.trace('action', { type: a.type, ref: a.ref, target: info.name, risk, index: i + 1 });
      try {
        const loc = a.ref ? this.page.locator(`[data-ab-ref="ab-${a.ref.slice(1)}"]`) : null;
        if (a.type === 'click') await loc.click();
        if (a.type === 'fill') await loc.fill(String(a.value ?? ''));
        if (a.type === 'press') {
          const key = String(a.value || 'Enter').replace(/^enter$/i, 'Enter');
          if (loc) await loc.press(key); else await this.page.keyboard.press(key);
        }
        if (a.type === 'select') await loc.selectOption(String(a.value || ''));
        if (a.type === 'check') await loc.setChecked(a.value === true || a.value === 'true');
        if (a.type === 'scroll') await this.page.mouse.wheel(0, Math.max(-1200, Math.min(1200, Number(a.value) || 650)));
        if (a.type === 'back') await this.page.goBack({ waitUntil: 'domcontentloaded' });
        await this.page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
      } catch (error) {
        const fresh = await this.observe();
        if (this.current() !== before) { this.trace('recovery', { reason: 'navigation completed after action timeout', url: this.current() }); return fresh; }
        return `ACTION_FAILED: ${clip(error.message, 400)}\nFRESH_STATE: ${fresh}`;
      }
      if (this.current() !== before || ['click', 'press', 'back'].includes(a.type)) break;
    }
    return this.observe();
  }
  tabs() { return this.context.pages().map((p, i) => ({ index: i, url: p.url(), active: p === this.page })); }
  async switchTab(index) { const p = this.context.pages()[index]; if (!p) throw new Error('Нет такой вкладки'); this.page = p; return this.observe(); }
  async close() { await this.context?.close(); }
}
