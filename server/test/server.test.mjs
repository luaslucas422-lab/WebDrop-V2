// Local test for the WebDrop server: real SQLite (node:sqlite) as D1, fake Google / Stripe / GitHub.
// Run:  node server/test/server.test.mjs
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { totpAt, questsFor } from '../src/index.js';

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
  RUNS_CACHE_MS: "0",
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
r = await call('POST', '/api/build', { session: sC, body: { ...build, icon_b64: 'iVBORw0KGgo=', icon_custom: true, extras: 'splash,aab,exe,dark' } });
const id2 = r.j.id;
ok(r.status === 200, 'build with custom picture starts');
ok(state.dispatched.at(-1).inputs.extras === 'splash', 'free accounts can’t get the .aab (or other ULTRA extras)');
state.runs = [{ name: 'WebDrop ' + id2, status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/builds/actions/runs/2' }];
state.releases[id2] = { assets: [{ name: 'MyShop.apk', browser_download_url: 'https://github.com/owner/builds/releases/download/build-' + id2 + '/MyShop.apk' }] };
r = await call('GET', '/api/build/' + id2, { session: sC });
ok(r.j.status === 'ready' && /MyShop\.apk$/.test(r.j.apk_url), 'successful build returns the APK link');
ok(r.j.user.qb === 2 && r.j.user.pic === 2, 'success spends 1 Quick Build + 1 Custom Picture token');
r = await call('GET', '/api/build/' + id2, { session: sC });
ok(r.j.user.qb === 2 && r.j.user.pic === 2, 'polling again does not charge twice');
sql.prepare('UPDATE users SET qb = qb + 5 WHERE id = ?').run('carol');
const before = sql.prepare("SELECT COUNT(*) AS n FROM builds").get().n;
r = await call('POST', '/api/build', { session: sC, body: { ...build, html_kind: 'html', html: '<h1>x</h1>', watermark: '' } });
ok(r.status === 200 && state.dispatched.at(-1).inputs.watermark === 'Made with WebDrop' && state.dispatched.at(-1).inputs.site === 'html', 'free HTML apps always get the WebDrop watermark');
r = await call('POST', '/api/build', { session: sC, body: { ...build, html_kind: 'html', html: 'x'.repeat(1_500_000) } });
ok(r.status === 413, 'too-big HTML rejected');
r = await call('POST', '/api/build', { session: sC, body: build });
ok(state.dispatched.at(-1).inputs.watermark === '' && state.dispatched.at(-1).inputs.site === '', 'website apps have no watermark');
sql.prepare("UPDATE builds SET status = 'failed' WHERE rowid > (SELECT MAX(rowid) FROM builds) - ?").run(sql.prepare("SELECT COUNT(*) AS n FROM builds").get().n - before);
sql.prepare('UPDATE users SET qb = qb - 5 WHERE id = ?').run('carol');
r = await call('GET', '/api/build/' + id2, { session: sA });
ok(r.status === 404, "can't see someone else's build");
sql.prepare('UPDATE users SET qb = 0 WHERE id = ?').run('carol');
r = await call('POST', '/api/build', { session: sC, body: build });
ok(r.status === 402 && r.j.error === 'no_qb', 'no tokens left → clear message');
r = await call('POST', '/api/build', { session: sA, body: { ...build, name: 'A much longer ULTRA app name', extras: 'splash,aab,exe,evil' } });
ok(r.status === 200, 'ULTRA: long names allowed');
ok(state.dispatched.at(-1).inputs.extras === 'splash,aab,exe', 'ULTRA can ask for a Play Store .aab and a Windows .exe (unknown extras dropped)');
const dA = state.dispatched[state.dispatched.length - 1];
ok(dA.inputs.orientation === 'landscape' && dA.inputs.desktop_mode === 'true' && dA.inputs.status_bar_color === '#112233', 'ULTRA options passed through');
const idA = r.j.id;
state.runs = [{ name: 'WebDrop ' + idA, status: 'completed', conclusion: 'success', html_url: 'x' }];
state.releases[idA] = { assets: [{ name: 'A.apk', browser_download_url: 'https://github.com/owner/builds/releases/download/build-' + idA + '/A.apk' }] };
r = await call('GET', '/api/build/' + idA, { session: sA });
ok(r.j.status === 'ready' && r.j.user.qb === 3, 'ULTRA builds are unlimited (no token spent)');
// HTML apps
const htmlPage = '<!doctype html><title>Hi</title><h1>Hello offline</h1>';
r = await call('POST', '/api/build', { session: sA, body: { ...build, html_kind: 'html', html: htmlPage, watermark: '' } });
ok(r.status === 200, 'ULTRA HTML app starts');
let dH = state.dispatched.at(-1).inputs;
ok(dH.site === 'html' && dH.app_url === 'https://webdrop.local/index.html' && dH.watermark === '', 'ULTRA can switch the watermark off');
const idH = r.j.id;
let hr = await worker.fetch(new Request('https://srv.test/api/html/' + idH, { headers: { 'x-queue-key': 'qk_test' } }), env);
let hj = await hr.json();
ok(hr.status === 200 && hj.kind === 'html' && hj.data === htmlPage, 'build machine fetches the HTML');
hr = await worker.fetch(new Request('https://srv.test/api/html/' + idH, { headers: { 'x-queue-key': 'nope' } }), env);
ok(hr.status === 401, 'HTML needs the build key');
r = await call('POST', '/api/build', { session: sA, body: { ...build, html_kind: 'zip', html: 'UEsDBA==', watermark: '  My   Cool\u0007 Studio  ' } });
ok(state.dispatched.at(-1).inputs.watermark === 'My Cool Studio', 'ULTRA custom watermark (cleaned)');
r = await call('POST', '/api/build', { session: sA, body: { ...build, html_kind: 'zip', html: 'not base64!' } });
ok(r.status === 413 || r.status === 400, 'bad zip data rejected');
r = await call('POST', '/api/build', { session: sA, body: { ...build, html_kind: 'html', html: '   ' } });
ok(r.status === 400, 'empty HTML rejected');
state.runs = [{ name: 'WebDrop ' + idH, status: 'completed', conclusion: 'success', html_url: 'x' }];
state.releases[idH] = { assets: [{ name: 'H.apk', browser_download_url: 'https://x/H.apk' }] };
r = await call('GET', '/api/build/' + idH, { session: sA });
hr = await worker.fetch(new Request('https://srv.test/api/html/' + idH, { headers: { 'x-queue-key': 'qk_test' } }), env);
ok(r.j.status === 'ready' && hr.status === 404, 'stored HTML is deleted once the build is done');
// faster: the APK is picked up while GitHub is still tidying up the run
r = await call('POST', '/api/build', { session: sA, body: { ...build, extras: 'splash' } });
const idF = r.j.id;
state.runs = [{ name: 'WebDrop ' + idF, status: 'in_progress', run_started_at: new Date(Date.now() - 60e3).toISOString(), html_url: 'x' }];
r = await call('GET', '/api/build/' + idF, { session: sA });
ok(r.j.status === 'building', 'running build without a release yet is building');
state.releases[idF] = { assets: [{ name: 'F.apk', browser_download_url: 'https://x/F.apk' }] };
r = await call('GET', '/api/build/' + idF, { session: sA });
ok(r.j.status === 'ready' && r.j.apk_url === 'https://x/F.apk', 'APK found before the run is marked complete');
state.runs = [{ name: 'WebDrop ' + idF, status: 'in_progress', run_started_at: new Date(Date.now() - 5e3).toISOString(), html_url: 'x' }];
// with a Windows app, wait for the .exe too
r = await call('POST', '/api/build', { session: sA, body: { ...build, extras: 'splash,exe' } });
const idX = r.j.id;
state.runs = [{ name: 'WebDrop ' + idX, status: 'in_progress', run_started_at: new Date(Date.now() - 90e3).toISOString(), html_url: 'x' }];
state.releases[idX] = { assets: [{ name: 'X.apk', browser_download_url: 'https://x/X.apk' }] };
r = await call('GET', '/api/build/' + idX, { session: sA });
ok(r.j.status === 'building' && /Windows/.test(r.j.msg), 'waits for the Windows app while it is being made');
state.releases[idX].assets.push({ name: 'X.exe', browser_download_url: 'https://x/X.exe' });
r = await call('GET', '/api/build/' + idX, { session: sA });
ok(r.j.status === 'ready' && r.j.msg === 'Ready to install', 'ready once the .exe is attached');
r = await call('POST', '/api/build', { session: sA, body: { ...build, extras: 'exe' } });
const idY = r.j.id;
state.runs = [{ name: 'WebDrop ' + idY, status: 'completed', conclusion: 'success', html_url: 'x' }];
state.releases[idY] = { assets: [{ name: 'Y.apk', browser_download_url: 'https://x/Y.apk' }] };
r = await call('GET', '/api/build/' + idY, { session: sA });
ok(r.j.status === 'ready' && /Windows app didn/.test(r.j.msg), 'APK still delivered if the Windows app fails');
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

console.log('ULTRA belongs to an account');
{
  sql.prepare("INSERT INTO licences (key, user_id, plan, exp, created) VALUES ('WD-GUES-TKEY-0001', NULL, 'life', NULL, ?)").run(Date.now());
  const sX = (await call('POST', '/api/auth/google', { body: { credential: idToken(claims('xan')) } })).j.session;
  const sY = (await call('POST', '/api/auth/google', { body: { credential: idToken(claims('yui')) } })).j.session;
  r = await call('GET', '/api/me', { session: sY });
  ok(r.j.ultra === null, 'a brand-new account has no ULTRA');
  const longName = { ...build, name: 'A much longer ULTRA app name' };
  r = await call('POST', '/api/build', { session: sX, body: { ...longName, licence_key: 'WD-GUES-TKEY-0001' } });
  ok(r.status === 200 && sql.prepare("SELECT user_id FROM licences WHERE key = 'WD-GUES-TKEY-0001'").get().user_id === 'xan', 'an unclaimed key used for a build now belongs to that account');
  r = await call('POST', '/api/build', { session: sY, body: { ...longName, licence_key: 'WD-GUES-TKEY-0001' } });
  ok(r.status === 400 && r.j.error === 'name', 'another account can’t use that key for ULTRA builds');
  r = await call('POST', '/api/licence/claim', { session: sY, body: { key: 'WD-GUES-TKEY-0001' } });
  ok(r.status === 409, 'or claim it');
  r = await call('GET', '/api/me', { session: sY });
  ok(r.j.ultra === null, 'that account still has no ULTRA');
}

console.log('Workshop');
const apk1 = 'https://github.com/owner/builds/releases/download/build-x1/Shop.apk';
r = await call('GET', '/api/workshop');
ok(r.status === 401, 'Workshop needs sign-in');
r = await call('POST', '/api/workshop', { session: sA, body: { name: 'Shop', url: 'https://example.com', apk_url: apk1, icon: 'https://www.google.com/s2/favicons?domain=example.com&sz=128', note: '  My  shop\n\tapp <b>!</b> ' + 'x'.repeat(300) } });
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
ok(shop.note.startsWith('My shop app <b>!</b> xxx') && shop.note.length === 200 && bob.note === '', 'note kept as plain text, tidied, 200 max');
r = await call('POST', '/api/workshop/note', { session: sB, body: { id: shop.id, note: 'hacked' } });
ok(r.status === 404, "can't change someone else's note");
r = await call('POST', '/api/workshop/note', { session: sA, body: { id: shop.id, note: 'Fresh bread every day 🥖' } });
ok(r.status === 200 && r.j.note === 'Fresh bread every day 🥖', 'edit own note');
r = await call('GET', '/api/workshop', { session: sC });
ok(r.j.items.find((x) => x.name === 'Shop').note === 'Fresh bread every day 🥖', 'edited note shows');
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

console.log('Two-step verification');
{
  const sD = (await call('POST', '/api/auth/google', { body: { credential: idToken(claims('dave')) } })).j.session;
  const sD2 = (await call('POST', '/api/auth/google', { body: { credential: idToken(claims('dave')) } })).j.session;
  r = await call('GET', '/api/me', { session: sD });
  ok(r.j.two_step === false, 'off by default');
  r = await call('POST', '/api/2fa/setup', { session: sD });
  const sec = r.j.secret;
  ok(/^[A-Z2-7]{32}$/.test(sec) && r.j.uri.startsWith('otpauth://totp/WebDrop%3Adave%40gmail.com?secret=' + sec), 'setup gives a secret + authenticator link');
  const step = Math.floor(Date.now() / 30000);
  r = await call('POST', '/api/2fa/enable', { session: sD, body: { code: '000000' === (await totpAt(sec, step)) ? '111111' : '000000' } });
  ok(r.status === 400 && r.j.error === 'code', 'wrong code doesn’t turn it on');
  r = await call('POST', '/api/2fa/enable', { session: sD, body: { code: await totpAt(sec, step) } });
  ok(r.status === 200 && r.j.backup.length === 8 && /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(r.j.backup[0]) && r.j.session, 'right code turns it on + 8 backup codes');
  const backup = r.j.backup, sD3 = r.j.session;
  r = await call('GET', '/api/me', { session: sD2 });
  ok(r.status === 401, 'other devices are signed out');
  r = await call('GET', '/api/me', { session: sD3 });
  ok(r.status === 200 && r.j.two_step === true && r.j.backup_left === 8, 'this device stays signed in; me shows it on');
  r = await call('POST', '/api/auth/google', { body: { credential: idToken(claims('dave')) } });
  ok(r.status === 200 && r.j.need2fa === true && r.j.ticket && !r.j.session, 'Google sign-in now asks for the code');
  const ticket = r.j.ticket;
  r = await call('GET', '/api/me', { session: ticket });
  ok(r.status === 401, 'the half-way ticket is not a session');
  r = await call('POST', '/api/auth/2fa', { body: { ticket, code: await totpAt(sec, step) } });
  ok(r.status === 400, 'a code can’t be reused');
  r = await call('POST', '/api/auth/2fa', { body: { ticket, code: await totpAt(sec, step + 1) } });
  ok(r.status === 200 && r.j.session && r.j.user.email === 'dave@gmail.com', 'next code signs in');
  r = await call('POST', '/api/auth/2fa', { body: { ticket, code: backup[0].toUpperCase().replace('-', ' ') } });
  ok(r.status === 200 && r.j.session && r.j.backup_left === 7, 'a backup code signs in (any case/spacing)');
  r = await call('POST', '/api/auth/2fa', { body: { ticket, code: backup[0] } });
  ok(r.status === 400, 'a backup code works only once');
  r = await call('POST', '/api/auth/2fa', { body: { ticket: 'x.y', code: backup[1] } });
  ok(r.status === 401 && r.j.error === 'ticket', 'forged ticket rejected');
  for (let i = 0; i < 4; i++) await call('POST', '/api/auth/2fa', { body: { ticket, code: '12345' + i === (await totpAt(sec, step)) ? '999999' : '12345' + i } });
  r = await call('POST', '/api/auth/2fa', { body: { ticket, code: backup[1] } });
  ok(r.status === 429 && r.j.error === 'locked', 'locked after 5 wrong codes (even a good one waits)');
  sql.prepare('UPDATE two_step SET lock_until = NULL, fails = 0 WHERE user_id = ?').run('dave');
  r = await call('POST', '/api/2fa/disable', { session: sD3, body: { code: 'nope' } });
  ok(r.status === 400, 'turning off needs a code');
  r = await call('POST', '/api/2fa/disable', { session: sD3, body: { code: backup[2] } });
  ok(r.status === 200, 'turned off with a backup code');
  r = await call('POST', '/api/auth/google', { body: { credential: idToken(claims('dave')) } });
  ok(r.j.session && !r.j.need2fa, 'sign-in is back to Google only');
  r = await call('GET', '/auth/start?lang=de');
  ok(r.t.includes('Bestätigung in zwei Schritten') && r.t.includes('one-time-code'), 'sign-in page has the code step (translated)');
}

console.log('Quests');
{
  env.QUEST_SET = 'build3,share2,secret';
  const sQ = (await call('POST', '/api/auth/google', { body: { credential: idToken(claims('quinn')) } })).j.session;
  const me0 = (await call('GET', '/api/me', { session: sQ })).j.user, qb0 = me0.qb, pic0 = me0.pic;
  r = await call('GET', '/api/quests', { session: sQ });
  ok(r.status === 200 && r.j.quests.length === 3 && r.j.quests.every((q) => q.progress === 0 && !q.claimed) && r.j.quests.reduce((t, q) => t + q.reward, 0) === 3, '3 quests, 3 tokens a day, nothing done yet');
  ok(r.j.resets_at > Date.now() && r.j.resets_at - Date.now() <= 864e5, 'resets within a day');
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'build3' } });
  ok(r.status === 400 && r.j.error === 'not_done', 'can’t claim an unfinished quest');
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) sql.prepare("INSERT INTO builds (id, user_id, name, status, created) VALUES (?, 'quinn', 'A', ?, ?)").run('qb' + i, i < 2 ? 'ready' : 'failed', t0);
  sql.prepare("INSERT INTO builds (id, user_id, name, status, created) VALUES ('qold', 'quinn', 'A', 'ready', ?)").run(t0 - 2 * 864e5);
  r = await call('GET', '/api/quests', { session: sQ });
  ok(r.j.quests.find((q) => q.id === 'build3').progress === 2, 'only today’s finished builds count');
  sql.prepare("UPDATE builds SET status = 'ready' WHERE id = 'qb2'").run();
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'build3' } });
  ok(r.status === 200 && r.j.reward === 1 && r.j.kind === 'qb' && r.j.user.qb === qb0 + 1 && r.j.quests.find((q) => q.id === 'build3').claimed, 'build quest pays 1 Quick Build token');
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'build3' } });
  ok(r.status === 409, 'only once a day');
  for (let i = 0; i < 2; i++) sql.prepare("INSERT INTO workshop (id, user_id, name, url, apk_url, created) VALUES (?, 'quinn', 'A', 'https://a.example', ?, ?)").run('qw' + i, 'https://github.com/a/b/releases/download/x/q' + i + '.apk', t0);
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'share2', kind: 'pic' } });
  ok(r.status === 200 && r.j.kind === 'pic' && r.j.user.pic === pic0 + 1 && r.j.user.qb === qb0 + 1, 'Workshop quest can pay a Custom Picture token instead');
