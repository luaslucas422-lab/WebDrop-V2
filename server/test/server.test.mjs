// Local test for the WebDrop server: real SQLite (node:sqlite) as D1, fake Google / Stripe / GitHub.
// Run:  node server/test/server.test.mjs
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra); } };

/* ---------- D1 shim ---------- */
const sql = new DatabaseSync(':memory:');
sql.exec(fs.readFileSync(path.join(here, '..', 'schema.sql'), 'utf8'));
const DB = {
  prepare(q) {
    let args = [];
    const st = {
      bind(...a) { args = a.map((x) => (x === undefined ? null : x)); return st; },
      async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
      async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
      async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return st;
  },
};

/* ---------- fake Google / Stripe / GitHub ---------- */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (b) => Buffer.from(b).toString('base64url');
function idToken(claims, key = privateKey, kid = 'k1') {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const p = b64u(JSON.stringify(claims));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), key);
  return h + '.' + p + '.' + b64u(sig);
}
const state = { dispatched: [], runs: [], releases: {}, charges: [], sessions: {} };
const mock = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/certs') return send(200, { keys: [jwk] });
    if (u.pathname.startsWith('/v1/') && req.headers.authorization !== 'Bearer sk_test_x') return send(401, { error: { message: 'bad key' } });
    if (u.pathname === '/v1/prices') {
      const plan = (u.searchParams.get('lookup_keys[]') || '').replace('webdrop_', '');
      const cents = { week: 100, month: 450, year: 1550, life: 2500 }[plan];
      return send(200, { data: cents ? [{ id: 'price_' + plan, unit_amount: cents, currency: 'eur' }] : [] });
    }
    if (u.pathname === '/v1/checkout/sessions' && req.method === 'POST') {
      const f = Object.fromEntries(new URLSearchParams(data));
      const id = 'cs_test_' + (state.charges.length + 1);
      const amount = { price_week: 100, price_month: 450, price_year: 1550, price_life: 2500 }[f['line_items[0][price]']] || Number(f['line_items[0][price_data][unit_amount]']);
      const total = f['discounts[0][coupon]'] === 'LILYDROP' ? Math.round(amount * 0.6) : amount;
      state.charges.push(f);
      state.sessions[id] = { id, payment_status: 'unpaid', status: 'open', amount_total: total, metadata: { plan: f['metadata[plan]'], promo: f['metadata[promo]'], user: f['metadata[user]'] } };
      return send(200, { id, url: 'https://checkout.stripe.com/c/pay/' + id });
    }
    const cs = u.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[\w]+)$/);
    if (cs) return state.sessions[cs[1]] ? send(200, state.sessions[cs[1]]) : send(404, { error: { message: 'No such session' } });
    if (u.pathname.endsWith('/dispatches')) {
      if (req.headers['user-agent'] !== 'webdrop-server' || req.headers.authorization !== 'Bearer ghp_server') return send(401, {});
      state.dispatched.push(JSON.parse(data));
      return send(204);
    }
    if (u.pathname.endsWith('/runs')) return send(200, { workflow_runs: state.runs });
    const m = u.pathname.match(/\/releases\/tags\/build-(.+)$/);
    if (m) return state.releases[m[1]] ? send(200, state.releases[m[1]]) : send(404, {});
    send(404, {});
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

