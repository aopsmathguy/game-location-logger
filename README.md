# enemy-location-logger

Chrome extension that injects into [survev.io](https://survev.io), reads the
live in-memory game state, and exposes it for analysis, an enemy overlay, an
aim helper, and weapon quickswap. Intended for red-teaming the user's own
authorized deployment of survev.

## Features

- **Enemy overlay** — every visible enemy is drawn as a marker on a canvas
  overlaid on the page, with position, velocity, weapon, and status.
- **Aim helper** — held Shift suppresses real mouse events and dispatches
  randomized aim points each frame; a committed-target aimbot tracks the
  closest enemy under the user's real cursor.
- **Auto-quickswap** — after firing a slow-firerate gun (sniper, pump
  shotgun, etc.) the extension synthesizes a `SwapWeapSlots` input on the
  next server tick so the other gun is ready immediately.
- **Position log** — periodic snapshots of self + enemy positions are sent
  to the service worker; click the toolbar icon to export as JSON
  (see `sample.json` for the schema).

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Architecture

Three layers, wired up by `manifest.json`:

| File | World | Role |
| --- | --- | --- |
| `mangled.js` | MAIN | Single dictionary mapping semantic names (`netData`, `localPlayer`, `inputBinds`, …) to the bundle's current mangled identifiers. Auto-generated. |
| `inject.js` | MAIN | All gameplay logic. Reads every mangled name through `window.__SURVEV_MANGLED__`. |
| `content.js` | Isolated | Bridges `window.postMessage` from inject.js to the service worker. |
| `background.js` | Service worker | Buffers samples, drives the toolbar badge, handles JSON export. |

`mangled.js` runs before `inject.js` in the same content_scripts entry, so the
dictionary is on `window` by the time inject.js's IIFE reads it.

## Updating mangled names when survev redeploys

survev re-mangles its bundle on every deploy: readable TypeScript field names
like `m_netData`, `m_localData`, `m_pos` become short opaque identifiers
(`qJm`, `TXaUHs`, `lxf`, …) that change every build. When that happens,
features that depend on those fields silently break.

`mangled.js` is the single source of truth, and two Python scripts regenerate
it from a fresh bundle:

```sh
pip install jsbeautifier              # one-time
python fetch_survev_js.py             # downloads the current bundle into js_dump/
python derive_mangled.py              # re-derives mangled.js from js_dump/
# reload the extension in chrome://extensions
```

`derive_mangled.py` doesn't pin to mangled names; it anchors every entry on
*stable readable patterns* survev keeps un-mangled — class field declarations
(`bodySprite`, `helmetSprite`, `gunSwitchCooldown`, `anonPlayerNames`,
`debugHUD`, `playerPool`, `onJoin`/`onQuit`, `posInterpTicker`,
`dirInterpolationTicker`, `isBindDown`, `isBindPressed`) and the
server-protocol field names on update payloads (`e.pos`, `e.dir`,
`e.activeWeapon`, `e.zoom`, `e.health`, `e.curWeapIdx`, `e.dead`, `e.downed`).
Each derived name is cross-checked against multiple anchors where possible.
If any anchor fails to match, the script aborts naming the specific entry
that broke — that's the signal a regex in `derive_mangled.py` needs a new
fallback.

The script prints an old → new diff and writes a `mangled.js.bak` before
overwriting, so re-running is safe.

## How inject.js finds the game

survev keeps its `Rr` (Game) instance in a module-private `var` that's not
reachable from `window`. inject.js installs setter traps on
`Object.prototype` for the property names that the `Rr` constructor body
assigns from positional parameters (the `seedNames` list in `mangled.js`),
so the first time any `Rr` is constructed, the trap fires with `this` ==
the new game instance and we capture it. A runtime script-scan adds extra
trap names from any class on the page whose constructor matches the same
pattern, for cases where positional-param names change but the structure
doesn't.

## Notes

- Injects at `document_start` in all frames; `world: "MAIN"` so it runs in
  the page's own JS context (required to read non-extension-exposed objects).
- The overlay canvas is appended to the page body; it doesn't interfere
  with the game's own canvas.
- The aim helper is bound to **Shift** (hold to engage); the auto-quickswap
  is keybind-agnostic and triggers off the user's real Fire bind.
- Sample JSON schema lives in `sample.json` — keys: `ts`, `self`, `enemies[]`.
