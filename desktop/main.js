// WebDrop Windows app: opens one website in its own window.
// Settings come from config.json, written by android/scripts/prepare.py from the build inputs.
const { app, BrowserWindow, Menu, shell, session, ipcMain, dialog, nativeTheme, powerSaveBlocker, clipboard, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const has = (x) => Array.isArray(cfg.extras) && cfg.extras.includes(x);
const START = new URL(cfg.url);
const SITE = baseDomain(START.hostname);
const AD_HOSTS = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagservices.com', 'adservice.google.com', 'pagead2.googlesyndication.com', 'adnxs.com', 'taboola.com',
  'outbrain.com', 'criteo.com', 'criteo.net', 'amazon-adsystem.com', 'scorecardresearch.com', 'quantserve.com',
  'moatads.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'adsrvr.org', 'casalemedia.com', 'popads.net',
  'propellerads.com', 'mgid.com', 'hotjar.com', 'doubleverify.com', 'adform.net', 'smartadserver.com', 'teads.tv',
  '33across.com', 'sharethrough.com', 'media.net', 'bidswitch.net', 'indexww.com', 'advertising.com',
  'ads-twitter.com', 'ads.yahoo.com', 'zedo.com', 'yieldmo.com', 'adcolony.com', 'applovin.com',
  'unityads.unity3d.com', 'chartbeat.com', 'mixpanel.com', 'segment.io', 'clarity.ms', 'adroll.com',
  'bounceexchange.com', 'exoclick.com', 'trafficjunky.net'];

let win = null;
let unlocked = !cfg.lockHash;
let quitting = false;

function baseDomain(h) {
  const p = String(h || '').toLowerCase().split('.');
  return p.length > 2 ? p.slice(-2).join('.') : p.join('.');
}
function sameSite(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && baseDomain(x.hostname) === SITE; } catch (e) { return false; }
}
function isWeb(u) { return /^https?:\/\//i.test(u); }
function isAd(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return AD_HOSTS.some((d) => h === d || h.endsWith('.' + d)) && baseDomain(h) !== SITE;
  } catch (e) { return false; }
}
function openOutside(u) {
  if (/^(https?|mailto|tel):/i.test(u)) shell.openExternal(u).catch(() => {});
}

// ---- small saved state (window size, last page) ----
const STATE_FILE = () => path.join(app.getPath('userData'), 'webdrop-window.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch (e) { return {}; } }
function saveState(patch) {
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify(Object.assign(loadState(), patch))); } catch (e) {}
}
function startUrl() {
  if (has('resume') && !has('private')) {
    const last = loadState().last;
    if (last && sameSite(last)) return last;
  }
  return cfg.url;
}