const env = {
  DB, SESSION_SECRET: 'test-secret-123', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_CERTS_URL: base + '/certs', STRIPE_API: base, GITHUB_API: base,
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  GH_TOKEN: 'ghp_server', GH_REPO: 'owner/builds', QUEUE_KEY: 'qk_test', APP_SCHEMES: 'webdrop', WEB_ORIGINS: 'http://localhost:8080',
};
async function call(method, p, { body, session, envOver } = {}) {
  const req = new Request('https://srv.test' + p, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { authorization: 'Bearer ' + session } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const r = await worker.fetch(req, { ...env, ...(envOver || {}) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t, headers: r.headers };
}
const claims = (sub, extra = {}) => ({ iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, sub, email: sub + '@gmail.com', name: 'User ' + sub, exp: Math.floor(Date.now() / 1000) + 600, ...extra });

console.log('Login');
let r = await call('POST', '/api/auth/google', { body: { credential: idToken(claims('alice')) } });
ok(r.status === 200 && r.j.session, 'valid Google token signs in');
const sA = r.j.session;
ok(r.j.user.qb === 3 && r.j.user.pic === 3, 'new user gets 3 Quick Build + 3 Custom Picture tokens');
r = await call('POST', '/api/auth/google', { body: { credential: idToken(claims('eve', { aud: 'someone-else' })) } });
ok(r.status === 401, 'token for another app is rejected');
const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
r = await call('POST', '/api/auth/google', { body: { credential: idToken(claims('eve'), otherKey) } });
ok(r.status === 401, 'forged signature is rejected');
r = await call('POST', '/api/auth/google', { body: { credential: idToken(claims('eve', { exp: 1000 })) } });
ok(r.status === 401, 'expired token is rejected');
r = await call('GET', '/api/me', { session: sA.slice(0, -2) + 'xx' });
ok(r.status === 401, 'tampered session is rejected');
r = await call('GET', '/api/me', { session: sA });
ok(r.status === 200 && r.j.user.email === 'alice@gmail.com' && r.j.ultra === null, '/api/me works');
await call('POST', '/api/auth/google', { body: { credential: idToken(claims('alice')) } });
r = await call('GET', '/api/me', { session: sA });
ok(r.j.user.qb === 3, 'signing in again does not reset tokens');

console.log('Usernames');
r = await call('POST', '/api/username', { session: sA, body: { username: 'lily_drop' } });
ok(r.status === 200 && r.j.user.username === 'lily_drop', 'set username');
const sB = (await call('POST', '/api/auth/google', { body: { credential: idToken(claims('bob')) } })).j.session;
r = await call('POST', '/api/username', { session: sB, body: { username: 'LILY_DROP' } });
ok(r.status === 409, 'username is unique (case-insensitive)');
r = await call('POST', '/api/username', { session: sB, body: { username: 'a b' } });
ok(r.status === 400, 'invalid username rejected');

console.log('Pricing & payments');
r = await call('GET', '/api/quote?plan=year&promo=lilydrop');
ok(r.j.total === 930 && r.j.pct === 40 && r.j.lily, 'LILYDROP: €15.50 → €9.30 + lily');
r = await call('GET', '/api/quote?plan=week');
ok(r.j.total === 100, 'week €1');
r = await call('GET', '/api/quote?plan=month');
ok(r.j.total === 450, 'month €4.50');
r = await call('GET', '/api/quote?plan=life');
ok(r.j.total === 2500, 'lifetime €25');
r = await call('GET', '/api/quote?plan=life&promo=NOPE');
ok(r.status === 400, 'unknown promo rejected');
r = await call('POST', '/api/checkout', { session: sA, body: { plan: 'year', promo: 'LILYDROP', scheme: 'webdrop' } });
ok(r.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(r.j.url), 'checkout session created');
let f = state.charges.at(-1);
ok(f['line_items[0][price]'] === 'price_year' && f['discounts[0][coupon]'] === 'LILYDROP' && f.mode === 'payment', 'uses the Stripe price + LILYDROP coupon');
ok(f.success_url.startsWith('https://srv.test/checkout/done?sid={CHECKOUT_SESSION_ID}') && f['metadata[user]'] === 'alice', 'return URL and account are attached');
ok(!f.locale && !f.success_url.includes('lang='), 'English checkout has no locale');
const sid = r.j.id;
r = await call('GET', '/checkout/done?sid=' + sid);
ok(r.status === 200 && r.t.includes('Payment not finished') && !r.t.includes('showThanks({'), 'unpaid session gives no licence');
state.sessions[sid].payment_status = 'paid'; state.sessions[sid].status = 'complete';
r = await call('GET', '/checkout/done?sid=' + sid + '&scheme=webdrop');
const m1 = r.t.match(/showThanks\((\{.*?\})\)/);
const lic1 = m1 && JSON.parse(m1[1]);
ok(lic1 && /^WD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(lic1.key) && lic1.plan === 'year' && lic1.lily, 'paid session → thank-you page with licence key');
r = await call('GET', '/checkout/done?sid=' + sid);
ok(r.t.includes(lic1.key), 'reloading the page shows the same key (no duplicates)');
const keyA = lic1.key;
r = await call('GET', '/api/me', { session: sA });
ok(r.j.ultra && r.j.ultra.key === keyA, 'licence attached to the signed-in account');
// webhook
const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: state.sessions[sid] } });
const t = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac('sha256', 'whsec_test').update(t + '.' + ev).digest('hex');
let wr = await worker.fetch(new Request('https://srv.test/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: ev }), env);
ok(wr.status === 200, 'webhook with valid signature accepted');
ok(sql.prepare('SELECT COUNT(*) AS n FROM licences WHERE payment = ?').get(sid).n === 1, 'webhook + return page still make only one licence');
wr = await worker.fetch(new Request('https://srv.test/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=deadbeef` }, body: ev }), env);
ok(wr.status === 400, 'forged webhook rejected');
r = await call('POST', '/api/checkout', { body: { plan: 'week', lang: 'fr' } });
ok(state.charges.at(-1).locale === 'fr' && state.charges.at(-1).success_url.includes('&lang=fr') && state.charges.at(-1).cancel_url.includes('&lang=fr'), 'French checkout: Stripe locale + return pages in French');
const sid2 = r.j.id; state.sessions[sid2].payment_status = 'paid';
const evG = JSON.stringify({ type: 'checkout.session.completed', data: { object: state.sessions[sid2] } });
const sigG = crypto.createHmac('sha256', 'whsec_test').update(t + '.' + evG).digest('hex');
await worker.fetch(new Request('https://srv.test/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sigG}` }, body: evG }), env);
const guestKey = sql.prepare('SELECT key FROM licences WHERE payment = ?').get(sid2).key;
ok(!!guestKey, 'guest purchase fulfilled by webhook even if the page is closed');
r = await call('POST', '/api/licence/verify', { body: { key: keyA.toLowerCase().replace(/-/g, ' ') } });
ok(r.j.valid && r.j.plan === 'year', 'verify works with messy input');
r = await call('POST', '/api/licence/verify', { body: { key: 'WD-AAAA-BBBB-CCCC' } });
ok(r.j.valid === false, 'unknown key is invalid');
r = await call('POST', '/api/licence/claim', { session: sB, body: { key: guestKey } });
ok(r.status === 200 && r.j.ultra && r.j.ultra.key === guestKey, 'key can be attached to an account later');
r = await call('POST', '/api/licence/claim', { session: sA, body: { key: guestKey } });
ok(r.status === 409, "someone else's key can't be claimed");
r = await call('POST', '/api/licence/issue', { body: { plan: 'month' } });
ok(r.status === 402, 'paid plans cannot skip checkout');
r = await call('POST', '/api/checkout', { body: { plan: 'month' }, envOver: { STRIPE_SECRET_KEY: '' } });
ok(r.status === 503, 'no Stripe key → clear "not set up" error');
r = await call('POST', '/api/checkout', { body: { plan: 'life', promo: 'SUPADROP' } });
ok(r.j.free === true, '100% codes skip Stripe');

r = await call('GET', '/api/quote?plan=life&promo=giveme70%25off');
ok(r.status === 200 && r.j.total === 750 && r.j.money && r.j.promo_label === 'GIVEME70%OFF', 'GIVEME70%OFF: lifetime €25 → €7.50 + money themes');
r = await call('GET', '/api/quote?plan=year&promo=GIVEME70%25OFF');
ok(r.status === 400 && /Lifetime/.test(r.j.message), 'GIVEME70%OFF refused on other plans');
r = await call('POST', '/api/checkout', { body: { plan: 'life', promo: 'GIVEME70%OFF' } });
f = state.charges.at(-1);
ok(f['discounts[0][coupon]'] === 'GIVEME70OFF' && f['line_items[0][price]'] === 'price_life', 'checkout uses the GIVEME70OFF coupon on the lifetime price');
const sid3 = r.j.id; state.sessions[sid3].payment_status = 'paid';
r = await call('GET', '/checkout/done?sid=' + sid3);
const m3 = r.t.match(/showThanks\((\{.*?\})\)/); const l3 = m3 && JSON.parse(m3[1]);
ok(l3 && l3.money && l3.plan === 'life', 'GIVEME70%OFF licence unlocks money themes');

console.log('SUPADROP (100% off, 10 uses, once per account)');
r = await call('POST', '/api/licence/issue', { body: { plan: 'life', promo: 'SUPADROP' } });
ok(r.status === 401, 'needs sign-in');
const chargesBefore = state.charges.length;
let issued = 0, lastStatus = 0, already = 0;
for (let i = 0; i < 13; i++) {
  const s = (await call('POST', '/api/auth/google', { body: { credential: idToken(claims('promo' + i)) } })).j.session;
  const x = await call('POST', '/api/licence/issue', { session: s, body: { plan: 'life', promo: 'SUPADROP' } });
  if (x.status === 200) issued++; else lastStatus = x.status;
  if (i === 0) { const y = await call('POST', '/api/licence/issue', { session: s, body: { plan: 'life', promo: 'SUPADROP' } }); if (y.status === 409 && y.j.error === 'used') already++; }
}
ok(issued === 10 && lastStatus === 409, 'exactly 10 free licences, then "fully redeemed"', `issued=${issued}`);
ok(already === 1, 'same account cannot redeem twice');
ok(state.charges.length === chargesBefore, 'nothing was charged for SUPADROP');
r = await call('GET', '/api/quote?plan=life&promo=SUPADROP');
ok(r.status === 409, 'quote shows SUPADROP is used up');

console.log('Quick Build');
const sC = (await call('POST', '/api/auth/google', { body: { credential: idToken(claims('carol')) } })).j.session;
const build = { url: 'https://example.com', name: 'MyShop', pkg: 'com.example.shop', orientation: 'landscape', desktop_mode: true, status_bar_color: '#112233' };
r = await call('POST', '/api/build', { body: build });
ok(r.status === 401, 'guests cannot Quick Build');
r = await call('POST', '/api/build', { session: sC, body: { ...build, name: 'ThisNameIsTooLong' } });
ok(r.status === 400, 'free name limit 10 enforced on the server');
r = await call('POST', '/api/build', { session: sC, body: build });
ok(r.status === 200 && r.j.id && r.j.user.qb === 3 && r.j.user.qb_reserved === 1, 'build starts; token reserved, not spent');
const id1 = r.j.id;
const d = state.dispatched[state.dispatched.length - 1];
ok(d.inputs.build_id === id1 && d.inputs.orientation === 'unspecified' && d.inputs.desktop_mode === 'false' && d.inputs.status_bar_color === '', 'ULTRA-only options stripped for free users');
r = await call('GET', '/api/build/' + id1, { session: sC });
ok(r.j.status === 'queued', 'poll: queued while run not visible');
state.runs = [{ name: 'WebDrop ' + id1, status: 'in_progress', html_url: 'https://github.com/owner/builds/actions/runs/1' }];
r = await call('GET', '/api/build/' + id1, { session: sC });
ok(r.j.status === 'building', 'poll: building');
state.runs = [{ name: 'WebDrop ' + id1, status: 'completed', conclusion: 'failure', html_url: 'x' }];
r = await call('GET', '/api/build/' + id1, { session: sC });
ok(r.j.status === 'failed' && r.j.user.qb === 3 && r.j.user.qb_reserved === 0, 'failed build costs no token');
r = await call('POST', '/api/build', { session: sC, body: { ...build, icon_b64: 'iVBORw0KGgo=', icon_custom: true } });
const id2 = r.j.id;
ok(r.status === 200, 'build with custom picture starts');
state.runs = [{ name: 'WebDrop ' + id2, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/builds/actions/runs/2' }];
state.releases[id2] = { assets: [{ name: 'MyShop.apk', browser_download_url: 'https://github.com/owner/builds/releases/download/build-' + id2 + '/MyShop.apk' }] };
r = await call('GET', '/api/build/' + id2, { session: sC });
ok(r.j.status === 'ready' && /MyShop\.apk$/.test(r.j.apk_url), 'successful build returns the APK link');
ok(r.j.user.qb === 2 && r.j.user.pic === 2, 'success spends 1 Quick Build + 1 Custom Picture token');
r = await call('GET', '/api/build/' + id2, { session: sC });
ok(r.j.user.qb === 2 && r.j.user.pic === 2, 'polling again does not charge twice');
r = await call('GET', '/api/build/' + id2, { session: sA });
ok(r.status === 404, "can't see someone else's build");
sql.prepare('UPDATE users SET qb = 0 WHERE id = ?').run('carol');
r = await call('POST', '/api/build', { session: sC, body: build });
ok(r.status === 402 && r.j.error === 'no_qb', 'no tokens left → clear message');
r = await call('POST', '/api/build', { session: sA, body: { ...build, name: 'A much longer ULTRA app name' } });
ok(r.status === 200, 'ULTRA: long names allowed');
const dA = state.dispatched[state.dispatched.length - 1];
ok(dA.inputs.orientation === 'landscape' && dA.inputs.desktop_mode === 'true' && dA.inputs.status_bar_color === '#112233', 'ULTRA options passed through');
const idA = r.j.id;
state.runs = [{ name: 'WebDrop ' + idA, status: 'completed', conclusion: 'success', html_url: 'x' }];
state.releases[idA] = { assets: [{ name: 'A.apk', browser_download_url: 'https://github.com/owner/builds/releases/download/build-' + idA + '/A.apk' }] };
r = await call('GET', '/api/build/' + idA, { session: sA });
ok(r.j.status === 'ready' && r.j.user.qb === 3, 'ULTRA builds are unlimited (no token spent)');
r = await call('POST', '/api/build', { session: sB, body: { ...build, lock_salt: 'zz', lock_hash: 'nothex' } });
ok(r.status === 400, 'malformed password hash rejected');

console.log('Build queue (no working BUILD_TOKEN)');
sql.prepare('UPDATE users SET qb = 3 WHERE id = ?').run('carol');
r = await call('POST', '/api/build', { session: sC, body: build, envOver: { GH_TOKEN: '' } });
ok(r.status === 200 && /queue/.test(r.j.msg), 'build is queued when the server cannot start it');
const qid = r.j.id;
r = await call('GET', '/api/build/' + qid, { session: sC, envOver: { GH_TOKEN: '' } });
ok(r.j.status === 'queued', 'queued build waits (no "never started" error)');
r = await call('GET', '/api/queue');
ok(r.status === 401, 'queue needs the key');
let qr = await worker.fetch(new Request('https://srv.test/api/queue', { headers: { 'x-queue-key': 'qk_test' } }), env);
let qj = await qr.json();
ok(qj.builds.length === 1 && qj.builds[0].id === qid && qj.builds[0].inputs.app_url === 'https://example.com', 'queue job receives the build with its inputs');
qr = await worker.fetch(new Request('https://srv.test/api/queue', { headers: { 'x-queue-key': 'qk_test' } }), env);
qj = await qr.json();
ok(qj.builds.length === 0, 'each build is handed out only once');
state.runs = [{ name: 'WebDrop ' + qid, status: 'completed', conclusion: 'success', html_url: 'x' }];
state.releases[qid] = { assets: [{ name: 'Q.apk', browser_download_url: 'https://github.com/owner/builds/releases/download/build-' + qid + '/Q.apk' }] };
r = await call('GET', '/api/build/' + qid, { session: sC });
ok(r.j.status === 'ready', 'queued build completes normally');

console.log('Workshop');
const apk1 = 'https://github.com/owner/builds/releases/download/build-x1/Shop.apk';
r = await call('GET', '/api/workshop');
ok(r.status === 401, 'Workshop needs sign-in');
r = await call('POST', '/api/workshop', { session: sA, body: { name: 'Shop', url: 'https://example.com', apk_url: apk1, icon: 'https://www.google.com/s2/favicons?domain=example.com&sz=128' } });
ok(r.status === 200 && r.j.id, 'share an app');
r = await call('POST', '/api/workshop', { session: sA, body: { name: 'Shop', url: 'https://example.com', apk_url: apk1 } });
ok(r.status === 409, 'same app cannot be shared twice');
r = await call('POST', '/api/workshop', { session: sA, body: { name: 'Bad', url: 'https://example.com', apk_url: 'https://evil.example/x.apk' } });
ok(r.status === 400, 'only WebDrop-built APK links accepted');
r = await call('POST', '/api/workshop', { session: sB, body: { name: 'Bob App', url: 'https://bob.example', apk_url: 'https://github.com/owner/builds/releases/download/build-x2/Bob.apk', icon: 'https://tracker.example/pixel.png' } });
ok(r.status === 200, 'second user shares');
r = await call('GET', '/api/workshop', { session: sC });
const items = r.j.items;
const shop = items.find((x) => x.name === 'Shop'), bob = items.find((x) => x.name === 'Bob App');
ok(shop.author === '@lily_drop' && !shop.mine, 'author shows username');
ok(bob.icon === '', 'untrusted icon URLs are dropped');
r = await call('POST', '/api/settings', { session: sA, body: { show_name: false } });
ok(r.j.user.show_name === false && /^Anonymous #\d{4}$/.test(r.j.user.anon_name), 'can switch to anonymous');
r = await call('GET', '/api/workshop', { session: sC });
ok(/^Anonymous #\d{4}$/.test(r.j.items.find((x) => x.name === 'Shop').author), 'anonymous shown as random number');
r = await call('GET', '/api/workshop', { session: sA });
ok(r.j.items.find((x) => x.name === 'Shop').mine, 'own app marked as mine');
r = await call('POST', '/api/workshop/remove', { session: sB, body: { id: shop.id } });
ok(r.status === 404, "can't remove someone else's app");
for (const s of [sB, sC, sA]) await call('POST', '/api/workshop/report', { session: s, body: { id: bob.id } });
r = await call('GET', '/api/workshop', { session: sC });
ok(!r.j.items.find((x) => x.name === 'Bob App'), 'hidden after 3 reports');
r = await call('POST', '/api/workshop/remove', { session: sA, body: { id: shop.id } });
ok(r.status === 200, 'remove own app');

console.log('Pages');
r = await call('GET', '/auth/start?scheme=evil');
ok(r.status === 200 && r.t.includes('"webdrop"') && !r.t.includes('"evil"'), 'login page ignores unknown app schemes');
r = await call('GET', '/pay?plan=year&promo=LILYDROP&origin=https://evil.example');
ok(r.status === 200 && r.t.includes('"origin":""'), 'pay page ignores unknown web origins');
r = await call('GET', '/auth/start?origin=http://localhost:8080');
ok(r.t.includes('"http://localhost:8080"'), 'allowed web origin kept');
r = await call('OPTIONS', '/api/me');
ok(r.status === 204 && r.headers.get('access-control-allow-headers').includes('authorization'), 'CORS preflight');
r = await call('GET', '/auth/start?lang=es');
ok(r.t.includes('lang="es"') && r.t.includes('Inicia sesión en WebDrop') && r.t.includes('locale:WL'), 'login page in Spanish');
r = await call('GET', '/pay?plan=month&lang=de');
ok(r.t.includes('lang="de"') && r.t.includes('Preis wird geladen') && r.t.includes('"lang":"de"'), 'pay page in German');
r = await call('GET', '/pay?plan=month&lang=xx<script>');
ok(r.t.includes('lang="en"') && !r.t.includes('xx<script>'), 'unknown language falls back to English');
r = await call('GET', '/checkout/done?sid=bad&lang=it');
ok(r.t.includes('Pagamento non completato'), 'done page in Italian');

mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
