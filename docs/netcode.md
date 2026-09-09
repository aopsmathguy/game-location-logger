# Netcode smoothing

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


# Bullets on the render clock

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

# The trade

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
from `extension/core/inject.js` itself.

Nothing here touches input, packets or gameplay state; it is purely a render
path change, and the master toggle restores stock behaviour live.
