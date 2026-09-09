# Bullet-blocking geometry

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

# Which ones reflect

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

# Fading out blocked enemies

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
