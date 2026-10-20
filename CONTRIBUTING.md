# Contributing guide

reMona (AICleaner) welcomes contributions. This file describes the standards a
change is expected to meet. Opening an issue first is a good start even for a
small fix: it keeps two people from doing the same work.

## Requirements

- **Node.js 18 or newer** (development is done on Node 24).
- **Windows 10/11.** The application is Windows-specific: the Recycle Bin bridge
  uses PowerShell/COM and the path assumptions are Windows ones. No work is
  underway on Linux/macOS support.

## Setup

```bat
git clone <repository-url>
cd <project-folder>
npm install
npm start
```

`npm install` downloads the Electron binary (about 235 MB). If you only want to
run the tests, you do not need the binary:

```bat
npm ci --ignore-scripts
npm test
```

## Development commands

| Command | What it does |
|---|---|
| `npm start` | Opens the application |
| `npm run dev` | Opens with DevTools and verbose logging |
| `npm test` | Engine tests (`node:test`) |
| `npm run smoke` | Read-only scan of the real disk; deletes nothing |
| `npm run pack` | Produces an unpacked folder |
| `npm run dist` | Produces the NSIS installer and portable executable |

Visual verification without opening the app by hand — opens the window, writes a
PNG, closes:

```bat
node_modules\electron\dist\electron.exe . --capture=.remona\ui-check.png
```

## Before you change anything

1. **Run the tests.** If `npm test` is not clean, fix that first.
2. **If you changed the engine, run the smoke test too.** `npm run smoke` scans
   the real system and reports numbers; it is read-only.
3. **If you are fixing a bug,** add a test that reproduces it. Tests live under
   `tests/` and are written with `node:test`.

## Security rules for code that deletes files

This application really deletes files. In any contribution that touches the
engine layer the following rules are not negotiable:

- **Do not add a new delete path.** The only deletable roots are the category
  definitions in `src/engine/config.js`. A path that comes from the user or the
  interface is never deleted directly.
- **Do not bypass the security gate.** Every deletion passes the allow list /
  block list / root protection check in `src/engine/utils.js`. A change that
  disables that check "for speed" is not accepted.
- **Leave quarantine as the default.** Permanent deletion is an explicit user
  choice.
- **Do not give the interface filesystem access.** `contextIsolation: true` and
  `sandbox: true` are kept; `preload.js` exposes only a counted set of powers
  and never leaks the `ipcRenderer` object.

If you found a security vulnerability, please do not open an issue — follow the
path in [SECURITY.md](SECURITY.md).

## Code layout

- **Language:** code, comments, documentation and identifiers are English.
  Translated user-facing strings live in `src/i18n/locales/`.
- **Style:** follow the layout of the existing files — 2-space indent, single
  quotes, semicolons. There is no separate formatter configuration; the
  surrounding file is the standard.
- **Comments:** write only a constraint the code itself cannot express (the
  "why", when it is needed). Do not add comments that describe what the code
  does.
- **Dependencies:** do not add runtime dependencies. The application is
  deliberately written with zero runtime dependencies; `electron` and
  `electron-builder` are development dependencies only. If a new dependency is
  genuinely required, justify it in an issue first.

## Commits and pull requests

- Keep the commit message short and in the imperative mood: `fix quarantine
  restore failure`.
- Keep a PR focused on a single topic; split unrelated edits into separate PRs.
- In the PR description write **what** changed and **how you verified it**
  (which command, which output).
- If the change touches the interface, include before/after screenshots.
- Nothing is merged while CI is red.

## License

By submitting a contribution you agree that it may be published under the
repository's [MIT license](LICENSE).
