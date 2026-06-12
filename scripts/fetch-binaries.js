// scripts/fetch-binaries.js
//
// Runs automatically after `npm install`. Downloads the right yt-dlp and
// ffmpeg binaries for the host platform into ./vendor/<platform>/.
// Skips downloads that are already present so re-running is cheap.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// ---------- Platform detection ----------
const PLATFORM = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
  : process.platform === 'win32' ? 'win-x64'
  : 'linux-x64';

const VENDOR_DIR = path.join(ROOT, 'vendor', PLATFORM);
fs.mkdirSync(VENDOR_DIR, { recursive: true });

// ---------- URLs ----------
// yt-dlp ships single-file binaries per platform on its GitHub releases.
// We pin to "latest" — fine for dev. Production builds should pin a version.
const YTDLP_URLS = {
  'mac-arm64': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  'mac-x64':   'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  'win-x64':   'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  'linux-x64': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
};

// ffmpeg static builds. evermeet for Mac, gyan.dev for Windows, johnvansickle for Linux.
// These are archives so we have to unpack them.
const FFMPEG_SOURCES = {
  'mac-arm64': { url: 'https://www.osxexperts.net/ffmpeg7arm.zip',                            type: 'zip', innerPath: 'ffmpeg' },
  'mac-x64':   { url: 'https://www.osxexperts.net/ffmpeg71intel.zip',                        type: 'zip', innerPath: 'ffmpeg' },
  'win-x64':   { url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',    type: 'zip', innerPath: '*/bin/ffmpeg.exe' },
  'linux-x64': { url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz', type: 'tarxz', innerPath: '*/ffmpeg' },
};

// ---------- Helpers ----------
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (currentUrl, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects: ' + url));
      https.get(currentUrl, { headers: { 'User-Agent': 'grabby-installer' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, currentUrl).toString();
          return get(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed: ${currentUrl} → HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    get(url);
  });
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

// ---------- yt-dlp ----------
async function fetchYtdlp() {
  const ext = PLATFORM === 'win-x64' ? '.exe' : '';
  const out = path.join(VENDOR_DIR, 'yt-dlp' + ext);
  if (exists(out)) { console.log('  yt-dlp already present, skipping'); return; }

  console.log('  Downloading yt-dlp...');
  await download(YTDLP_URLS[PLATFORM], out);
  if (PLATFORM !== 'win-x64') fs.chmodSync(out, 0o755);
  console.log('  ✓ yt-dlp installed');
}

// ---------- ffmpeg ----------
async function fetchFfmpeg() {
  const ext = PLATFORM === 'win-x64' ? '.exe' : '';
  const out = path.join(VENDOR_DIR, 'ffmpeg' + ext);
  if (exists(out)) { console.log('  ffmpeg already present, skipping'); return; }

  const src = FFMPEG_SOURCES[PLATFORM];
  const tmp = path.join(os.tmpdir(), 'grabby-ffmpeg-' + Date.now() + (src.type === 'zip' ? '.zip' : '.tar.xz'));

  console.log('  Downloading ffmpeg... (this is the big one, ~30–80 MB)');
  await download(src.url, tmp);

  console.log('  Extracting ffmpeg...');
  const extractDir = path.join(os.tmpdir(), 'grabby-ffmpeg-extract-' + Date.now());
  fs.mkdirSync(extractDir, { recursive: true });

  if (src.type === 'zip') {
    if (process.platform === 'win32') {
      // PowerShell's Expand-Archive is the only thing reliably present on stock Windows.
      execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmp}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'inherit' });
    } else {
      execSync(`unzip -q -o "${tmp}" -d "${extractDir}"`, { stdio: 'inherit' });
    }
  } else { // tarxz
    execSync(`tar -xf "${tmp}" -C "${extractDir}"`, { stdio: 'inherit' });
  }

  // Find the ffmpeg binary in the extracted tree.
  const innerName = PLATFORM === 'win-x64' ? 'ffmpeg.exe' : 'ffmpeg';
  const found = findFile(extractDir, innerName);
  if (!found) throw new Error(`Could not locate ${innerName} in extracted archive at ${extractDir}`);

  fs.copyFileSync(found, out);
  if (PLATFORM !== 'win-x64') fs.chmodSync(out, 0o755);

  // Tidy up.
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}

  console.log('  ✓ ffmpeg installed');
}

function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const inner = findFile(full, name);
      if (inner) return inner;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

// ---------- Run ----------
(async () => {
  console.log(`grabby: fetching binaries for ${PLATFORM}`);
  console.log(`  vendor dir: ${VENDOR_DIR}`);
  try {
    await fetchYtdlp();
    await fetchFfmpeg();
    console.log('Done. You can now run `npm start`.');
  } catch (e) {
    console.error('\n  ERROR:', e.message);
    console.error('\n  You can install the binaries manually:');
    console.error(`    yt-dlp → ${YTDLP_URLS[PLATFORM]}`);
    console.error(`    ffmpeg → ${FFMPEG_SOURCES[PLATFORM].url}`);
    console.error(`    Put them in: ${VENDOR_DIR}`);
    console.error('  Then run `npm start`.\n');
    process.exit(1);
  }
})();