function offlinePage(target) {
  const safe = JSON.stringify(String(target));
  const html = '<!doctype html><meta charset="utf-8"><title>Offline</title><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b1020;color:#eef2ff;font:15px "Segoe UI",system-ui,sans-serif;text-align:center}button{margin-top:14px;padding:10px 22px;border:0;border-radius:10px;background:linear-gradient(90deg,#3cc8ff,#7b5cff);color:#fff;font-weight:700;font-size:15px;cursor:pointer}p{color:#9aa6c8}</style>'
    + '<div><div style="font-size:34px">📡</div><h2>Can’t reach the site</h2><p>Check your internet connection.</p><button onclick="location.href=' + safe.replace(/"/g, '&quot;') + '">Try again</button></div>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function buildContextMenu(wc, params) {
  const items = [];
  if (params.isEditable) {
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
  } else if (params.selectionText) {
    items.push({ role: 'copy' }, { type: 'separator' });
  }
  if (params.linkURL && isWeb(params.linkURL)) {
    items.push({ label: 'Open link in browser', click: () => openOutside(params.linkURL) },
      { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
  }
  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    { label: 'Home', click: () => wc.loadURL(cfg.url) },
    { type: 'separator' },
    { label: 'Open page in browser', enabled: isWeb(wc.getURL()), click: () => openOutside(wc.getURL()) },
    { label: win && win.isFullScreen() ? 'Leave full screen' : 'Full screen', click: () => win && win.setFullScreen(!win.isFullScreen()) },
  );
  return Menu.buildFromTemplate(items);
}

function createWindow() {
  const st = loadState();
  const area = screen.getPrimaryDisplay().workAreaSize;
  // first start: a comfortable size that always fits the screen, centred
  const fits = (r) => r && r.width >= 360 && r.height >= 400 && r.width <= area.width + 40 && r.height <= area.height + 40;
  const b = fits(st.bounds) ? st.bounds : { width: Math.min(1200, Math.round(area.width * 0.9)), height: Math.min(840, Math.round(area.height * 0.9)) };
  const bg = /^#[0-9a-f]{6}$/i.test(cfg.statusColor || '') ? cfg.statusColor : (has('dark') ? '#121212' : '#ffffff');
  const ses = has('private') ? session.fromPartition('webdrop-private') : session.defaultSession;

  if (has('adblock')) {
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => cb({ cancel: isAd(d.url) }));
  }
  ses.setPermissionRequestHandler((wc, perm, cb) => {
    cb(['notifications', 'media', 'fullscreen', 'clipboard-sanitized-write', 'geolocation', 'pointerLock'].includes(perm));
  });

  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y, center: b.x === undefined,
    minWidth: 360, minHeight: 400,
    title: cfg.name,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: bg,
    autoHideMenuBar: true,
    show: false,
    fullscreen: !!cfg.fullscreen,
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  Menu.setApplicationMenu(null);
  if (st.maximized) win.maximize();
  if (has('secure')) win.setContentProtection(true);
  const wc = win.webContents;
  wc.setUserAgent(wc.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?webdrop-desktop\/\S+/, ''));

  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 4000);

  wc.on('did-finish-load', () => {
    if (has('bigtext')) wc.setZoomFactor(1.15);
    if (!cfg.allowZoom) wc.setVisualZoomLevelLimits(1, 1).catch(() => {});
  });
  wc.on('page-title-updated', () => {});

  // Links: other sites open in the normal browser unless "keep all links inside the app" is on.
  wc.setWindowOpenHandler(({ url }) => {
    if (!isWeb(url)) { openOutside(url); return { action: 'deny' }; }
    if (cfg.internalLinks || sameSite(url)) wc.loadURL(url);
    else openOutside(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('data:') || url.startsWith('file:')) return;
    if (!isWeb(url)) { e.preventDefault(); openOutside(url); return; }
    if (!unlocked) { e.preventDefault(); return; }
    if (!cfg.internalLinks && !sameSite(url)) { e.preventDefault(); openOutside(url); }
  });
  wc.on('did-navigate', (e, url) => { if (has('resume') && !has('private') && sameSite(url)) saveState({ last: url }); });
  wc.on('did-navigate-in-page', (e, url, main) => { if (main && has('resume') && !has('private') && sameSite(url)) saveState({ last: url }); });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && isWeb(url)) wc.loadURL(offlinePage(url));
  });
  wc.on('context-menu', (e, params) => buildContextMenu(wc, params).popup({ window: win }));

  // Keyboard: F5 / Ctrl+R reload, Alt+←/→ back and forward, Alt+Home home, F11 full screen, zoom keys.
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const k = i.key;
    const ctrl = i.control || i.meta;
    let done = true;
    if (k === 'F5' || (ctrl && k.toLowerCase() === 'r')) wc.reload();
    else if (k === 'F11') win.setFullScreen(!win.isFullScreen());
    else if (k === 'Escape' && win.isFullScreen() && !cfg.fullscreen) win.setFullScreen(false);
    else if (i.alt && k === 'ArrowLeft') wc.navigationHistory.goBack();
    else if (i.alt && k === 'ArrowRight') wc.navigationHistory.goForward();
    else if (k === 'BrowserBack') wc.navigationHistory.goBack();
    else if (k === 'BrowserForward') wc.navigationHistory.goForward();
    else if (i.alt && k === 'Home') wc.loadURL(cfg.url);
    else if (ctrl && (k === '=' || k === '+' || k === '-' || k === '0')) {
      if (cfg.allowZoom) {
        const z = wc.getZoomFactor();
        wc.setZoomFactor(k === '0' ? (has('bigtext') ? 1.15 : 1) : Math.min(3, Math.max(0.5, z + (k === '-' ? -0.1 : 0.1))));
      }
    } else done = false;
    if (done) e.preventDefault();
  });

  const remember = () => {
    if (!win || win.isFullScreen()) return;
    saveState({ maximized: win.isMaximized(), bounds: win.isMaximized() ? (loadState().bounds || {}) : win.getBounds() });
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', (e) => {
    remember();
    if (cfg.confirmExit && !quitting) {
      const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close', 'Cancel'], defaultId: 0, cancelId: 1, title: cfg.name, message: 'Close ' + cfg.name + '?' });
      if (r !== 0) { e.preventDefault(); return; }
      quitting = true;
    }
    if (has('private')) ses.clearStorageData().catch(() => {});
  });
  win.on('closed', () => { win = null; });

  if (unlocked) wc.loadURL(startUrl());
  else wc.loadFile(path.join(__dirname, 'lock.html'));
}

ipcMain.handle('webdrop-name', () => cfg.name);
ipcMain.handle('webdrop-unlock', (e, pw) => {
  const h = crypto.createHash('sha256').update(cfg.lockSalt + ':' + pw, 'utf8').digest('hex');
  const ok = !!cfg.lockHash && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(cfg.lockHash));
  if (ok && win) { unlocked = true; win.webContents.loadURL(startUrl()); }
  return ok;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.setAppUserModelId(cfg.appId);
  if (has('dark')) nativeTheme.themeSource = 'dark';
  app.whenReady().then(() => {
    if (cfg.keepScreenOn) powerSaveBlocker.start('prevent-display-sleep');
    if (has('private')) session.fromPartition('webdrop-private').clearStorageData().catch(() => {});
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
