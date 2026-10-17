#!/usr/bin/env python3
"""Validate build inputs, fetch/prepare the app icon, and write Android resources.

Inputs come from environment variables (never interpolated into shell code):
  APP_URL, APP_NAME, PACKAGE_ID, ICON_MODE (favicon|image), ICON_B64
Writes:
  android/app/src/main/res/values/strings.xml
  android/app/src/main/res/mipmap-*/ic_launcher.png
  $GITHUB_OUTPUT  ->  apk_name=<ascii-slug>.apk, icon_source=<what was used>
"""
import base64
import json, io, os, re, sys, urllib.parse, urllib.request
from html.parser import HTMLParser
from xml.sax.saxutils import escape

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
RES = os.path.join(ROOT, 'app', 'src', 'main', 'res')
SIZES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'
MAX_BYTES = 3_000_000


def fail(msg):
    print(f'::error::{msg}')
    sys.exit(1)


def env(name, default=''):
    return os.environ.get(name, default).strip()


# ---------- validation ----------
APP_URL = env('APP_URL')
if not re.fullmatch(r"https://[A-Za-z0-9._~:/?#@!&()*+,;=%\-]{3,480}", APP_URL):
    fail('app_url must be a plain https:// address (Android blocks http).')
PKG = env('PACKAGE_ID')
if not re.fullmatch(r'[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+', PKG) or len(PKG) > 120:
    fail('package_id must look like com.example.myapp')
NAME = os.environ.get('APP_NAME', '').strip()
if not (1 <= len(NAME) <= 60) or any(ord(c) < 32 for c in NAME):
    fail('app_name must be 1-60 characters')
ORIENTATION = env('ORIENTATION', 'unspecified') or 'unspecified'
if ORIENTATION not in ('unspecified', 'portrait', 'landscape'):
    fail('orientation must be unspecified, portrait or landscape')
STATUS_COLOR = env('STATUS_COLOR')
if STATUS_COLOR and not re.fullmatch(r'#[0-9A-Fa-f]{6}', STATUS_COLOR):
    fail('status_bar_color must look like #1a2b3c (or be empty)')
LOCK_SALT = env('LOCK_SALT').lower()
LOCK_HASH = env('LOCK_HASH').lower()
if LOCK_HASH or LOCK_SALT:
    if not (re.fullmatch(r'[0-9a-f]{8,64}', LOCK_SALT) and re.fullmatch(r'[0-9a-f]{64}', LOCK_HASH)):
        fail('lock_salt/lock_hash are malformed (they are set by the WebDrop app)')
MODE = env('ICON_MODE', 'favicon')
if MODE not in ('favicon', 'image'):
    fail('icon_mode must be favicon or image')


# ---------- icon helpers ----------
def http_get(url, timeout=12):
    if not url.lower().startswith('https://'):
        raise ValueError('https only')
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError('too large')
        return data, r.headers.get('Content-Type', ''), r.geturl()


class IconLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = []  # (score, href)

    def handle_starttag(self, tag, attrs):
        if tag != 'link':
            return
        a = {k.lower(): (v or '') for k, v in attrs}
        rel = a.get('rel', '').lower().split()
        href = a.get('href', '')
        if not href or 'icon' not in ' '.join(rel):
            return
        if href.lower().split('?')[0].endswith('.svg'):
            return  # Pillow cannot rasterise SVG
        size = 0
        m = re.match(r'(\d+)x(\d+)', a.get('sizes', '').lower())
        if m:
            size = int(m.group(1))
        score = size + (1000 if 'apple-touch-icon' in rel or 'apple-touch-icon-precomposed' in rel else 0)
        self.found.append((score, href))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)


def candidates(url):
    out = []
    try:
        html, _, final = http_get(url)
        p = IconLinks()
        p.feed(html.decode('utf-8', 'ignore'))
        for _, href in sorted(p.found, key=lambda x: -x[0]):
            out.append(urllib.parse.urljoin(final, href))
    except Exception as e:
        print(f'note: could not read site HTML ({e})')
    parts = urllib.parse.urlsplit(url)
    origin = f'{parts.scheme}://{parts.netloc}'
    out.append(origin + '/apple-touch-icon.png')
    out.append(origin + '/favicon.ico')
    out.append(f'https://www.google.com/s2/favicons?domain={urllib.parse.quote(parts.netloc)}&sz=256')
    seen, uniq = set(), []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def load_image(data):
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im.load()
    if getattr(im, 'n_frames', 1) > 1 and im.format == 'ICO':
        pass
    if im.format == 'ICO':
        # pick the largest frame
        sizes = im.info.get('sizes') or {im.size}
        im.size = max(sizes, key=lambda s: s[0])
        im.load()
    return im.convert('RGBA')


