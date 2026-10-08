const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { networkInterfaces } = require('node:os');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { appendFile } = require('node:fs/promises');
const smoke = process.argv.includes('--smoke-test');
app.setPath('userData', join(app.getPath('appData'), smoke ? 'rpe-next-server-smoke' : 'rpe-next-server'));
mkdirSync(app.getPath('userData'), { recursive: true });
const configPath = join(app.getPath('userData'), 'preferences.json');
const diagnosticPath = join(app.getPath('userData'), 'collaboration-diagnostics.log');
writeFileSync(diagnosticPath, '');
let diagnosticBytes = 0; let diagnosticWrites = Promise.resolve();
const diagnostic = entry => {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
  if (diagnosticBytes + line.length > 1024 * 1024) return;
  diagnosticBytes += line.length;
  diagnosticWrites = diagnosticWrites.then(() => appendFile(diagnosticPath, line)).catch(() => {});
};
let preferences = {};
try { preferences = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
let window; let service; let tunnel; let tunnelPath = ''; let publicAddress = ''; let counts = { rooms: 0, users: 0 }; let message = '服务未启动';
tunnelPath = typeof preferences.tunnelPath === 'string' ? preferences.tunnelPath : '';
app.setName('RPE Next 协作服务器');
const state = () => ({ running: Boolean(service), port: service?.port, preferences: { port: preferences.port ?? 4182, lan: preferences.lan ?? false }, tunnel: Boolean(tunnel), tunnelPath, publicAddress, ...counts, message, localAddresses: Object.values(networkInterfaces()).flat().filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => `ws://${entry.address}:${service?.port ?? 4182}/collab`) });
const update = () => { if (window && !window.isDestroyed()) window.webContents.send('server-state', state()); };
ipcMain.handle('server-action', async (event, action, values = {}) => {
  if (event.sender !== window?.webContents) throw new Error('无权限');
  try {
    if (action === 'start' && !service) {
      const port = Number(values.port); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口须为 1024–65535');
      const module = await import(pathToFileURL(join(__dirname, 'server.mjs')).href);
      service = await module.startCollaborationServer({ port, host: values.lan ? '0.0.0.0' : '127.0.0.1', creationKey: String(values.key ?? ''), onDiagnostic: diagnostic, onStatus: value => { counts = value; update(); } });
      diagnostic({ phase: 'service-start', framed: true, acknowledgementWindow: 16, maximumWindow: 128, compression: true, assetDelivery: true });
      preferences = { port, lan: Boolean(values.lan), tunnelPath }; writeFileSync(configPath, JSON.stringify(preferences));
      message = '服务已启动。公网协作请启动隧道或配置固定公网入口。';
    } else if (action === 'stop') {
      tunnel?.kill(); tunnel = null; if (service) await service.close(); service = null; counts = { rooms: 0, users: 0 }; publicAddress = ''; message = '服务已停止';
    } else if (action === 'diagnostics') {
      await diagnosticWrites; await shell.showItemInFolder(diagnosticPath);
    } else if (action === 'download-tunnel') {
      await shell.openExternal('https://github.com/cloudflare/cloudflared/releases/latest');
    } else if (action === 'choose-tunnel') {
      const result = await dialog.showOpenDialog(window, { title: '选择从 Cloudflare 官方下载的 cloudflared.exe', filters: [{ name: 'Cloudflare Tunnel', extensions: ['exe'] }], properties: ['openFile'] });
      if (!result.canceled) { tunnelPath = result.filePaths[0]; preferences.tunnelPath = tunnelPath; writeFileSync(configPath, JSON.stringify(preferences)); }
    } else if (action === 'tunnel') {
      if (!service || !tunnelPath) throw new Error('请先启动服务并选择 cloudflared.exe');
      if (tunnel) return state();
      const args = values.token ? ['tunnel', '--no-autoupdate', 'run', '--token', String(values.token)] : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${service.port}`];
      const child = spawn(tunnelPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); tunnel = child;
      message = values.token ? '固定隧道正在启动；请使用已配置的域名。令牌仅在本次运行使用。' : '临时公网入口正在申请，通常需要数秒。';
      const onData = bytes => {
        const text = String(bytes); const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) { publicAddress = match[0].replace('https:', 'wss:') + '/collab'; message = '临时公网入口已生成，复制地址到编辑器即可。临时入口重启会变化。'; update(); }
        if (/Registered tunnel connection/.test(text)) { message = '公网隧道已连接'; update(); }
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('error', () => { if (tunnel === child) tunnel = null; message = '隧道启动失败，请检查工具路径与网络'; update(); });
      child.on('exit', () => { if (tunnel === child) { tunnel = null; message = '公网隧道已停止；本地服务仍可使用'; update(); } });
    } else if (action !== 'state' && action !== 'start') throw new Error('未知操作');
  } catch (error) { message = error.message; }
  update(); return state();
});
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 840, height: 760, minWidth: 660, minHeight: 580, show: !smoke, autoHideMenuBar: true, backgroundColor: '#242424', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const errors = []; window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(join(__dirname, 'manager.html'));
  if (smoke) {
    const module = await import(pathToFileURL(join(__dirname, 'server.mjs')).href);
    service = await module.startCollaborationServer({ port: 0 });
    const health = await fetch(`http://127.0.0.1:${service.port}/health`).then(response => response.json());
    const ui = await window.webContents.executeJavaScript('({ title: document.title, bridge: typeof window.serverManager?.action, start: Boolean(document.querySelector("#start")), status: document.querySelector("#status")?.textContent })');
    await service.close(); service = null;
    console.log(JSON.stringify({ health, ui, errors })); app.exit(health.protocol === 1 && ui.bridge === 'function' && ui.start && !errors.length ? 0 : 1);
  }
}).catch(error => { console.error(error.message); app.exit(1); });
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true; tunnel?.kill();
  Promise.resolve(service?.close()).catch(() => {}).finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
