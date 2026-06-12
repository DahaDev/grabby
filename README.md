# grabby

Local desktop video downloader. Mac + Windows. Built on Electron and yt-dlp.

## Run in development

```bash
npm install
npm start
```

`npm install` auto-downloads yt-dlp and ffmpeg binaries into `./vendor/`. Takes
a couple minutes the first time.

## Build installers locally

To produce a `.dmg` / `.zip` for Mac (must run on a Mac):
```bash
npm run dist:mac
```

To produce a `.exe` installer for Windows (must run on Windows):
```bash
npm run dist:win
```

Output goes to `./dist/`. These are unsigned builds — fine for testing but
end users will see a "unidentified developer" warning on first launch.

## Ship a release

The release flow is automated via GitHub Actions. To cut a new version:

```bash
# 1. Bump the version
npm version patch              # or: npm version minor / major

# 2. Push the commit AND the tag
git push && git push --tags
```

GitHub Actions takes over from there:
- Builds Mac (Apple Silicon + Intel) and Windows installers in parallel
- Uploads them to a GitHub Release with the new tag
- Users with the app installed auto-update from that release on next launch

Watch the build at: `https://github.com/DahaDev/grabby/actions`

## First-time GitHub setup

Before the first release works, you need to:

1. **Create a GitHub repo** named `grabby` (or whatever — but update the
   references in `package.json`, `docs/index.html`, and this README).
2. **Push your code:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/DahaDev/grabby.git
   git push -u origin main
   ```
3. **Enable GitHub Pages** (Settings → Pages → Source: "Deploy from branch" →
   Branch: `main`, Folder: `/docs`). Your landing page goes live at
   `https://DahaDev.github.io/grabby/`.
4. Cut your first release with `npm version 0.1.0` (or whatever) and
   `git push --tags`.

## Update the app icon

The icon is generated procedurally from the Fraunces font. To re-render
(after tweaking colors or positioning in `build/make-icon.py`):

```bash
npm run icon
```

You need Python 3 with Pillow installed (`pip install Pillow fonttools brotli`).

## What's in the box

```
grabby-desktop/
├── .github/workflows/release.yml    Build + publish CI
├── build/
│   ├── icon.png                     1024x1024 master
│   ├── icon.ico                     Windows icon (7 sizes)
│   ├── icon-rounded-512.png         Landing-page icon
│   └── make-icon.py                 Icon generator
├── docs/
│   └── index.html                   Landing page (GitHub Pages)
├── scripts/
│   └── fetch-binaries.js            Postinstall: grabs yt-dlp + ffmpeg
├── src/
│   ├── main/                        Electron main process
│   │   ├── main.js
│   │   └── preload.js
│   └── renderer/                    UI
│       ├── index.html
│       ├── renderer.js
│       └── styles.css
└── package.json                     Deps + electron-builder config
```

## Code signing (when you're ready)

The CI builds unsigned. To sign, you need:

**Mac** — Apple Developer Program ($99/year). Get a "Developer ID Application"
certificate from Apple. Add to GitHub Secrets:
- `CSC_LINK` — base64-encoded `.p12` file
- `CSC_KEY_PASSWORD` — the cert password
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization

**Windows** — Code-signing cert from a CA like Sectigo, DigiCert, or
SignMyCode ($200-400/year). Add to GitHub Secrets:
- `CSC_LINK` (Windows variant)
- `CSC_KEY_PASSWORD`

Then remove the `CSC_IDENTITY_AUTO_DISCOVERY: false` line from
`.github/workflows/release.yml` and electron-builder will pick the certs up
automatically.

## Legal

For personal use. Respect the content sources' Terms of Service and the
copyright laws in your jurisdiction. Users are responsible for how they
use this tool.
