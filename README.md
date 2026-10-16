# WebDrop build service

One GitHub repo that does two things:

1. **Builds the WebDrop app itself** — clean wrapper, no watermark, no ads, no Pro lock.
2. **Builds apps for your websites** — the WebDrop app sends a URL, name, icon and options; GitHub builds a signed APK and publishes it as a release; the app shows a Download button.

## Setup (once, ~3 minutes)

1. Create a **public** GitHub repository (public repos get free build minutes and public download links).
2. Upload everything in this folder — `.github`, `android`, `server`, `webdrop-app` — to the top level of the repo
   (GitHub → Add file → Upload files; keep the folder structure).

### A. Get WebDrop without the watermark
3. In the repo open **Actions → Build WebDrop app → Run workflow** (keep the defaults, or change the name/package).
4. After ~5 minutes open **Releases → WebDrop app #1 → WebDrop.apk** on your phone, download and install it.
   (Uninstall the old WebDrop first — it was signed with a different key.)

### B. Build apps for your websites
5. Create a token: GitHub → Settings → Developer settings → Fine-grained personal access tokens.
   Select only this repo; give it **Actions: Read and write** and **Contents: Read**.
6. In the WebDrop app: Settings → Build service → paste `owner/repo` and the token → **Save & test**.
7. Home → enter a website → **Prepare APK build**. Watch it in **My Apps**; tap **Download APK** when it says Ready.

## Icons
The build downloads the site's own icon (apple-touch-icon, then `<link rel=icon>`, `/favicon.ico`, then Google's favicon service) and tiles small ones onto a clean background. If none is found it uses the default icon. Preset and uploaded icons are sent with the build request instead.

## Per-app options
Immersive display, keep links in app, keep screen on, loading bar (free). Desktop mode, pinch-to-zoom, back-twice-to-exit, orientation lock and status bar colour (ULTRA in the app).

## Keep updates installable (recommended)
Without a stored key, every build is signed with a one-off key and must be uninstalled before reinstalling. Add these repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `KEYSTORE_BASE64` | your `.p12` keystore, base64-encoded (`base64 -w0 keys.p12`) |
| `KEYSTORE_PASSWORD` | the keystore password |
| `KEY_ALIAS` | the key alias (default `webdrop`) |

## Updating the WebDrop app later
Replace `webdrop-app/index.html` in the repo and run **Build WebDrop app** again.

## Notes
- Only `https://` sites work for built apps (Android blocks plain http).
- Each build creates a release; delete old ones whenever you like.
- If a run fails, open it from My Apps → View run (or the Actions tab); the log says which step broke.

## Accounts, Quick Build and payments (the WebDrop server)

Upload the `server` folder too. The server runs free on Cloudflare Workers and adds Google sign-in, usernames,
tokens (3 Quick Builds + 3 Custom Pictures for new accounts), Quick Build without GitHub for your users,
real ULTRA licences, promo-code limits and payments through Stripe Checkout (Google Pay + cards).

**Tiers:** Guest (4 themes, website icon, sounds on/off) → Google account (all free themes incl. Material,
icon presets, all sounds, more app options, tokens) → ULTRA (everything, unlimited tokens).
**Plans:** 1 week €1, 1 month €5, 1 year €10, lifetime €15. **Promo codes:** `SUPADROP` 100% off, 10 uses total,
one per account (needs sign-in); `LILYDROP` 40% off + the secret Lily's Picks and Lilypad themes.
Edit prices/codes in `server/src/index.js` (`PLANS`, `PROMOS`) and in `webdrop-app/index.html` (`WD_PLANS`, `WD_PROMOS`).

### 1. Cloudflare (free)
1. Sign up at cloudflare.com. In **Workers & Pages**, open it once so a `workers.dev` subdomain is created.
2. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template, then **add permission
   Account → D1 → Edit**. Create it and copy the token.
3. Copy your **Account ID** (Workers & Pages overview, right side).

### 2. Repo secrets (GitHub repo → Settings → Secrets and variables → Actions → New repository secret)
| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token from step 1.2 |
| `CLOUDFLARE_ACCOUNT_ID` | optional: only needed if you have more than one Cloudflare account |
| `BUILD_TOKEN` | fine-grained GitHub token for **this repo**: Actions read & write, Contents read (Quick Build uses it) |
| `GOOGLE_CLIENT_ID` | from step 4 (add after the first deploy) |
| `STRIPE_SECRET_KEY` | from step 5 |
| `STRIPE_WEBHOOK_SECRET` | from step 5 (optional) |

### 3. Deploy
**Actions → Deploy WebDrop server → Run workflow.** Tick **test_payments** while you try things out.
It tests the code, creates the database, deploys, stores the secrets and then rebuilds the WebDrop app pointed at the
server automatically. The run summary shows your server address (`https://webdrop-server.<you>.workers.dev`).
Run it again whenever you change a secret.

### 4. Google sign-in
1. console.cloud.google.com → new project → **APIs & Services → OAuth consent screen**: External, app name WebDrop,
   your email; publish it.
2. **Credentials → Create credentials → OAuth client ID → Web application.** Under *Authorized JavaScript origins*
   add your server address from step 3. Copy the **Client ID** into the `GOOGLE_CLIENT_ID` secret and run the deploy again.
Sign-in opens in the phone's browser (Google blocks sign-in inside app WebViews) and returns to WebDrop by itself.
2-step verification is Google's: whatever the user has on their Google account applies.

### 5. Payments (Stripe Checkout, with Google Pay)
Already set up in your Stripe account (test mode): product **WebDrop ULTRA** with prices `webdrop_week` €1,
`webdrop_month` €5, `webdrop_year` €10, `webdrop_life` €15, and coupon **LILYDROP** (40%).
1. Stripe Dashboard → Developers → API keys → copy the **secret key** into the `STRIPE_SECRET_KEY` secret.
2. After the first deploy, add a webhook: Developers → Webhooks → endpoint `<server>/stripe/webhook`, event
   `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET` and deploy again.
   (Without it, keys are still issued when the buyer returns from checkout; the webhook covers people who close the page.)
3. Google Pay shows up automatically in Stripe Checkout on Android/Chrome. No Google merchant approval needed.
4. Going live: activate your Stripe account, create the same prices/coupon in live mode (same lookup keys), and swap in
   the live secret key and a live webhook secret.

### Checking it works
Open the server address in a browser: it shows which parts are switched on (`login`, `builds`, `payments`).
Run the server tests locally with Node 22: `node --no-warnings server/test/server.test.mjs`.

## Start password

If a start password is set in the builder, the app asks for it every time it opens. Only a random salt and the
SHA-256 hash go into the build inputs, never the password itself.
