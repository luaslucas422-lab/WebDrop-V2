/*
 * WebDrop server — Cloudflare Worker + D1 (live: webdrop-server.luaslucas422.workers.dev).
 *
 * Google login, usernames, Quick Build / Custom Picture tokens, Quick Build (no GitHub needed by users),
 * ULTRA licences (plans, promo codes with redemption limits, Stripe Checkout with Google Pay),
 * licence verification, and the hosted sign-in and checkout pages.
 *
 * Secrets / vars (set by .github/workflows/deploy-server.yml):
 *   SESSION_SECRET        random string, signs login sessions                         (required)
 *   GOOGLE_CLIENT_ID      OAuth "Web application" client ID                           (login)
 *   GH_TOKEN, GH_REPO     token with Actions read/write on the build repo, "owner/repo" (Quick Build)
 *   GH_BRANCH             default "main"
 *   STRIPE_SECRET_KEY     Stripe secret key; checkout shows Google Pay + cards       (payments)
 *   STRIPE_WEBHOOK_SECRET optional, signs checkout.session.completed events         (payments)
 *   TEST_PAYMENTS         "true" = never charge, hand out licences for testing
 *   APP_SCHEMES           allowed app link schemes, default "webdrop"
 *   WEB_ORIGINS           comma list of web origins allowed to receive results by postMessage
 *   GOOGLE_CERTS_URL, STRIPE_API, GITHUB_API   overrides used by the local tests only
 */

export const PLANS = {
  week: { cents: 100, days: 7, label: '1 week' },
  month: { cents: 450, days: 30, label: '1 month' },
  year: { cents: 1550, days: 365, label: '1 year' },
  life: { cents: 2500, days: null, label: 'Lifetime' },
};
export const PROMOS = {
  SUPADROP: { pct: 100, limit: 10, perUser: true },
  LILYDROP: { pct: 40, lily: true },
  GIVEME70OFF: { pct: 70, plans: ['life'], money: true, label: 'GIVEME70%OFF' },
};
const NEW_USER_TOKENS = { qb: 3, pic: 3 };
const FREE_NAME = 10, ULTRA_NAME = 40;
const MAX_PENDING = 2;

/* ------------------------------------------------------------------ helpers */
const enc = new TextEncoder();
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });
const err = (status, error, message) => json({ error, message }, status);
const html = (body) =>
  new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });

