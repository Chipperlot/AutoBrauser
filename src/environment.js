import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Rpc } from './rpc.js';

const menuModels = ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna'];

export function findCodexCli() {
  const paths = [];
  if (process.env.AUTOBRAUSER_CODEX) paths.push({ command: process.env.AUTOBRAUSER_CODEX, prefix: [] });
  if (process.platform === 'win32') {
    const desktopBin = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    if (existsSync(desktopBin)) for (const name of readdirSync(desktopBin)) {
      const exe = path.join(desktopBin, name, 'codex.exe');
      if (existsSync(exe)) paths.push({ command: exe, prefix: [] });
    }
    paths.push({ command: 'codex.exe', prefix: [] });
    const npm = path.join(process.env.APPDATA || '', 'npm');
    const script = path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) paths.push({ command: process.execPath, prefix: [script] });
    const exe = path.join(npm, 'codex.exe');
    if (existsSync(exe)) paths.push({ command: exe, prefix: [] });
  } else paths.push({ command: 'codex', prefix: [] });
  return paths.find(item => spawnSync(item.command, [...item.prefix, '--version'], { encoding: 'utf8', timeout: 12000 }).status === 0);
}

export async function listModels(cli) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  const rpc = new Rpc(cli.command, [...cli.prefix, 'app-server', '-c', 'forced_login_method="chatgpt"'], { env });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'AutoBrauser', version: '4.0.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized', params: {} });
    const response = await rpc.request('model/list', { limit: 100 }, 30000);
    return response.data.filter(model => !model.hidden && menuModels.includes(model.model)).map(model => ({
      id: model.model, name: model.displayName, description: model.description, isDefault: model.isDefault,
    }));
  } finally { rpc.close(); }
}
