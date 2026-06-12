// src/main/main.js
//
// Electron main process. Owns the BrowserWindow, talks to the renderer via
// IPC, and shells out to the bundled yt-dlp + ffmpeg binaries.

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { autoUpdater } = require('electron-updater');

// ---------- Persistent settings ----------
// Simple JSON file in the OS-appropriate userData dir. We avoid electron-store
// because its current version is ESM-only and we want this main process to
// stay CommonJS for simpler bundling later.
const DEFAULT_SETTINGS = {
  downloadDir: path.join(os.homedir(), 'Downloads', 'grabby'),
  cookiesBrowser: 'none',          // 'none' | 'chrome' | 'firefox' | 'safari' | 'edge'
  skipUnavailable: true,            // skip private/blocked videos in playlists
};

let _settings = null;
let _settingsPath = null;

function settingsPath() {
  if (!_settingsPath) _settingsPath = path.join(app.getPath('userData'), 'settings.json');
  return _settingsPath;
}

function loadSettings() {
  if (_settings) return _settings;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    _settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    _settings = { ...DEFAULT_SETTINGS };
  }
  return _settings;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(_settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

const store = {
  get: (key) => loadSettings()[key],
  set: (key, val) => { loadSettings()[key] = val; saveSettings(); },
};

// ---------- Binary paths ----------
// In development: binaries live in ./vendor/<platform>/
// In production:  they're inside resources/vendor/ next to the app bundle.
function vendorDir() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'vendor')
    : path.join(__dirname, '..', '..', 'vendor');
  const platform =
    process.platform === 'darwin'  ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
    : process.platform === 'win32' ? 'win-x64'
    : 'linux-x64';
  return path.join(base, platform);
}

function binaryPath(name) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(vendorDir(), name + ext);
}

const YTDLP_PATH  = () => binaryPath('yt-dlp');
const FFMPEG_PATH = () => binaryPath('ffmpeg');

// ---------- Window ----------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#f4f1ea',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,                // wait for ready-to-show to avoid white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in the user's actual browser, not inside our window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// Minimal native menu so users get Cmd+C / Cmd+V / Cmd+Q on Mac.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open downloads folder', click: () => shell.openPath(store.get('downloadDir')) },
        { label: 'yt-dlp on GitHub', click: () => shell.openExternal('https://github.com/yt-dlp/yt-dlp') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Auto-updater ----------
// electron-updater checks GitHub Releases (configured in package.json "publish")
// for newer versions and downloads them in the background. The user gets a
// prompt before install. In dev mode (unpackaged) we skip all of this; the
// updater would crash without dev-app-update.yml otherwise.
function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;          // we ask first
  autoUpdater.autoInstallOnAppQuit = true;   // install when user quits

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('update-available', { version: info.version, notes: info.releaseNotes });
  });

  autoUpdater.on('update-not-available', () => {
    sendToRenderer('update-not-available', {});
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update-download-progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('update-downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    // Common in development or behind some corporate networks. Don't pester.
    console.error('[updater]', err?.message || err);
  });

  // Initial check 10 seconds after boot — don't slow down app startup.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  // Re-check every 4 hours while the app is open.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- App lifecycle ----------
app.whenReady().then(() => {
  // Make sure the download dir exists before we start handing out file paths.
  fs.mkdirSync(store.get('downloadDir'), { recursive: true });
  buildMenu();
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- yt-dlp helpers ----------
// Run yt-dlp and return a promise that resolves with parsed JSON, or rejects
// with the formatted stderr.
function runYtDlpJSON(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', err => reject(new Error(
      err.code === 'ENOENT'
        ? `yt-dlp binary not found at ${YTDLP_PATH()}. Run \`npm install\` to fetch it.`
        : err.message
    )));
    proc.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error('Failed to parse yt-dlp output: ' + e.message)); }
      } else {
        reject(new Error(cleanYtDlpError(stderr)));
      }
    });
  });
}

function cleanYtDlpError(stderr) {
  // Pluck the last ERROR: line; yt-dlp's stderr is usually multi-line warnings + final error.
  const lines = stderr.split('\n').filter(Boolean);
  const errLine = [...lines].reverse().find(l => l.startsWith('ERROR:'));
  return (errLine || lines[lines.length - 1] || 'Unknown error').replace(/^ERROR:\s*/, '');
}

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url))   return 'youtube';
  if (/instagram\.com/i.test(url))           return 'instagram';
  if (/tiktok\.com/i.test(url))              return 'tiktok';
  if (/snapchat\.com/i.test(url))            return 'snapchat';
  return 'other';
}