function b64url(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function randomKey() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  a.forEach((v) => (s += C[v % 32]));
  return `WD-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
export function normKey(k) {
  const raw = String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length === 14 && raw.startsWith('WD')) return `WD-${raw.slice(2, 6)}-${raw.slice(6, 10)}-${raw.slice(10, 14)}`;
  return null;
}
const now = () => Date.now();

async function body(req) {
  try {
    const t = await req.text();
    if (t.length > 200000) return null;
    return t ? JSON.parse(t) : {};
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ sessions */
async function makeSession(env, sub) {
  const payload = b64url(enc.encode(JSON.stringify({ sub, exp: now() + 30 * 864e5 })));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}
async function readSession(env, req) {
  const h = req.headers.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok || !env.SESSION_SECRET) return null;
  const [payload, sig] = tok.split('.');
  if (!payload || !sig) return null;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, payload))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!p.sub || !p.exp || p.exp < now()) return null;
    return p.sub;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ Google ID tokens */
let certCache = { at: 0, keys: [] };
async function googleKeys(env) {
  if (certCache.keys.length && now() - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch(env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('certs');
  certCache = { at: now(), keys: (await r.json()).keys || [] };
  return certCache.keys;
}
export async function verifyGoogle(env, credential) {
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw new Error('format');
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  if (header.alg !== 'RS256') throw new Error('alg');
  const jwk = (await googleKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('signature');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('iss');
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error('aud');
  if (!claims.exp || claims.exp * 1000 < now()) throw new Error('expired');
  if (!claims.sub) throw new Error('sub');
  return claims;
}

/* ------------------------------------------------------------------ data access */
async function getUser(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}
async function userLicence(env, userId) {
  return env.DB.prepare(
    'SELECT * FROM licences WHERE user_id = ? AND revoked = 0 AND (exp IS NULL OR exp > ?) ORDER BY (exp IS NULL) DESC, exp DESC LIMIT 1'
  ).bind(userId, now()).first();
}
async function licenceByKey(env, key) {
  const k = normKey(key);
  return k ? env.DB.prepare('SELECT * FROM licences WHERE key = ?').bind(k).first() : null;
}
const licLive = (l) => !!(l && !l.revoked && (l.exp == null || l.exp > now()));
const licOut = (l) => (l ? { key: l.key, plan: l.plan, exp: l.exp, lily: !!l.lily, money: !!l.money } : null);
async function pending(env, userId) {
  return env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(used_pic),0) AS p FROM builds WHERE user_id = ? AND status IN ('queued','building') AND ultra = 0"
  ).bind(userId).first();
}
async function meOut(env, user) {
  const lic = await userLicence(env, user.id);
  const p = await pending(env, user.id);
  return {
    user: {
      email: user.email, name: user.name, picture: user.picture, username: user.username,
      qb: user.qb, pic: user.pic, qb_reserved: p ? p.n : 0, pic_reserved: p ? p.p : 0,
      show_name: user.show_name !== 0, anon_name: user.anon_no ? 'Anonymous #' + user.anon_no : null,
    },
    ultra: licOut(lic),
  };
}

/* ------------------------------------------------------------------ Workshop (shared apps) */
const RE_APK = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^\s"'<>]+\.apk$/i;
const RE_FAV = /^https:\/\/www\.google\.com\/s2\/favicons\?domain=[\w.%-]+(&sz=\d+)?$/;
const RE_DATAIMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
async function anonNo(env, user) {
  if (user.anon_no) return user.anon_no;
  const n = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
  await env.DB.prepare('UPDATE users SET anon_no = ? WHERE id = ? AND anon_no IS NULL').bind(n, user.id).run();
  return (await getUser(env, user.id)).anon_no;
}
function authorOf(row) {
  if (row.show_name === 0) return 'Anonymous #' + (row.anon_no || '0000');
  if (row.username) return '@' + row.username;
  return String(row.uname || 'WebDrop user').split(' ')[0];
}
async function workshopList(env, user) {
  const rows = (await env.DB.prepare(
    `SELECT w.id, w.user_id, w.name, w.url, w.icon, w.apk_url, w.created, u.username, u.name AS uname, u.show_name, u.anon_no
     FROM workshop w LEFT JOIN users u ON u.id = w.user_id WHERE w.hidden = 0 ORDER BY w.created DESC LIMIT 80`
  ).bind().all()).results || [];
  return json({
    items: rows.map((r) => ({ id: r.id, name: r.name, url: r.url, icon: r.icon || '', apk_url: r.apk_url, created: r.created, author: authorOf(r), mine: r.user_id === user.id })),
  });
}
async function workshopShare(env, user, b) {
  const name = String(b.name || '').trim(), url = String(b.url || '').trim(), apk = String(b.apk_url || '').trim();
  let icon = String(b.icon || '').trim();
  if (!name || name.length > 40 || /[\x00-\x1f]/.test(name)) return err(400, 'name', 'The app needs a name (up to 40 characters).');
  if (!RE_URL.test(url)) return err(400, 'url', 'The website link must start with https://');
  if (!RE_APK.test(apk)) return err(400, 'apk', 'Only apps built with WebDrop can be shared.');
  if (icon && !(RE_FAV.test(icon) || (RE_DATAIMG.test(icon) && icon.length <= 40000))) icon = '';
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM workshop WHERE user_id = ?').bind(user.id).first();
  if (count && count.n >= 20) return err(429, 'limit', 'You can share up to 20 apps. Remove one first.');
  await anonNo(env, user);
  const id = 'w' + now().toString(36) + crypto.getRandomValues(new Uint8Array(3)).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
  try {
    await env.DB.prepare('INSERT INTO workshop (id, user_id, name, url, icon, apk_url, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, user.id, name, url, icon, apk, now()).run();
  } catch {
    return err(409, 'dup', 'That app is already in the Workshop.');
  }
  return json({ id });
}

/* ------------------------------------------------------------------ pricing */
export function quote(plan, promoCode) {
  const p = PLANS[plan];
  if (!p) return { error: 'plan' };
  const code = String(promoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const promo = code ? PROMOS[code] : null;
  if (code && !promo) return { error: 'promo' };
  if (promo && promo.plans && !promo.plans.includes(plan)) return { error: 'promo_plan', message: `${promo.label || code} only works on the Lifetime licence.` };
  const pct = promo ? promo.pct : 0;
  const total = Math.round((p.cents * (100 - pct)) / 100);
  return { plan, label: p.label, base: p.cents, pct, total, promo: promo ? code : '', promo_label: promo ? promo.label || code : '', lily: !!(promo && promo.lily), money: !!(promo && promo.money) };
}

/* ------------------------------------------------------------------ Stripe Checkout (shows Google Pay + cards) */
function stripe(env, path, form) {
  return fetch((env.STRIPE_API || 'https://api.stripe.com') + path, {
    method: form ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
}
const priceCache = {};
async function stripePrice(env, plan) {
  if (priceCache[plan] && now() - priceCache[plan].at < 600e3) return priceCache[plan].id;
  try {
    const r = await stripe(env, '/v1/prices?active=true&lookup_keys[]=webdrop_' + plan);
    const j = await r.json();
    const p = (j.data || [])[0];
    if (p && p.unit_amount === PLANS[plan].cents && p.currency === 'eur') {
      priceCache[plan] = { id: p.id, at: now() };
      return p.id;
    }
  } catch {}
  return null;
}
async function createCheckout(env, req, b) {
  const userId = await readSession(env, req);
  const q = quote(b.plan, b.promo);
  if (q.error) return err(400, q.error, q.message || (q.error === 'promo' ? 'That promo code isn’t valid.' : 'Pick a plan.'));
  if (q.total === 0) return json({ free: true, ...q });
  if (env.TEST_PAYMENTS === 'true') return json({ test: true, ...q });
  if (!env.STRIPE_SECRET_KEY) return err(503, 'payments_off', 'Payments are not set up on the server yet.');
  const origin = new URL(req.url).origin;
  const scheme = allowedScheme(env, b.scheme || '');
  const back = allowedOrigin(env, b.origin || '');
  const tail = '&scheme=' + encodeURIComponent(scheme) + (back ? '&origin=' + encodeURIComponent(back) : '');
  const form = {
    mode: 'payment',
    success_url: origin + '/checkout/done?sid={CHECKOUT_SESSION_ID}' + tail,
    cancel_url: origin + '/pay?plan=' + q.plan + '&promo=' + encodeURIComponent(q.promo) + '&cancelled=1' + tail,
    'metadata[plan]': q.plan,
    'metadata[promo]': q.promo,
    'metadata[user]': userId || '',
    'payment_intent_data[description]': 'WebDrop ULTRA · ' + q.label,
    'line_items[0][quantity]': '1',
  };
  if (userId) form.client_reference_id = userId;
  const price = await stripePrice(env, q.plan);
  const coupon = q.promo ? env['STRIPE_COUPON_' + q.promo] || q.promo : '';
  if (price && (!q.pct || coupon)) {
    form['line_items[0][price]'] = price;
    if (q.pct) form['discounts[0][coupon]'] = coupon;
  } else {
    form['line_items[0][price_data][currency]'] = 'eur';
    form['line_items[0][price_data][unit_amount]'] = String(q.total);
    form['line_items[0][price_data][product_data][name]'] = 'WebDrop ULTRA · ' + q.label + (q.pct ? ` (${q.promo} −${q.pct}%)` : '');
  }
  const r = await stripe(env, '/v1/checkout/sessions', form);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) return err(502, 'stripe', (j.error && j.error.message) || 'Checkout couldn’t start. Try again.');
  return json({ url: j.url, id: j.id });
}
/** Turns a paid Checkout Session into a licence. Safe to call many times (webhook + return page). */
async function fulfil(env, sessionObj) {
  if (!sessionObj || sessionObj.payment_status !== 'paid') return null;
  const existing = await env.DB.prepare('SELECT * FROM licences WHERE payment = ?').bind(sessionObj.id).first();
  if (existing) return existing;
  const m = sessionObj.metadata || {};
  const q = quote(m.plan, m.promo);
  if (q.error) return null;
  return createLicence(env, { userId: m.user || null, q, amount: sessionObj.amount_total || 0, payment: sessionObj.id });
}
async function verifyStripeSignature(secret, payload, header) {
  const parts = Object.fromEntries(String(header || '').split(',').map((x) => x.split('=')));
  const t = parts.t;
  const sigs = String(header || '').split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
  if (!t || !sigs.length || Math.abs(now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(t + '.' + payload)));
  const hex = [...mac].map((x) => x.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => safeEqual(s, hex));
}

/* ------------------------------------------------------------------ GitHub (Quick Build) */
function ghRaw(env, path, opt = {}, auth = true) {
  return fetch((env.GITHUB_API || 'https://api.github.com') + path, {
    ...opt,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(auth && env.GH_TOKEN ? { authorization: 'Bearer ' + env.GH_TOKEN } : {}),
      'user-agent': 'webdrop-server',
      ...(opt.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}
/** GitHub request; reads fall back to no token if the token is refused (the build repo is public). */
async function gh(env, path, opt = {}) {
  const r = await ghRaw(env, path, opt, true);
  if (!opt.method && env.GH_TOKEN && (r.status === 401 || r.status === 403)) return ghRaw(env, path, opt, false);
  return r;
}
const RE_URL = /^https:\/\/[A-Za-z0-9._~:/?#@!&()*+,;=%\-]{3,480}$/;
const RE_PKG = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RE_COL = /^#[0-9A-Fa-f]{6}$/;
const bool = (v) => (v === true || v === 'true' ? 'true' : 'false');

async function startQuickBuild(env, user, b) {
  if (!env.GH_REPO) return err(503, 'builds_off', 'Quick Build is not set up on the server yet.');
  const url = String(b.url || '').trim();
  const name = String(b.name || '').trim();
  const pkg = String(b.pkg || '').trim();
  let lic = await userLicence(env, user.id);
  if (!lic && b.licence_key) {
    const k = await licenceByKey(env, b.licence_key);
    if (licLive(k) && (!k.user_id || k.user_id === user.id)) lic = k;
  }
  const ultra = !!lic;
  if (!RE_URL.test(url)) return err(400, 'url', 'Use a full https:// address.');
  if (!name || name.length > (ultra ? ULTRA_NAME : FREE_NAME) || /[\x00-\x1f]/.test(name))
    return err(400, 'name', ultra ? 'App names can be up to 40 characters.' : 'Free app names can be up to 10 characters.');
  if (!RE_PKG.test(pkg) || pkg.length > 120) return err(400, 'pkg', 'The package ID should look like com.example.app.');
  const icon = typeof b.icon_b64 === 'string' ? b.icon_b64 : '';
  if (icon && (icon.length > 60000 || !/^[A-Za-z0-9+/=]+$/.test(icon))) return err(400, 'icon', 'That icon is too large.');
  const custom = !!(icon && b.icon_custom);
  const p = await pending(env, user.id);
  if (!ultra) {
    if (p.n >= MAX_PENDING) return err(429, 'busy', 'You already have builds running. Wait for them to finish.');
    if (user.qb - p.n <= 0) return err(402, 'no_qb', 'You’re out of Quick Build tokens. Get ULTRA for unlimited builds.');
    if (custom && user.pic - p.p <= 0) return err(402, 'no_pic', 'You’re out of Custom Picture tokens. Use your website’s icon, or get ULTRA.');
  }
  const salt = String(b.lock_salt || '').toLowerCase(), hash = String(b.lock_hash || '').toLowerCase();
  if ((salt || hash) && !(/^[0-9a-f]{8,64}$/.test(salt) && /^[0-9a-f]{64}$/.test(hash))) return err(400, 'lock', 'The start password could not be prepared.');
  const orient = ['unspecified', 'portrait', 'landscape'].includes(b.orientation) ? b.orientation : 'unspecified';
  const status = RE_COL.test(b.status_bar_color || '') ? b.status_bar_color : '';
  const id = 'q' + now().toString(36) + crypto.getRandomValues(new Uint8Array(3)).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
  const inputs = {
    build_id: id, app_url: url, app_name: name, package_id: pkg,
    icon_mode: icon ? 'image' : 'favicon', icon_b64: icon,
    immersive: bool(b.immersive), internal_links: bool(b.internal_links ?? true), keep_screen_on: bool(b.keep_screen_on),
    show_progress: bool(b.show_progress ?? true),
    orientation: ultra ? orient : 'unspecified',
    status_bar_color: ultra ? status : '',
    desktop_mode: ultra ? bool(b.desktop_mode) : 'false',
    allow_zoom: ultra ? bool(b.allow_zoom) : 'false',
    confirm_exit: ultra ? bool(b.confirm_exit) : 'false',
    lock_salt: salt, lock_hash: hash,
    // free: splash, bigtext · ULTRA: dark, secure
    extras: String(b.extras || '').split(',').map((x) => x.trim()).filter((x) => ['splash', 'bigtext'].includes(x) || (ultra && ['dark', 'secure'].includes(x))).filter((x, i, a) => a.indexOf(x) === i).join(','),
  };
  // Start right away when BUILD_TOKEN can; otherwise the "Quick Build queue" GitHub job picks it up within minutes.
  let dispatched = false;
  if (env.GH_TOKEN) {
    try {
      const r = await gh(env, `/repos/${env.GH_REPO}/actions/workflows/build-apk.yml/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref: env.GH_BRANCH || 'main', inputs }),
      });
      dispatched = r.status === 204;
    } catch {}
  }
  const msg = dispatched ? 'Waiting for a build machine…' : 'In the build queue… starts within a few minutes';
  await env.DB.prepare(
    'INSERT INTO builds (id, user_id, name, pkg, status, msg, ultra, used_pic, created, inputs, dispatched, dispatched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, name, pkg, 'queued', msg, ultra ? 1 : 0, custom ? 1 : 0, now(), dispatched ? null : JSON.stringify(inputs), dispatched ? 1 : 0, dispatched ? now() : null).run();
  return json({ id, status: 'queued', msg, ...(await meOut(env, await getUser(env, user.id))) });
}

