// WebDrop Windows app: opens one website in its own window.
// Settings come from config.json, written by android/scripts/prepare.py from the build inputs.
const { app, BrowserWindow, Menu, shell, session, ipcMain, dialog, nativeTheme, powerSaveBlocker, clipboard, screen, net } = require('electron');
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

// HTML apps: the uploaded files are packed in ./site and served as https://webdrop.local/...
const MIME = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain', xml: 'application/xml', wasm: 'application/wasm' };
function serveSite(ses) {
  const root = path.join(__dirname, 'site');
  ses.protocol.handle('https', async (req) => {
    const u = new URL(req.url);
    if (u.hostname !== 'webdrop.local') return net.fetch(req, { bypassCustomProtocolHandlers: true });
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      return new Response(body, { headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' } });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

// Small corner label, drawn in its own shadow root so the page's styles can't change it. Clicks pass through.
function watermarkJs(text) {
  return `(()=>{if(document.getElementById('__wd_wm'))return;const h=document.createElement('div');h.id='__wd_wm';h.style.cssText='position:fixed;left:12px;bottom:14px;z-index:2147483647;pointer-events:none';const r=h.attachShadow({mode:'closed'});const s=document.createElement('span');s.textContent=${JSON.stringify(text)};s.style.cssText='display:inline-block;font:500 11px/1.3 "Segoe UI",system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:4px 9px;border-radius:20px;opacity:.93;box-shadow:0 2px 8px rgba(0,0,0,.25)';r.appendChild(s);(document.body||document.documentElement).appendChild(h)})()`;
}

// ULTRA "Add George": George the orb in a corner. Click for a line, drag to move, hold to hide (until restart).
const GEORGE_LINES = ["George here. Just checking you're still awesome. ✅", "I'm George. I've been an orb for 3 years. Ask me anything. 🔮", "George's tip: drink water, build apps, repeat. 💧", "Don't tell Gerald, but I'm the cool one. 😎", "George is doing a little dance right now. You can't see it. 💃", "I tried to be a square once. Didn't work out. ⬛", "George fact: I'm 100% round and 0% pointy. 🟠", "Have you met my goldfish, Kevin? He's also an orb. 🐟", "I'm not saying I'm the best orb. But I am. 🏅", "George's mood today: sparkly. ✨", "Psst. It's George. I like your vibe. 🤝", "Every time you tap me, I get a tiny bit dizzier. 😵‍💫", "George is on a coffee break. ☕ Leave a message after the boop.", "I've been practising my wink. 😉 How was that?", "George's to-do list: 1. Glow. 2. Glow more. 📝", "One day I'll be a disco ball. Dream big. 🪩", "I'm learning to juggle. It's hard without hands. 🤹", "George here: your website would look great as an app. Just saying. 📱", "My grandma was a bubble. She'd be so proud of me. 🫧", "Knock knock. Who's there? George. George who? George the orb, obviously. 🚪", "George here. I just learned what a 'website' is. Wild. 🌐", "Fun fact: I can't swim. I just float. Majestically. 🏊", "I asked Gerald for a hug. He said orbs don't hug. 😔", "George's weather report: 100% chance of sparkles. ✨", "I tried to read a book once. It rolled away. Like me. 📖", "Did you know? My favourite colour is… orb. 🟠", "George is thinking about lunch. George cannot eat. 🍕", "I'm not lazy, I'm in energy-saving mode. 🔋", "Every app you build makes George very proud. 🥹", "My cousin Gerald says hi. Gerald is wearing a hat again. 🎩", "I put on sunglasses. Now I'm cool George. 😎", "I tried to tell a joke but I forgot the round part. 🙃", "George's motto: stay round, stay bright. 🔆", "Is it just me, or is this app getting fancier? 💅", "I once rolled all the way to the shop. Forgot my wallet. 🛒", "Plot twist: Kevin the goldfish is the real boss. 🐟", "If you see a sparkle, that's me waving. 👋", "I'm practising my evil laugh: mwa-ha-ha… boop. 😈", "Sometimes I glow just because. No reason. 💡", "Thanks for tapping. Your tap has been added to the Big Book of Taps. 📚"];
function georgeJs() {
  return `(()=>{try{if(sessionStorage.getItem('__wd_george_nap'))return}catch(e){}if(document.getElementById('__wd_george'))return;const L=${JSON.stringify(GEORGE_LINES)};
const h=document.createElement('div');h.id='__wd_george';h.style.cssText='position:fixed;right:18px;bottom:22px;z-index:2147483646';
const r=h.attachShadow({mode:'closed'});
r.innerHTML='<style>.w{display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:700 13px/1.35 "Segoe UI",system-ui,sans-serif}'
+'.s{max-width:240px;padding:8px 12px;border-radius:14px;background:#fff6e6;color:#2b1a10;box-shadow:0 6px 18px rgba(0,0,0,.35);opacity:0;transform:translateY(6px);transition:.18s;pointer-events:none}.s.on{opacity:1;transform:none}'
+'.g{position:relative;width:58px;height:58px;border-radius:50%;cursor:grab;user-select:none;touch-action:none;background:radial-gradient(circle at 34% 27%,#fffbe0 0,#ffe066 18%,#ffc83d 42%,#ff9f43 75%,#e8590c 100%);box-shadow:0 0 18px rgba(255,200,61,.7),inset -6px -8px 14px rgba(179,64,10,.35);transition:transform .25s}'
+'.g:before,.g:after{content:"";position:absolute;top:40%;width:6px;height:6px;border-radius:50%;background:#2b1a10}.g:before{left:34%}.g:after{right:34%}'
+'.m{position:absolute;left:35%;top:55%;width:30%;height:14%;border:3px solid #2b1a10;border-top:0;border-radius:0 0 99px 99px}.g.b{transform:scale(1.15,.88)}</style>'
+'<div class="w"><div class="s"></div><div class="g" title="George"><div class="m"></div></div></div>';
const s=r.querySelector('.s'),g=r.querySelector('.g');let t=0,last=-1;
const say=x=>{s.textContent=x;s.classList.add('on');clearTimeout(t);t=setTimeout(()=>s.classList.remove('on'),3800)};
let sx=0,sy=0,ox=0,oy=0,mv=false,down=false,hold=0;
g.addEventListener('pointerdown',e=>{down=true;mv=false;sx=e.clientX;sy=e.clientY;const b=h.getBoundingClientRect();ox=b.left;oy=b.top;g.setPointerCapture(e.pointerId);hold=setTimeout(()=>{mv=true;h.remove();try{sessionStorage.setItem('__wd_george_nap','1')}catch(e){}},650)});
g.addEventListener('pointermove',e=>{if(!down)return;const dx=e.clientX-sx,dy=e.clientY-sy;if(!mv&&Math.hypot(dx,dy)>6){mv=true;clearTimeout(hold)}if(mv){h.style.left=Math.max(0,Math.min(innerWidth-70,ox+dx))+'px';h.style.top=Math.max(0,Math.min(innerHeight-70,oy+dy))+'px';h.style.right='auto';h.style.bottom='auto'}});
g.addEventListener('pointerup',()=>{down=false;clearTimeout(hold);if(!mv){let i;do{i=Math.floor(Math.random()*L.length)}while(L.length>1&&i===last);last=i;say(L[i]);g.classList.add('b');setTimeout(()=>g.classList.remove('b'),130)}});
(document.body||document.documentElement).appendChild(h);
let hi=null;try{hi=sessionStorage.getItem('__wd_george_hi')}catch(e){}if(!hi){try{sessionStorage.setItem('__wd_george_hi','1')}catch(e){}setTimeout(()=>say("Hi, I'm George! Click me 👋"),2200)}})()`;
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

  if (cfg.site) serveSite(ses);
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

  wc.on('dom-ready', () => {
    if (cfg.watermark && isWeb(wc.getURL())) wc.executeJavaScript(watermarkJs(cfg.watermark)).catch(() => {});
    if (has('george') && isWeb(wc.getURL())) wc.executeJavaScript(georgeJs()).catch(() => {});
  });
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
