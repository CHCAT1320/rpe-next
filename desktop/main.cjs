const { app, BrowserWindow, dialog, net, protocol, shell } = require('electron');
const { realpath } = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const { resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');

const origin = 'rpe://app';
const smoke = process.argv.includes('--smoke-test');
app.setName('RePhiEdit Next');
app.setPath('userData', resolve(app.getPath('appData'), smoke ? 'rpe-next-desktop-smoke' : 'rpe-next-desktop'));
mkdirSync(app.getPath('userData'), { recursive: true });
protocol.registerSchemesAsPrivileged([{ scheme: 'rpe', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let mainWindow;
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    const root = await realpath(resolve(__dirname, '..'));
    const { collaborationConnectSources } = await import(pathToFileURL(resolve(root, 'src/core/collaboration-policy.mjs')).href);
    const connectSources = collaborationConnectSources(process.env.RPE_MEDIA_ORIGINS);
    protocol.handle('rpe', async request => {
      try {
        const url = new URL(request.url);
        if (url.host !== 'app' || !['GET', 'HEAD'].includes(request.method)) return new Response('Forbidden', { status: 403 });
        const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        if (!['index.html', 'styles.css'].includes(relative) && !relative.startsWith('src/') && !relative.startsWith('assets/')) return new Response('Not found', { status: 404 });
        const path = await realpath(resolve(root, relative));
        if (!path.startsWith(root + sep)) return new Response('Not found', { status: 404 });
        const response = await net.fetch(pathToFileURL(path).href);
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src ${connectSources}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
        headers.set('X-Content-Type-Options', 'nosniff');
        if (path.endsWith('.mjs')) headers.set('Content-Type', 'text/javascript; charset=utf-8');
        return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
      } catch { return new Response('Not found', { status: 404 }); }
    });
    mainWindow = new BrowserWindow({
      width: 1440, height: 960, minWidth: 1000, minHeight: 680,
      title: 'Re:PhiEdit Next', backgroundColor: '#171c25', show: false,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false }
    });
    mainWindow.removeMenu();
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      const address = new URL(url);
      if (address.protocol === 'https:' && ['github.com', 'kclg-ysj.github.io'].includes(address.hostname)) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault(); });
    mainWindow.webContents.on('will-prevent-unload', event => {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question', buttons: ['继续编辑', '放弃未保存修改并退出'], defaultId: 0, cancelId: 0,
        title: '尚未保存', message: '当前谱面有未保存的修改，是否退出？'
      });
      if (choice === 1) event.preventDefault();
    });
    const errors = [];
    mainWindow.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    await mainWindow.loadURL(`${origin}/`);
    if (smoke) {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        await document.fonts.ready;
        await new Promise(resolve => setTimeout(resolve, 1000));
        const resources = await Promise.all(['/src/ui/app.mjs', '/assets/rpe/Texture/Tap2.png', '/assets/rpe/fonts/cmdysj.ttf'].map(async path => { const response = await fetch(path); return { path, status: response.status, bytes: (await response.arrayBuffer()).byteLength }; }));
        const forbidden = await fetch('/desktop/main.cjs');
        const canvas = document.createElement('canvas');
        const database = await new Promise((resolve, reject) => { const request = indexedDB.open('desktop-smoke'); request.onsuccess = () => { request.result.close(); resolve(true); }; request.onerror = () => reject(request.error); });
        return { title: document.title, secure: isSecureContext, libraryVisible: Boolean(document.querySelector('#home') && !document.querySelector('#home').hidden), directoryPicker: typeof showDirectoryPicker === 'function', webgl: Boolean(canvas.getContext('webgl2')), database, resources, forbidden: forbidden.status };
      })()`);
      console.log(JSON.stringify({ ...result, errors }));
      const passed = result.secure && result.libraryVisible && result.webgl && result.database && result.resources.every(resource => resource.status === 200 && resource.bytes > 0) && result.forbidden === 404 && !errors.length;
      app.exit(passed ? 0 : 1);
    } else { mainWindow.maximize(); mainWindow.show(); }
  }).catch(error => { console.error(error); if (!smoke) dialog.showErrorBox('启动失败', error.message); app.exit(1); });
}