ok(r.j.quests.find((q) => q.id === 'share2').got === 'pic' && r.j.quests.find((q) => q.id === 'build3').got === 'qb' && r.j.quests.find((q) => q.id === 'secret').got === null, 'quests remember which token you picked');
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'secret', theme: 'old' } });
  ok(r.status === 400, 'a normal theme doesn’t count as secret');
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'secret', theme: 'rainbow', kind: 'weird' } });
  ok(r.status === 200 && r.j.kind === 'qb' && r.j.user.qb === qb0 + 2 && r.j.user.pic === pic0 + 1 && r.j.quests.every((q) => q.claimed), 'secret theme quest pays; 3 tokens today in total');
  sql.prepare("UPDATE quest_claims SET day = '2000-01-01' WHERE user_id = 'quinn'").run();
  r = await call('GET', '/api/quests', { session: sQ });
  ok(r.j.quests.every((q) => !q.claimed), 'new day: quests can be claimed again');
  r = await call('GET', '/api/quests');
  ok(r.status === 401, 'quests need sign-in');
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'nope' } });
  ok(r.status === 400, 'unknown quest rejected');
  // other quest types
  env.QUEST_SET = 'pic1,note1,orb25';
  sql.prepare("DELETE FROM quest_claims WHERE user_id = 'quinn'").run();
  sql.prepare("INSERT INTO builds (id, user_id, name, status, created, used_pic) VALUES ('qp1', 'quinn', 'P', 'ready', ?, 1)").run(t0);
  sql.prepare("UPDATE workshop SET note = 'hi there' WHERE id = 'qw0'").run();
  r = await call('GET', '/api/quests?orb=12', { session: sQ });
  ok(JSON.stringify(r.j.quests.map((q) => [q.id, q.progress, q.goal])) === JSON.stringify([['pic1', 1, 1], ['note1', 1, 1], ['orb25', 12, 25]]), 'custom-picture build, note and orb-tap quests track progress');
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'orb25', orb: 24 } });
  ok(r.status === 400, 'orb quest needs 25 taps');
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'orb25', orb: 25, kind: 'pic' } });
  ok(r.status === 200 && r.j.quests.find((q) => q.id === 'orb25').got === 'pic', 'orb quest pays');
  env.QUEST_SET = 'build1,lock1,home30,themes3,orb50';
  sql.prepare("INSERT INTO builds (id, user_id, name, status, created, locked) VALUES ('ql1', 'quinn', 'L', 'ready', ?, 1)").run(t0);
  r = await call('GET', '/api/quests?home=31&themes=2&orb=7', { session: sQ });
  ok(JSON.stringify(r.j.quests.map((q) => [q.id, q.progress])) === JSON.stringify([['build1', 1], ['lock1', 1], ['home30', 30], ['themes3', 2], ['orb50', 7]]), 'password build, home-orb, themes and orb-50 quests track progress');
  r = await call('POST', '/api/quests/claim', { session: sQ, body: { id: 'themes3', themes: 3 } });
  ok(r.status === 200, 'themes quest pays');
  r = await call('POST', '/api/build', { session: sQ, body: { url: 'https://example.com', name: 'Locky', pkg: 'com.example.locky', lock_salt: 'abcdef12', lock_hash: 'a'.repeat(64) } });
  ok(r.status === 200 && sql.prepare('SELECT locked FROM builds WHERE id = ?').get(r.j.id).locked === 1, 'builds with a start password are marked');
  delete env.QUEST_SET;
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 9, 1) + i * 864e5).toISOString().slice(0, 10));
  const sets = days.map((d) => questsFor(d));
  const slots = [['build1', 'build2', 'build3', 'pic1', 'lock1'], ['share1', 'share2', 'note1'], ['secret', 'orb25', 'orb50', 'home30', 'themes3']];
  ok(sets.every((q) => q.length === 3 && q.every((id, i) => slots[i].includes(id))), 'every day: one build, one Workshop and one fun quest');
  ok(sets.every((q, i) => i === 0 || q.every((id, k) => id !== sets[i - 1][k])) && slots.flat().every((id) => sets.some((q) => q.includes(id))), 'all 3 quests change every day (every type shows up)');
  ok(JSON.stringify(questsFor('2026-10-17')) === JSON.stringify(questsFor('2026-10-17')), 'same quests for everyone on the same day');
  env.QUEST_SET = 'build3,share2,secret';
  sql.exec('ALTER TABLE quest_claims RENAME TO qc_off');
  r = await call('GET', '/api/quests', { session: sQ });
  ok(r.status === 503 && r.j.error === 'quests_off', 'missing table: quests say they’re off (no crash)');
  sql.exec('ALTER TABLE qc_off RENAME TO quest_claims');
  delete env.QUEST_SET;
}

sql.exec('ALTER TABLE two_step RENAME TO two_step_off');
r = await call('GET', '/api/me', { session: sA });
ok(r.status === 200 && r.j.two_step === false, 'sign-in still works if the two_step table is missing');
sql.exec('ALTER TABLE two_step_off RENAME TO two_step');

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
