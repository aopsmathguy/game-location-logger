# Dodge bot

Takes the movement keys for exactly as long as something is going to hit us,
and hands them back when nothing is. Off by default; "Dodge bot" in the MOD
tab. "Something" is every round in the air, plus — because a round in the air
is already half a beat too late to answer — one hypothetical round per enemy
currently aimed at us, at a discount. See [Firing lines](#firing-lines).

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