async function pollQuickBuild(env, user, id) {
  const b = await env.DB.prepare('SELECT * FROM builds WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!b) return err(404, 'not_found', 'Build not found.');
  const out = async (x) => json({ id, status: x.status, msg: x.msg, apk_url: x.apk_url, run_url: x.run_url, ...(await meOut(env, await getUser(env, user.id))) });
  if (!['queued', 'building'].includes(b.status)) return out(b);
  const set = async (patch) => {
    const keys = Object.keys(patch);
    await env.DB.prepare(`UPDATE builds SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).bind(...keys.map((k) => patch[k]), id).run();
    Object.assign(b, patch);
  };
  if (now() - b.created > 60 * 60e3) {
    await set({ status: 'error', msg: 'This build timed out. No tokens were used.' });
    return out(b);
  }
  if (!b.dispatched) return out(b); // still waiting for the queue job
  let runs = [];
  try {
    const r = await gh(env, `/repos/${env.GH_REPO}/actions/workflows/build-apk.yml/runs?event=workflow_dispatch&per_page=40`);
    if (r.ok) runs = (await r.json()).workflow_runs || [];
  } catch {}
  const run = runs.find((x) => String(x.name || '').includes(id) || String(x.display_title || '').includes(id));
  if (!run) {
    if (now() - (b.dispatched_at || b.created) > 6 * 60e3) await set({ status: 'error', msg: 'The build never started. No tokens were used.' });
    return out(b);
  }
  if (run.status !== 'completed') {
    await set({ status: run.status === 'queued' ? 'queued' : 'building', msg: run.status === 'queued' ? 'Waiting for a build machine…' : 'Building your app… usually 3–6 minutes', run_url: run.html_url || null });
    return out(b);
  }
  if (run.conclusion !== 'success') {
    await set({ status: 'failed', msg: 'The build failed. No tokens were used.', run_url: run.html_url || null });
    return out(b);
  }
  const rel = await gh(env, `/repos/${env.GH_REPO}/releases/tags/build-${id}`);
  if (!rel.ok) {
    await set({ status: 'building', msg: 'Finishing up…' });
    return out(b);
  }
  const asset = ((await rel.json()).assets || []).find((a) => /\.apk$/i.test(a.name));
  if (!asset) {
    await set({ status: 'failed', msg: 'The build finished but no APK was attached. No tokens were used.', run_url: run.html_url || null });
    return out(b);
  }
  await set({ status: 'ready', msg: 'Ready to install', apk_url: asset.browser_download_url, run_url: run.html_url || null });
  // Tokens are only used once a build has really succeeded — and only once.
  const c = await env.DB.prepare('UPDATE builds SET charged = 1 WHERE id = ? AND charged = 0').bind(id).run();
  if (c.meta && c.meta.changes === 1 && !b.ultra) {
    await env.DB.prepare('UPDATE users SET qb = MAX(qb - 1, 0), pic = MAX(pic - ?, 0) WHERE id = ?').bind(b.used_pic ? 1 : 0, user.id).run();
  }
  return out(b);
}

/* ------------------------------------------------------------------ licences */
async function createLicence(env, { userId, q, amount, payment }) {
  let start = now();
  let lily = q.lily ? 1 : 0;
  let money = q.money ? 1 : 0;
  if (userId) {
    const cur = await userLicence(env, userId);
    if (cur && cur.exp && cur.exp > start) start = cur.exp; // extend instead of overlapping
    const prevLily = await env.DB.prepare('SELECT 1 AS x FROM licences WHERE user_id = ? AND lily = 1 LIMIT 1').bind(userId).first();
    if (prevLily) lily = 1;
    const prevMoney = await env.DB.prepare('SELECT 1 AS x FROM licences WHERE user_id = ? AND money = 1 LIMIT 1').bind(userId).first();
    if (prevMoney) money = 1;
  }
  const days = PLANS[q.plan].days;
  const lic = { key: randomKey(), user_id: userId, plan: q.plan, exp: days ? start + days * 864e5 : null, promo: q.promo || null, lily, money, amount, payment: payment || null };
  try {
    await env.DB.prepare(
      'INSERT INTO licences (key, user_id, plan, exp, promo, lily, money, amount, payment, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(lic.key, lic.user_id, lic.plan, lic.exp, lic.promo, lic.lily, lic.money, lic.amount, lic.payment, now()).run();
  } catch (e) {
    if (payment) return env.DB.prepare('SELECT * FROM licences WHERE payment = ?').bind(payment).first();
    throw e;
  }
  if (q.promo && !(PROMOS[q.promo] && PROMOS[q.promo].limit)) {
    await env.DB.prepare('INSERT INTO promo_uses (code, uses) VALUES (?, 1) ON CONFLICT(code) DO UPDATE SET uses = uses + 1').bind(q.promo).run();
  }
  return lic;
}

/** Free licences (100% promo codes) and test-mode purchases. Paid ones go through Stripe Checkout. */
async function issueLicence(env, req, b) {
  const userId = await readSession(env, req);
  const q = quote(b.plan, b.promo);
  if (q.error === 'plan') return err(400, 'plan', 'Pick a plan.');
  if (q.error === 'promo') return err(400, 'promo', 'That promo code isn’t valid.');
  if (q.error) return err(400, q.error, q.message);
  if (q.total > 0 && env.TEST_PAYMENTS !== 'true') return err(402, 'use_checkout', 'Please pay through checkout.');
  const promo = q.promo ? PROMOS[q.promo] : null;
  if (q.total === 0 && !(promo && promo.limit)) return err(400, 'promo', 'That code can’t be used on its own.');
  if (promo && promo.perUser && !userId) return err(401, 'login', `Sign in with Google to use ${q.promo}.`);
  let redeemed = false;
  if (promo && promo.perUser) {
    try {
      await env.DB.prepare('INSERT INTO promo_redemptions (code, user_id, created) VALUES (?, ?, ?)').bind(q.promo, userId, now()).run();
      redeemed = true;
    } catch {
      return err(409, 'used', `You’ve already used ${q.promo}.`);
    }
  }
  if (promo && promo.limit) {
    await env.DB.prepare('INSERT INTO promo_uses (code, uses) VALUES (?, 0) ON CONFLICT(code) DO NOTHING').bind(q.promo).run();
    const u = await env.DB.prepare('UPDATE promo_uses SET uses = uses + 1 WHERE code = ? AND uses < ?').bind(q.promo, promo.limit).run();
    if (!u.meta || u.meta.changes !== 1) {
      if (redeemed) await env.DB.prepare('DELETE FROM promo_redemptions WHERE code = ? AND user_id = ?').bind(q.promo, userId).run();
      return err(409, 'limit', `Sorry, ${q.promo} has been fully redeemed.`);
    }
  }
  const lic = await createLicence(env, { userId, q, amount: 0, payment: q.total > 0 ? 'test_' + crypto.randomUUID() : null });
  return json({ ...licOut(lic), amount: q.total, test: env.TEST_PAYMENTS === 'true' });
}

/* ------------------------------------------------------------------ hosted pages */
function allowedScheme(env, s) {
  const list = String(env.APP_SCHEMES || 'webdrop').split(',').map((x) => x.trim()).filter(Boolean);
  return list.includes(s) ? s : list[0] || 'webdrop';
}
function allowedOrigin(env, o) {
  const list = String(env.WEB_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.includes(o) ? o : '';
}
const PAGE_CSS = `*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8eefc;background:radial-gradient(ellipse at 50% 0,#1b2c5c,#070b18 65%)}
.card{width:min(420px,100%);background:rgba(16,24,48,.92);border:1px solid #2a4170;border-radius:22px;padding:26px 22px;text-align:center;box-shadow:0 20px 60px #0008}
h1{font-size:22px;margin:6px 0 4px}p{color:#a9b8da;margin:8px 0}.mark{font-size:30px}
.btn{display:block;width:100%;margin-top:14px;padding:14px;border:0;border-radius:14px;background:#4d8dff;color:#fff;font:600 16px system-ui;text-decoration:none;cursor:pointer}
.btn.ghost{background:transparent;border:1px solid #2a4170;color:#cfe0ff}
.row{display:flex;justify-content:space-between;padding:4px 0;font-size:14px}.tot{font-weight:800;font-size:18px;border-top:1px solid #2a4170;margin-top:6px;padding-top:8px}
.disc{color:#4ade80}.box{margin:14px 0;padding:12px;border:1px dashed #2a4170;border-radius:14px;text-align:left}
input{width:100%;padding:13px;border-radius:12px;border:1px solid #2a4170;background:#070b18;color:#fff;font:600 17px ui-monospace,Menlo,monospace;text-align:center;letter-spacing:.06em}
.msg{min-height:22px;font-size:14px}.bad{color:#fb7185}.good{color:#4ade80}#gsi,#gpay{display:flex;justify-content:center;margin-top:16px;min-height:44px}.small{font-size:12px;color:#7d8db3}`;

function loginPage(env, url) {
  const scheme = allowedScheme(env, url.searchParams.get('scheme') || 'webdrop');
  const origin = allowedOrigin(env, url.searchParams.get('origin') || '');
  const cid = env.GOOGLE_CLIENT_ID || '';
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · WebDrop</title><style>${PAGE_CSS}</style></head>
<body><main class="card"><div class="mark">✦</div><h1>Sign in to WebDrop</h1>
<p>Use your Google account. Google keeps your password and 2-step verification. WebDrop never sees them.</p>
${cid ? '<div id="gsi"></div>' : '<p class="bad">Google sign-in isn’t set up on this server yet (GOOGLE_CLIENT_ID is missing).</p>'}
<p class="msg" id="msg"></p><a class="btn" id="back" hidden>Return to WebDrop</a>
<p class="small">New accounts get 3 Quick Build tokens and 3 Custom Picture tokens.</p></main>
${cid ? '<script src="https://accounts.google.com/gsi/client" async></script>' : ''}
<script>
const CID=${JSON.stringify(cid)},SCHEME=${JSON.stringify(scheme)},ORIGIN=${JSON.stringify(origin)};
const msg=(t,c)=>{const m=document.getElementById('msg');m.textContent=t;m.className='msg '+(c||'')};
function done(session){
  if(ORIGIN&&window.opener){window.opener.postMessage({type:'wd-auth',session},ORIGIN);msg('Signed in ✓ You can close this window.','good');setTimeout(()=>window.close(),600);return}
  const link=SCHEME+'://auth?s='+encodeURIComponent(session);const a=document.getElementById('back');a.href=link;a.hidden=false;msg('Signed in ✓','good');location.href=link}
async function onCred(r){msg('Signing in…');try{const res=await fetch('/api/auth/google',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({credential:r.credential})});const j=await res.json();if(!res.ok)throw new Error(j.message||'Sign-in failed');done(j.session)}catch(e){msg(e.message||'Sign-in failed','bad')}}
window.onload=()=>{if(!CID||!window.google)return;google.accounts.id.initialize({client_id:CID,callback:onCred,ux_mode:'popup'});google.accounts.id.renderButton(document.getElementById('gsi'),{theme:'filled_blue',size:'large',shape:'pill',text:'continue_with',width:300})};
</script></body></html>`);
}

function payPage(env, url) {
  const scheme = allowedScheme(env, url.searchParams.get('scheme') || 'webdrop');
  const origin = allowedOrigin(env, url.searchParams.get('origin') || '');
  const plan = PLANS[url.searchParams.get('plan')] ? url.searchParams.get('plan') : 'month';
  const promo = String(url.searchParams.get('promo') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  const cfg = { scheme, origin, plan, promo, test: env.TEST_PAYMENTS === 'true', cancelled: url.searchParams.has('cancelled') };
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Get ULTRA · WebDrop</title><style>${PAGE_CSS}</style></head>
<body><main class="card" id="card"><div class="mark">✦</div><h1>WebDrop ULTRA</h1><div class="box" id="sum">Loading price…</div>
<button class="btn" id="pay" hidden>Pay</button><button class="btn" id="claim" hidden>Claim ULTRA for free</button>
<p class="msg" id="msg"></p><p class="small" id="note"></p></main>
${THANKS_HTML}
<script>
const C=${JSON.stringify(cfg)};let S='';try{S=new URLSearchParams(location.hash.slice(1)).get('s')||sessionStorage.getItem('wd-s')||'';if(S)sessionStorage.setItem('wd-s',S)}catch(e){}
const $=id=>document.getElementById(id);const msg=(t,c)=>{$('msg').textContent=t||'';$('msg').className='msg '+(c||'')};
const eur=c=>'€'+(c%100?(c/100).toFixed(2):String(c/100));let Q=null,busy=false;
const H=()=>Object.assign({'content-type':'application/json'},S?{authorization:'Bearer '+S}:{});
async function load(){const r=await fetch('/api/quote?plan='+C.plan+'&promo='+encodeURIComponent(C.promo));const q=await r.json();if(!r.ok){$('sum').textContent=q.message||'That promo code isn’t valid.';return}Q=q;
 $('sum').innerHTML='<div class="row"><span>ULTRA · '+q.label+'</span><span>'+eur(q.base)+'</span></div>'+(q.pct?'<div class="row disc"><span>'+(q.promo_label||q.promo)+' (−'+q.pct+'%)</span><span>−'+eur(q.base-q.total)+'</span></div>':'')+'<div class="row tot"><span>Total</span><span>'+eur(q.total)+'</span></div>';
 if(q.total===0){$('claim').hidden=false;if(!S)msg('Sign in with Google in WebDrop first to use '+q.promo+'.','bad');return}
 $('pay').hidden=false;$('pay').textContent=C.test?'Pay '+eur(q.total)+' (test mode, no charge)':'Pay '+eur(q.total)+' · Google Pay or card';
 $('note').textContent=C.test?'Test mode: no money is taken.':'Secure checkout by Stripe. Google Pay appears automatically on supported phones.';
 if(C.cancelled)msg('Payment cancelled. You weren’t charged.')}
async function pay(){if(busy)return;busy=true;msg('Opening secure checkout…');try{
 if(C.test){await issue();return}
 const r=await fetch('/api/checkout',{method:'POST',headers:H(),body:JSON.stringify({plan:C.plan,promo:C.promo,scheme:C.scheme,origin:C.origin})});const j=await r.json();
 if(!r.ok){msg(j.message||'Checkout couldn’t start.','bad');return}if(j.url)location.href=j.url}catch(e){msg('Couldn’t reach the server. Try again.','bad')}finally{busy=false}}
async function issue(){busy=true;msg('Confirming…');try{const r=await fetch('/api/licence/issue',{method:'POST',headers:H(),body:JSON.stringify({plan:C.plan,promo:C.promo})});const j=await r.json();if(!r.ok){msg(j.message||'Something went wrong.','bad');return}showThanks(j)}catch(e){msg('Couldn’t reach the server. Try again.','bad')}finally{busy=false}}
$('pay').onclick=pay;$('claim').onclick=issue;load();
</script>${THANKS_JS(cfg)}</body></html>`);
}

const THANKS_HTML = `<main class="card" id="thanks" hidden><div class="mark">✦</div><h1>Thank you!</h1><p id="planline"></p>
<p>This is your licence key. Keep it safe. You can find it again in WebDrop → Settings.</p><input id="key" readonly><button class="btn ghost" id="copy">Copy key</button>
<p class="msg" id="cmsg"></p><a class="btn" id="back">Return to WebDrop</a></main>`;
const THANKS_JS = (cfg) => `<script>
(()=>{const C2=${JSON.stringify({ scheme: cfg.scheme, origin: cfg.origin })};const $=id=>document.getElementById(id);
async function copy(){const v=$('key').value;let ok=false;try{await navigator.clipboard.writeText(v);ok=true}catch(e){$('key').select();try{ok=document.execCommand('copy')}catch(x){}}$('cmsg').textContent=ok?'Licence key copied ✓':'Select the key and copy it.';$('cmsg').className='msg '+(ok?'good':'')}
window.showThanks=l=>{const c=$('card');if(c)c.hidden=true;$('thanks').hidden=false;$('key').value=l.key;$('planline').textContent=(l.plan==='life'?'Lifetime · never expires':'Active until '+new Date(l.exp).toLocaleDateString())+(l.lily?' · Secret Lily themes unlocked 🌸':'')+(l.money?' · Money themes unlocked 💸':'');copy();
 const qs='key='+encodeURIComponent(l.key)+'&plan='+l.plan+'&exp='+(l.exp||'')+'&lily='+(l.lily?1:0)+'&money='+(l.money?1:0);
 if(C2.origin&&window.opener){try{window.opener.postMessage({type:'wd-licence',licence:l},C2.origin)}catch(e){}$('back').textContent='Close';$('back').href='#';$('back').onclick=e=>{e.preventDefault();window.close()};return}
 $('back').href=C2.scheme+'://licence?'+qs};
$('copy').onclick=copy;$('key').onfocus=e=>e.target.select()})();
</script>`;

function donePage(env, url, lic, problem) {
  const scheme = allowedScheme(env, url.searchParams.get('scheme') || 'webdrop');
  const origin = allowedOrigin(env, url.searchParams.get('origin') || '');
  const l = lic ? licOut(lic) : null;
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you · WebDrop</title><style>${PAGE_CSS}</style></head>
<body>${l ? '' : `<main class="card" id="card"><div class="mark">✦</div><h1>Payment not finished</h1><p>${esc(problem || 'We couldn’t confirm this payment yet. If you were charged, your key will appear in WebDrop → Settings after you sign in, or contact support.')}</p></main>`}
${THANKS_HTML}${THANKS_JS({ scheme, origin })}${l ? `<script>showThanks(${JSON.stringify(l)})</script>` : ''}</body></html>`);
}

/* ------------------------------------------------------------------ router */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (path === '/' ) return json({ ok: true, service: 'webdrop', login: !!env.GOOGLE_CLIENT_ID, builds: !!env.GH_REPO, queue: !!env.QUEUE_KEY, payments: env.TEST_PAYMENTS === 'true' ? 'test' : env.STRIPE_SECRET_KEY ? (env.STRIPE_SECRET_KEY.startsWith('sk_live') ? 'live' : 'stripe-test') : false, webhook: !!env.STRIPE_WEBHOOK_SECRET });
      if (path === '/auth/start' && req.method === 'GET') return loginPage(env, url);
      if (path === '/pay' && req.method === 'GET') return payPage(env, url);
      if (path === '/checkout/done' && req.method === 'GET') {
        const sid = url.searchParams.get('sid') || '';
        if (!/^cs_[A-Za-z0-9_]+$/.test(sid) || !env.STRIPE_SECRET_KEY) return donePage(env, url, null);
        const r = await stripe(env, '/v1/checkout/sessions/' + sid);
        const s = await r.json().catch(() => null);
        if (!r.ok || !s) return donePage(env, url, null);
        if (s.payment_status !== 'paid') return donePage(env, url, null, 'This payment hasn’t gone through. You weren’t charged.');
        return donePage(env, url, await fulfil(env, s));
      }
      if (path === '/stripe/webhook' && req.method === 'POST') {
        const raw = await req.text();
        if (!env.STRIPE_WEBHOOK_SECRET || !(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, raw, req.headers.get('stripe-signature'))))
          return err(400, 'signature', 'Bad signature.');
        const ev = JSON.parse(raw);
        if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') await fulfil(env, ev.data.object);
        return json({ received: true });
      }
      if (!env.SESSION_SECRET) return err(503, 'setup', 'The server is missing SESSION_SECRET.');

      if (path === '/api/auth/google' && req.method === 'POST') {
        if (!env.GOOGLE_CLIENT_ID) return err(503, 'login_off', 'Google sign-in isn’t set up yet.');
        const b = await body(req);
        let c;
        try {
          c = await verifyGoogle(env, b && b.credential);
        } catch {
          return err(401, 'bad_credential', 'Google sign-in couldn’t be verified. Try again.');
        }
        await env.DB.prepare(
          `INSERT INTO users (id, email, name, picture, qb, pic, created) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`
        ).bind(c.sub, c.email || null, c.name || null, c.picture || null, NEW_USER_TOKENS.qb, NEW_USER_TOKENS.pic, now()).run();
        const user = await getUser(env, c.sub);
        return json({ session: await makeSession(env, c.sub), ...(await meOut(env, user)) });
      }

      if (path === '/api/quote' && req.method === 'GET') {
        const q = quote(url.searchParams.get('plan'), url.searchParams.get('promo'));
        if (q.error) return err(400, q.error, q.message || (q.error === 'promo' ? 'That promo code isn’t valid.' : 'Pick a plan.'));
        if (q.promo && PROMOS[q.promo].limit) {
          const u = await env.DB.prepare('SELECT uses FROM promo_uses WHERE code = ?').bind(q.promo).first();
          const left = PROMOS[q.promo].limit - (u ? u.uses : 0);
          if (left <= 0) return err(409, 'limit', `Sorry, ${q.promo} has been fully redeemed.`);
          q.left = left;
        }
        return json(q);
      }
      if (path === '/api/checkout' && req.method === 'POST') {
        const b = await body(req);
        if (!b) return err(400, 'body', 'Bad request.');
        return createCheckout(env, req, b);
      }
      if (path === '/api/licence/issue' && req.method === 'POST') {
        const b = await body(req);
        if (!b) return err(400, 'body', 'Bad request.');
        return issueLicence(env, req, b);
      }
      if (path === '/api/queue' && req.method === 'GET') {
        // Called by the "Quick Build queue" GitHub job. Hands out waiting builds once each.
        const k = req.headers.get('x-queue-key') || '';
        if (!env.QUEUE_KEY || !safeEqual(k, env.QUEUE_KEY)) return err(401, 'queue_key', 'Bad queue key.');
        const rows = (await env.DB.prepare("SELECT id, inputs FROM builds WHERE dispatched = 0 AND status = 'queued' AND inputs IS NOT NULL ORDER BY created LIMIT 10").bind().all()).results || [];
        const out = [];
        for (const r of rows) {
          const c = await env.DB.prepare("UPDATE builds SET dispatched = 1, dispatched_at = ?, msg = 'Waiting for a build machine…' WHERE id = ? AND dispatched = 0").bind(now(), r.id).run();
          if (c.meta && c.meta.changes === 1) out.push({ id: r.id, inputs: JSON.parse(r.inputs) });
        }
        return json({ builds: out });
      }
      if (path === '/api/licence/verify' && req.method === 'POST') {
        const b = await body(req);
        const l = await licenceByKey(env, b && b.key);
        if (!l) return json({ valid: false, reason: 'unknown' });
        return json({ valid: licLive(l), reason: l.revoked ? 'revoked' : licLive(l) ? '' : 'expired', ...licOut(l) });
      }

      const uid = await readSession(env, req);
      if (path.startsWith('/api/') && !uid) return err(401, 'login', 'Please sign in again.');
      const user = uid ? await getUser(env, uid) : null;
      if (path.startsWith('/api/') && !user) return err(401, 'login', 'Please sign in again.');

      if (path === '/api/me' && req.method === 'GET') {
        if (!user.anon_no) await anonNo(env, user);
        return json(await meOut(env, await getUser(env, user.id)));
      }
      if (path === '/api/settings' && req.method === 'POST') {
        const b = await body(req);
        if (!b || typeof b.show_name !== 'boolean') return err(400, 'body', 'Bad request.');
        await env.DB.prepare('UPDATE users SET show_name = ? WHERE id = ?').bind(b.show_name ? 1 : 0, user.id).run();
        await anonNo(env, user);
        return json(await meOut(env, await getUser(env, user.id)));
      }
      if (path === '/api/workshop' && req.method === 'GET') return workshopList(env, user);
      if (path === '/api/workshop' && req.method === 'POST') {
        const b = await body(req);
        if (!b) return err(400, 'body', 'Bad request.');
        return workshopShare(env, user, b);
      }
      if (path === '/api/workshop/remove' && req.method === 'POST') {
        const b = await body(req);
        const r = await env.DB.prepare('DELETE FROM workshop WHERE id = ? AND user_id = ?').bind(String((b && b.id) || ''), user.id).run();
        return r.meta && r.meta.changes ? json({ ok: true }) : err(404, 'not_found', 'Not found.');
      }
      if (path === '/api/workshop/report' && req.method === 'POST') {
        const b = await body(req);
        const id = String((b && b.id) || '');
        try {
          await env.DB.prepare('INSERT INTO workshop_reports (item_id, user_id, created) VALUES (?, ?, ?)').bind(id, user.id, now()).run();
          await env.DB.prepare('UPDATE workshop SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= 3 THEN 1 ELSE hidden END WHERE id = ?').bind(id).run();
        } catch {}
        return json({ ok: true });
      }
      if (path === '/api/username' && req.method === 'POST') {
        const b = await body(req);
        const name = String((b && b.username) || '').trim();
        if (!/^[A-Za-z0-9_.]{3,20}$/.test(name)) return err(400, 'username', 'Use 3–20 letters, numbers, dots or underscores.');
        try {
          await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(name, user.id).run();
        } catch {
          return err(409, 'taken', 'That username is taken.');
        }
        return json(await meOut(env, await getUser(env, user.id)));
      }
      if (path === '/api/licence/claim' && req.method === 'POST') {
        const b = await body(req);
        const l = await licenceByKey(env, b && b.key);
        if (!l) return err(404, 'unknown', 'That key isn’t valid.');
        if (l.user_id && l.user_id !== user.id) return err(409, 'other', 'That key belongs to another account.');
        if (!l.user_id) await env.DB.prepare('UPDATE licences SET user_id = ? WHERE key = ?').bind(user.id, l.key).run();
        return json({ valid: licLive(l), ...licOut(l), ...(await meOut(env, user)) });
      }
      if (path === '/api/build' && req.method === 'POST') {
        const b = await body(req);
        if (!b) return err(400, 'body', 'Bad request.');
        return startQuickBuild(env, user, b);
      }
      const m = path.match(/^\/api\/build\/([a-z0-9]{6,40})$/);
      if (m && req.method === 'GET') return pollQuickBuild(env, user, m[1]);
      return err(404, 'not_found', 'Not found.');
    } catch (e) {
      return err(500, 'server', 'Something went wrong on the server.');
    }
  },
};
