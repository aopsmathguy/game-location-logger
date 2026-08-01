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
  closest enemy under the user's real cursor. Target positions, velocities
  and the lead point are all computed on the recovered server clock and led
  by the measured round trip — see [Aiming on the clock](#aiming-on-the-clock).
- **Auto-quickswap** — after firing a slow-firerate gun (sniper, pump
  shotgun, etc.) the extension synthesizes a `SwapWeapSlots` input on the
  next server tick so the other gun is ready immediately. "Slow" means a
  gun whose `fireDelay` is at or above a threshold that defaults to 0.5s;
  the in-game settings tab has a slider to retune it live.
- **Netcode smoothing** — survev renders entity motion by lerping over the
  *raw* previous packet gap, so any network jitter makes everything
  alternately sprint and freeze, and a late packet freezes the world until
  it lands. This recovers the server's tick clock by regression and renders
  players against that instead, which removes the stutter and the freezing
  without touching input or gameplay state. Live knobs are in the MOD tab;
  see [Netcode smoothing](#netcode-smoothing) below.
- **Settings tab** — all live-tunable knobs live in a third tab ("MOD") in
  survev's own Escape menu, alongside Settings and Keybinds, built from the
  game's own markup and styles.
- **Ping readout** — live round-trip time above the top-left team panel,
  colour-coded green/amber/red. Read from the RTT samples survev already
  collects (`game.pings`), so it adds no traffic of its own.
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
`dirInterpolationTicker`, `interpolationT`, `updateIntervalGraph`,
`isBindDown`, `isBindPressed`) and the
server-protocol field names on update payloads (`e.pos`, `e.dir`,
`e.activeWeapon`, `e.zoom`, `e.health`, `e.curWeapIdx`, `e.dead`, `e.downed`).
Each derived name is cross-checked against multiple anchors where possible.
If any anchor fails to match, the script aborts naming the specific entry
that broke — that's the signal a regex in `derive_mangled.py` needs a new
fallback.

The script prints an old → new diff and writes a `mangled.js.bak` before
overwriting, so re-running is safe.

## How inject.js finds the game

survev keeps its entire object graph module-private: the app singleton is an
anonymous `Ri = new class { … }` and the Game instance lives on its `game`
field, so neither is reachable by walking from `window`.

**Primary path — `Function.prototype.bind` wrapper.** The app singleton wires
its callbacks through `.bind(this)` (e.g.
`this.onTeamMenuJoinGame.bind(this)` in its own constructor, and
`this.onConfigModified.bind(this)` in `tryLoad`). inject.js installs a thin
wrapper around `Function.prototype.bind` at `document_start`, recognizes the
app by its own class fields (`game`, `pixi`, `config`, `localization`,
`audioManager`, `teamMenu` — all real readable names), keeps the reference,
and uninstalls itself immediately. `app.game` is then re-read live on every
sample tick, so a Game swapped in for a new round is picked up for free.

**Fallback path — `Object.prototype` setter traps.** The original approach:
trap the property names that the Game constructor body assigns from
positional parameters (the `seedNames` list in `mangled.js`), so constructing
a Game fires the setter with `this` == the new instance. This **no longer
fires on current builds**, because they pre-declare every one of those names
as a class field (`var Jr = class { nHb; GHBZo; … }`), and class fields are
installed with `[[DefineOwnProperty]]` before the constructor body runs — the
assignment hits an existing own slot and never walks the prototype chain. It
is kept because it costs nothing and still works on builds that don't declare
their fields. Same for the runtime script-scan that adds extra trap names
(it already skips names it sees declared as class fields).

If the console reports `App singleton not captured`, that's the real
breakage signal: the app's field shape changed. Check
`window.__enemyLocationLogger.getDiagnostics()` for the capture state.

## Netcode smoothing

survev only learns positions from server update packets. On each packet it
records the **raw** gap since the previous one on the camera, and every entity
— players, loot, obstacles, projectiles, the gas circle — renders itself at

```
lerp(clamp(posInterpTicker / camera.interpWindow, 0, 1), visualPosOld, pos)
```

Two things follow the moment the link is imperfect:

1. The window is the gap that *just happened*, applied to the interval it is
   about to be used on. On a link alternating 20/80ms, the client plays the
   80ms intervals back at 4x then sits frozen, and crawls through the 20ms
   ones at quarter speed before snapping. That sprint/freeze alternation is
   the stutter.
2. The `clamp(…, 0, 1)` means a late packet freezes every entity dead until it
   arrives, then teleports it.

`inject.js` replaces that render path with a recovered server clock.

Updates are numbered by arrival, and arrival time is fit against that index
with a slow exponentially-weighted linear regression. The fit gives every
packet a **pseudotime** — when it would have arrived on a jitter-free link.
Players are rendered by lerping between the last two snapshots on that clock:
given `p1@t1` and `p2@t2` in pseudotime,

```
p1 * (t_now - t2)/(t1 - t2) + p2 * (t1 - t_now)/(t1 - t2)
```

which is the standard two-point lerp written over `(t1 - t2)`; the weights sum
to 1 for any `t_now`. Because the clock advances smoothly and is never yanked
by a single late arrival, the discontinuities stop existing rather than being
smoothed away after the fact.

Numbering by arrival is exact here: survev runs over a WebSocket, so TCP
guarantees no loss and no reordering, and the arrival count *is* the tick
index. That would not hold over UDP.

Everything that is not a player — loot, obstacles, projectiles, the gas circle
— still goes through survev's own lerp, so the raw gap it divides by is
replaced with an EWMA of the mean plus an allowance proportional to measured
deviation (`jitterK`). One accessor on one camera field reaches all of them.

### The trade

The lerp is deliberately unclamped, so a stall is extrapolated through rather
than frozen. It is taken half a tick behind the clock (`renderLag`, in ticks)
rather than at `t_now`: rendering at `t_now` exactly means the newest
snapshot's pseudotime is always slightly in the past, so *every* frame leans
past the end of the data, and half a tick of playout centres the render on the
data instead.

Either way it eliminates freezing outright — frozen frames are ~0% on every
link tested, against 16–26% for stock — and on straight-line motion it is close
to perfect: stutter down 92–99% and position error down 5–6x even across 400ms
stalls.

What the playout delay buys, from `netcode_sim.js`:

| | `renderLag` 0 | `renderLag` 0.5 |
| --- | --- | --- |
| jerk vs stock, hard reversals | +443% | +147% |
| jerk vs stock, strafing (clean link) | +458% | +170% |
| shape error, hard reversals | 1.74u | 1.18u |
| overshoot stopping, no stall | 0.167u | 0.025u |
| overshoot stopping, 300ms stall | 2.80u | 2.50u |
| latency vs stock, straight line | 50ms ahead | 17ms ahead |

So about 35ms of the latency lead buys back roughly half the stutter and most
of the stop overshoot, and the render still arrives ahead of stock survev's.
What remains is inherent: during a stall there is no data to interpolate
between, so the renderer extends the last line and is corrected when the stream
resumes. Set `renderLag` to 0 in the MOD tab for the lowest-latency,
highest-overshoot end of the trade; `netcode_sim.js` re-measures both columns
from `inject.js` itself.

Nothing here touches input, packets or gameplay state; it is purely a render
path change, and the master toggle restores stock behaviour live.

## Aiming on the clock

The aim helper reads targets off the same clock and the same per-tick snapshot
rings the renderer draws from, rather than off the 20ms sample ring the logger
keeps.

The reason is motion, not smoothness. Positions arrive at the server tick rate
(~20Hz) and the logger samples them every 20ms, so most sample gaps see the
position unchanged and the occasional one sees a whole tick of movement at
once. Any velocity differenced from that is a comb — runs of zero punched
through by spikes of 2–3x true speed — and every lead point built from it
inherits the spikes. A snapshot pair spans exactly one tick of real motion over
an exactly-known interval, with arrival jitter already taken out by the clock
fit: against a target held at 12 u/s over a link jittering 25ms, the
reconstructed speed comes back as 12.02 u/s.

Aiming is then the same lerp the renderer uses, asked about the future instead
of about now. Both sides of the shot are evaluated at the pseudotime they
actually happen at:

- the shot **spawns** at `t_now + ping` — the input we send now reaches the
  server one one-way delay later, and the state we are looking at left it one
  one-way delay ago, so the world the server resolves the shot in is a full
  round trip ahead of this frame;
- it **connects** at `t_now + ping + travel`.

So with the target's last two snapshots `p1@t1` and `p2@t2`, perfect aim is
that line evaluated at `T = t_now + ping + travel`:

```
p1 * (T - t2)/(t1 - t2) + p2 * (t1 - T)/(t1 - t2)
```

and the point it is aimed *from* is our own line evaluated at `t_now + ping` —
spawn time, not impact time, because the bullet leaves when the input lands and
where we walk during its flight cannot change where it was fired from. `travel`
depends on the answer, so it is solved by fixed-point iteration; three passes
land within a few millimetres. The game is only ever told a direction, so that
firing origin is what the bearing is measured from: over a 100ms round trip at
full sprint it sits a world unit ahead of where we are drawn, which is a couple
of degrees at duel range.

`reactionMs` is latency, not a shorter lead — it is **fake ping**, carried
alongside the real one. A human reacting late is acting on a view of the world
`reactionMs` old, and pays for that by having to lead `reactionMs` further:

```
viewpoint  t_v  = t_now - reactionMs
lead from it     = reactionMs + ping + travel
so            T  = t_v + reactionMs + ping + travel = t_now + ping + travel
```

Both halves are needed. Delaying the view without extending the lead aims
behind every moving target; extending the lead without delaying the view aims
past it. Together they cancel on a target holding a constant velocity — it lies
on the same line either way and is hit exactly — and only a *change* in its
motion is picked up late, which is the humanization. At `reactionMs = 0` the
viewpoint is now, the pair is the newest, and the expression above is exactly
perfect aim.

Against a target reversing at full speed, with ping and bullet flight taken out
so the reaction term stands alone (`travel` hitscan, `ping` 0):

| ms after reversal | aim y, `reactionMs` 140 | aim y, `reactionMs` 0 | target y |
| --- | --- | --- | --- |
| 0 | 11.84 | 11.84 | 12.00 |
| 50 | 12.46 | 12.46 | 11.40 |
| 100 | 13.04 | 10.96 | 10.80 |
| 150 | 13.66 | 10.34 | 10.20 |
| 200 | 9.76 | 9.76 | 9.60 |

The lagged column keeps committing to the pre-reversal line for a reaction
time, overshooting by up to ~3.5 units, and then snaps onto the new one; the
zero column turns as soon as the packet lands. Both lead slightly ahead of the
drawn position even at zero ping, because the newest snapshot's pseudotime is
always a little in the past — the same property the renderer has.

The RTT is the one survev already measures for its own debug HUD (`game.pings`),
the same source as the ping readout. `pingLeadK` scales it: 1 (the default) is
right for a server that resolves shots when the input lands; set it to 0
against a server that rewinds (lag compensation), where the shot is judged
against the world we actually saw and any ping lead is pure overshoot.

Target *selection* and the screen↔world conversions use clock positions too,
so the cheat engages the enemy whose sprite is under the cursor, and the
bearing it sends is measured from the position the camera is actually centred
on. Every lookup falls back to the sample ring when the clock can't answer —
still converging, an enemy that just came into view, or `clockAim` switched
off — so nothing depends on the clock being ready. `window.__aimDiag()` reports
which path is live, the three lead terms in ms, and how far ahead of the drawn
sprite the crosshair is being placed.

## Notes

- Injects at `document_start` in all frames; `world: "MAIN"` so it runs in
  the page's own JS context (required to read non-extension-exposed objects).
- The overlay canvas is appended to the page body; it doesn't interfere
  with the game's own canvas.
- The aim helper is bound to **Shift** (hold to engage); the auto-quickswap
  is keybind-agnostic and triggers off the user's real Fire bind.
- Netcode smoothing swaps two fields for accessors — the camera's
  interpolation window, and each Player's interpolated position. Both are
  installed per *instance* rather than on a prototype, because survev declares
  them as class fields, so an own data property would shadow anything put on
  the prototype (the same mechanism that broke the constructor setter traps).
- The ping readout inserts one `pointer-events:none` element as the first
  child of `#ui-top-left`, above `#ui-team`.
- Sample JSON schema lives in `sample.json` — keys: `ts`, `self`, `enemies[]`.
