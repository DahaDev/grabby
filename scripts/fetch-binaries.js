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
// On a Mac, we want binaries for BOTH architectures even when the host is
// arm64, because electron-builder cross-builds both Intel and Apple Silicon
// DMGs from a single Mac runner. Without this, the x64 DMG ships missing
// yt-dlp and ffmpeg and the app silently breaks for Intel Mac users.
const HOST_PLATFORMS = (() => {
  if (process.platform === 'darwin') {
    return ['mac-arm64', 'mac-x64'];
  }
  if (process.platform === 'win32') return ['win-x64'];
  return ['linux-x64'];
})();

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
async function fetchYtdlp(platform, vendorDir) {
  const ext = platform === 'win-x64' ? '.exe' : '';
  const out = path.join(vendorDir, 'yt-dlp' + ext);
  if (exists(out)) { console.log(`  [${platform}] yt-dlp already present, skipping`); return; }

  console.log(`  [${platform}] Downloading yt-dlp...`);
  await download(YTDLP_URLS[platform], out);
  if (platform !== 'win-x64') fs.chmodSync(out, 0o755);
  console.log(`  [${platform}] ✓ yt-dlp installed`);
}

// ---------- ffmpeg ----------
async function fetchFfmpeg(platform, vendorDir) {
  const ext = platform === 'win-x64' ? '.exe' : '';
  const out = path.join(vendorDir, 'ffmpeg' + ext);
  if (exists(out)) { console.log(`  [${platform}] ffmpeg already present, skipping`); return; }

  const src = FFMPEG_SOURCES[platform];
  const tmp = path.join(os.tmpdir(), 'grabby-ffmpeg-' + Date.now() + (src.type === 'zip' ? '.zip' : '.tar.xz'));

  console.log(`  [${platform}] Downloading ffmpeg... (~30-80 MB)`);
  await download(src.url, tmp);

  console.log(`  [${platform}] Extracting ffmpeg...`);
  const extractDir = path.join(os.tmpdir(), 'grabby-ffmpeg-extract-' + Date.now());
  fs.mkdirSync(extractDir, { recursive: true });

  if (src.type === 'zip') {
    if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmp}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'inherit' });
    } else {
      execSync(`unzip -q -o "${tmp}" -d "${extractDir}"`, { stdio: 'inherit' });
    }
  } else {
    execSync(`tar -xf "${tmp}" -C "${extractDir}"`, { stdio: 'inherit' });
  }

  const innerName = platform === 'win-x64' ? 'ffmpeg.exe' : 'ffmpeg';
  const found = findFile(extractDir, innerName);
  if (!found) throw new Error(`Could not locate ${innerName} in extracted archive at ${extractDir}`);

  fs.copyFileSync(found, out);
  if (platform !== 'win-x64') fs.chmodSync(out, 0o755);

  try { fs.unlinkSync(tmp); } catch {}
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}

  console.log(`  [${platform}] ✓ ffmpeg installed`);
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
  console.log(`grabby: fetching binaries for ${HOST_PLATFORMS.join(', ')}`);
  for (const platform of HOST_PLATFORMS) {
    const vendorDir = path.join(ROOT, 'vendor', platform);
    fs.mkdirSync(vendorDir, { recursive: true });
    try {
      await fetchYtdlp(platform, vendorDir);
      await fetchFfmpeg(platform, vendorDir);
    } catch (e) {
      console.error(`\n  [${platform}] ERROR:`, e.message);
      console.error('\n  You can install the binaries manually:');
      console.error(`    yt-dlp → ${YTDLP_URLS[platform]}`);
      console.error(`    ffmpeg → ${FFMPEG_SOURCES[platform].url}`);
      console.error(`    Put them in: ${vendorDir}\n`);
      process.exit(1);
    }
  }
  console.log('Done. You can now run `npm start`.');
})();