function humanSize(bytes) {
  if (!bytes) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

// Pick a small, human-friendly list of quality choices from yt-dlp's format array.
function summarizeFormats(info) {
  const formats = info.formats || [];
  const choices = [];
  const seenHeights = new Set();

  const videoFormats = formats
    .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
    .sort((a, b) => {
      if (a.height !== b.height) return b.height - a.height;
      const aHasAudio = a.acodec && a.acodec !== 'none' ? 0 : 1;
      const bHasAudio = b.acodec && b.acodec !== 'none' ? 0 : 1;
      if (aHasAudio !== bHasAudio) return aHasAudio - bHasAudio;
      return (a.ext === 'mp4' ? 0 : 1) - (b.ext === 'mp4' ? 0 : 1);
    });

  for (const f of videoFormats) {
    if (seenHeights.has(f.height)) continue;
    seenHeights.add(f.height);
    const noAudio = !f.acodec || f.acodec === 'none';
    choices.push({
      id: f.format_id,
      label: `${f.height}p${noAudio ? ' (will merge audio)' : ''}`,
      ext: f.ext,
      height: f.height,
      filesize: humanSize(f.filesize || f.filesize_approx),
      is_audio: false,
    });
  }

  const hasAudio = formats.some(f => f.acodec && f.acodec !== 'none');
  if (hasAudio) {
    choices.push({ id: 'bestaudio', label: 'Audio only (MP3)', ext: 'mp3', height: null, filesize: null, is_audio: true });
  }

  if (choices.length === 0) {
    choices.push({ id: 'best', label: 'Best available', ext: info.ext || 'mp4', filesize: null, is_audio: false });
  }
  return choices;
}

// ---------- IPC: probe ----------
ipcMain.handle('probe', async (_event, { url }) => {
  if (!url || !url.trim()) throw new Error('Please paste a URL.');

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',                 // probe only the first video; we'll handle playlists in download
    '--ffmpeg-location', FFMPEG_PATH(),
  ];
  const cookiesBrowser = store.get('cookiesBrowser');
  if (cookiesBrowser && cookiesBrowser !== 'none') {
    args.push('--cookies-from-browser', cookiesBrowser);
  }
  args.push(url.trim());

  const info = await runYtDlpJSON(args);

  // Also do a quick playlist probe so the UI can show "N videos" if it IS a playlist.
  let playlistCount = null;
  if (/[?&]list=/.test(url)) {
    try {
      const plArgs = ['--flat-playlist', '--dump-single-json', '--no-warnings'];
      if (cookiesBrowser && cookiesBrowser !== 'none') plArgs.push('--cookies-from-browser', cookiesBrowser);
      plArgs.push(url.trim());
      const pl = await runYtDlpJSON(plArgs);
      if (pl.entries) playlistCount = pl.entries.length;
    } catch { /* ignore — single-video probe already succeeded */ }
  }

  return {
    title: info.title,
    uploader: info.uploader || info.channel,
    thumbnail: info.thumbnail,
    duration: info.duration,
    platform: detectPlatform(url),
    formats: summarizeFormats(info),
    playlistCount,
  };
});

// ---------- IPC: download ----------
// Active downloads keyed by jobId so the renderer can poll/cancel.
const jobs = new Map();

