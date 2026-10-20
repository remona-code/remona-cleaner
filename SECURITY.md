# Security policy

## Supported versions

| Version | Support |
|---|---|
| 1.x | Supported |

The repository follows a single development line (`main`). Security fixes are
applied to the latest version.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead send a private report through the repository's
**Security → Report a vulnerability** section (GitHub Security Advisories).
Include:

- The affected version and your Windows version,
- Steps to reproduce the problem,
- Expected and actual behaviour,
- A proof of concept (PoC) or log output where available.

The first response target is **7 days** and the fix target is **30 days**. Once
the fix is released we will add your name to the thanks list, if you want.

### Do not put an API key in a report

Do not write an OpenAI or similar provider key into an issue, a log or a
screenshot. If a key has leaked, revoke it from the provider's dashboard first,
then report. The application never returns the key to the interface; it only
shows a `••••abcd` mask.

## Threat model

This application deliberately deletes files. Its most important security goal is
therefore **never to harm the user's system files or personal data.**

In scope:

- Deleting or quarantining a file outside the category allow list by bypassing
  the security gate,
- Using a path that came from the interface in the engine layer without
  validation,
- A quarantined file writing outside its target path, overwriting something, or
  performing path traversal while being restored,
- An IPC surface that crosses the `contextIsolation` / `sandbox` boundary: the
  interface being able to reach the Node API, `require`, or the filesystem,
- A stored API key being written to disk in plain text, or leaking into the
  interface or a third-party service,
- An update or component that is force-downloaded or executed without
  verification.

Out of scope:

- **Running as administrator** by itself. The application does not request
  administrator rights; categories such as `C:\Windows\Temp` are partially
  readable without them.
- Permanent deletion being irreversible — **permanent delete** is an explicit
  user choice and asks for confirmation. The default behaviour is quarantine.
- Windows' own Recycle Bin being emptied through the `--empty` flag being
  something the user asked for. This runs through the COM/PowerShell bridge and
  only on an explicit selection.
- The third-party AI provider's (OpenAI etc.) own privacy policy. Only a **short
  summary** such as file names and sizes is sent to the provider; file contents
  are never sent.

## Security measures in the application

The detailed model is in the **Security model** section of the README. Summary:

- Deletable roots are only the category definitions in `src/engine/config.js`;
  every deletion passes the allow list, block list and root protection check.
- Cleanup has two stages: a dry-run report first, then re-verification for every
  file.
- The interface sends no file paths; it sends only category and item
  identifiers.
- The API key is encrypted with the operating system's encryption vault (DPAPI
  on Windows) and is never returned to the interface.
- Node integration is disabled in the interface (`contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`).
