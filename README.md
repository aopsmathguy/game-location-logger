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
  faded out — see [Fading out blocked enemies](#fading-out-blocked-enemies).
- **ESP** — stops anything you can see or shoot through from covering what you
  can't: building roofs come off, so a house shows its inside, and bushes,
  destroyed-obstacle rubble, tree canopies and smoke are all faded to the same
  `0.3` so whoever is standing under them isn't hidden. A display switch in the
  MOD tab's ESP section, off by default and independent of the overlay toggle
  above it; see [ESP render](#esp-render).
- **Enemy name tags** — every enemy's name is drawn under their sprite in red,
  the same label the game already draws under a teammate in cyan. "Enemy
  names" in the MOD tab turns them off; on by default, and independent of the
  overlay. See [Enemy name tags](#enemy-name-tags).
- **Bank shots** — when a wall is in the way, the aim helper looks for a
  one-bounce path off a reflecting surface and takes that instead. Off by
  default, as is "Prefer banks", which hunts for a bounce even when the direct
  line is open; see [Bank shots](#bank-shots).
- **Aim helper** — once enabled by the "Aimbot" button in the MOD tab, holding
  the aimbot key (Shift by default, rebindable on the row below it) suppresses
  real mouse events and dispatches aim points each frame, onto whichever enemy
  is nearest the user's cursor — recomputed every frame, with no commitment,
  and counting a just-killed one as alive until its linger timer is up. If that
  enemy has no shot on them, it does nothing at all and
  replays the real cursor instead. Target positions, velocities and the lead
  point are all computed on the recovered server clock and led by the measured
  round trip — see [Aiming on the clock](#aiming-on-the-clock).
- **Whitelist** — a multi-line box in the MOD tab, one player name per line.
  Anyone on it is never aimed at and never shot at; see
  [The whitelist](#the-whitelist).
- **Autoshoot** — shoots exactly while the shot is on and stops the moment it
  isn't, at whatever cadence the gun allows: holding an automatic, tapping a
  semi-auto, or shot-then-quickswap for a slow one. See
  [Autoshoot](#autoshoot). Off by default. It interrupts a reload to fire
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
  [Dodge bot](#dodge-bot) for why that is a property of the game and not of
  the implementation. Enemies aimed at us are a cost of their own, so it steers
  off firing lines before anything is fired — see
  [Firing lines](#firing-lines). It searches when the world it planned against
  has actually changed and holds the course it found in between, which is a
  fifth to a third as much searching for the same play — see
  [Deciding at the rate the news arrives](#deciding-at-the-rate-the-news-arrives).
  "Show plan" draws the path the search actually chose on the overlay, with the
  legs already spent faded — see [Watching the plan](#watching-the-plan).
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
  see [Netcode smoothing](#netcode-smoothing) below.
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
  [Debug render](#debug-render).
- **Position log** — periodic snapshots of self + enemy positions are sent
  to the service worker; click the toolbar icon to export as JSON
  (see `docs/sample.json` for the schema).

## Install

Two ways to run the toolkit. Both load the same `core/mangled.js` and
`core/inject.js` — see [Repository layout](#repository-layout).

**As a Chrome extension**

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

**As a local mirror** (no extension install, and editing `core/inject.js` +
reloading the page is the whole edit loop)

```sh
cd webapp && npm start        # then open http://localhost:8080
```

See [webapp/README.md](webapp/README.md) for how the mirror works.

## Repository layout

```
core/       inject.js + mangled.js — the toolkit, shared by both consumers
extension/  manifest, content script, service worker; core/ is a symlink
webapp/     reverse-proxy mirror that serves survev with core/ injected
tools/      fetch_survev_js.py, derive_mangled.py
tests/      netcode_sim.js
docs/       sample log schema
js_dump/    bundle cache (gitignored) — repopulated by tools/fetch_survev_js.py
```

`core/` is deliberately not inside `extension/`: the mirror serves the same two
files, and neither consumer should have to reach into the other. The extension
picks them up through an `extension/core` symlink, which Chrome follows on an
unpacked load.

## Architecture

Three layers, wired up by `extension/manifest.json`:

| File | World | Role |
| --- | --- | --- |
| `core/mangled.js` | MAIN | Single dictionary mapping semantic names (`netData`, `localPlayer`, `inputBinds`, …) to the bundle's current mangled identifiers. Auto-generated. |
| `core/inject.js` | MAIN | All gameplay logic. Reads every mangled name through `window.__SURVEV_MANGLED__`. |
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
python tools/derive_mangled.py         # re-derives core/mangled.js from js_dump/
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

The script prints an old → new diff and writes a `core/mangled.js.bak` before
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

## Bullet-blocking geometry

survev has no separate "wall" entity. Every solid thing in the world — walls,
trees, crates, rocks, barrels, bunker stairwells — is an **Obstacle**;
buildings and structures carry only ceilings, floors and stair volumes, none of
which stop a bullet. So the client's obstacle pool *is* the bullet collision
set, plus players.

The pool lives on `game.map` (a readable field) under a mangled name alongside
the building and structure pools, so `inject.js` identifies it by what its
entries are rather than by what it is called: the Obstacle class declares
`collider`, `collidable`, `dead`, `height`, `layer`, `isWindow`, `isWall`,
`isDoor`, `isBush` and `type` under real readable names that survive
re-mangling. Nothing here needs a new `mangled.js` entry — the only mangled
name on the path is the pool's `getAll`, which is already there.

`collider` is already in world space: the Obstacle rebuilds it on every update
as `collider.transform(def.collision, pos, oriToRad(ori), scale)`, and since
`ori` is a quarter-turn count, a rotated AABB stays axis-aligned. So the only
two shapes that ever come back are

```
{ type: 0, pos: {x, y}, rad }          circle
{ type: 1, min: {x, y}, max: {x, y} }  aabb
```

A door's `pos`/`ori` are resent when it swings, so its collider tracks the open
state for free. `getAll()` returns the pool's raw backing array including
recycled-but-inactive entries, so every read filters on `active`.

Whether a given obstacle stops a shot is the game's own test, lifted from its
bullet path: `active && !dead && collidable && !isWindow && height >=
GameConfig.bullet.height (0.25) && sameLayer(shooterLayer, obstacleLayer)`.
Note `sameLayer` — not the `canInteract` rule used for target eligibility. The
two disagree for a shooter on a stairs layer: `canInteract` says a player on
layer 2/3 can engage anything, but `sameLayer(2, 1)` is false, so ground-floor
obstacles are the ones that block them.

### Which ones reflect

166 of survev's 724 obstacle types bounce a bullet instead of eating it —
metal walls, barrels, lockers, vault doors, shipping-container walls,
appliances, airdrop crates. That is `reflectBullets` on the obstacle def, and
unlike the fields above it is **not** copied onto the client Obstacle:
`thAfw` keeps `collidable`, `destructible`, `height`, `isWall`, `isWindow`,
`isBush` and the door/button blocks and drops the rest, and the def module is
bundle-private. What the instance does keep is `type`, so `inject.js` carries a
static `REFLECTS_BULLETS` set keyed on the type string. Type names are content,
not identifiers, so they survive re-mangling — this list only goes stale when
survev ships new map objects, not on every deploy (same deal as
`GUN_BULLET_SPEED`).

It was derived offline by evaluating the definitions chunk's def factories
rather than regexing them: slice out the factory run plus the `MapObjectDefs`
table, eval it inside a `with (proxy)` scope that stubs every free identifier,
supply real `mergeDeep`/collider/vec implementations, then read
`reflectBullets` off each merged def. All 724 obstacle defs carry the flag
explicitly (none inferred), and every one of the 166 reflectors is also
collidable, non-window and at least bullet-height — so **every reflector is
also a blocker**.

That last point is the thing to keep straight: reflection is not
pass-through. A reflector between you and a target is cover that shoots back,
and the near face of one is somewhere to bank a shot from; it never means the
line is clear. Reflection is decided server-side — the client is only told
after the fact, via `reflectCount`/`reflectObjId` on the bullet — and is capped
at `GameConfig.bullet.maxReflect` (3) with damage decaying by
`reflectDistDecay` (1.5). A player carrying a pan is a reflector too, equipped
or stowed, but that's a player rather than map geometry.

`segHitCircle`/`segHitAabb` are ports of `collider.intersectSegment`'s two
branches, kept faithful to the game's arithmetic including its epsilon nudge
for axis-parallel segments. Checked differentially against the bundle's own
implementations over 800k random segments: no hit/miss disagreement, worst
distance error 9e-9 world units.

From the console:

```js
__wallDiag()                       // capture state, blocker/reflector counts on my layer
__bulletGeom.list()                // plain-object snapshot of the collision set
__bulletGeom.list(0)               // only what blocks a shot fired on layer 0
__bulletGeom.firstHit(x0,y0,x1,y1,layer[,minDist])  // nearest blocker, or null
__bulletGeom.los(x0,y0,x1,y1,layer[,minDist])       // true if the line is clear
__bulletGeom.reflects(obstacle)    // does this one bounce bullets?
__bulletGeom.reflectorTypes        // the whole reflecting-type set
__bulletGeom.bank(x0,y0,tx,ty[,layer])              // one-bounce solve, static target
```

Entries from `list()` carry `blocksBullets` and `reflectsBullets` alongside
their shape; `firstHit()` reports `type`, `reflects`, `dist` and the entry
point.

`minDist` drops hits closer than that to the origin: a shot origin sitting
inside a collider (hugging a wall, or the barrel offset pushing the muzzle into
one) otherwise reports distance 0 and reads as permanently blocked.

### Fading out blocked enemies

The overlay tests, per enemy per frame, whether anything solid stands in the
way of the shot — and fades the ring and its connecting line to
`ESP.blockedAlpha` when something does. That defaults to the same 0.5 an
enemy on an unreachable layer already fades to: both mean "no shot on this
one", so they read as the same state rather than as a hierarchy of two
different problems. "Dim blocked" and "Blocked fade" in the MOD tab's ESP
section turn it off and retune the alpha; it defaults on, and only shows once
the overlay itself is on.

The segment tested is **the shot the aimbot would actually take, not the one on
screen**: from our own position extrapolated to when the input lands, to the
target's position extrapolated to when the bullet arrives — both straight off
`reactionTarget`, the same solver `dispatchAim` steers by, reaction delay and
ping lead included. Testing the drawn positions instead would disagree with the
shot by a round trip plus flight time, which at duel range is exactly the
interval in which someone runs behind a tree.

Blocking is judged on our own layer, since that is the layer the bullet is
fired on. Enemies unreachable outright (a bunker while we're aboveground) are
already dimmed by the existing `canInteract` rule, and the two fades compose —
an unreachable enemy is never LOS-tested in the first place, so at the default
alpha the two paths land on the same 0.5 either way.

A ring with no shot behind it also gets **no connecting line**, whichever
reason applies. The line means "this one is takeable", so drawing a faded one
would say the opposite twice over. The committed target keeps its centre tick
either way — it is still the target — but loses its line too when there's
nothing to take.

One guard matters: hits closer to the origin than `GameConfig.player.radius`
(1 unit) are ignored. Collision resolution guarantees a real player centre is
never nearer than that to a collidable surface, so a blocker inside that radius
is one we are *inside* — which only happens when the origin has been
extrapolated into geometry (sprinting at a wall pushes it up to ~2.4 units
forward over a 200ms reaction plus ping). Without the guard that reads as
"blocked" against every enemy on screen. A wall you are genuinely pressed
against still registers, at ~1 unit, because the test is `>=`.

Both sweeps reject on a bounding-box overlap before running the exact
intersection, and the yes/no sweep stops at the first blocker rather than
sorting for the nearest, which is what keeps a per-enemy-per-frame call cheap
against a few hundred streamed obstacles.

## Bank shots

A walled-off enemy isn't necessarily a safe one: survev bounces bullets off
`reflectBullets` surfaces, so a metal wall you can see is a shot at someone you
can't. When the direct line fails, `reactionTarget` goes looking for a
one-bounce path, and if it finds one it returns **the mirrored point as the
thing to aim at** — so the glide, the bearing and the overlay need no idea the
shot is going the long way round. "Bank shots" in the MOD tab turns it on; it
ships **off**, like the rest of the cheats, and with it off a blocked target
just gets shot at through the wall.

**"Prefer banks"** (also off by default) looks for a bounce even when the direct
line is wide open, which turns the fallback into a trick-shot mode: the bounce
is taken whenever the geometry offers one inside the path-length cap below, and
only a target with no usable surface anywhere near it gets shot at straight.
This is strictly worse aim — a longer flight, a bigger lead, and the damage
decay survev applies to a reflected bullet — so it is worth turning on because
it is funny, not because it is good. It also moves the search cost from "per
blocked enemy" to "per enemy", which the numbers below cover. It does nothing
unless "Bank shots" is on.

### The mirror trick

Reflecting the *target* across the plane of a face turns the two-leg path into
one straight segment. Where `P → E'` crosses the plane is exactly the point a
bullet aimed at `E'` bounces from to arrive at `E`, and `|P - E'|` is the whole
path length — which is also the number the lead solver wants for flight time.
So one construction gives the aim point, the bounce point and the travel
distance at once.

A face is a candidate only if **both** ends sit strictly outside its plane: a
specular bounce can't reach a target behind the surface it bounces off, and
that same test is what rules out the box's three other faces. The crossing then
has to land within the face's finite extent.

Nothing re-checks that the bullet meets *that* face rather than another of the
same box. With P strictly outside the plane and the crossing inside the face's
extent, the whole incoming leg lies in that plane's outside half-space, so it
can only touch the box at the bounce point. That is worth stating because the
obvious defensive check is actively harmful: probed over 54k random candidates,
an explicit entry-point test never once caught a real case and rejected 5% of
valid ones, on the floating-point tie of a segment ending exactly on a
boundary. A circle is convex and its bounce point is on the arc both ends can
see, so the same holds there.

All of the above is the AABB case; a circle needs a different solve, below.

### Lead and cost

Path length and lead are solved together. A different surface means a different
path length means a different flight time means a different lead, so each
candidate runs its **own** fixed point (the same three passes as the direct
solve) before it is validated — rather than the search running once against a
single guessed lead. Both legs are then checked for blockers with the reflector
itself excluded, since both touch it by construction.

Candidates are tried shortest-path-first and the first survivor wins, so the
expensive part — two line-of-sight sweeps — normally runs once. Two further
bounds keep a bad scene bad-but-bounded: at most 12 faces are validated, and a
path more than 3× the direct distance is dropped outright, since a bounce that
long arrives late, arrives weak (survev decays reflected damage over the extra
distance) and is aimed on a lead that stopped being a prediction. That cap is
also what stops "prefer banks" from taking absurd shots.

Measured per solve: **0.6µs** in the open with one reflector, ~95–155µs in a
deliberately pathological 300-obstacle scene with 75 reflective walls where
nothing validates. With "prefer banks" off that is paid once per *blocked*
enemy per frame; with it on, once per enemy per frame.

### Bouncing off a circle

A circle has no mirror plane, so the mirror trick doesn't apply and the bounce
point has to be solved directly. The condition is the reflection law written
for a curved mirror: the normal anywhere on a circle *is* its radius, so the
bounce point R is the one whose radius **bisects the angle P-R-E**. In
circle-centred coordinates with `R(θ) = C + r(cosθ, sinθ)`,

```
u = normalize(P - R),  v = normalize(E - R),  n = (cosθ, sinθ)
f(θ) = cross(u + v, n) = 0        "u + v points along n"
```

This is Alhazen's problem and has no closed form worth having — it reduces to a
quartic — so `circleBounce` solves it numerically. What makes that easy rather
than a quartic root-finding exercise is the visibility condition: R can only be
a bounce point if both ends can see it, and R is visible from P exactly when
`|θ - bearing(P)| < acos(r / |P - C|)`. Each constraint is an arc centred on
one point's bearing and less than half the circle wide, so their intersection
is a single arc, and bisecting it converges on the one bounce that physically
exists — never on the quartic's other roots, which live on the arcs facing away
from one end or the other.

That last claim is load-bearing, so it was checked rather than assumed: over
34,790 random mutually-visible arcs, **every one had exactly one sign change** —
none had zero, none had more. And over 173,903 solved configurations the answer
lands on the circle, makes equal angles with the normal on both sides, and has
both ends outside it. 28 bisection steps put the arc under 1e-8 rad; a solve
costs ~1.9µs.

For a circle the aim point returned *is* the bounce point rather than a
mirrored target — a circle has no mirror, but the bullet still leaves along
`P → R`, and the bearing is all the game is ever told.

**A circle has to be at least two barrels wide** (`2 × 1.75 = 3.5` units) to be
worth attempting. A curved mirror's sensitivity goes as `1/r`: move the bounce
point along the surface by a hair and the normal turns by that distance over
the radius, and the outgoing leg turns by twice that. On a barrel, every
centimetre of error in where the bullet actually meets the surface swings the
far leg by about two thirds of a degree — and neither the lead nor the
extrapolated origin is remotely that accurate. A flat face has no such term at
all, which is why only circles need a size floor.

Of the 23 circular reflectors in the game that leaves five: `silo_01`,
`silo_01po` (7.75) and `wheel_01`–`wheel_03` (4.60). Barrels (1.75), airdrop
crates (2.50), class shells (2.25), toilets, stoves and bollards are all below
it. The check is against the *live* collider, so a damaged silo that has shrunk
past the floor stops qualifying — correctly, since it really has got harder.

On the overlay, a bankable enemy is **not** faded, because there is a shot on
them; the committed target's line is drawn bent at the surface it bounces off,
so the aim swinging away from the target reads as deliberate rather than
broken. `__aimDiag()` reports `shot: 'direct' | 'bank' | 'blocked'` and, for a
bank, which obstacle type it is coming off, where, and how much longer the path
is than the direct one.

**Scope.** The server only streams objects inside the local player's view
radius, so the pool holds what is on screen plus a margin — exactly the set a
shot at a *visible* enemy can pass through. There is no client-side source for
the collision geometry of off-screen map objects: the join-time map message
carries every object's `type`/`pos`/`ori`/`scale` (`game.map.mapData.objects`),
but the per-type `collision` shapes live in bundle-private defs.

## Enemy name tags

survev already builds the label. Every Player owns a `nameText` — a PIXI.Text
child of its own container, anchored under the sprite — and the per-frame
player update fills it in for **everyone**:

```js
this.nameText.text = info.name;
this.nameText.visible = !isActivePlayer && sameGroup;
```

then shows it only for teammates. So an enemy's tag is already built, already
carrying the right name, and already following the sprite through zoom, layer
and death. The only thing between it and the screen is that `visible`
assignment.

Taking that over rather than drawing labels of our own is what makes the enemy
tag pixel-identical to the teammate one — same font, same offset, same scaling
with the camera, same disappearance when the player dies or the ceiling hides
them — and it costs one property read per player per frame. `nameText` is one
of the names survev leaves readable (like `playerPool` and `pings`), so none of
this needs a `mangled.js` entry.

The hook is an **accessor on the Text instance**, not a write from our own
tick, and that is for ordering rather than tidiness: the game assigns `visible`
once per frame per player, in the same update that assigns the interpolated
position our netcode hook rides on, and the sample loop is not ordered against
that — anything we wrote would be overwritten before the next render about half
the time. The accessor ORs our decision onto the game's, so the local player's
own name stays hidden, a teammate stays visible for the game's own reason, and
turning the toggle off restores stock behaviour on the very next assignment.
It is installed per *instance* for the same reason the netcode hooks are, and
only while the feature is on — with it switched off, no label built afterwards
gets an accessor. The tick keeps running once anything *is* hooked, so
switching it off hands every label back rather than leaving one forced on.

It ships **on**, alongside the netcode smoothing and the ping readout rather
than with the cheats: it reads a label the game has already built, positioned
and filled in, and touches no input or gameplay state.

The tags also wait for the local player to resolve. Without one there is no
side to be on, and the sampler's reading of that state — "everyone is an enemy"
— would paint the squad red for the frames before it fills in. Our own sprite
is excluded by object identity rather than by id, since the pool holds us too
and identity can't be defeated by an `__id` that hasn't arrived.

`__nameTagDiag()` reports the whole path when a name doesn't show: whether the
tick reaches the pool, who it thinks we are, how many labels are hooked, and
per live player what the label holds against what the renderer is being told.
`missingLabel` is the one entry that means a code change rather than a setting
— it counts live players with no `nameText`, i.e. the bundle stopped calling
the label that. `visible` next to `worldVisible` separates "we never forced it"
from "we did and something above it is hidden anyway".

Colour is the ESP overlay's enemy red (`#ff3c3c`) against the teammate cyan, so
the two features read as one thing rather than as two different opinions about
who is dangerous. It is applied by assigning `style.fill`, which bumps the
style's ID and makes PIXI rebuild the text texture — so it is written only when
the colour actually changes, not every frame. The fill to restore is read off
the label at install rather than assumed, and who counts as an enemy is
re-derived every tick rather than latched, because pool entries are recycled:
the object that held an enemy last round can hold a squadmate in the next one.

That enemy test is `isHostileTo`, the same one the sampler uses — squadmates
share a `groupId`, faction teammates share a non-zero `teamId` — so the tags
and the overlay cannot disagree about who is on which side.

Names come from `getPlayerInfo(id).name`, which is the raw name: survev's
`anonPlayerNames` setting is applied by `getPlayerName()` on the paths that
respect it, and the in-world label never went through that function.

## Debug render

"Debug" in the MOD tab replaces the rendered world with its hitboxes. Ground —
grass, beach, riverbanks, ground patches — all becomes flat white, kept under
the game's own grid so there is still a sense of scale and of how far something
has moved; water keeps whatever colour the biome gives it, because water is
terrain you swim in rather than something with a collider. Every collidable
object is a filled shape drawn straight from `obstacle.collider`: an
axis-aligned rectangle or a circle, no stroke, all one colour. Every player is
a circle of `GameConfig.player.radius` in a second colour, with no
teammate/enemy or downed distinction. Nothing is drawn with a border, because a
border sits *outside* the shape and would make every hitbox read a pixel or two
larger than it is.

The switch works off survev's scene graph rather than off any drawing hook.
`Game.init()` adds a flat list of children to the PIXI stage:

```
map.display.ground     terrain, in world coords, re-transformed to screen each frame
renderer.layers[0]     ┐
renderer.ground        │  every sprite: obstacles, buildings, ceilings,
renderer.layers[1..3]  ┘  players, loot, bullets, particles
debugDisplay
gasRenderer.display    ┐
emoteBarn.container    │  UI, above the world
uiManager.container    ┘  (minimap, indicators, …)
```

So the whole world switches off by setting `renderable = false` on
`renderer.ground` and the four layers. Nothing else on the page changes: the
HUD is DOM, and the minimap is a texture `renderMap()` bakes from a Graphics of
its own rather than from `display.ground`.

`renderable`, not `visible`: the renderer rewrites `visible` on the layers every
frame from the layer-transition alphas, so it would take the flag straight back
off us. It never touches `renderable`, and PIXI checks it before descending into
a container, so one `false` skips the container and its whole subtree.

Our own geometry goes in as three `Graphics` children of `map.display.ground`.
That parent is the one node on the stage already carrying the world→screen
transform, so drawing in world units under it needs no camera read of our own
and cannot drift a frame behind the game's: whatever transform the renderer
resolves for the terrain is the one our shapes get, on the same pass. It also
sits at stage index 0, under everything — which is where a replacement world
belongs. The white sheet is painted *over* the game's terrain rather than
replacing it, so switching the mode back off is one `renderable` flip with the
game's own geometry still intact underneath.

The three layers are split by how often they change:

| Layer | Redrawn |
| --- | --- |
| Ground + water | Once per map, keyed on `map.terrain` identity |
| Obstacle colliders | Only when a cheap signature over the collider set changes |
| Player circles | Every frame |

The signature is a rolling hash of obstacle count, ids, and the collider numbers
quantized to 1/64 of a unit, computed without allocating. It catches an obstacle
entering or leaving the pool, one being destroyed, and a door swinging its
collider onto a new orientation — which is everything that can change a shape on
screen — so the expensive part, clearing and re-tessellating a few hundred
shapes, only runs on frames where the geometry actually moved. Players are
deliberately outside that gate: they move every frame, so gating them would
never pay off.

The ground and water are laid down in the same order `renderTerrain` uses — one
white sheet over the map and its 120-unit margin, then the play area minus the
shore polygon as ocean, then each river's `waterPoly`, with looped rivers taking
`lakeWater` when the biome defines it, then the grid over the lot. The shore is
concave and hand-jittered, so the ocean is cut as a PIXI hole exactly the way
the game cuts it, not approximated with a border. The grid is the game's own:
`GameConfig.map.gridSize` spacing, black at 0.15, over the play area rather than
the margin, and `2 / camera.ppu` wide — our Graphics hangs off
`map.display.ground` and inherits its world→screen scale, so that width lands on
the same pixels survev's grid does.

### Player positions

Players are drawn at `posAlt`, not `pos`. `pos` is where the last packet said
the player was; `posAlt` is the render-interpolated position the game lerps
toward it each frame, and it is the one the body sprite's own `pointToScreen`
is fed — so reading it is what puts the circle exactly where the hidden sprite
was, rather than a fraction of a tick ahead of it.

It is also the field [Netcode smoothing](#netcode-smoothing) installs its
accessor on. So the circles play back on the recovered tick clock whenever
Smoothing is on, respond live to `jitterK`, `clockHalfLife` and `renderLag`,
and fall back to survev's stock lerp the moment it is switched off — the same
playback the sprite itself would have been drawn with, which is the whole point
of a view that claims to show where things really are. `pos` is only the
fallback for a player the game has not interpolated yet.

`window.__debugRenderDiag()` reports what the mode found. `rendererFound: false`
means the layer containers are still on screen and the hitboxes are drawing
underneath them; `mapFound: false` in a live match means `findMapOnGame` lost
the map shape and `mangled.js` may need re-deriving.

## ESP render

"ESP" in the MOD tab's ESP section stops art that isn't part of the collision
set from covering art that is. **Building roofs** come off entirely, so a house
shows its inside. Everything else that hides a body without stopping one —
**bushes**, the **rubble a destroyed obstacle leaves behind**, **tree canopies**
and **smoke** — is faded to `0.3` instead. Canopies are on the collidable side
of the game's own line and the first two are not, but they read at one depth on
purpose: the fade means "you can see through this", and what is solid is what
the ESP overlay and `__bulletGeom` already answer.

It is a display switch and nothing more. No geometry is read from it, nothing
about aim, sampling or input changes, and it is deliberately **independent of
the "ESP overlay" toggle above it**: it puts nothing on the overlay canvas, so
gating it behind the canvas would only be surprising. Off by default, and
persisted like every other row.

### Roofs

A house's inside is already being rendered. Its floor, its walls, the loot and
the players in it all draw on the same layer as the world outside, and the roof
is only a sprite laid over the top of them at `zOrd = 750 - zIdx`. `Building`
keeps both halves of that art in one `imgs` array with each entry tagged
`isCeiling`, so switching off the ceiling ones leaves the building standing,
its layer, its bounds and its zoom regions untouched, and reveals what was
underneath.

`renderable = false` per sprite, for the same reason the debug render uses it
on the layer containers: the game rewrites both of the other candidates on
every update — `positionSprite` sets a ceiling img's `alpha` from
`ceiling.fadeAlpha`, and a `removeOnDamaged` img gets a `visible` — so anything
written there is gone within a frame. `renderable` it never touches, and PIXI
checks it before drawing.

This does **not** open up a bunker. Underground art lives on
`renderer.layers[2]`, which the renderer masks down to the stairwell openings
the whole time the local player is aboveground, so there is no roof to hide:
those sprites are being clipped away, not covered up.

### Bushes and rubble

Obstacles are sorted by the game's own rule for what an object is. `collidable`
is its line between an object and scenery — a bush carries a collider and
doesn't stop you — and a destroyed obstacle keeps its collider object but stops
colliding, so both are art in front of nothing, and both are faded to `0.3`
rather than removed: a bush is still cover from being *seen*, and rubble still
says an obstacle was there. A door's casing is a second sprite the obstacle
positions alongside its own, so a dead door's frame fades with it rather than
staying solid around nothing.

A **skinned player's disguise** falls out of the same rule: the client builds a
skin as an obstacle and sets `collidable = def.collidable && !isSkin`, so a
skin is never collidable and always faded here, leaving the player sprite it
was covering plainly readable underneath.

### Tree canopies

A tree is collidable. It stops a bullet and it is cover, so removing it would
make the view lie about exactly the thing the view is for — but its leaves are
drawn on top of whoever is standing under them, which is the problem this mode
exists to solve. So canopy art is faded to `0.3` instead — the same value the
bushes and rubble above get: the tree still reads as a tree, and the player
under it reads as a player.

Which art counts as a canopy comes from the game's own rule rather than a list
of type names that would rot on the next content patch. `sprite.zOrd` is the
obstacle def's `img.zIdx`, and `Obstacle.render` treats `>= 50` as "this draws
above the player" — it lifts exactly those onto the player's layer and pushes
them past their z-order. Tree canopies sit at 200 and 801. Tables, pipes and
statue tops share the rule and get the same treatment, for the same reason:
they are all art the game deliberately puts in front of a body.

The alpha is written straight onto the sprite rather than through an accessor,
because an obstacle only assigns `sprite.alpha` on the rare frame it swaps a
texture — spawn, death, a button toggling. That is also what makes the value
to restore free: every sprite carries its own `imgAlpha`, which is the number
the game last put there, so a table that ships at `0.8` goes back to `0.8`
rather than to a blanket `1`.

### Smoke

A smoke cloud is the canopy problem out of a different barn. It is not an
obstacle, it is in no collision set, it stops neither a bullet nor a body — and
it is drawn over everyone inside it, which is the thing this mode exists to
stop. So it is faded to the same `0.3`, and a tree seen through smoke reads at
one depth instead of two.

The smoke barn hangs off the `Game` rather than the map, and keeps its
particles in a plain array beside its entity pool. Both are mangled, so the
pair is found by what the array's entries are: a particle declares
`radTarget`, `fadeTicker`, `rotVel`, `interior` and `sprite` as readable
fields, and nothing else on the `Game` carries that set. As with the obstacle
and building pools, that needs one live entry — one smoke thrown this round —
and until then the barn is simply unidentified. Arrays are skipped rather than
descended into during the scan: the `Game` keeps `pings` and `updateIntervals`
beside its barns, both one entry per server update and both unbounded over a
match.

Unlike a canopy's, smoke's alpha is **rewritten every frame** — the barn sets
`alpha = clamp(1 - fadeTicker / fadeDuration) * 0.9` in the same tick that
renders the particle, so there is no point in a frame where a value written
from the overlay's own loop is the one that gets drawn. So the write is
intercepted rather than repeated: an own accessor keeps the game's number and
hands back the lower of it and `0.3`. The barn goes on assigning exactly as it
did, and a puff's own fade-out still plays, because those values are under the
cap and pass straight through. What is capped is how solid the cloud gets, not
how it dies.

Because each particle is capped rather than the cloud, a **dense cloud still
builds up** where many particles overlap — every one of them is at most as
opaque as a tree canopy, but they composite. That is the honest reading of a
per-sprite cap; hiding smoke outright is the alternative, and it would put the
mode back to lying about what is on screen.

### Handing sprites back

Each held property — `renderable` for what is hidden, `alpha` for what is
faded, the `alpha` accessor for what is capped — is tracked by a pair of
`Set`s swapped each frame: one holds what is
currently held, the other collects the frame being built, and anything in the
first that the new frame didn't re-claim is handed back before the swap.

That is what restores a sprite when a pool entry is recycled into a different
object, when the toggle goes off, and when the round ends. It is also what
moves one cleanly between the two states: a tree that gets destroyed stops
being canopy and starts being rubble, so the same frame that hides it also
gives its alpha back. Swapping rather than allocating keeps a per-frame pass
over a few hundred sprites free of garbage.

`renderable` is only ever set back to `true`, which is the value the game ships
sprites with and never writes itself; a faded `alpha` goes back to the sprite's
own `imgAlpha`; a capped one has its accessor deleted and the game's own last
number assigned in its place, which puts a plain data property back where PIXI
put one.

`window.__espDiag()` reports what the mode found, including live
`hiddenSprites`, `fadedSprites` and `cappedSprites` counts. `buildings: 0` in
a live match means `findBuildingPool` hasn't identified the building pool —
roofs are still up, and if it stays that way once a match is running,
`mangled.js` may need re-deriving. `smokeBarnKey: null` only means no smoke has
been thrown yet.

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
with a slow exponentially-weighted linear regression, carried as mean-centred
moments that each packet updates in a few arithmetic ops rather than as a
buffer re-summed per arrival. The fit gives every packet a **pseudotime** —
when it would have arrived on a jitter-free link.
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

Aim direction rides in the same packet as the position, so each snapshot
carries it too and the body's rotation is played back on the same clock, off
the same pair — with two departures.

It **stops at the newest snapshot**: the fraction is capped at 1, so the
rotation never turns past a direction the server actually sent, and a stall
holds the last real one. That costs nothing in the steady state, since the
render already sits half a tick behind the newest snapshot, and nothing on the
way back in either — resuming from a held angle is a rate change, not the
positional snap that makes freezing unacceptable for position.

And it is interpolated as an **angle** along the shortest arc, not as a vector.
A componentwise lerp of two direction vectors sweeps at a non-constant rate,
and degenerates entirely on a ~180° turn in one tick, where the interpolant
passes through the origin and its `atan2` is arbitrary. Walking the arc turns
at a constant rate and has no degenerate pair.

Everything that is not a player — loot, obstacles, projectiles, the gas circle
— still goes through survev's own lerp, so the raw gap it divides by is
replaced with an EWMA of the mean plus an allowance proportional to measured
deviation (`jitterK`). One accessor on one camera field reaches all of them.


### Bullets on the render clock

Everything drawn should represent the same instant, and by default it does not.
Players render at the recovered clock held `renderLag` ticks back; bullets are a
pure client-side simulation the barn advances by frame dt, so they are drawn at
`t_now`. Every tracer on screen is half a tick ahead of every body on screen. At
20Hz that is 25ms, which a Barrett round spends 5.4 units of travel on — five
player radii, and the difference between a round that looks like it missed and
one that looks like it hit.

This is survev's own inconsistency rather than one the smoothing introduces:
stock lerps players a whole tick behind the newest snapshot while running
bullets in real time, so the gap there is wider. The clock narrows it, and the
barn's render pass closes it, by walking each round back along its own direction
by exactly the lag the player render is held at.

The substitution happens in the barn's render pass and nowhere else. `pos` is
left exactly as the barn computed it, because the barn's own update integrates
it, tests the swept segment against obstacles and players for the tracer-stop
and the whiz sound, and the dodge bot reads it to build its threat list — all of
which want the true simulated position and none of which is a render. Only the
value handed to the sprite transform moves, and it is put back before the frame
ends, including if the render throws. The barn recomputes the tracer's length
from `pos - startPos` in the same pass, so a round drawn earlier in its flight
gets the shorter trail it had then for free.

The render pass is found by shape, since its name is mangled and rotates every
deploy: survev leaves `onMapLoad`, `addBullet` and `createBulletHit` readable
and mangles the other two, and of those the update takes eight arguments while
the render takes one — so the render is the only arity-1 method on the prototype
that is not `onMapLoad`. If a future bundle makes that ambiguous the lookup
returns nothing and the feature turns itself off, which is the right failure:
a wrong guess would wrap the update and quietly corrupt the simulation.

The one thing it cannot do is un-draw a round that had not been fired yet at
render time. Walking back is clamped at the muzzle instead, so a new bullet sits
at its start point for up to half a tick and then sets off.

The impact is the mirror image, and it is where a fixed offset stops being the
same clock. On a hit the barn snaps `pos` onto the contact point, clears `alive`
and holds it there while `scale` retracts the streak into that point over
~167ms. A dead round is no longer where it was a lag ago — it *stopped* — so
subtracting the same distance for the whole fade draws it at no instant at all,
collapsing the trail 5.4 units short of the rock it visibly just hit (a Barrett
at 214 u/s over half a 20Hz tick) with the spark stranded at the surface for ten
frames.

Reading the clock literally fixes it: the shift is `speed ×` *the part of the
lag the round was still in the air for* — the whole lag while it flies, then
running down to nothing over the lag after it dies. The tracer covers its last
stretch, arrives at the contact point about a frame and a half after the spark,
and rests there for the remainder of the fade.

The stall case closes the same way. `renderOnClock` will not carry a player more
than `NET_MAX_EXTRAP_MS` (200ms) past its newest snapshot, so a long stall parks
the bodies at the end of that coast; the bullet lag is taken against that same
clipped render time rather than against `t_now - renderLag`, so it grows at
exactly the rate real time does and the tracers hold still beside them. Without
it they fly on through a frozen world.

This rides the master `Smoothing` switch rather than a toggle of its own: the
whole point of the clock is that one instant is drawn, and a smoothed world with
bullets left at `t_now` is the incoherent half-state. It does cost half a tick of
warning on incoming fire, which is the price of the tracer and the body agreeing
about when they are — the dodge bot is unaffected either way, since it reads the
barn's true positions and never looks at a sprite.

### The trade

The lerp extrapolates rather than freezing, so a stall is coasted through — but
only for 200ms past the newest snapshot (`NET_MAX_EXTRAP_MS`), after which the
render time is clipped and the player parks at the end of that coast instead of
sliding away on a velocity the server stopped confirming a fifth of a second
ago. It is taken half a tick behind the clock (`renderLag`, in ticks)
rather than at `t_now`: rendering at `t_now` exactly means the newest
snapshot's pseudotime is always slightly in the past, so *every* frame leans
past the end of the data, and half a tick of playout centres the render on the
data instead.

Either way it eliminates freezing outright — frozen frames are ~0% on every
link tested, against 16–26% for stock — and on straight-line motion it is close
to perfect: stutter down 92–99% and position error down 5–6x even across 400ms
stalls.

What the playout delay buys, from `tests/netcode_sim.js`:

| | `renderLag` 0 | `renderLag` 0.5 |
| --- | --- | --- |
| jerk vs stock, hard reversals | +443% | +147% |
| jerk vs stock, strafing (clean link) | +458% | +170% |
| shape error, hard reversals | 1.74u | 1.18u |
| overshoot stopping, no stall | 0.167u | 0.025u |
| overshoot stopping, 300ms stall | 1.20u | 1.20u |
| latency vs stock, straight line | 50ms ahead | 17ms ahead |

So about 35ms of the latency lead buys back roughly half the stutter and most
of the stop overshoot, and the render still arrives ahead of stock survev's.
The two 300ms-stall figures match because the 200ms extrapolation cap has
already engaged by then: past that point the overshoot is set by the cap rather
than by the playout delay, and it no longer grows with the stall.

What remains is inherent: during a stall there is no data to interpolate
between, so the renderer extends the last line and is corrected when the stream
resumes. Set `renderLag` to 0 in the MOD tab for the lowest-latency,
highest-overshoot end of the trade; `tests/netcode_sim.js` re-measures both columns
from `core/inject.js` itself.

Nothing here touches input, packets or gameplay state; it is purely a render
path change, and the master toggle restores stock behaviour live.

## Autoshoot

Holds the trigger exactly while the shot is on, and lets go the moment it
isn't. Off by default; "Autoshoot" in the MOD tab.

It rides on the aim helper rather than standing alone: the aimbot decides where
the crosshair points and whether a shot exists at all, and autoshoot only
decides whether to pull. So it does nothing unless the aimbot is enabled **and
its key is held** — without that the crosshair isn't on anyone and "can the
enemy be hit" has no meaning.

Four conditions, all of which have to hold:

1. **A gun at all** — not a melee or a throwable. This is also what keeps the
   single-gun swap below from eating itself, since that path taps melee on the
   way round and a Fire press with a melee equipped is a swing, not a shot.
2. **Something in the magazine.** A reload in progress is *not* a reason to
   hold off — firing cancels it, and rounds already loaded are worth more right
   now than the ones being loaded. That covers the shell-by-shell shotgun
   reload, where every shell that lands is immediately shootable, and the
   tactical reload of a part-full magazine, where all of it is. An **empty**
   magazine is the one case that still waits, and it has to: interrupting an
   empty gun's reload cancels it, leaves nothing to fire, and the auto-reload
   starts over — press again and the gun never reloads at all. This single
   check is what keeps "interrupt reloads" from meaning "never finish one".
3. **The shot exists** — `reactionTarget` reports a clear direct line or a
   bounce it found. Blocked with no bounce means hold fire.
4. **The crosshair has arrived.** The aim glides toward the solution at
   `followFraction` a frame, so early in an engagement the shot exists but we
   aren't pointing at it yet. The tolerance is the target's own angular radius
   at the range the bullet travels — for a bank that's the whole path length,
   which is the right denominator, since the far leg is what has to land.

### How it pulls

Three cases, decided by the gun:

| | |
| --- | --- |
| **slow** — `fireDelay` at or over `AUTO_SWAP.slowFireThreshold` | one shot, then the quickswap |
| **auto** or **burst** | hold the trigger; it keeps firing on its own |
| anything else | a press per frame |

Slow wins where it overlaps with auto (the USAS at the default threshold, more
of them if it's dialled down), because the swap beats the wait either way. It
never overlaps with burst: every burst gun is in `AUTO_SWAP_NEVER`, which
`isSlowFireGun` rejects outright.

**Slow guns** spend most of their time in recovery, and a swap resets
`gunSwitchCooldown` — so shot → swap → shoot the other one beats waiting out
the delay. It's the trick auto-quickswap already does off the user's trigger,
driven off autoshoot's instead. From the simulated frame loop, mosin (1.75s)
plus sv98 (1.5s), three seconds:

```
mosin@0 -> sv98@304 -> mosin@608 -> sv98@912 -> mosin@1216 -> sv98@1520 -> ...
```

so a shot every ~300ms from a pair of guns that fire every 1500–1750ms on
their own. With one gun it taps melee and comes back, landing a shot every
~336ms instead of every 1750ms.

The ordering here is the whole difficulty. The press that *fires* the gun
can't also be the press that queues the swap: after a swap the new gun still
owes its `switchDelay`, and a press inside that window is silently dropped —
queue the swap off it anyway and the two guns trade places forever without a
shot between them. So the swap is triggered by the **magazine going down**,
which is proof a shot actually went out, and until it does autoshoot just keeps
tapping.

That confirmation takes a round trip to arrive, and it is why the magazine is
read by `autoShootObserve` every frame, independently of the shoot decision.
The plan drops to null on any of eight conditions and several of them flicker
constantly mid-engagement — the aim wobbling a hair past tolerance, the target
blinking out of a sample, a bank momentarily failing to validate. Folding the
magazine reading into that meant one such frame anywhere in the three-to-six
frame confirmation window wiped the evidence, the swap never fired, and the gun
just shot and waited. Only a *weapon change* retires tracking now. The drop is
also measured against the reading taken at the press rather than against the
previous frame, so a gap in readings can't swallow it, and a queued swap that
never lands times out rather than wedging the gun.

**Everything else** gets a press per frame. Pacing it at the gun's `fireDelay`
looks tidier and measures slower: a press the gun isn't ready for is dropped,
and if that press has already moved the gate forward a full cycle, the *next*
one lands a cycle late — a 130ms gun ends up firing every 224ms. Pressing
freely costs nothing, since the server ignores what it can't honour, and adds
no packets either, because the aim is already rewriting the input message every
frame during an engagement.

**Burst** guns (an94, famas, m93r, m93r_dual, ump9) hold, the same as an
automatic: a held trigger keeps them firing burst after burst and the server
paces the gap. That also sidesteps what makes pressing them awkward, which is
that a press part-way through a burst restarts it.

Which gun is which comes from static `fireMode` sets derived from the gun defs
the same way the reflector table was: 74 guns, 28 auto, 5 burst, 41 single,
every one carrying the field explicitly. The 28 auto and 5 burst hold; the 41
single are what the press path is for.

Mechanically it works the same way auto-quickswap does. survev builds the
outgoing packet's fire flags straight off the bind object —

```
shootStart = inputBinds.isBindPressed(Input.Fire)
shootHold  = inputBinds.isBindDown(Input.Fire)
```

— so wrapping those two methods is enough to fire without owning a keybind.
`heldInputs` is a level signal read by `isBindDown`; the rising edge also
presses, so `shootStart` goes true on the first frame, for a server that arms
the trigger on the start flag. Anything that wants to observe the *user* reads
through `realBindDown` instead — auto-quickswap's fire-edge detector does, or
every burst autoshoot fired would look to it like a fresh trigger pull.

A synthetic Fire press has to survive a **whole frame** rather than being
consumed by the first reader, and that is not a detail — it is the difference
between the press path working and doing nothing at all. `Input.Fire` has two
readers per frame and they run in the wrong order: the player update polls
`isBindPressed(Fire)` for its dry-fire sound, and it runs earlier in
`Game.update` than the input-message build that turns the same poll into
`shootStart`. A consume-on-read token is eaten by the first and never reaches
the packet, so every press-fired gun silently never shoots — an automatic one
works fine, because it rides on `isBindDown`, which is level and never
consumed. So Fire goes in `framePressInputs`, read without consuming and
retired by the arming tick on its next frame, which makes it exactly one frame
wide — the same width survev's own `keysOld`/`keys` edge gives a real key
press. The equip inputs stay one-shot: they have a single reader, and a second
read would swap twice.

## Dodge bot

Takes the movement keys for exactly as long as something is going to hit us,
and hands them back when nothing is. Off by default; "Dodge bot" in the MOD
tab. "Something" is every round in the air, plus — because a round in the air
is already half a beat too late to answer — one hypothetical round per enemy
currently aimed at us, at a discount. See [Firing lines](#firing-lines).

### What is and isn't dodgeable

A player moves at 12 u/s (`GameConfig.player.moveSpeed`) and the guns in
`GUN_BULLET_SPEED` fire between 66 u/s (M870) and 214 u/s (Barrett). Nothing
here out-runs a bullet, and no amount of planning changes that. The only
reason a dodge ever works is that the shot was aimed where we were *going*,
and a shot led against a path we then leave misses.

That reframes the arithmetic usefully. Clearing our own radius — one world
unit — takes ~83ms from a standstill, during which an mp5 round covers 7
units and a mosin round 15. Add a round trip and the shot has to have come
from ~18 units away (mp5) or ~38 (mosin) before we can be out of it in time.

But we don't have to displace in world space, only to diverge from the path
the shooter led against. From a standstill we can diverge at 12 u/s. If we
were already strafing across the shot when it left and we simply *reverse*,
the two paths separate at 24 u/s and the clearance takes ~42ms, halving every
threshold above. That is the whole reason the planner is allowed to keep
moving. It is not, however, pushed to: standing still carries no penalty of its
own, and among plans that are equally clear of every round in the air it is only
the `Follow input` term — the pull toward the keys the player is actually
holding — that stops it being chosen by default.

The consequence worth being honest about: **at close range there is no
dodge.** An SMG round from 8 units arrives in under 100ms, which is less than
the link's own round trip, and no input we send can be in time. This is a
ranged-exchange feature.

### Solving the bullets

Threats come from the bullet barn (`bn` in the bundle), which is found by
shape: it is the only object the `Game` owns that has all of a `bullets`
array, a `tracerColors` map and an `addBullet` method, and all three are real
readable class fields, so it survives a re-mangle and needs no `mangled.js`
entry. Each live bullet carries `pos`, `dir`, `speed`, `startPos` and
`distance` under equally readable names, is advanced client-side every frame,
and travels a deterministic straight line from spawn — so the whole future
path is known rather than guessed.

Four things happen to each bullet before it is scored:

1. **Ours and our squad's are dropped.** Our own rounds only come back at us
   as shrapnel or off a reflector, which is exactly what the barn's own
   `damageSelf` flag already means. A squadmate's round passes through us in
   every non-FF mode, so dodging it would hand the keys away for nothing.
   Hostility is asked through the same `isHostileTo` the sampler and the name
   tags use, so the three can't disagree.
2. **It is advanced by the measured round trip.** What we render is the
   server's world one one-way trip ago, and an input we send now is acted on
   one one-way trip from now, so the bullet the server tests against us has
   travelled roughly a full round trip further than the one on screen. Same
   lead, from the same `game.pings` samples, that the aim helper uses.

   **Our own start state is led the same way.** Whatever we choose this frame
   is not acted on until it reaches the server, and until then we keep going
   the way we are already going — so the rollout starts from where that leaves
   us, not from where we are. Leading the bullets but not ourselves credits the
   planner with an escape beginning a full round trip early, which at 60ms is
   most of a player radius of head start it does not have; it is the difference
   between correctly reporting a close shot as unavoidable and confidently
   walking into it. The prefix is capped at half the horizon so a bad link
   cannot move the start of the plan further than the plan is long.

   **That correction is not a leg of the plan, and running it as one was a
   bug** — `dodgeCarry` exists to say so. Threats are placed where they will be
   when our input lands, so plan-time zero is that moment *for them*; our own
   position is a round trip behind it. Closing the gap with a scored leg
   advances the threats a second time along with it, because their positions
   are a function of plan time, and every bullet is then solved against us from
   a round trip too far away. At 60ms on an mp5 round that is five units of
   error and it mostly still works; at 140ms it is twelve, and the bot cleanly
   proves to itself that a round about to hit it will miss.
   `dodgebot-test/bench.js` is what caught it: at 140ms the hit rate with the
   bot driving was indistinguishable from having no bot at all, and at 60ms it
   was costing a factor of seven. So the gap is closed by a position correction
   that walls still clip — we really can be stopped during it — but that sweeps
   nothing and charges nothing, leaving the whole horizon to the plan.
3. **It is truncated at the first wall on its own path**, via the same
   `firstBulletHit` the aim helper and the ESP fade use. A round that dies on
   a crate is not a threat, and treating it as one is precisely what would
   walk the bot out of cover.
4. **It is dropped unless it can reach us.** Solved against our radius grown
   by `speed × horizon` — everywhere we could possibly stand before
   the plan ends — so a round rejected here is one no candidate plan could be
   touched by. This filter is now the only thing deciding the size of the
   set — everything surviving it is kept and planned against, however many
   that is. There used to be a hard cap of 48 on top of it, with a newcomer
   displacing the slot furthest from mattering. Nothing replaces that bound,
   so threat count now multiplies into the innermost loop unchecked; the
   reachability filter is what makes that acceptable, since it already
   rejects everything flying somewhere else, which in a firefight is nearly
   all of it.

Collision is then solved in closed form, not sampled. For a candidate
velocity `v` and a bullet `(b, w)`, with `q = b - p` and `u = w - v`:

```
a = u·u,  bb = q·u,  c = q·q - R²
c ≤ 0   → already overlapping
bb ≥ 0  → separating
disc = bb² - a·c ;  t = (-bb - √disc)/a
```

`R` is our own radius plus `Clearance`: we are treated as a point and the bullet
carries the radius, which is what lets the planner be dimensionless everywhere
else, including the wall march. The radius is read live rather than assumed —
the game collides against `scale × GameConfig.player.radius`, and `scale` is a
per-player field off the wire, so a planner solving a fixed `1` would be testing
the wrong body. `Clearance` on top is the safety factor for the errors the
geometry cannot see: the ping lead is an estimate and the server's idea of where
we are is a round trip old.

Sampling is not an option: a Barrett round crosses a player's diameter in 9ms
and would step straight over a 16ms frame without ever testing as overlapping.

What the planner does with the result is *not* a yes/no. See
[Graded by what we don't know](#graded-by-what-we-dont-know).

### What a round is worth

Not one. Each threat carries its damage in HP, and both searches minimise
expected HP lost rather than expected hit count — so a plan that eats an MP5
round to stay out of an AWC's line is correctly the cheap one, which under a
flat hit count it never could be.

The number comes from `BULLET_DAMAGE`, a transcription of survev's
`shared/defs/gameObjects/bulletDefs.ts` holding `[damage, falloff]` for all 63
bullet types, derived the same way `GUN_BULLET_SPEED` was. Those two are the
only figures the server's formula needs that aren't already on the client's own
barn entry:

```
finalDamage  = def.damage × damageMult
finalDamage ×= 1 / (reflectCount + 1)
distT        = clamp(distanceTraveled / bullet.distance, 0, 1)
finalDamage ×= remap(distT, 0, 1, 1, def.falloff)
```

`distance` is deliberately not in the table. The instance's own distance —
after the reflect decay, the `distanceMult`, the variance and the ±1 spray
jitter — is what the falloff divides by, and the barn entry already carries
exactly that number. Copying the def's would silently use the wrong
denominator. Falloff is evaluated at the point along the path where the round
reaches *us*, not where it is now; at sniper range those differ by most of its
life. The estimate uses the earliest time it could touch anywhere we might be,
which is the shortest flight and so the most the round can still be worth —
erring high, which can only make the bot take a threat more seriously than it
deserves.

**The type is not on the barn entry, and cannot be inferred from what is.**
`addBullet` is handed the wire bullet, resolves `bulletType` to a def, and
copies out only what the renderer needs; the name never survives. Identifying
it afterwards doesn't work either — `speed` is `def.speed` times a variance the
wire also doesn't carry, and speeds collide anyway: every shotgun in the game
fires at 66 u/s, and buckshot, birdshot and slug do 12.5, 4 and 77 damage.

So the type is taken on the way past. `addBullet` is wrapped, and the type
stamped onto the entry that call wrote — which has to be worked out rather than
observed, because the barn pools its entries and `addBullet` returns nothing.
It takes the first slot that is neither `alive` nor `collided` and pushes a
fresh one when there isn't one, so finding that slot before the call by the
same rule, and falling back to the array's new tail, names it exactly. Reuse
can't go stale: a pooled slot is re-stamped every time it is handed out, and is
only ever read while `alive`.

Two things stay out of reach. `damageMult` never goes on the wire, so a perk
that scales damage is invisible and every round is priced at its base value.
And a round we can't name at all — the hook went on mid-flight, or survev has
shipped a bullet the table doesn't list — is priced at `DODGE_DMG_REF`, which
is exactly the flat hit-counting the planner did before the table existed.

Flares and the invisible round do 0 damage, and are dropped rather than scored
as zero. They would take a threat slot from something that can actually hurt
us, and — since the bot drives for as long as anything is in the air that could
reach us — one flare would keep it driving for the whole of that flight for no
reason.

### Planning

Nine candidate headings: the eight the protocol can express, plus standing
still. Diagonals are unit length, because the server normalizes the move
vector before scaling it by speed — a diagonal is not faster, and believing
otherwise would have the planner counting on an escape it cannot execute.

What gets planned is not a heading, and not two. One heading is enough to get
out of the way of one bullet and is reliably wrong about two: the one that
clears the first can be the one with nowhere left to go when the second
arrives. Against a fast round the escape is not a heading at all but a
*sequence* — go, then stop, then go back — over a flight shorter than any
commit worth making. So the question is asked over the whole horizon at once:
over the next `horizon` seconds, chopped into `Step` decisions, which sequence
of headings takes the least damage?

At the default 0.1s step that is eight decisions and 9⁸ ≈ 43 million sequences,
which is hopeless as a tree — and it is not a tree. Two paths that arrive at the
same place at the same time are worth exactly the same from there on, so they
merge, and what is left is a shortest path over a graph whose nodes are
`(cell, layer)`, where `Grid` is what position gets snapped to. Time only moves
forward, so that graph is a DAG and its layers are already in topological order:
no priority queue, no Dijkstra, just a forward sweep keeping the cheapest way
into each cell. The reachable set at layer *k* is a disc of radius
`speed·k·step` rather than 9ᵏ, and that is the whole difference — a few thousand
states rather than 43 million rollouts.

The one rollout that is not part of that search — "is the course the user is
already on going to be hit?" — runs through a context object instead, advanced
once through the latency prefix and then copied, so the prefix is paid for
once. It carries the per-threat contact times with it, so a copy resumes
exactly where the original left off. That question used to be the takeover
trigger; it now only feeds the HUD.

Merging is sound only if cost is additive per edge and the cost of finishing
depends on nothing but `(cell, layer)`. The loss is a sum of damage over the
rounds that land, so both hold outright — nothing in it needs to know how a
state was reached. That was not free when turning, standing and wall-grinding
were also charged: the turn penalty in particular needed the previous heading,
which is history, and had to be special-cased onto the first layer.

Three things are approximate, and none of them is hidden:

**Snapping.** Position is quantised to `Grid` at every layer and the error is a
random walk, not a fixed offset — worst case `steps·grid/2` by the end of the
horizon. The leg that actually gets executed is the first, whose geometry is
exact; the drift only degrades the value of a tail that is thrown away as soon
as anything new arrives — about every 50ms, see
[Deciding at the rate the news arrives](#deciding-at-the-rate-the-news-arrives).
This is the approximation the graded hit test is built out of
rather than in spite of — the band is exactly the half-cell the snapping costs.

**Re-billing.** A threat is charged on the leg where it *enters the band*, and
legs that open already inside it score nothing rather than a second hit. Without
that a slow round would be billed on every step it spends near us, and the total
would depend on how the horizon happened to be chopped up. A round crosses a
body in about 20ms against a 100ms step, so an encounter opens and closes inside
one leg in practice. The first leg is the exception and bills whatever it opens
on, since no earlier leg exists to have done it.

**The beam.** Only the cheapest 64 states per layer are expanded. A firefight
puts several times as many rounds in the air as a duel and every one of them is
swept on every edge, so the exact search is the thing whose cost is not under
our control — the frontier is. On the bench 64 measured inside the noise of the
exact search, 3.4% against 3.2%, for a quarter of the time.

The objective is a sum of damage in HP — see [What a round is worth](#what-a-round-is-worth).

Measured in `dodgebot-test/bench.js`, 60 trials × 12s, against the same seeded
fights with the same shot noise:

```
  Barrett 214u/s      no bot   two-leg     this    ms/plan
  ---------------------------------------------------------
    0ms                96.9%     8.7%      3.2%    0.02 / 1.36
   60ms                96.9%    29.7%     22.7%    0.02 / 1.42
```

The middle column is a two-leg branch search this replaced — nine headings held
for the horizon, a second leg for the best few — kept here as the measurement
that justifies the cost. Slower guns were already fully dodged by both, an M870
round at 66 u/s taking long enough that one turn is all anyone needs, and the
difference there was noise in both directions. The win is entirely in the
rounds that arrive before a two-leg plan can finish, and it costs nothing for
the rest.

The loss, in full:

```
  sum over threats of   w × f × (1e6 - t_closest × 1e4)
      +  follow × (how opposed each leg is to the keys being held)
```

`w` is the round's damage over `DODGE_DMG_REF` (25 HP, about a mid-tier round),
so a typical threat weighs about 1. `f` is how much of a hit the pass counts as.
The first term is the whole of what the bot is for. Nothing is charged for
standing still, for turning, or for grinding along a wall — all three used to
carry a penalty and no longer do.

### Graded by what we don't know

`f` is not 0 or 1. A binary test asks whether our centre is inside the hitbox,
which pretends we know where our centre is — and we don't. Position is snapped
to `Grid` at every layer, and the ping lead is an estimate, so a plan that
clears a round by a hair has not really cleared it. So:

```
  d ≤ R                f = 1                       band = grid
  R < d < R + band     f = (R + band - d) / band   linear
  d ≥ R + band         f = 0
```

with `d` the closest approach on that leg. At the default grid the fade runs
`1.0 → 1.35`.

**The band sits entirely outside the hitbox, and that is deliberate.** It can
only ever *add* cost to what a binary test would charge, never remove it — a
round whose closest approach is inside the body scores a full hit exactly as
before. An earlier version centred the band on `R`, which also discounted
marginal hits: a pass at `0.9u`, comfortably inside the body, billed `0.786` of
a hit. That is the wrong direction to be uncertain in — uncertainty should make
the planner more careful, not less.

`R` is already our body plus `Clearance` — the two stack rather than overlap.
`Clearance` decides where *certainly hit* ends; the band fades out over one grid
cell beyond that. At the defaults that is a full hit out to `1.2` and zero by
`1.55`.

**The width is derived, not tuned.** It is the quantisation of the state space,
so it tracks the `Grid` knob without anyone re-tuning it — sharpen the grid and
the model sharpens with it. That is the whole difference from the graze term
this replaces, which had a hand-picked `σ = 0.6` and, far worse, left a
six-order-of-magnitude cliff at the hitbox edge:

```
  gap = 0⁻  (hit)    1.00e+6
  gap = 0⁺  (graze)  1.00e+0
```

A plan could shave that edge and win by a factor of a million. The ramp is
continuous across it, so it can't.

The time is the **closest approach**, not the moment the hitbox is crossed. That
crossing doesn't exist for a graze and appears discontinuously as one becomes a
hit, which would put a cliff back into the very term the ramp exists to smooth.
The two differ by less than the time a round takes to cross a body, against a
bonus worth at most 2% of the hit.

It is calibrated for the leg that actually executes: layer 1 carries about
`0.10u` of snapping error against `h = 0.175`. The drift compounds to `~0.29u`
by layer 8, so the band under-states the uncertainty in the tail — the right way
round, since the tail is re-planned the moment anything new arrives and pressed
only when nothing has.

The closed form costs almost nothing. Two rejections run ahead of it and are
pure multiplies — a round separating from the leg's start never closes, and one
whose unconstrained closest approach `|q|² - b²/a` still clears the band never
enters it, which rearranges to `b² ≤ a(|q|² - (R+h)²)` with no division. The
divide is paid only by rounds genuinely passing close, and the square root only
by the ~0.4% of threat-edge pairs that land in the band. Measured at **+12%** on
the sweep against the binary test it replaces.

**The second term is why the first one being that blunt is survivable.** A
hit-only loss scores every escape at exactly zero, and among the headings that
all get clear it would return whichever the sweep happened to reach a cell by
first — which, since headings are tried from index 0 and standing still is index
0, means standing still wins every tie. `Follow input` breaks those ties toward
what the player is already asking for:

```
  penalty = follow × dt × (1 - cos θ) / 2
```

where θ is the angle between the leg's heading and the heading the movement keys
are really held on, read past the bot's own synthetic input. Running with the
keys is free, running dead against them costs `follow` per second, and the
diagonals either side cost about a seventh of that. Standing still sits at half,
the same as running across — it is not what was asked for, but it is not the
opposite of it either. A player holding nothing has no intent to agree with, so
the term vanishes entirely rather than penalising every heading equally.

It cannot buy a hit and is not meant to. The worst case is the knob at its
maximum of 5 over a 2s horizon, which is 10, against the weakest hit in the game
— a birdshot pellet at full falloff, 1 HP, worth `1/25 × 1e6` ≈ 39,200. There is
a factor of ~4000 in hand even there, and about `1e6` for a typical round at the
default of 1. Set it to 0 and the ties go back to being arbitrary.

Because the penalty depends only on the heading of the leg being taken, it is
additive per edge and needs no history, so it does not disturb the merging
argument above the way the old turn penalty did.

Between two plans that both get hit it takes the *later* one: the extra tenth
of a second is free option value — the shooter can lose the line, the round can
find a wall, and we may simply be somewhere else by then.

Damage outranks that delay bonus rather than competing with it. Over a 2s
horizon the bonus is at most 2% of the hit term, so it only ever breaks ties
between rounds within 2% of each other in damage — which is what it is for.
Taking an MP5 round now to avoid an AWC round later falls straight out of
`11/25 × 1e6` against `180/25 × 1e6`.

Walls are the collidable obstacles near us, inflated by our own radius so the
planner can treat itself as a point, and each leg is clipped at the first one
and split into the part actually spent moving and the part spent standing where
it stopped — the pin itself is free, and only matters through the rounds that
then reach us. A step is refused only if it puts us *deeper* into an obstacle
than we already are — a plain inside/outside test would report every
wall-ward heading as blocked the moment we touched a wall, and the bot would
stand against it and eat the shot instead of sliding along it, which is the
one thing it most needs to do while cornered.

Speed is measured rather than assumed. `GameConfig` says 12, but water, being
downed and a heavy weapon all scale it, and a planner that believes in 12
while the player wades at 9 plans escapes it cannot make. Only frames where
we were plainly moving update the estimate; a standing player would otherwise
drag it to zero.

### Taking the keys, and giving them back

The bot drives whenever a round is in the air that could reach us inside the
horizon, and hands the keys back when there are none. That is the whole of it:
there is no takeover threshold and no handback timer.

There used to be both. A plan was pressed only once the user's own course was
proven to be hit inside `trigger` seconds, and the keys went back after
`releaseMs` of that question answering no. Both were answers to something the
loss already answers better. A threshold has to be crossed, and crossing it is
discrete: one frame the user is walking into a round, the next the bot is
mid-dodge from a start state it did not choose, having spent the whole lead-up
— the part where the dodge was still cheap — going the wrong way. The timer
existed only to stop that threshold flapping, which is a problem the threshold
created.

The planner was never a dodge-or-don't decision in the first place. With
nothing on course the hit term is zero everywhere and the loss is the alignment
term alone, whose minimum is exactly the heading the user is holding — so the
bot presses the user's own keys, and the handback is continuous rather than an
event. As a round closes, its hit term grows against that alignment and the
plan bends off the user's heading in proportion to what the round is worth and
how sure the geometry is about it. It leans out of the way early and cheaply
where that is enough, instead of waiting for a threshold and then dodging late
and hard.

The price is that **Follow input** is load-bearing rather than a tiebreak: it
is the whole of how the user steers while the bot is on. At 0 the bot has no
reason to prefer their heading over any other equally safe one, so 0 no longer
means "don't interfere" — to stop the bot driving, turn the bot off.

The user's heading is read through `realBindDown`, which reads past our own
synthetic input layer, so the bot can never see its own held keys and follow
itself in a circle. The arrow keys are tracked separately, because the bundle's
movement path ORs the binds with a raw read of them:

```js
moveLeft = isBindDown(MoveLeft) || keyDown(Left) && !isKeyBound(Left)
```

Driving an axis, rather than adding to one, means the user's keys have to
come *off* — their W and our S otherwise cancel and the dodge goes nowhere.
`heldInputs` could only ever add, so this adds its inverse, `suppressedInputs`,
which makes `isBindDown` and `isBindPressed` report false whatever the
keyboard is doing. Nothing in the bind layer can suppress that raw `keyDown`
above, but reporting the arrow as *bound* falsifies the second half of the
`&&`, so `isKeyBound` is wrapped too, and only while the bot is driving.

The keys go back the moment the threat set empties. Anything that can go wrong
hands them back immediately too: the toggle going off, the local player dying
or disappearing, a new match, or an exception anywhere in the step.

### Firing lines

Everything above is reactive: a threat exists once a round does. That is half a
beat too late by construction — at any range where flight time is under the
round trip, no plan beats the round, which is the whole of
[What is and isn't dodgeable](#what-is-and-isnt-dodgeable). What *is* knowable
long before the trigger is pulled is the line. Standing in front of a gun is a
decision made with our own feet, several hundred milliseconds ahead of the shot
that punishes it.

So each hostile pointing a gun near us contributes one more threat: a round
leaving their gun at the last frame we have data for, from the position that
frame reported, along the aim it carried, at their current gun's speed, range
and damage. It is advanced by the same ping lead, clipped by the same walls,
priced by the same `BULLET_DAMAGE`, and swept by the same quadratic as a round
genuinely in the air. Nothing in the search knows the difference.

**Firing lines** in the MOD tab is what it is worth, and what that number means
is the chance the shot is actually taken. The loss is expected HP —
`w × bill × DODGE_HIT_COST`, where `bill` is already the chance the round
connects — so scaling `w` by a probability of firing keeps the term in the same
currency as everything else and directly comparable to a live round of the same
gun. At the default 0.35, a Barrett lined up on our path outweighs an MP5 round
genuinely in the air. At 1 the bot treats aim as fire and will not stand in a
line it could leave. At 0 none of it runs and the bot is what it was before.

Three properties this leans on:

- **The ray is frozen.** The phantom is not re-aimed as the plan moves us, and
  must not be. An enemy modelled as tracking us perfectly makes every position
  equally doomed, the term goes flat, and a flat term steers nothing. Frozen, it
  has a gradient, and the gradient points off the line.
- **It is one round, not a stream.** Fire rate is not modelled, so this prices
  being on the line at an instant rather than living there. That understates a
  held trigger, which is the conservative direction for a term that is a guess
  about someone's intent.
- **It shares the reach filter.** A phantom only survives if the aim ray already
  passes within our own reach of us inside the horizon, so a gun pointed
  anywhere else costs exactly nothing, and neither does an enemy behind a wall
  or on another layer.

The bot therefore plans, and holds the keys, while someone is aimed at us and
not only while a round is in the air. That is the term working rather than a
side effect of it, but it is a real change in when the bot drives: turn
**Firing lines** to 0 for the old rounds-only behaviour.

Two static tables feed it, both derived from the same bundle dump as
`GUN_BULLET_SPEED` and both carrying its caveat — re-derive when survev ships
new guns. `GUN_BULLET_TYPE` maps a gun to the round it fires, which is not the
regular `bullet_<gun>` a third of it looks like: shotguns share pellet types,
every dual fires its base gun's round, and the potato guns fire a damageless
`bullet_invis` that is dropped exactly like a flare. `BULLET_RANGE` is the def's
own `distance`, kept apart from `BULLET_DAMAGE` for the reason that table gives
for not carrying distance itself — a live round's range is its own, and only a
round that does not exist yet has to fall back on the def's.

Not modelled: pellet count and spread (a shotgun contributes one pellet down the
centre line, at one pellet's damage), the muzzle offset (`barrelLength`, ~2.6u
along the aim, which matters only at ranges where nothing here helps anyway),
and the magazine, which is not on the wire for anyone but us — an enemy who is
dry, reloading or mid-switch is still modelled as able to fire.

### Deciding at the rate the news arrives

The search is deterministic in its inputs. Run it twice against the same world
and it returns the same course, so a second run is worth exactly what the world
has changed by since the first — and between two server updates the world has
changed by nothing the plan did not already model. Rounds do move on the client
in that gap, but they move in straight lines at constant speed, which is
precisely how the plan advanced them; re-reading their positions 16ms later
re-derives the state the standing plan is already holding.

So the bot plans on new information and plays the answer out in between. It
used to plan every frame — a beam search, ~1.4ms of it, sixty times a second,
to be handed the same nine-way choice it was handed 16ms earlier.

What counts as new information is every input the search reads, and the list is
short because almost all of them arrive together:

| | what it covers |
| --- | --- |
| `netStats.updates` | our position, everyone else's, their aim, their weapon, the layer, the walls, the measured speed — one comparison for all of it |
| `dodgeBulletAdds` | a round fired, off the `addBullet` hook |
| `dodgeState.liveKey` | a round gone, as the identity of the live set |
| the user's heading | the whole of the alignment term, and so of what they are asking for |
| the knobs | anything in the MOD tab the loss reads |
| the ping lead | but only past a cell of it — see below |

The packet counter is the camera interpolation-window setter, which the netcode
path already hooks and which fires exactly once per update packet. Everything
the planner reads about the world outside our own keyboard arrives through it,
so one integer covers the lot. Where that hook never installed there is no way
to tell a new update from an old one, and the bot falls back to planning every
step, which is what it did before any of this.

The user's heading is on the list separately rather than folded into the packet
clock, because it is the one input that is theirs and not the server's. Waiting
for a packet to notice it would put up to a full update of lag on the steering,
which is the opposite of what **Follow input** is for.

`liveKey` is the only entry that is not simply a counter. Rounds fly and die on
the client between updates, so a round leaving is news the packet clock cannot
carry — and it is *only* the rounds the threat build actually accepted, hashed
by the barn slot they sit in. That makes it change on exactly the transitions
that matter: a round dying, a round expiring, a round crossing into the reach
filter or out of it. A round merely getting closer, which is the common case,
leaves it alone, because that is the case the plan already predicted. Slots are
pooled, so a round dying and another being born into the same slot inside one
gap would leave the hash where it was; `dodgeBulletAdds` is what closes that.

#### What the lead does to a held plan

Plan time is not wall time with a constant subtracted. Its zero is the moment a
press reaches the server — the far end of the ping lead — so a press made `d`
seconds after the plan lands `d` seconds later in plan time *only while the lead
is what it was*. If the link has moved, the press arrives that much earlier or
later relative to the world the plan described, and the correction is exactly
the difference in leads:

```
  t  =  (now - plan.at)  +  (lead_now - lead_planned)
```

That one term is right for the threats as well, and for free, because plan time
is a single clock over the whole scored world: at plan time `t` the rounds are
where the search put them at `t`, since that is how they were swept. Indexing
the course at the true `t` therefore reads the leg that was scored against the
rounds as they will actually be. A slower link does not merely delay our press
— it delays it into a world the plan already has an opinion about.

It holds only while the plan does. A lead that moves far enough to slide the
plan's own start off the cell the search rounded it to is a different start
state, not a different index into this one, so past `DODGE_LEAD_SLACK_CELLS`
of it the plan is dropped instead of re-indexed. As a distance rather than a
time it tracks `Grid` and the measured speed on its own; at the defaults it is
about 29ms of ping.

A negative `t` — the link speeding up, so our press now lands before the plan's
own zero — presses the opening leg. That is the heading the plan commits to at
its start, and the alternative of pressing nothing would spend the gap standing
still, which the search never scored.

#### What it actually changes

Almost nothing about how the bot plays, and a lot about what it costs. Against
a simulated link the search runs on 20–37% of the steps it used to, and on a
healthy link **the leg being pressed is always the opening one** — the plan is
replaced before its second decision ever comes due. The bot is not committing to
a course; it is declining to re-derive the same answer:

```
  link                        searches / steps    deepest leg reached
  ------------------------------------------------------------------
  20Hz, 40ms, no jitter            25%                   0
  20Hz, 60ms, ±8ms                 25%                   0
  20Hz, 140ms, ±25ms               37%                   0
  15Hz, 60ms, no jitter            20%                   0
  20Hz with a 400ms stall          23%                   3
```

The 140ms row is the lead-slack rule earning its keep: at that jitter the lead
moves about a cell between steps, so plans get dropped rather than re-indexed.
The stall row is the only one where legs past the first are ever pressed, and it
is the case that motivates the whole thing — with no new information arriving,
continuing the plan is strictly better than re-running the search on data that
has not changed.

The keys still go back the instant the threat set empties, because the threat
build and that check run on every step regardless. What is skipped is the
search, which is two orders of magnitude more of the frame than the rest of it.

### Watching the plan

The search's own answer is one heading — the one to press now — and every other
leg behind it used to be overwritten as the layers swapped. That is no longer
enough for the search's own caller, never mind for anyone watching: the plan is
held and played out, so the legs after the first have to survive the function
that found them.

**Show plan** in the MOD tab draws them. The line on the overlay canvas is the
winning state's own ancestry, walked back through the search — not a
re-simulation of the opening heading, which is a different path the moment the
plan turns, and turning is exactly when the line is worth looking at.

Recovering it costs two extra tables. `dodgeDpParent` records, per state, the
grid index it was reached from, and `dodgeDpDir` the heading of the edge that
reached it; after the beam has pruned a layer, `dodgeTraceCapture` snapshots the
survivors along with both. Only survivors are ever expanded, so a parent is
always still in the previous snapshot, and walking the winner back is a lookup
rather than a search. Both stores ride in the inner loop unconditionally — two
writes on the edges that improve a cell, against a table already carrying nine
`Float32` pairs per cell, and a branch there would cost more than the stores do.

The walk itself is unconditional now too. It used to be gated on the toggle,
which was right while the tail of a plan was only ever looked at; the tail is
pressed now, so the toggle gates the drawing and nothing else. `dodgeDpFirst`
survives as the search's own statement of its opening heading, but what
`dodgeStep` presses is `dirs[0]` off the walked-back course — the two agree by
construction, since `dodgeDpFirst` and `dodgeDpParent` are written by the same
relaxation on the same edges, and reading one of them twice is how it stays
that way.

#### Three positions, not two

The plan does not start at your sprite, and the gap is worth being exact about
because two different things make it up:

| | what it is | drawn as |
| --- | --- | --- |
| playout | `stateOnClock` at `renderNowMs()`, held `renderLag` ticks behind the clock so the lerp interpolates between snapshots it actually has | the camera centre — your sprite |
| packet | `me.pos`, the newest thing the server has said, and what `dodgeStep` plans from | a dot, at the end of the dotted leg |
| carried | packet + `dodgeCarry(prefixS)` — where the heading now held will have taken us by the time this frame's key press reaches the server | where the solid line begins |

The **dotted leg** is the renderer being behind the newest update. It is half a
tick to a tick of movement, 0.3 to 0.6 units at full speed, and the planner had
no hand in it. The **dashed leg** is the ping lead the planner applies on
purpose — `min(RTT × leadK, horizon/2)` — and it collapses to nothing with
**Ping lead** at 0. Drawing them as one stub off the sprite, which is what this
did first, makes the renderer's lag read as part of the bot's lead; at any
normal ping the two are about the same length.

The threats get the same lead in the same frame (`dodgeBuildThreats` advances
each round `leadS × speed` down its line), so plan-time zero means "the world as
the server will have it when this press lands", with us and the rounds both in
it.

#### The rest of the line

- **The plan itself**, solid, one dot per decision. The points are the grid's,
  not the mover's — every layer snaps to `Grid`, so these are the positions the
  loss was actually evaluated at, and drawing the unsnapped ends of the legs
  would draw a path the planner never scored. The gaps between dots are `Step`
  seconds of committed heading, so how coarse the plan is is visible directly.
- **The split at the leg being pressed.** Everything behind it — decisions
  already sent — is faded to a third; everything ahead is what is left to hold
  if nothing new arrives. On a healthy link the split sits on the first dot and
  never travels, which is the plan being replaced rather than spent. Watching it
  crawl is watching a stall.
- **A hollow ring** at the far end, which is where scoring stops rather than
  anywhere the plan intends to arrive.

It is display only: it reads the snapshot the last plan made, it cannot change a
plan, and the drawing is wrapped so that a bug in it cannot take the movement
keys with it. The line is dropped 120ms after the last step that pressed it —
refreshed on every step that holds the plan, not only on the ones that make it,
or it would blink out between packets — so it disappears when the threat set
empties and the keys go back. It keeps the overlay canvas alive on its own, so
the plan can be watched with the ESP overlay off. `window.__dodge().pathPts` is
the point count.

### Knobs

| MOD tab | default | |
| --- | --- | --- |
| Dodge bot | off | master switch |
| Show plan | off | draw the plan the search returned on the overlay |
| Horizon | 0.8s | how far ahead a plan is scored |
| Ping lead | 1.0 | multiplier on the measured round trip when advancing threats |
| Clearance | 0.2 | added to our radius before anything is solved, as a safety factor |
| Follow input | 1.0 | pull toward the keys you are holding, per second of opposition; also the only thing steering the bot when nothing is on course |
| Firing lines | 0.35 | what an enemy's aim is worth, as the chance the shot is taken; 0 is rounds-only |

`window.__dodge()` reports the live state — engaged or not, current heading,
measured speed, wall count, the lead actually being applied, and time-to-impact
both on the user's course and on the plan's. The threat count is split three
ways: `threats` is everything being solved against, `live` is rounds genuinely
in the air and `phantoms` is hostiles currently aimed near us, one apiece.
`worstDmg` is the worst live round in HP and `worstAimed` the worst line pointed
at us, undiscounted. A `typed` well under `live` means the `addBullet` hook went
on mid-flight or survev has shipped a bullet `BULLET_DAMAGE` doesn't list.
Neither hit readout counts phantoms: they are a real cost in the loss and
deliberately not an event in a number that answers "when does a round that
exists reach us".

`planLegs` is how many decisions the standing plan holds and `planLeg` which of
them is being pressed. `planLeg` climbing off 0 means the press about to land
falls past the plan's first decision — more than a `Step` of plan time has gone
by without the world producing anything new — and `planAgeMs`, wall time since
the search last ran, is the same story in milliseconds: at a healthy 20Hz of
updates it sits under 50. Both are the readout for
[Deciding at the rate the news arrives](#deciding-at-the-rate-the-news-arrives);
a `planAgeMs` that will not come down is a link that has stopped talking.

### What it doesn't do

The shot that hasn't been fired yet is only half-covered. Enemies aimed at us
are a cost — [Firing lines](#firing-lines) — but that is one frozen round per
enemy, priced by a flat prior on whether it is taken. What is still missing is
the rest of the model it implies: fire rate, so that living on a line costs more
than crossing one; anything bounding how long a single heading is held, which is
what makes a path predictable enough to lead in the first place; and any notion
that an enemy will re-aim. The gas isn't modelled either, so a dodge can push us
into it; the bursts are under a second, which makes that survivable rather than
solved.

Our own health isn't an input. A round is priced at what it would take off us,
never at what fraction of what's left that is — so the bot plays a hit the same
way at 12 HP as at 100, when at 12 the right move is to accept a wall-pin
penalty that would be silly at full health. Armour and helmets aren't modelled
either, and neither is `damageMult`.

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

### Selection, and declining to aim

The target is **whichever enemy is nearest the cursor**, recomputed every
frame, with no commitment.

A just-killed enemy stays in play for `deadLingerMs` (the "Linger" slider,
600ms by default) and inside that window is treated as a live player in every
respect — it competes for nearest-the-cursor on equal terms, gets a shot solved
for it, and gets fired at. The kill often lands before the last of a burst
does, and dropping the target the instant the server says "dead" throws away
shots that were already on their way. Once the timer is up it drops out
entirely.

That question is asked in exactly one place, `isEngageable`, so target
selection, the overlay's marker and autoshoot cannot disagree about whether a
body is still in play. The window is measured from the death rather than
restarted on each observation, and seeing the player alive again clears the
record so a later death gets a fresh window. The overlay's *threat* rings are
the one deliberate exception: those still skip the dead, since a corpse isn't a
threat — but the green target ring follows the aim, so a body being tracked
still shows one.

If that enemy **can't be shot** — `blocked`, meaning no clear line and no bounce
either — the aim helper does nothing at all. It does not fall through to the
next-nearest enemy and it does not drag the crosshair onto someone unreachable;
it replays the user's own cursor position and gets out of the way. That replay
is necessary rather than cosmetic: real mousemoves are being swallowed for as
long as the key is held, so the game sees only what we send it, and sending
their position straight back is what "no aimbot" has to mean. The glide anchor
is dropped at the same time, so re-engaging starts from where the mouse is now
rather than sweeping across from wherever the last target stood.

Autoshoot agrees by construction — it already refuses to fire on a blocked
shot — so declining to aim and declining to shoot happen together.

Target selection and the screen↔world conversions use clock positions too,
so the cheat engages the enemy whose sprite is under the cursor, and the
bearing it sends is measured from the position the camera is actually centred
on. Every lookup falls back to the sample ring when the clock can't answer —
still converging, or an enemy that just came into view — so nothing depends on
the clock being ready. `window.__aimDiag()` reports which path is live, the
lead terms in ms, and how far ahead of the drawn sprite the crosshair is being
placed.

### The whitelist

"Never aim at" in the MOD tab's Aimbot section is a multi-line box: **one
player name per line**. Anyone on it is never picked as a target, never marked
by the overlay's green ring and never shot at — the aim path behaves as though
they were not on the field. It is empty by default, so nobody is spared until a
name is put there.

The test lives in `isEngageable`, next to the dead-linger window, for the
reason that function exists at all: target selection, the overlay's marker and
autoshoot all ask it, so putting the whitelist anywhere else would mean the
three could disagree about it. Whitelisted players still get an ordinary red
threat ring — they are still someone to watch — they just never get the green
one, and `__aimDiag()` lists the ones on screen under `whitelisted`, which is
the first thing to check when the aim "does nothing" against someone.

Matching is on the trimmed line, case-insensitively. The name is being retyped
from memory rather than copied out of the game, and it is a whole-name match:
`friend` does not spare `friendly`. Blank lines are ignored rather than
matching the empty name. The raw text is what gets stored — reopening the menu
shows exactly what was typed, blank lines and all — and the lookup set is
rebuilt from it only when it changes, since the question is asked once per
enemy per frame.

Typing in the box does not reach the game. survev's key handler is a
bubble-phase listener on `window`, so stopping the event at the box is enough
to keep `wasd` from walking the player and a digit from swapping weapons; the
aimbot's own listener is capture-phase and runs first, so it checks whether the
caret is in one of our boxes instead of being stopped. Escape is deliberately
let through — it blurs the box and closes the menu, as it does everywhere else.

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
