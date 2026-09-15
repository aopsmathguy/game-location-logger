# Aiming on the clock

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

# Selection, and declining to aim

The target is **whichever enemy is nearest the cursor**, recomputed every
frame, with no commitment. On a touch device there is no cursor to be nearest
to, and the question is scored as an angle off the aim pad's bearing instead,
with anyone more than 30° off it (45° once engaged) not picked at all — see
[Selection: a bearing, not a point](mobile.md#selection-a-bearing-not-a-point).

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
long as Fire is held, so the game sees only what we send it, and sending
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

# The whitelist

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
