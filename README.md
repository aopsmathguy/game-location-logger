# enemy-location-logger

Chrome extension that injects into [survev.io](https://survev.io), reads the
live in-memory game state, and exposes it for analysis, an enemy overlay, an
aim helper, and weapon quickswap. Intended for red-teaming the user's own
authorized deployment of survev.

## Features

The aim helper, enemy overlay, bank shots and auto-quickswap all ship **off**
and are turned on from the MOD tab; until then the game plays as stock survev.
The netcode smoothing, ping readout and enemy name tags are on by default —
none of them touches input or gameplay state.

- **Enemy overlay** — every visible enemy is drawn as a marker on a canvas
  overlaid on the page, with position, velocity, weapon, and status. Toggled
  by the "ESP overlay" button in the MOD tab; turning it off only stops the
  drawing, sampling and aim keep running. Enemies you have no shot on are
  faded out — see [Fading out blocked enemies](docs/bullets.md#fading-out-blocked-enemies).
- **ESP** — stops anything you can see or shoot through from covering what you
  can't: building roofs come off, so a house shows its inside, and bushes,
  destroyed-obstacle rubble, tree canopies and smoke are all faded to the same
  `0.3` so whoever is standing under them isn't hidden. A display switch in the
  MOD tab's ESP section, off by default and independent of the overlay toggle
  above it; see [ESP render](docs/esp.md#esp-render).
- **Enemy name tags** — every enemy's name is drawn under their sprite in red,
  the same label the game already draws under a teammate in cyan. "Enemy
  names" in the MOD tab turns them off; on by default, and independent of the
  overlay. See [Enemy name tags](docs/name-tags.md#enemy-name-tags).
- **Bank shots** — when a wall is in the way, the aim helper looks for a
  one-bounce path off a reflecting surface and takes that instead. Off by
  default, as is "Prefer banks", which hunts for a bounce even when the direct
  line is open; see [Bank shots](docs/bank-shots.md#bank-shots).
- **Aim helper** — once enabled by the "Aimbot" button in the MOD tab, holding
  the aimbot key (Shift by default, rebindable on the row below it) suppresses
  real mouse events and dispatches aim points each frame, onto whichever enemy
  is nearest the user's cursor — recomputed every frame, with no commitment,
  and counting a just-killed one as alive until its linger timer is up. If that
  enemy has no shot on them, it does nothing at all and
  replays the real cursor instead. Target positions, velocities and the lead
  point are all computed on the recovered server clock and led by the measured
  round trip — see [Aiming on the clock](docs/aiming.md#aiming-on-the-clock).
- **Whitelist** — a multi-line box in the MOD tab, one player name per line.
  Anyone on it is never aimed at and never shot at; see
  [The whitelist](docs/aiming.md#the-whitelist).
- **Autoshoot** — shoots exactly while the shot is on and stops the moment it
  isn't, at whatever cadence the gun allows: holding an automatic, tapping a
  semi-auto, or shot-then-quickswap for a slow one. See
  [Autoshoot](docs/autoshoot.md#autoshoot). Off by default. It interrupts a reload to fire
  what is already loaded, but leaves an empty gun alone to finish reloading.
- **Dodge bot** — while a live bullet is on course to hit us, the movement
  keys are taken over and steered out of the way; the moment the user's own
  course is clear again they are handed straight back. Every bullet in the
  air is solved exactly, as a moving-circle quadratic rather than a sampled
  path, so nothing tunnels; rounds that will die on a wall first are ignored,
  so it doesn't walk out of cover. Each round is priced at what it would
  actually take off us in HP, falloff and reflects included, so the plan that
  eats an MP5 round to stay out of an AWC's line is the cheap one. Off by
  default, "Dodge bot" in the MOD
  tab. It wins ranged exchanges and does nothing at knife range — see
  [Dodge bot](docs/dodge-bot.md#dodge-bot) for why that is a property of the game and not of
  the implementation. Enemies aimed at us are a cost of their own, so it steers
  off firing lines before anything is fired — see
  [Firing lines](docs/dodge-bot.md#firing-lines). It searches when the world it planned against
  has actually changed and holds the course it found in between, which is a
  fifth to a third as much searching for the same play — see
  [Deciding at the rate the news arrives](docs/dodge-bot.md#deciding-at-the-rate-the-news-arrives).
  "Show plan" draws the path the search actually chose on the overlay, with the
  legs already spent faded — see [Watching the plan](docs/dodge-bot.md#watching-the-plan).
- **Auto-quickswap** — after firing a slow-firerate gun (sniper, pump
  shotgun, etc.) the extension synthesizes a `SwapWeapSlots` input on the
  next server tick so the other gun is ready immediately. "Slow" means a
  gun whose `fireDelay` is at or above a threshold that defaults to 0.5s;
  the MOD tab has an on/off button and a slider to retune the threshold live.
- **Netcode smoothing** — survev renders entity motion by lerping over the
  *raw* previous packet gap, so any network jitter makes everything
  alternately sprint and freeze, and a late packet freezes the world until
  it lands. This recovers the server's tick clock by regression and renders
  players against that instead, which removes the stutter and the freezing
  without touching input or gameplay state. Live knobs are in the MOD tab;
  see [Netcode smoothing](docs/netcode.md#netcode-smoothing) below.
- **Settings tab** — all live-tunable knobs live in a third tab ("MOD") in
  survev's own Escape menu, alongside Settings and Keybinds, built from the
  game's own markup and styles. Every value persists in `localStorage` under
  `elg_settings` and is validated against its own spec on load, so a stale or
  hand-edited entry can't drop a `NaN` into the aim or netcode paths.
- **Ping readout** — live round-trip time above the top-left team panel,
  colour-coded green/amber/red. Read from the RTT samples survev already
  collects (`game.pings`), so it adds no traffic of its own, and averaged with
  the same decayed-moment EWMA the clock regression runs on — an 8-sample
  half-life, so about the twelve samples the old median held, with no window
  edge. The aim lead and the dodge bot's threat advance read the same number.
- **Debug render** — the "Debug" button in the MOD tab throws the game's art
  away and draws the collision geometry instead: white ground under the map's
  own grid, water in the map's own colour, every collidable object as a filled
  borderless rectangle or circle exactly matching its collider, and every
  player as a one-colour circle at the collision radius, drawn at the same
  smoothed position the sprite would have been. Off by default; see
  [Debug render](docs/debug-render.md#debug-render).
- **Position log** — periodic snapshots of self + enemy positions are sent
  to the service worker; click the toolbar icon to export as JSON
  (see `docs/sample.json` for the schema).

## Install

Two ways to run the toolkit. Both load the same `extension/core/mangled.js`
and `extension/core/inject.js` — see [Repository layout](#repository-layout).

**As a Chrome extension**

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

**As a local mirror** (no extension install, and editing `extension/core/inject.js` +
reloading the page is the whole edit loop)

```sh
cd webapp && npm start        # then open http://localhost:8080
```

See [webapp/README.md](webapp/README.md) for how the mirror works.

## Repository layout

```
extension/       manifest, content script, service worker
extension/core/  inject.js + mangled.js — the toolkit, shared by both consumers
webapp/          reverse-proxy mirror that serves survev with core/ injected
tools/           fetch_survev_js.py, derive_mangled.py
tests/           netcode_sim.js
docs/            design notes, sample log schema
js_dump/         bundle cache (gitignored) — repopulated by tools/fetch_survev_js.py
```

The shared toolkit lives *inside* `extension/` rather than beside it, because
Chrome resolves content-script paths against the extension root and refuses any
that escape it. `extension/core` was previously a symlink to a top-level
`core/`; Chrome follows symlinks on an unpacked load, but only while they stay
within the root, so the two scripts silently never injected — the extension
loaded, the service worker started, and nothing ran on the page. Keeping the
real directory under `extension/` costs the mirror nothing: `webapp/server.js`
reads the files straight off disk through a single `CORE_DIR` constant.

## Architecture

Three layers, wired up by `extension/manifest.json`:

| File | World | Role |
| --- | --- | --- |
| `extension/core/mangled.js` | MAIN | Single dictionary mapping semantic names (`netData`, `localPlayer`, `inputBinds`, …) to the bundle's current mangled identifiers. Auto-generated. |
| `extension/core/inject.js` | MAIN | All gameplay logic. Reads every mangled name through `window.__SURVEV_MANGLED__`. |
| `extension/content.js` | Isolated | Bridges `window.postMessage` from inject.js to the service worker. |
| `extension/background.js` | Service worker | Buffers samples, drives the toolbar badge, handles JSON export. |

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
pip install -r tools/requirements.txt   # one-time
python tools/fetch_survev_js.py        # downloads the current bundle into js_dump/
python tools/derive_mangled.py         # re-derives extension/core/mangled.js
# reload the extension in chrome://extensions (the mirror picks it up on reload)
```

`derive_mangled.py` doesn't pin to mangled names; it anchors every entry on
*stable readable patterns* survev keeps un-mangled — class field declarations
(`bodySprite`, `helmetSprite`, `gunSwitchCooldown`, `anonPlayerNames`,
`debugHUD`, `playerPool`, `onJoin`/`onQuit`, `posInterpTicker`,
`dirInterpolationTicker`, `interpolationT`, `updateIntervalGraph`,
`isBindDown`, `isBindPressed`) and the
server-protocol field names on update payloads (`e.pos`, `e.dir`,
`e.activeWeapon`, `e.zoom`, `e.health`, `e.curWeapIdx`, `e.dead`, `e.downed`).
Each derived name is cross-checked against multiple anchors where possible.
If any anchor fails to match, the script aborts naming the specific entry
that broke — that's the signal a regex in `derive_mangled.py` needs a new
fallback.

The script prints an old → new diff and writes an `extension/core/mangled.js.bak` before
overwriting, so re-running is safe.

The mirror does this by itself. `webapp/server.js` watches the bundle hashes in
the HTML it proxies, and when survev redeploys it re-runs both scripts before
serving the next `mangled.js` — see
[Regenerating mangled.js](webapp/README.md#regenerating-mangledjs).

## Documentation

Each feature's design notes, and why it works the way it does:

| Doc | What it covers |
| --- | --- |
| [docs/hooking.md](docs/hooking.md) | How `inject.js` gets a handle on the running game |
| [docs/esp.md](docs/esp.md) | The enemy overlay: roofs, bushes, canopies, smoke, sprite handback |
| [docs/bullets.md](docs/bullets.md) | Bullet-blocking geometry — which obstacles stop a shot, and which reflect it |
| [docs/bank-shots.md](docs/bank-shots.md) | One-bounce firing solutions off reflecting surfaces |
| [docs/aiming.md](docs/aiming.md) | Aiming on the recovered clock, target selection, the whitelist |
| [docs/autoshoot.md](docs/autoshoot.md) | When the trigger pulls itself |
| [docs/dodge-bot.md](docs/dodge-bot.md) | Solving incoming bullets and planning a way out of them |
| [docs/netcode.md](docs/netcode.md) | Clock recovery and smoothing, and the trade it makes |
| [docs/name-tags.md](docs/name-tags.md) | Enemy name tags |
| [docs/debug-render.md](docs/debug-render.md) | The debug overlay |
| [docs/sample.json](docs/sample.json) | Position-log schema |

## Notes

- Injects at `document_start` in all frames; `world: "MAIN"` so it runs in
  the page's own JS context (required to read non-extension-exposed objects).
- The overlay canvas is appended to the page body; it doesn't interfere
  with the game's own canvas.
- The aim helper defaults to **Shift** (hold to engage) and is rebindable from
  the Aimbot row in the MOD tab, which is survev's own keybind row — same
  markup, same key names, same rules: click to arm, Escape cancels, Backspace
  unbinds (leaving the aimbot off), and Ctrl/Alt/Win/Menu/F1–F12 are refused.
  Binds are stored as legacy `keyCode`, so left and right modifiers are one
  key. Mouse buttons aren't bindable — survev's rows accept them, ours don't.
  The auto-quickswap is keybind-agnostic and triggers off the user's real
  Fire bind.
- Netcode smoothing swaps three fields for accessors — the camera's
  interpolation window, and each Player's interpolated position and
  interpolated aim direction. The two Player fields are installed per
  *instance* rather than on a prototype, because survev declares them as class
  fields, so an own data property would shadow anything put on the prototype
  (the same mechanism that broke the constructor setter traps). It also wraps
  the bullet barn's render pass — on the prototype, since a new round builds a
  fresh barn off the same class — to draw each round at the same instant the
  players are drawn at; that rides the same `Smoothing` switch and restores the
  positions before the frame ends.
- The ping readout inserts one `pointer-events:none` element as the first
  child of `#ui-top-left`, above `#ui-team`.
- Sample JSON schema lives in `docs/sample.json` — keys: `ts`, `self`, `enemies[]`.
