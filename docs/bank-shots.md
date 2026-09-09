# Bank shots

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

# The mirror trick

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

# Lead and cost

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

# Bouncing off a circle

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
