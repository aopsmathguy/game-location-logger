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
  (the same mechanism that broke the constructor setter traps).
- The ping readout inserts one `pointer-events:none` element as the first
  child of `#ui-top-left`, above `#ui-team`.
- Sample JSON schema lives in `sample.json` — keys: `ts`, `self`, `enemies[]`.