def edge_color(im):
    from collections import Counter
    w, h = im.size
    px = im.load()
    c = Counter()
    for x in range(0, w, max(1, w // 24)):
        for y in (0, h - 1):
            r, g, b, a = px[x, y]
            if a > 200:
                c[(r, g, b)] += 1
    for y in range(0, h, max(1, h // 24)):
        for x in (0, w - 1):
            r, g, b, a = px[x, y]
            if a > 200:
                c[(r, g, b)] += 1
    return c.most_common(1)[0][0] if c else (255, 255, 255)


def make_square(im):
    """Return a 512x512 RGBA launcher image."""
    from PIL import Image
    w, h = im.size
    s = min(w, h)
    opaque_edges = all(im.getpixel(p)[3] > 200 for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
    if abs(w - h) <= max(2, s // 20) and s >= 128 and opaque_edges:
        im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
        return im.resize((512, 512), Image.LANCZOS)
    # small / transparent icon: centre on a tile coloured like the icon's edge
    bg = edge_color(im) if opaque_edges else (255, 255, 255)
    tile = Image.new('RGBA', (512, 512), bg + (255,))
    scale = 344 / max(w, h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    resample = Image.NEAREST if max(w, h) <= 24 else Image.LANCZOS
    sm = im.resize((nw, nh), resample)
    tile.alpha_composite(sm, ((512 - nw) // 2, (512 - nh) // 2))
    return tile


def write_icons(square):
    from PIL import Image
    for dpi, px in SIZES.items():
        d = os.path.join(RES, f'mipmap-{dpi}')
        os.makedirs(d, exist_ok=True)
        out = square.resize((px, px), Image.LANCZOS)
        # rounded-square mask so the legacy icon looks intentional on every launcher
        mask = Image.new('L', (px * 4, px * 4), 0)
        from PIL import ImageDraw
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, px * 4 - 1, px * 4 - 1), radius=int(px * 4 * 0.22), fill=255)
        mask = mask.resize((px, px), Image.LANCZOS)
        out.putalpha(mask)
        out.save(os.path.join(d, 'ic_launcher.png'))
    write_desktop_icon(square)


DESKTOP = os.path.join(os.path.dirname(ROOT), 'desktop')


def write_desktop_icon(square):
    """256px rounded icon for the Windows .exe (ULTRA)."""
    from PIL import Image, ImageDraw
    px = 256
    out = square.convert('RGBA').resize((px, px), Image.LANCZOS)
    mask = Image.new('L', (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, px * 4 - 1, px * 4 - 1), radius=int(px * 4 * 0.22), fill=255)
    out.putalpha(mask.resize((px, px), Image.LANCZOS))
    os.makedirs(DESKTOP, exist_ok=True)
    out.save(os.path.join(DESKTOP, 'icon.png'))


def prepare_icon():
    if MODE == 'image':
        raw = os.environ.get('ICON_B64', '').strip()
        if raw:
            try:
                data = base64.b64decode(raw, validate=False)
                if len(data) > MAX_BYTES:
                    raise ValueError('too large')
                write_icons(make_square(load_image(data)))
                return 'chosen image'
            except Exception as e:
                print(f'::warning::could not use the chosen icon ({e}); falling back to the website icon')
    for c in candidates(APP_URL):
        try:
            data, ctype, _ = http_get(c)
            if b'<svg' in data[:512].lower():
                continue
            im = load_image(data)
            if min(im.size) < 16:
                continue
            write_icons(make_square(im))
            return f'website icon ({c})'
        except Exception as e:
            print(f'note: {c} -> {e}')
    return 'default icon (no website icon found)'


try:
    source = prepare_icon()
except ImportError:
    fail('Pillow is not installed')
print(f'icon: {source}')

# ---------- Windows app settings (used only when the ULTRA .exe is built) ----------
def flag(name, default=False):
    v = env(name).lower()
    return default if v == '' else v == 'true'

EXTRAS = [x for x in re.sub(r'[^a-z,]', '', env('EXTRAS').lower()).split(',') if x]
try:
    if not os.path.exists(os.path.join(DESKTOP, 'icon.png')):
        from PIL import Image
        write_desktop_icon(Image.open(os.path.join(RES, 'mipmap-xxxhdpi', 'ic_launcher.png')))
    os.makedirs(DESKTOP, exist_ok=True)
    with open(os.path.join(DESKTOP, 'config.json'), 'w', encoding='utf-8') as f:
        json.dump({
            'url': APP_URL, 'name': NAME, 'appId': PKG,
            'internalLinks': flag('INTERNAL_LINKS', True), 'allowZoom': flag('ALLOW_ZOOM'),
            'keepScreenOn': flag('KEEP_SCREEN_ON'), 'fullscreen': flag('IMMERSIVE'),
            'confirmExit': flag('CONFIRM_EXIT'), 'statusColor': STATUS_COLOR,
            'lockSalt': LOCK_SALT, 'lockHash': LOCK_HASH,
            'extras': [x for x in EXTRAS if x in ('splash', 'bigtext', 'dark', 'secure', 'resume', 'adblock', 'private', 'homebtn')],
        }, f, ensure_ascii=False, indent=1)
except Exception as e:
    print(f'::warning::could not prepare the Windows app settings ({e})')

# ---------- strings.xml ----------
def android_string(s):
    s = escape(s).replace('\\', '\\\\').replace("'", "\\'").replace('"', '\\"')
    if s[:1] in ('@', '?'):
        s = '\\' + s
    return s

os.makedirs(os.path.join(RES, 'values'), exist_ok=True)
with open(os.path.join(RES, 'values', 'strings.xml'), 'w', encoding='utf-8') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
            f'    <string name="app_name">{android_string(NAME)}</string>\n</resources>\n')

slug = re.sub(r'[^A-Za-z0-9]+', '-', NAME).strip('-') or 'app'
out = os.environ.get('GITHUB_OUTPUT')
if out:
    with open(out, 'a') as f:
        f.write(f'apk_name={slug}.apk\n')
        f.write(f"icon_source={source.splitlines()[0]}\n")
        f.write(f'orientation={ORIENTATION}\n')
        f.write(f'status_color={STATUS_COLOR}\n')
        f.write(f'lock_salt={LOCK_SALT}\n')
        f.write(f'lock_hash={LOCK_HASH}\n')
print('prepared', slug)
