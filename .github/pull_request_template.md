## What changed

<!-- Short summary. Keep it focused on a single topic. -->

## Why

<!-- Which problem does it solve? Related issue: "Closes #12" -->

## How it was verified

<!-- Which command, which output. "Tests passed" on its own is not enough. -->

```bat
npm test
npm run smoke
```

## Checklist

- [ ] `npm test` passes cleanly
- [ ] `npm run smoke` was run if the engine layer was touched (read-only)
- [ ] No new delete root was added; deletable paths live only in `src/engine/config.js`
- [ ] `contextIsolation` / `sandbox` are preserved and `preload.js` exposes no new filesystem power
- [ ] Before/after screenshots were added if the interface changed
- [ ] The commit message is short and in the imperative mood
- [ ] I agree that my contribution may be published under the MIT license