ipcMain.handle('download', async (event, { url, formatId, isAudio, downloadPlaylist }) => {
  const jobId = randomUUID().slice(0, 12);
  const downloadDir = store.get('downloadDir');
  fs.mkdirSync(downloadDir, { recursive: true });

  const outTemplate = path.join(downloadDir, '%(title).200B [%(id)s].%(ext)s');

  const args = [
    '--newline',                         // one progress line per update; easier to parse
    '--no-warnings',
    '--progress',
    '--progress-template', 'download:%(progress.downloaded_bytes)s/%(progress.total_bytes)s/%(progress.speed)s/%(progress.eta)s',
    '--ffmpeg-location', FFMPEG_PATH(),
    '--merge-output-format', 'mp4',
    '-o', outTemplate,
    '--print', 'after_move:filepath',    // prints final path so we know exactly what file landed
  ];

  if (isAudio) {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '192');
  } else if (!formatId || formatId === 'best') {
    args.push('-f', 'bv*+ba/b');
  } else {
    args.push('-f', `${formatId}+bestaudio/${formatId}/best`);
  }

  if (!downloadPlaylist) args.push('--no-playlist');
  if (store.get('skipUnavailable')) args.push('--ignore-errors');

  const cookiesBrowser = store.get('cookiesBrowser');
  if (cookiesBrowser && cookiesBrowser !== 'none') {
    args.push('--cookies-from-browser', cookiesBrowser);
  }

  args.push(url.trim());

  const proc = spawn(YTDLP_PATH(), args, { windowsHide: true });
  jobs.set(jobId, { proc, status: 'starting', progress: 0, files: [], errors: [], url });

  // Stream progress back to the renderer in real time.
  let stderrTail = '';
  proc.stdout.on('data', chunk => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('download:')) {
        // Our custom progress template.
        const [, payload] = trimmed.split('download:');
        const [done, total, speed, eta] = payload.split('/');
        const job = jobs.get(jobId);
        if (job) {
          const pct = total && total !== 'NA' ? (parseInt(done) / parseInt(total)) * 100 : 0;
          job.status = 'downloading';
          job.progress = Math.round(pct * 10) / 10;
          job.speed = speed !== 'NA' ? parseFloat(speed) : null;
          job.eta = eta !== 'NA' ? parseInt(eta) : null;
          sendProgress(jobId, job);
        }
      } else if (trimmed.startsWith('/') || /^[A-Z]:\\/.test(trimmed)) {
        // The --print after_move:filepath line — final saved file.
        const job = jobs.get(jobId);
        if (job) {
          job.files.push({ path: trimmed, name: path.basename(trimmed) });
          sendProgress(jobId, job);
        }
      }
    }
  });

  proc.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000); // keep last ~2KB for diagnostics
    const job = jobs.get(jobId);
    if (job && /Merger|ExtractAudio|Fixup/.test(chunk.toString())) {
      job.status = 'processing';
      sendProgress(jobId, job);
    }
  });

  proc.on('error', err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.code === 'ENOENT'
        ? `yt-dlp binary not found at ${YTDLP_PATH()}.`
        : err.message;
      sendProgress(jobId, job);
    }
  });

  proc.on('close', code => {
    const job = jobs.get(jobId);
    if (!job) return;
    if (code === 0 || (code !== 0 && job.files.length > 0)) {
      // code !== 0 with some files means playlist partially succeeded (--ignore-errors).
      job.status = 'done';
      job.progress = 100;
    } else {
      job.status = 'error';
      job.error = cleanYtDlpError(stderrTail);
    }
    sendProgress(jobId, job);
  });

  return { jobId };
});

function sendProgress(jobId, job) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('job-update', {
    jobId,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    files: job.files,
    error: job.error,
    url: job.url,
  });
}

ipcMain.handle('cancel', async (_event, { jobId }) => {
  const job = jobs.get(jobId);
  if (!job) return { ok: false };
  try { job.proc.kill('SIGTERM'); } catch {}
  job.status = 'cancelled';
  sendProgress(jobId, job);
  return { ok: true };
});

// ---------- IPC: open file / reveal in folder ----------
ipcMain.handle('open-file', async (_event, { filePath }) => {
  await shell.openPath(filePath);
});

ipcMain.handle('reveal-file', async (_event, { filePath }) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('open-downloads', async () => {
  await shell.openPath(store.get('downloadDir'));
});

// ---------- IPC: settings ----------
ipcMain.handle('get-settings', async () => ({
  downloadDir: store.get('downloadDir'),
  cookiesBrowser: store.get('cookiesBrowser'),
  skipUnavailable: store.get('skipUnavailable'),
}));

ipcMain.handle('set-settings', async (_event, patch) => {
  if (patch.cookiesBrowser !== undefined)  store.set('cookiesBrowser', patch.cookiesBrowser);
  if (patch.skipUnavailable !== undefined) store.set('skipUnavailable', patch.skipUnavailable);
  if (patch.downloadDir !== undefined) {
    fs.mkdirSync(patch.downloadDir, { recursive: true });
    store.set('downloadDir', patch.downloadDir);
  }
  return { ok: true };
});

ipcMain.handle('pick-download-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: store.get('downloadDir'),
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  const dir = result.filePaths[0];
  store.set('downloadDir', dir);
  return { ok: true, dir };
});

// ---------- IPC: updater actions ----------
ipcMain.handle('updater-download', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Updates disabled in dev mode.' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('updater-install', async () => {
  // Quits and installs immediately. Pass false to actually quit (not just hide).
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle('updater-check', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Updates disabled in dev mode.' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result?.updateInfo?.version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app-version', async () => app.getVersion());
