# Dodge bot

Takes the movement keys for exactly as long as something is going to hit us,
and hands them back when nothing is. Off by default; "Dodge bot" in the MOD
tab. "Something" is every round in the air; plus — because a round in the air
is already half a beat too late to answer — one hypothetical round per enemy
currently aimed at us, at a discount; plus the blast of every grenade whose fuse
is already burning. See [Firing lines](#firing-lines) and
[Grenades](#grenades).

# What is and isn't dodgeable

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

# Solving the bullets

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

# What a round is worth

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

# Planning

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

# Graded by what we don't know

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

# Taking the keys, and giving them back

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

# Firing lines

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

# Grenades

A round is a line and a blast is a moment, and that difference decides
everything about how one is scored. There is nothing to sweep, no closest
approach to find, and no question of when contact begins: a grenade does exactly
one thing to us and it does it at one instant. What has to be right is *where*
it is at that instant and *when* that instant is — and the wire carries neither.

A projectile's update is `pos`, `posZ` and `dir`, plus `type` and `layer` on a
full update. No velocity, no fuse, no thrower. All three are reconstructed.

## Where it will be

By simulating it, not by solving it. The closed form exists — the airborne leg
is a straight line at constant speed for `(velZ + √(velZ² + 2g·z₀))/g` seconds,
1.044s for a frag, and the ground leg's entire remaining travel is exactly
`speed/drag` however the tick length is chosen — but it stops existing the
moment the grenade touches anything, and grenades are thrown at cover for a
living. Stepping survev's own integrator handles bounces, the table it lands on
and the river it falls in without any of them being a case anyone has to write,
and it costs a few hundred multiplies for a threat that appears a handful of
times a match.

Three things about that loop are easy to write plausibly and get backwards, and
all three change the answer by units:

- **Drag applies only while it is resting.** `posZ <= obstacleBellowHeight` is
  the server's test. An airborne grenade holds its horizontal speed *exactly*,
  which is also why one snapshot delta measures that speed outright rather than
  sampling something that is changing.
- **There is no bounce in Z.** `posZ` is clamped at the floor and `velZ` carries
  on downward, so a grenade lands once and stays landed. One arc covers the
  whole life.
- **A bounce keeps `max(1 + d·n, 0.15)` of its speed**, so a graze keeps almost
  everything and a head-on hit keeps a sixth. Obstacles *below* it raise the
  floor instead of turning it, which is how a grenade comes to rest on a crate.

`tests/blast_sim.js` drives the shipped simulator against an independent
transcription of `server/src/game/objects/projectile.ts` over open ground, a
wall, a glancing wall, a table, a barrel, a bush, water, a cooked airburst and a
short lob. Worst position error across the nine: **0.000u**. It also checks the
two independently derivable numbers — the air time and the `v/drag` slide —
which agree with the loop to 0.083u, the whole of which is Euler at 100Hz
against the exact parabola.

## Solved once

The detonation point is solved on the first packet that can measure a velocity —
the second one, since velocity takes two snapshots — and then **frozen for the
life of the grenade**.

That is not an optimisation, though it is one. Re-running the simulation every
packet is *redundant*: simulating from a later state over a correspondingly
shorter fuse lands in the same place, because the later state is on the
trajectory the earlier run computed. All re-running can add is the jitter of
re-deriving velocity from a fresh pair of quantised positions, which makes the
blast point wander when it is a fixed spot on the ground. The same test file
checks the invariant directly, re-solving each scenario from a quarter, a half
and three quarters of the way through its fuse: **0.000u** of drift in every
one, bounces and tables included.

Getting that clean took a real fix. The simulation used to start with its floor
at zero and build up from there, which is right for a grenade in the air and
wrong for one already resting on a table — it would believe itself airborne,
skip the drag it should have been under, fall to the ground and be put back.
Handing it a state mid-slide diverged by 11u. The floor is now derived from the
state the simulation is given, the way `obstacleBellowHeight` is carried across
ticks on the server.

Freezing has one cost worth naming: if the world changes under the prediction —
a crate the grenade would have bounced off is destroyed mid-flight — the frozen
point is stale and nothing re-checks it.

## When it goes off

The fuse is not on the wire, but the *animation* is. The server calls
`playAnim(Anim.Cook, fuseTime)` the instant the pin comes out and
`playAnim(Anim.Throw, …)` the instant it leaves the hand, and both ride the
player's full update as `animType`/`animSeq`. Those two transitions bracket the
cook exactly, to within the packet they arrived on.

They are read off **netData**, through `mangled.js` — `netData.animType` and
`netData.animSeq`, derived by the same `derive_field_on` anchor as
`activeWeapon`, off `this.<netData>.<X> = e.animType`. The client also keeps a
render-side `player.anim` under readable names that would need no dictionary
entry, and it is the fallback, but it is not the source: `player.anim` is the
animation the client is *playing*, and it resets `anim.type` to None locally —
without touching `anim.seq` — when the selected animation has no data and when
the active weapon stops being a throwable. Neither fires during a real cook, so
reading it worked; but a transition detected by a sequence change and then
classified by a type something local may have rewritten is a fragile pair to
hang the whole fuse estimate on. netData is the verbatim wire copy and nothing
but the packet writes to it.

That is worth the bookkeeping because cooking is the whole difficulty. An
uncooked frag detonates 4s after the throw and is at rest for the last second
and a half of it; one cooked for three seconds goes off about where it lands.

**We never see a grenade at the height it was thrown from.** The server creates
it at `posZ` 0.5 on a 100Hz physics tick and serialises the world at 33Hz, so
one to three ticks of flight have already happened by the time the first packet
carrying it arrives, and `posZ` is between 0.549 and 0.644. Any test for spawn
height is a test that cannot pass — and while one was the gate on this path,
nothing behind it ever ran: no grenade was attributed, no cook was carried, and
every fuse read as full.

So the age comes from the arc, which has two answers — the same `posZ` occurs
once going up and once coming down — and **the throw animation picks between
them**:

1. **Somebody threw within the last few ticks.** The grenade is at the start of
   its flight, so the ascending root is the age, and their cook comes with it.
   This close to the throw `velZ` is still near its full 5 and the inversion is
   at its best conditioned, dating it to a fraction of a millisecond.
2. **Nobody threw.** We have picked it up in the middle of a life we did not
   watch, so the descending root is taken — the larger of the two, which reads
   as the older grenade, the one that goes off sooner. The fuse is assumed full,
   which is the longest it can be. A second snapshot with a rising `posZ`
   corrects the branch.

The cook itself is only carried from a thrower the animation *named*, never from
the fallback that guesses the nearest body — better an assumed full fuse than
somebody else's measured one. And "watched begin" means we had an update about
that player on the tick before the pin came out, not merely that we have seen
them at some point: a player cooking out of view sends no updates at all, so
when they walk back in their `animSeq` has moved and their `animType` is Cook,
and nothing in that packet distinguishes a pin pulled just now from one pulled
three seconds ago behind a wall.

An unmeasured cook reads as "nobody cooked it", which is the longest fuse the
grenade can have. That would be a grenade the planner never sees, except for the
rule below.

The elapsed time is measured in pseudotime — the clock the netcode block
recovers — because that is what the tick indices mean and it is jitter-free by
construction. Wall time is the fallback rather than a fabricated tick length:
survev's `netSyncTps` is 33, so assuming 50ms would inflate every cook by two
thirds and read a 2s cook as 3.3s — a fifth of a frag's fuse, invented.

## The grenade nobody has thrown

A frag spends up to four seconds in a hand before it spends any in the air, and
that is the part of its life we can see coming: the pin is out, the fuse is
running, and the clock is on the wire as an animation. Starting only when the
projectile exists is late for a bullet and much later for this.

It is also wrong in the dangerous direction for the throw that matters most. A
grenade cooked for three seconds goes off about where it lands, so the planner
first meets it with under a second of fuse on a threat it has never seen.

So a player currently cooking contributes one blast **at their own feet**, at
the moment their fuse runs out. If they never throw it that is exactly what
happens; if they do, they throw it somewhere unknowable — at us, which is worse,
or away, which is better. Their own position is the neutral reading and the only
one that does not require guessing at intent.

Which is why it is priced as a **phantom**, on the same footing as the round
nobody has fired: a real cost in the loss, deliberately not an event in the
readouts, and scaled by `DODGE.phantom` as the probability half of the
expectation. The two knobs multiply, so **Firing lines** at 0 turns this off
along with the aim term.

Only a cook we can actually time is counted — an unwatched one is not counted
from when we noticed, it is not counted at all. Our own cook is skipped: we
decide when it leaves our hand, and the projectile it becomes is picked up like
anyone else's.

**Three things end a cook, and all three have to be caught**, because a cook
that does not end is a ring expanding forever on somebody holding nothing.

- **The animation leaves Cook** — *any* animation, not `Anim.Throw`. Throwing by
  switching back to a gun, which is how most grenades are actually thrown, runs
  `throwThrowable()` and `cancelAnim()` in the same server tick, and only the
  last state of a tick reaches the wire. What we see is Cook → None, and the
  `Anim.Throw` in between never existed as far as any packet is concerned.
  Watching for Throw alone left the cook running forever *and* quietly cost the
  resulting grenade its thrower and its cook time. Leaving Cook is therefore
  read as the throw; the ways that can be a lie — a cook cancelled inside
  `cookTime`, a `cancelAnim` from a revive — produced no grenade, and nothing
  reads the throw without one appearing.
- **The player stops sending updates**, which means they are out of view and the
  cook may have ended without us.
- **The clock.** A cook cannot outlive its own fuse: the server force-throws at
  `cookTicker > fuseTime` and gives the Cook animation exactly that long to run,
  so getting past it means the grenade left their hand while we were not
  looking.

On the overlay a cooked grenade draws with a **dashed** outline, which is how a
place that is still a guess is told from one already committed to. The fuse in
it is as real as a thrown grenade's.

**For our own cook the place stops being a guess**, and the ring moves off our
feet onto the ground where the grenade would actually land. We know the cursor,
and on this server the cursor *is* the throw strength: `throwThrowable` scales
the throw by `clamp(mouseDist, 0, 18) / 18`, so half a cursor is half a throw
and everything past 18 units is the same full-strength lob. That makes the
cursor a throttle rather than only an aim, and a ring on the ground is the only
honest readout of it — the alternative is learning the mapping by feel.

The whole throw is ported: the spawn a hand's length out along the aim and
**clipped back to the first wall**, which is the case that matters because
cooking behind cover and lobbing over it is what people do; our own movement
folded in at `playerVelMult`; the `amped_explosives` multipliers on both range
and speed when we have the perk. The result goes through the same
`dodgeSimBlast` every other grenade does, from a state we construct instead of
one the wire delivered, so the bounces and the slide are the same physics.

Two deliberate choices. It reads the **live cursor**, not the aim the last
packet carried — the question is what happens if we let go *now*, and the cursor
is a round trip ahead of the wire. And our own movement comes from the packet
ring rather than from the movement keys, because that is the velocity the server
actually applied and it already carries every reason it might not be 12: water,
being downed, a heavy weapon.

For anyone else's cook the cursor is not on the wire, so their feet remain the
only honest answer and the ring stays there.

## A fuse that outlasts the horizon

The horizon is 0.8s and an uncooked frag has three seconds left when it lands,
so scoring only what fits inside the plan would make every grenade invisible
until its last 0.8s — by which point the blast is 12u across, a player covers
9.6u, and there is no escape left to plan.

So a fuse that runs past the horizon **detonates at the end of the horizon
instead** — but still *where the grenade actually goes off*, not where it
happens to be when the horizon runs out. The time is a guess the horizon forces
on us; the place is not, so it is not guessed as well. That is a correction as
much as a simplification: scoring the position at horizon-end meant a grenade
sailing over our heads on its way to landing twenty units away was charged as
detonating overhead, which is the one thing it is certainly not going to do.

The time discount already prices the far end of the horizon at a quarter of face
value, and every step re-reads the fuse one tick shorter. Nothing about the
horizon itself had to change.

## What it costs

`dodgeDpBlast` replaces the sweep for a blast, and it is cheaper than the thing
it replaces: the leg containing `tBoom` carries us to one position, that
position is one distance from the blast, and the distance decides the damage. No
other leg is charged, because on no other leg does the explosion exist — which
makes the once-only billing rule automatic rather than enforced, so `billOpen`,
`dodgeDpSkip` and the already-inside test never come into it.

The falloff is survev's own, with one surprise: past `rad.min` the ramp is
measured from the *centre*, not from `rad.min`, so it does not resume at full
damage where the plateau ends. A frag is 125 out to 5u and about 73 just past
it, decaying to nothing at 12. That step is the game's, not ours. `DODGE.
clearance` is subtracted from the distance before the curve is evaluated, the
same doubt it stands for everywhere else, and assuming we are that much closer
than we think can only raise the charge.

Because `f` here is a fraction of real HP rather than a probability that a hit
happens at all, and both are multiplied by the same `w × DODGE_HIT_COST`, a
blast is directly comparable to a round: 125 HP of frag against 11 of MP5 falls
out without any of it being a special case in the loss.

## Cover, per cell

Cover was tested once, from the blast to where we already stood, and a wall
dropped the threat outright. That was safe in one direction only: the bot could
not be pulled *out* of cover by a blast a wall would stop, but neither could it
be held *in* cover, because a plan that walked us out from behind the wall was
not charged for it either.

`dodgeDpVisible` answers it per cell of the search grid instead, memoized on
exactly the pattern `dodgeDpMoveFor` uses for movement and for the same reason:
walls do not move within a plan, so the answer cannot depend on when we arrive,
and the several states that reach a cell pay for the raycast once between them.
The wall becomes a gradient the search can climb — zero behind it, full in front
of it — so staying put and stepping back into cover are things the planner now
has an opinion about.

The cost is bounded by the frontier, not by the grid. A blast is billed on the
one layer its instant falls in, so only the cells reached on that layer are ever
asked: at most the beam width times nine headings, and far fewer in practice
because headings out of neighbouring cells land in the same cells. Blockers are
prefiltered per plan to those that could stand between the blast and anywhere
reachable, so each ray scans a handful of obstacles rather than the map, and the
distance test runs first so most of the grid never reaches the raycast at all.

Four blasts get per-cell visibility; any beyond that fall back to the
single-point answer, as does the rollout that feeds `userHitIn` — it runs before
the search, so the grid its cells would be indexed against does not exist yet.

The occlusion predicate is the explosion's own, not `blocksBullets`:
`collidable && height > 0.5`, which is a higher bar than a bullet's 0.25 and —
unlike a bullet — does not let a blast through a window.

A blast a wall already blocks is now deliberately still a threat, costing
nothing everywhere the wall covers. That is the point of doing it per cell, and
it does mean the bot engages for grenades it is already safe from; the plan it
finds is the user's own keys until those keys would walk into the blast.

## Whose grenade it is

This has to be right, because the three cases are genuinely different: **a
squadmate's frag cannot hurt us at all** (`Player.damage` returns early on a
shared `teamId`), **our own hurts us in full** (the same test is skipped when
the source is the victim), and an unknown thrower is treated as hostile,
matching what the bullet path does with an unknown shooter. Getting it backwards
either walks the bot off a harmless grenade or leaves it standing on our own.

The wire never says. It says two things that together very nearly do.

**The throw animation names them.** `throwThrowable` calls `addProjectile` and
`playAnim(Anim.Throw, …)` in the same call, on the same tick, and both are dirty
in the same packet — so the thrower is animating a throw in the very packet the
grenade first appears in. `Anim.Throw` is played nowhere else in the game. That
alone usually leaves one candidate.

**The type is the second gate.** A cook records what was in hand when the pin
came out — read at the Cook transition, not at the throw, because throwing your
last grenade switches your weapon before the packet is built. So a `frag` can
only have come from someone who was cooking a frag, which separates them from
whoever threw a smoke on the same tick.

**Geometry ranks whatever is left**, and does it by the hand rather than the
body. The throw leaves from `player.pos + rotate({0.5,-1.0}, aim)` — 1.118u out
at 63.4° off the aim — so the expected point is fixed by two things both on the
wire, and the test is oriented instead of a circle. It is measured to the
*segment* from body to hand, not to the point, because the server clips the
spawn back along exactly that segment when a wall is in the way, so anywhere on
it is a perfect fit rather than an error of up to a hand's length. Two players
standing 0.4u apart and throwing in opposite directions are separated by 1.00u
of fit against a 0.35u margin; a radius around the body could not tell them
apart at all.

**One candidate needs no geometry at all.** If one player threw a grenade of
this type on this tick, that player threw this grenade; the position test exists
to break ties, not to second-guess the animation. With two or more, the winner
has to clear the fit tolerance *and* beat the runner-up by the margin, and the
tolerance is widened by how far the grenade can have flown in the tick or so
since it left the hand — `(speed × 2 + 7.2) × age`, the throw speed at the
`amped_explosives` multiplier plus the most of their own motion a thrower can
put into it. Anything else falls back to nearest body and is marked unsure.

**`sure` gates exactly two things, and it is the asymmetry that decides which.**
Being wrong is not the same size in both directions: calling an enemy frag a
squadmate's and ignoring it costs 125 HP, while calling a squadmate's an enemy's
costs a few hundred milliseconds of walking somewhere we did not need to go. So
only a named thrower can make a grenade harmless, and only a named thrower is
trusted with a cook time — better an assumed full fuse than somebody else's
measured one. An unsure attribution reads as hostile like any other unowned
grenade.

`window.__dodge().nades` lists every grenade in the air with its type, thrower,
whether that is named or guessed, and the fuse left; `owned` against `tracked`
is the same story as a ratio. An `owned` well under `tracked` in a squad means
the bot is dodging its own team's grenades.

## Watching it

**Grenade rings** in the MOD tab draws, for every grenade in the air, the blast
it is going to make: a faint red outline of the damage radius at the
*detonation* point rather than around the sprite, because for anything still
moving those are not the same place and the one that matters is where it will be
when the fuse runs out. A dashed leader joins the two when they differ, so a
grenade mid-flight reads as "it is here, it goes off there" rather than as a ring
that has drifted off its object.

**The fuse is the fill.** A low-alpha disc grows out from the centre to meet
that outline as the fuse burns, and a full circle means now. That is the whole
of the countdown — there is no clock in seconds, and there shouldn't be: the
disc reads without being looked at directly, which a number in the middle of a
firefight does not, and it is already in the units that matter. Seconds have to
be converted into ground before they mean anything; the disc *is* the ground.

The outline stays at a fixed faint alpha because it is a fact about the grenade
and not about the clock, so it must not compete with the thing that is moving.
The fill is measured against the throwable's own fuse rather than against when we
first saw it, so a grenade cooked for three seconds arrives three quarters full
instead of starting from empty and understating how little time is left. A
grenade still in a hand dashes its outline: the centre is a guess about somebody
who has not committed to it yet.

It is display only and works with the bot off, but it is not a second opinion:
it reads the same per-packet flight record and cook state the loss is scored
against, so what is on screen is what the planner is using — and it draws
exactly what the planner prices. Grenades on another layer are not drawn, for
the same reason they are not threats. **Neither is a squadmate's**: their frag
cannot touch us, so a 12u circle over the middle of a fight is ink for nothing.

That skip follows the planner's own asymmetry rather than being a second rule.
A grenade *in the air* is hidden only when the throw animation **named** its
thrower — a guess from proximity is not enough to take a blast off the screen,
exactly as it is not enough to drop it from the loss. A grenade still in a
**hand** needs no such caution: that is the player, in front of us, with the pin
out, and there is nothing to attribute.

**Our own grenades are always drawn, thrown or held**, and the held case is
where the overlay parts company with the loss on purpose. The planner does not
price our own cook — we decide when it leaves our hand, so it is not a threat to
plan around — but knowing *that* we are cooking is not the same as knowing how
much of the fuse is left, and that is the number the ring exists to show. It is
also the only fuse on screen we can still do anything about. Our own thrown
grenade is drawn for a simpler reason: it hurts us in full.

Whether a fuse was measured or assumed no longer shows on the overlay — it is in
`window.__dodge().nades` as `sure`, and in `cooks` as `exact`.

## The knob, and what isn't modelled

**Grenades** in the MOD tab scales what a blast is worth. Unlike **Firing
lines** it is not a probability of anything — a fuse that runs out is not a
guess — so 1 is the honest setting and the default; it is a knob because a 12u
radius is wide enough that answering one moves us a long way. 0 goes back to
rounds and firing lines only.

- **Shrapnel is not priced.** Every fuse throwable also throws 8–12 pellets at
  `v2.randomUnit()`, drawn on the server at detonation. There is no version of
  that a plan could be right about, and modelling it would put noise into the
  loss and nothing else. Only the core blast is charged.
- **Cover is per cell**, not per grenade — see below.
- **Impact throwables are ignored.** Potatoes, snowballs and coconuts detonate
  on contact, which is a collision to predict rather than a clock to read.
- **Layer changes mid-flight are not predicted.** The current layer is used, and
  a grenade taking the stairs is a tick late being re-attributed.
- **MIRV's children are not predicted.** They are spawned at detonation with a
  velocity drawn from `randomPointInCircle`, so only the parent blast is scored;
  the six minis become threats in their own right once they exist.
- **`fuseVariance` is taken at its low end.** `mirv_mini` and `martyr_nade` add
  a 0–0.3s draw the wire never carries, so the estimate is the earliest the
  grenade can go off.

# Deciding at the rate the news arrives

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

# Watching the plan

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

# Knobs

| MOD tab | default | |
| --- | --- | --- |
| Dodge bot | off | master switch |
| Show plan | off | draw the plan the search returned on the overlay |
| Horizon | 0.8s | how far ahead a plan is scored |
| Ping lead | 1.0 | multiplier on the measured round trip when advancing threats |
| Clearance | 0.2 | added to our radius before anything is solved, as a safety factor |
| Follow input | 1.0 | pull toward the keys you are holding, per second of opposition; also the only thing steering the bot when nothing is on course |
| Firing lines | 0.35 | what an enemy's aim is worth, as the chance the shot is taken; 0 is rounds-only |
| Grenades | 1.0 | what a grenade's blast is worth, as a multiplier on the damage it would do; 0 is off |
| Grenade rings | off | draw each grenade's blast radius and fuse on the overlay |
| Frag aim | off | aim the throw at the instant it is released (see [Frag aim](#frag-aim)) |

`window.__dodge()` reports the live state — engaged or not, current heading,
measured speed, wall count, the lead actually being applied, and time-to-impact
both on the user's course and on the plan's. The threat count is split three
ways: `threats` is everything being solved against, `live` is rounds genuinely
in the air and `phantoms` is hostiles currently aimed near us, one apiece.
`worstDmg` is the worst live round in HP and `worstAimed` the worst line pointed
at us, undiscounted. `blasts` is grenades being planned against, `worstBlast`
the worst of them at its centre and `blastIn` how long the soonest has left in
plan time — a `blastIn` reading exactly `horizon` is the clamp in
[Grenades](#grenades), not a measurement. `tracked` is grenades in the air and
`cookTimed` how many of those we timed a cook for, and `owned` how many had a
thrower named outright by the throw animation rather than guessed from
proximity — see [Whose grenade it is](#whose-grenade-it-is). `nades` lists them
individually. `cooking` is grenades still in a hand and `cooks` lists those with
how long each has been burning and whether that is a measurement. A `cookTimed`
that is always zero means the anim watch is not seeing throws at all. A `typed` well under `live` means the `addBullet` hook went
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

# What it doesn't do

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

Grenades are a cost — [Grenades](#grenades) — but only their core blast.
Shrapnel, impact throwables, MIRV's children and mid-flight layer changes are
all listed there. The one worth repeating is what a cook we could not time does:
it is not counted, so the grenade it produces arrives priced at a full fuse,
which is the longest it can be and therefore the latest it can go off. That is
the safe direction for the horizon clamp to be wrong in, but it is still a
grenade the planner meets later than it could have.

# Frag aim

Off by default, and the only thing here that changes where a throw *goes*
rather than what is known about it.

**While a grenade is cooking, the cursor is driven every frame to the throw
that would land nearest the target** — so releasing at any instant throws it
there, and the user's job is reduced to deciding *when*.

Driving continuously rather than fixing the aim on release is both simpler and
better. Simpler because there is nothing to defer: the game builds one input
message a frame from whatever the cursor currently is, so if the cursor has been
right on every frame then it is right on the frame the release happens to land
in, and no part of the release has to be intercepted, held back or replayed.
Better because the throw is no longer a single solved instant that may already
be stale by the time the packet goes out — it is re-solved against where the
target is *now*, sixty times a second, until the moment it is let go.

The gate is the cook state itself, which is exactly "the pin is out and it has
not left our hand" and ends by itself the moment the throw goes out.

The user's real mouse is suppressed while this drives, the same way it is while
the gun aimbot's key is held, but it is still *recorded* — target selection
reads it, so moving the invisible cursor still chooses who to throw at. When the
takeover ends their real position is replayed once, so the aim snaps back to
where their mouse actually is rather than holding the last thing we sent.

The overlay ring follows the solve rather than the suppressed cursor, so what is
drawn is where the grenade is actually going. It costs no second simulation —
the solver already computed the landing point this frame.

## What it aims at

Whoever the **user's own cursor** was nearest when they let go, extrapolated to
where they will be when the grenade goes off. Picking by their cursor keeps the
choice theirs: this answers "how hard, and in what direction", which is the part
a human is bad at, and not "who".

The lead is the round trip plus the fuse — their position is a one-way trip old
and our release lands a one-way trip from now — evaluated on the same recovered
clock the aim helper leads with, so a strafing target is led and a standing one
is not.

## Solving the cursor

Two variables, and the second is the throw's strength, so this is a genuinely
two-dimensional aim rather than a direction with a range that takes care of
itself. It cannot be inverted in closed form once a wall is involved: a throw
that clears a crate and one that bounces off it differ by a degree and land
twenty units apart.

So it is searched — but seeded analytically, which is what keeps the search
small. With nothing in the way a standing throw covers
`speed × (tAir + 1/drag)`, the flight plus the whole of the slide, so the
strength that reaches a given distance is one division away. The seed is usually
the answer; the three-pass sweep around it is what copes with bounces, with the
thrower's own motion folded into the velocity, and with a fuse too short to let
the grenade finish sliding.

### What it costs, and what it cost before

Running this every frame put the whole thing on a budget it did not originally
respect. The first version ran the game at **20fps**, and the test now measures
the thing that did it: a solve against 40 obstacles in range took **38ms**.
Four separate mistakes, each invisible against the empty-field benchmark that
had been standing in for the measurement:

- **Every candidate rebuilt the obstacle list from scratch**, and that list is
  built by walking the entire obstacle pool — every obstacle on the map. A
  hundred candidates meant a hundred full sweeps, plus another hundred from the
  spawn clip. Both are now filtered once per solve: every candidate throws from
  the same body and none can travel further than the strongest, so one disc
  covers all of them.
- **Every candidate was integrated at the server's own 100Hz.** Ranking does not
  need that: the flight is a straight line at constant speed and the slide's
  total is `v/drag` whatever the step, so neither of the two things that decide
  where a grenade lands is sensitive to it. Candidates are ranked at 0.03s and
  the *winner* is re-thrown at full resolution, so what comes back is exact even
  though what found it was not.
- **Every candidate simulated the whole fuse**, including the two-and-a-half
  seconds a frag spends already at rest. It now stops when it stops — below a
  thousandth of a unit per second, which has four ten-thousandths of a unit of
  travel left in it, so the exit is finer than the position it exits from.
- **The innermost loop did the full collision test on obstacles it was nowhere
  near.** A bounds reject runs first now.

Together: **38ms → 0.88ms** warm, 1.99ms cold, with every reachable target still
solved to under 0.11u. The path simulation is still exact against the server
transcription at 0.000u, which is the property none of this was allowed to cost.

Two smaller per-frame leaks went with it. **Grenade rings** was holding the
overlay canvas open for the whole round — it asked whether any cook state was
*tracked* rather than whether any cook was *live*, and cook states are kept per
player until there are 32 of them. And the cooked-grenade threat re-swept every
obstacle on the map for its line of sight on every planner step, at up to 60Hz
against packets arriving at 20; it is cached per packet now, like the thrown
grenades' already was.

Solving every frame makes the previous frame's answer a near-perfect seed, so a
**warm** sweep opens an order of magnitude narrower — 0.05 rad against 0.28 —
and the same three passes land that much finer. It is gated on the target not
having changed, and it is self-correcting rather than trusted: a warm solve that
does not converge is redone cold and the better of the two kept. That matters
because the warm window can genuinely be outrun — a target three units away
while we strafe past it moves the bearing further in one frame than the window
is wide — and a seed that can no longer see the answer will sit where it is and
report a large error rather than go looking. The test drives a strafing target
for thirty frames (warm tracks cold exactly, 0.027u) and then hands the solver a
seed pointing 180° the wrong way, which converges anyway.

Two honesty properties the test pins down. A target out of range gets the
longest throw available and an error saying how far short it fell, rather than a
pretence that it reached — `window.__frag().missBy` is that number. And a target
behind a wall solves to a throw that stops at the wall; the search cannot reach
past it and does not claim to.
