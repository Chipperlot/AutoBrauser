import { isIP } from 'node:net';

export function safeUrl(value, allowLocal = false) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Только HTTP(S) без учётных данных в URL');
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost = h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
    !h.includes('.') || isIP(h) !== 0 && (isIP(h) === 6 || /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h));
  if (privateHost && !allowLocal) throw new Error('Локальный адрес запрещён; для собственного тестового сервера добавьте --allow-local');
  return url.href;
}

const sensitive = /password|passcode|one.time|otp|2fa|mfa|cvv|cvc|card.?number|парол|код.?подтверж|номер.?карт|секрет/i;
const consequential = /pay|purchase|checkout|place.?order|send|delete|remove|unsubscribe|apply|publish|оплат|купить|оформ|заказ|отправ|удал|отпис|отклик|опубли|брони|размест/i;
export function actionRisk(action, element = {}) {
  if (action.type === 'fill' && (element.type === 'password' || sensitive.test(`${element.name} ${element.placeholder} ${element.autocomplete}`))) return 'manual';
  if (action.type === 'click' || action.type === 'press' || action.type === 'check') {
    const label = `${element.name} ${element.text} ${element.ariaLabel} ${element.href}`;
    if (action.risk === 'consequential') return 'confirm';
    if (element.tag === 'a' && /^(https?:\/\/|\/)/i.test(element.href) && !/delete|remove|unsubscribe|удал|отпис/i.test(label)) return 'safe';
    if (consequential.test(label)) return 'confirm';
    if (/submit|confirm|подтверд/i.test(label) && !/search|найти|поиск/i.test(label)) return 'confirm';
    if (/continue|next|продолж|далее/i.test(label) && consequential.test(element.context || '')) return 'confirm';
  }
  return 'safe';
}

export function initialUrl(task) {
  const found = task.match(/https?:\/\/[^\s<>"«»]+/i)?.[0] || task.match(/(?:^|\s)((?:[a-z\d-]+\.)+[a-z]{2,}(?:\/[^\s<>"«»]*)?)/i)?.[1];
  return found ? (found.startsWith('http') ? found : `https://${found}`).replace(/[.,;!?:]+$/, '') : '';
}

export function startingUrl(task, resumeUrl = '') {
  if (/через поисковик|найди\s+(?:официальный\s+)?сайт/i.test(task)) return 'https://www.bing.com/';
  return initialUrl(task) || (resumeUrl && /текущ|открыт.*страниц|на этой странице|здесь|продолжи/i.test(task)
    ? resumeUrl : 'https://www.bing.com/');
}
