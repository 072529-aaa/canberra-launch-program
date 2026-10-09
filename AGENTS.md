# Project Instructions

## Goal

Keep the prototype playable before adding breadth. The primary quality bar is:

1. A player can build, launch, observe, recover or fail, and understand why.
2. Physics rules remain deterministic and testable outside the browser.
3. UI changes must not hide or bypass economy and mission rules.

## Commands

```powershell
python serve.py
node --test tests/*.test.mjs
node --check src/app.js
```

## Architecture Rules

- Keep pure physics and economy logic in `src/physics.js`, `src/craft.js`, `src/missions.js`, and `src/state.js`.
- Do not move authoritative simulation calculations into rendering code.
- Use fixed simulation steps. Browser frame rate may change step count, not the physical model.
- New parts belong in `src/data.js`; do not scatter part definitions through UI code.
- New mission objectives need an evaluator in `src/missions.js` and a focused test.
- Preserve local-storage compatibility by merging persisted state with defaults.

## Scope Rules

- Must not regress the sounding-rocket success path.
- Must keep the initial blueprint launchable and recoverable.
- Prefer one complete objective over several partial menus.
- Mark 3D, N-body gravity, robotics, docking, and multiplayer as deferred until the MVP loop is stable.

## Verification

Before finishing a feature:

1. Run the Node test suite.
2. Syntax-check `src/app.js`.
3. Load the page through a local server.
4. Verify the affected screen in desktop and mobile viewports.
5. For canvas changes, confirm the canvas contains non-background pixels.
