# reMona (AICleaner)

[![License: MIT](https://img.shields.io/badge/license-MIT-3da639.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6.svg)](#install-and-run)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-3c873a.svg)](#install-and-run)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-none-success.svg)](#architecture)

An AI-assisted disk cleaner for Windows. A real desktop application built with
Electron: not a web page in a browser tab, but an app with its own window, its
own icon and its own packager.

> **Branding:** the product is **reMona**; **AICleaner** is kept as the
> application's product name and technical identity (environment variables
> `AICLEANER_*`, renderer bridge `window.aicleaner`). Data from older versions
> is copied on first launch from `%APPDATA%\AICleaner\data` to
> `%APPDATA%\reMona AICleaner\data`.

![reMona (AICleaner) interface: disk ring, category cards and the AI insight
panel](docs/screenshot.jpg)

## Download

Grab the latest build from the
[**Releases page**](https://github.com/remona-code/remona-cleaner/releases/latest):

| File | What it is |
|---|---|
| `reMona-<version>-setup.exe` | Installer. Choose the install folder, get Start menu and desktop shortcuts. |
| `reMona-<version>-portable.exe` | Single portable executable. No installation, no registry writes. |

Both are unsigned, so Windows SmartScreen may warn on first run: choose
**More info → Run anyway**. The source of every release is the tag next to it
on the same page, so you can always build it yourself instead.

## What it does

It finds files on disk that are safe to remove, gives each group a **confidence
score**, recommends the safe ones, and cleans in a way that can be **undone**.

Categories scanned:

| Category | Risk | What it finds |
|---|---|---|
| User temporary files | Safe | Leftovers under `%TEMP%` |
| Windows temporary folder | Caution | `C:\Windows\Temp` |
| Browser caches | Safe | Chrome, Edge, Brave, Opera, Firefox caches |
| Windows Update leftovers | Caution | `SoftwareDistribution\Download` |
| Thumbnail cache | Safe | `Explorer\thumbcache_*.db` |
| Prefetch files | Caution | `C:\Windows\Prefetch` |
| Crash dumps | Safe | WER and CrashDumps folders |
| System and application logs | Caution | `.log`, `.etl`, `.dmp` files |
| Recycle Bin | Caution | The whole bin |
| Old downloads | Risky | Downloads older than 180 days |
| Large files | Risky | Files over 300 MB (deep scan) |
| Duplicate files | Risky | Files with identical content (deep scan) |

## Three layers of AI

1. **Rule engine (always on).** Produces a 0-100 confidence score from category
   risk, file age, size and disk fullness; writes its insights in the selected
   UI language. Needs no internet and always works.
2. **Smart selection.** Given a target such as "free up this many GB", it ranks
   the safest and most effective categories and tries to reach the goal.
3. **Language model (optional).** Connect a local Ollama instance or any
   OpenAI-compatible endpoint and it answers questions in natural language.
   Without one, layer 1 answers instead — the app never depends on a model.

### Connecting OpenAI

Models are added from inside the application: **Settings → AI provider**.

- **Provider:** Automatic / OpenAI / Local (Ollama) / Rule engine only.
  *Automatic* tries the local model, then OpenAI, then the rule engine.
- **API key** is entered once, written to `settings.json` through the operating
  system's encryption vault (DPAPI on Windows) and never returned to the
  interface — only a mask such as `••••abcd` is shown.
- **Endpoint** defaults to `https://api.openai.com/v1` when left empty. Any
  OpenAI-compatible server (LM Studio, vLLM, OpenRouter…) connects through the
  same field.
- **Model** list is read from the `/models` endpoint; the **Test connection**
  button sends a single trial request with the selected model and reports the
  result.

Environment variables are supported; a value in the settings file takes
precedence:

```bat
set AICLEANER_OPENAI_BASE=https://api.openai.com/v1
set AICLEANER_OPENAI_MODEL=gpt-4o-mini
set OPENAI_API_KEY=sk-...
set AICLEANER_OLLAMA_URL=http://127.0.0.1:11434
set AICLEANER_OLLAMA_MODEL=llama3.2
```

## Languages

The interface's source language is **English** (`src/i18n/locales/en.json`);
every other language layers on top like a patch. Shipped translations:
**Turkish, German, French, Spanish** — each carries all 385 keys.

- **Automatic selection.** The language comes from Windows' display language
  (`Settings → Language → System default`). An unsupported Windows language
  (Finnish, for example) opens the interface fully in English; no screen is
  ever left blank.
- **Manual selection.** The Settings → Language list shows only languages with
  a catalogue. The choice is written to `settings.json`.
- **Missing-key fallback.** If a translation lacks a key, the English string is
  used; if that is missing too, the key itself is shown. A half-finished
  translation therefore never breaks the app — only those lines appear in
  English.
- **Numbers and dates** follow the language too: `1,234.5 GB` (en) ↔
  `1.234,5 GB` (tr).
- **Engine text** (category names, insights, rule answers) is translated as
  well; a saved scan opened in another language has its names regenerated.

To add a language, copy `src/i18n/locales/en.json` to `<code>.json` and
translate the strings; the language is already defined in the list inside
`src/i18n/index.js` (e.g. `pl`, `ru`, `zh`, `ja`). Without a catalogue the
language does not appear in the list and falls back to English.

Verify translations and interface consistency:

```bat
npm run check        :: i18n:audit + ui:audit
npm run i18n:audit   :: missing keys, placeholder mismatches, language coverage
npm run ui:audit     :: does every id used by app.js exist in index.html
```

To check a language visually (without writing to settings):

```bat
npx electron . --locale=de --capture=screen.png
```

## Install and run

Requirement: **Node.js 20 or newer** (tested on Node 24).

The easiest path: double-click **`start.bat`**. It installs any missing
dependencies and opens the application.

From the command line:

```bat
npm install
npm start
```

Developer mode (DevTools and verbose logging):

```bat
npm run dev
```

## Packaging (installer)

```bat
npm run dist
```

Produces `release\reMona-1.0.0-setup.exe` (a single-file Windows installer) and
`release\reMona-1.0.0-portable.exe`. If you only want an unpacked folder:

```bat
npm run pack
```

The tray icon and the executable icon come from `build/icon.png`, which is
generated procedurally — regenerate it with:

```bat
npm run icon
```

## Verification

```bat
npm test          :: engine tests (node:test)
npm run smoke     :: read-only scan of the real disk, deletes nothing
node scripts/smoke.js --deep   :: includes large-file and duplicate scanning
```

Visual verification without opening the app by hand (opens the window, writes a
PNG, closes):

```bat
node_modules\electron\dist\electron.exe . --capture=.remona\ui-check.png
```

`npm run smoke` scans the real system and prints a breakdown of disk usage, the
recycle bin, category distribution, the AI summary and the security roots. It
performs no deletion.

## Security model

This application deletes files, so the security model is deliberately narrow.

- **Allow list.** Only files under the category roots defined in
  `src/engine/config.js` can be deleted. No other path is accepted.
- **Block list.** System components such as `System32`, `SysWOW64`, `WinSxS`,
  `Windows\Fonts`, `Windows\System`, `Windows\servicing` and
  `config\systemprofile` are blocked by fragment matching.
- **Root protection.** A drive root, the user folder, and the `Desktop`,
  `Documents`, `Pictures`, `Music`, `Videos` folders *themselves* cannot be
  deleted (files inside them can be).
- **Two-stage verification.** A selection is first reported through `preview`
  (a dry run); during a real cleanup every file passes the security gate again.
- **Quarantine by default.** Files are not deleted but moved under
  `%APPDATA%\reMona AICleaner\data\quarantine\<session>\` and kept with a
  manifest. They can be restored with one click. Permanent deletion is a
  separate, explicit choice.
- **The interface never sees paths.** The list of files to clean never comes
  from the renderer; the renderer sends only category and item identifiers, and
  paths are resolved in the main process from the in-memory scan result. There
  is no Node API, no `require` and no filesystem access in the renderer
  (`contextIsolation: true`, `sandbox: true`).

## Architecture

```
electron/
  main.js        window, IPC channels, scan/clean orchestration
  preload.js     contextBridge: a counted set of powers, ipcRenderer not leaked
src/engine/
  config.js      categories, security boundaries  <- single source of truth
  utils.js       directory walking, globbing, hashing, delete security gate
  scanner.js     category scanners + disk information
  ai.js          confidence score, insights, smart selection, optional LLM
  cleaner.js     quarantine, restore, permanent delete, history
  trash.js       Windows Recycle Bin bridge (PowerShell/COM)
  store.js       settings, history and last-scan store (atomic JSON)
src/renderer/
  index.html     interface skeleton and icon sprite
  styles.css     dark, glass-surfaced theme and motion system
  app.js         views, selection model, IPC calls
scripts/smoke.js engine smoke test (read-only)
tests/           node:test engine tests
```

Data folder: `%APPDATA%\reMona AICleaner\data` (`settings.json`,
`history.json`, `last_scan.json`, `quarantine/`).

This path is pinned explicitly in `electron/main.js` through
`app.setPath('userData', …)`: so that data stays put when the product name
changes, and so that the folder and single-instance lock never collide with
another reMona application installed on the same machine (an IDE, for example).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+R` | Reload the interface |
| `Ctrl+Shift+I` / `F12` | Developer tools |

## Troubleshooting

**The window does not open.** Run `npm start` in a terminal and read the error
message. If the Electron binary is missing, run
`node node_modules\electron\install.js`.

**Scanning is very slow.** With deep scan off (the default) only the fast
categories run. Large files and duplicate files only run in a deep scan.

**The Recycle Bin cannot be read.** This bridge runs through PowerShell. If
group policy blocks it on a managed machine the category appears empty and the
other categories are unaffected.

**The app seems to start and then closes immediately.** If the console says
`Unable to move the cache: Access is denied`, another process is holding the
same `userData` folder. Close the process locking
`%APPDATA%\reMona AICleaner`; for path conflicts see the `USER_DATA_DIR`
definition at the top of `electron/main.js`.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it
covers the development commands, code layout, and the security rules that apply
to any code that deletes files.

**Do not report security vulnerabilities as a public issue.** Follow the
private reporting path in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — Copyright (c) 2026 reMona (AICleaner) contributors.

You may use, modify and distribute the software; the only condition is that you
keep the copyright notice. The software is provided without warranty. It
deletes files: back up anything important and keep quarantine mode on for the
first run.
