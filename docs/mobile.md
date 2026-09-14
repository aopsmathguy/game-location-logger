# On a phone

Everything in this repo was written against survev's desktop input path: a
mouse that carries the aim, four keys that carry the movement, and a keybind
held down to say "aim for me". A touch device has none of the three. This is
what changes, and what deliberately doesn't.

The whole of it lives in one section of `extension/core/inject.js`, marked
`Touch input`, plus a handful of call sites that ask it which device they are
on. `tests/touch_sim.js` drives that section through a port of the bundle's own
pads.

# What the game does differently

The two input paths diverge inside a single `if` in the bundle's per-frame
input build:

```js
if (device.touch) {
  const move = touch.getTouchMovement(camera);
  const aim  = touch.getAimMovement(player, camera);
  if (touch.moveDetected) {
    msg.touchMoveDir = normalizeSafe(move.toMoveDir);
    msg.touchMoveLen = round(clamp(move.toMoveLen, 0, 1) * 255);
  } else msg.touchMoveLen = 0;
  msg.toMouseDir = aim.aimMovement.toAimDir;
  msg.toMouseLen = clamp(aim.aimMovement.toAimLen / touch.padPosRange, 0, 1)
                   * GameConfig.player.throwableMaxMouseDist;
} else {
  msg.moveLeft = binds.isBindDown(MoveLeft) || ...;   // and three more
  msg.toMouseDir = normalize(worldMousePos - playerPos);
  msg.toMouseLen = length(worldMousePos - playerPos);
}
msg.shootStart = binds.isBindPressed(Fire) || touch.shotDetected;
msg.shootHold  = binds.isBindDown(Fire)    || touch.shotDetected;
```

Three consequences, and they are the whole reason there is a mobile path at
all:

- **Aim is not the mouse.** The synthetic `mousemove` the aim helper dispatches
  every frame — see [Aiming on the clock](aiming.md#aiming-on-the-clock) — is
  read by nothing on this branch. `toMouseDir` comes off the right pad.
- **Movement is not the keys.** `moveLeft`..`moveDown` are not on the message.
  The dodge bot's four held binds go nowhere; movement is one analog vector.
- **The trigger still is the bind layer**, `|| shotDetected`. So
  [autoshoot](autoshoot.md#autoshoot) needs no mobile path of its own. It
  already presses through the same `isBindPressed`/`isBindDown` pair this
  branch reads, and everything it does — holding an automatic, tapping a
  semi-auto, the shot-then-quickswap for a slow gun — arrives unchanged.

So the mobile path wraps the two pad readers and rewrites what they return,
rather than trying to find a mouse where there isn't one.

# Finding the pads

`TouchInput`'s methods come through the mangler with their names intact —
`getAimMovement`, `getTouchMovement`, `setAimDir` are all readable in the
shipped bundle, the same property the roster fingerprint leans on in
[How inject.js finds the game](hooking.md#how-injectjs-finds-the-game). So the
instance is found by shape: the own property of the captured `Game` that has all
three plus an `aimMovement` field. No name is pinned, and a re-mangle doesn't
move it.

The wrap is marked on the instance itself rather than remembered in a variable.
A new round hands us a new `Game` while reusing the same `TouchInput`, and
wrapping a wrapper would make the second copy record our own driven values as if
they were the user's.

"Is this a touch device" is then answered by **whether the hook is firing**, not
by a user-agent string. `getAimMovement` is called from inside the
`if (device.touch)` branch and nowhere else, so it firing *is* the branch being
taken. The reading goes stale after 500ms, so a desktop that never enters the
branch never looks like a phone.

# The activation: the trigger is the aimbot

There is no key to hold, so the shot itself is the switch: **pulling the right
pad far enough to fire turns the aim helper and autoshoot on together**, and
letting it back off hands the aim straight back.

That threshold is survev's own. `shotDetected` goes up when the pad is pulled
past `padPosRange / 1.075` — about 93% of full deflection — so the gesture the
game already gives you for "aim without shooting" (a partial pull) is still
exactly that, and the one it gives you for "shoot" now aims instead.
`shotDetected` is computed by the original pad reader before anything of ours
runs, so what we read is the user's own trigger no matter what happens to the
vector afterwards.

The bind is still consulted alongside it, because a paired controller or
keyboard goes through it — and it is read past the synthetic-input layer via
`realBindDown`, so autoshoot's own presses can't latch the aim on forever. That
is the same precaution
[auto-quickswap](#auto-quickswap-one-half-of-it-needed-moving) takes with its
fire-edge detector, for the same reason.

The "Aimbot key" row disappears from the MOD tab on a touch device, since it
would be a dead control.

## ...and only the aimbot

Recording that trigger is not the same as letting it through, and it does not
get to be both. Once it is the activation, **autoshoot owns the trigger
outright**: `shotDetected` is read, stashed, and then cleared off the object
before the message is built.

Leaving it wired to both breaks the model in two ways you can see from the
first firefight:

- **It fires with no shot on.** The aim helper declining to aim at a blocked or
  absent target is supposed to mean nothing goes out — see
  [Selection, and declining to aim](aiming.md#selection-and-declining-to-aim).
  A trigger you cannot release without also dropping the aim keeps firing
  anyway, into walls and at nobody.
- **It breaks the slow-gun swap.** That cycle watches the magazine fall below a
  reading taken just before *autoshoot's* press — see
  [How it pulls](autoshoot.md#how-it-pulls). A held pad trigger fires on the
  same server tick the swap input lands, because both go out on one message. So
  the swapped-to gun's shot is already spent by the time the new gun is
  observed and its tracking reset, the drop is never seen against a pre-shot
  reading, and a pair of slow guns trades places exactly once and then sits
  there holding the trigger.

With the pull reduced to an activation, both go away for the same reason: every
shot that leaves the gun is one autoshoot decided on and took a reading before.
That is what "the pull is the bind, not the click" actually has to mean.

`shotDetected` is read in exactly two places in the bundle — the sticky-cook
line inside the pad reader, which has already run by the time our hook does, and
the message build, which hasn't — so this one write is total, and costs nothing
else. The aim line the pads draw reads `touchingAim`, a separate field, and
still shows.

Three cases are left alone, because in none of them is the trigger autoshoot's
to take:

| | why |
| --- | --- |
| A throwable | `shotDetected` isn't a trigger there, it *is* the cook. Clearing it throws the grenade on the spot. |
| A melee | Autoshoot doesn't swing. |
| Autoshoot or the aimbot switched off | Nothing else is going to fire, and taking the trigger away would leave you unarmed. |

## ...but only when there is someone to shoot

Taken unconditionally, the trigger left no gesture that meant "fire at that",
so a crate or a door could never be shot with both switches on. So autoshoot
only owns the trigger while **an enemy is inside the aim cone** — see
[Selection](#selection-a-bearing-not-a-point). Point the stick away from
everyone and the pull is an ordinary shot again, aimed by your thumb, since the
aim helper has nobody to drive the pad toward either. Point it at someone and
it's autoshoot's, blocked shots and all.

`touchShotSuppressed` asks that through the same `pickTarget` the aim helper
calls, from inside the pad hook, so on the very first frame of a pull the two
already agree — there is no frame where a manual shot slips out before the aim
loop has run.

One case inside the cone hands the trigger back as well: **an enemy whose only
cover is destructible**. The aim helper declines a blocked target, so nothing
was going to fire there, and the crate in the way is exactly what you want to
shoot. `blockedOnlyByDestructibles` sweeps the same line `reactionTarget` found
closed and says yes only if every obstacle on it is `destructible` — a crate in
front of a wall is still a wall. That sweep runs in the aim loop, which already
has the solve, and the pad hook reads its verdict through `aimCoverOnly`. With
no fresh verdict (the first frame of a pull, or one over 100ms old) the answer
is no, so the trigger stays autoshoot's. Once the crate breaks the line is
clear, the aim engages, and autoshoot takes over.

The handoff between the two needs no special care for the slow-gun swap. A
manual shot fired just before an enemy enters the cone can land its magazine
drop after autoshoot's first reading, and autoshoot will read that as its own
shot confirmed and swap. But the gun really did fire, so swapping out of its
recovery is the right move either way. What the swap can't survive is a pad
trigger and autoshoot both firing on the same message, and ownership is still
exclusive frame by frame.

# Tap to aim

On by default, and switchable in the MOD tab's **Touch** section. It replaces
the right-hand stick: **hold a finger anywhere and the gun fires at that spot**.
The movement stick shrinks to a corner around its own locked centre.

Each finger gets a role when it lands and keeps it until it lifts:

| where it lands | the stick is | role |
| --- | --- | --- |
| in the corner | free | the stick |
| in the corner | already held | aim + fire |
| anywhere else | either | aim + fire |

So a thumb that drifts out of the corner mid-walk keeps walking, and a finger
that slides into the corner keeps shooting. With several aim fingers down, the
newest one is aimed at.

The corner is `zone` (default 2) pad ranges right of and above the locked pad
centre, out to the screen edges the other two ways. It follows the game's own
layout, so portrait and the iOS offsets move it with the pad. It never reaches
past the middle of the screen, because the stock reader still decides whether a
finger is on the stick's half.

## How it is wired

It hooks one layer below the pad hooks: `getAim` and `getMovement`, the two
readers that `getAimMovement` and `getTouchMovement` call. Everything above
them (the recorded user aim, the driven bearing, the shot suppression, the dodge
override) runs unchanged on what the tap layer returns.

- **The stick** is the stock `getMovement`, handed a one-finger `input` for the
  duration of the call. The analog curve, dead zone, locked/anywhere style and
  pad sprite all stay the game's own.
- **The aim** is written fresh. The bearing runs from the centre of the screen,
  where the player is drawn, to the finger. `shotDetected` is simply "an aim
  finger is down". The pull is the finger's distance in world units, encoded
  through the same throttle frag aim inverts, so **a grenade is thrown to where
  you tap**, out to the pad's 18u ceiling, and it cooks for exactly as long as
  you hold. No right pad is drawn. The game shows both pads' sprites every
  frame no matter what, so the only way to hide this one is to put it off
  screen.

## Selection: a radius, not a cone

A tap is a point, as a cursor is, so `userAim` goes back to returning one.
`userAimScore` is the squared distance from the finger again. The limit on it is
**distance, not angle**: an enemy is only picked within `radius` world units of
the finger (default 5, widening 1.5× under the same `holdMs` hold the cone
uses). A player dead on the finger's bearing but far past it is not picked, and
one at a wide angle right next to the finger is.

## The trigger: the enemy's if there is a shot, the finger's if not

Ownership works as it does on the stick: autoshoot takes the trigger while there
is a target. The difference is what a walled-off target does. On the stick only
destructible cover hands the trigger back, because with nobody to shoot the
stick has only a bearing to fire along. A tap is a place you asked to shoot, so
**any** block hands it back. The aim loop records `blockedId` next to `coverId`,
and `aimBlocked` reads it with the same 100ms staleness rule. With no verdict
yet, on the first frame of a tap, the trigger stays autoshoot's.

In practice:

| | what fires, and where |
| --- | --- |
| aimbot off | the finger, at the finger |
| nobody within the radius | the finger, at the finger |
| an enemy within it, in line of sight | autoshoot, at the enemy |
| an enemy within it, walled off | the finger, at the finger |
| aimbot on, autoshoot off, enemy in sight | the finger, at the enemy |

# Driving the aim

A driven frame **claims the pad**, returning `touched: true` whatever the user's
thumb is doing. This is not cosmetic: a few lines after reading the pad, the
bundle checks

```js
if (touch.moveDetected && !aim.touched) { /* aim follows the movement stick */ }
```

so a reading that admits the aim pad is untouched has its bearing quietly
replaced by whichever way the player is walking. A solved bearing that only
holds while a thumb happens to be on the right half of the screen is not a
solved bearing.

Two things drive that pad — the gun aim helper and the frag solver — and a
release only lands if it comes from whoever last claimed it, so a cook that ends
mid-burst can't drop a crosshair the gun aim is holding. Releasing restores the
bearing and pull the user's own thumb last reported, for the same reason the
desktop path replays the real cursor once: the game keeps aiming at the last
thing it was told otherwise.

# Frag: the throttle is an inverse

Throw strength is cursor distance — see
[Frag aim](dodge-bot.md#frag-aim) — and on a pad that distance is not measured,
it is *encoded*:

```
toMouseLen = clamp(toAimLen / padPosRange, 0, 1) * throwableMaxMouseDist
```

So putting a solved cursor distance of `L` world units on the wire means solving
that back for the pad deflection that produces it,
`toAimLen = padPosRange * L / 18`. Get the direction of that division wrong and
every grenade still flies — just never as far as it was aimed, and only
noticeably at long range, which reads as "the solver is a bit off" rather than
as a bug. `tests/touch_sim.js` round-trips the full 0–18u range through the
bundle's own arithmetic for exactly this reason.

Setting the pull short does **not** end the cook. For a throwable the bundle
makes `shotDetected` sticky — once it is up and a finger is still down it stays
up regardless of deflection — which is what lets you hold a grenade at all, and
it means the solver is free to ask for a gentle lob. The throw goes out when the
finger lifts, and the message that carries it is built from the same solved
bearing and pull as every frame before it.

One capability is simply missing on a phone: **`amped_explosives` can't be
thrown at full range**. The pad's own ceiling is `throwableMaxMouseDist`, 18
units, while amped's reach multiplier wants 31.5, and there is no deflection
that asks for it. So the solver's `maxDist` is capped to 18 on a touch device.
Without the cap it would solve throws it cannot request and land every one of
them short.

# Auto-quickswap: one half of it needed moving

Auto-quickswap splits neatly, and only one half needed anything.

The half that **emits** the swap was already fine. `autoSwapEmitInput` arms
`isBindPressed` for `EquipOtherGun` (or the melee-tap pair), and the loop that
copies pressed equip inputs onto the message —

```js
for (const input of [Reload, ..., EquipMelee, ..., EquipLastWeap, EquipOtherGun, ...])
  if (binds.isBindPressed(input)) msg.addInput(input);
```

— sits *outside* the `if (device.touch)` branch, reading the same method the
synthetic-input layer wraps. So does the `SwapWeapSlots` line below it. Nothing
about getting a swap onto the wire is device-specific.

The half that **triggers** it was inert. The feature edge-detects on the user's
own trigger, and it read that as `realBindDown(binds, Fire)` — but on a pad the
user's trigger is not the Fire bind, it is the separate `|| touch.shotDetected`
term. The bind never moves, so the edge never arrived and the whole feature did
nothing on a phone while looking perfectly healthy in the MOD tab.

Both readers of "did the user pull the trigger" — this edge and the aim
activation above — now go through one `userFireDown`, which is the union of the
two terms the input message itself takes the union of. Both halves of it are
read past our synthetic layer, which is what keeps autoshoot's own presses from
queueing a swap on every burst it fires.

Autoshoot's *own* use of the swap was never affected by the edge — it queues off
its presses and the magazine drop, not off this. It was, separately, broken by
the pad trigger riding the same message as the swap; see
[...and only the aimbot](#and-only-the-aimbot).

# Dodge: one vector instead of four keys

[The dodge bot](dodge-bot.md#dodge-bot) plans in eight headings and used to
apply them by holding movement binds and suppressing the user's. On a pad it
writes the movement vector directly, and suppression comes free — the reading
being replaced *is* the user's.

Two details that the naive encoding gets wrong:

- **Standing still is not a direction.** The message gates its whole movement
  half on `moveDetected`, not on the vector, and a zero vector goes through
  `normalizeSafe(v, (1,0))`. So "hold this position" written as `(0,0)` walks
  due east at full speed. Putting `moveDetected` down is the only way to ask
  for nothing.
- **The user's own heading is analog.** `dodgeUserDirIdx` — the "is the course
  they asked for already clear" test — snaps the pad's bearing to the planner's
  eight by angle. The sign test the keyboard path uses would read a thumb a few
  degrees off due east as a diagonal, and a thumb is almost always a few degrees
  off something.

# Selection: a bearing, not a point

"Which enemy is the user pointing at" is a different question on the two
devices, and `userAim` is where they part.

A mouse gives a **point**: the cursor sits somewhere in the world and the enemy
nearest it wins. A pad gives a **bearing and a pull**, and the pull is the throw
throttle rather than a range — there is no point to be nearest to. Projecting
the bearing out to some invented radius would pick whichever enemy happened to
be standing at that radius, so the score becomes the angle off the bearing
instead, with distance folded in at a millionth of a radian per unit purely to
break ties between two enemies on the same line.

And the best score still has to be **inside a cone** (`TOUCH_CONE`), or nobody
is picked. Without one, a lone enemy directly behind you is "pointed at", and
since the pad trigger belongs to autoshoot whenever there is a target, that
left no way to shoot anything else — see
[...but only when there is someone to shoot](#but-only-when-there-is-someone-to-shoot).
It has two widths so a thumb sweeping across the edge doesn't hand the trigger
back and forth every frame:

| | |
| --- | --- |
| `enterDeg` 30° | an engagement starts inside this |
| `exitDeg` 45° | once one has, the limit widens to this |
| `holdMs` 250 | and narrows again after this long with nobody inside |

The hold is shared by every `pickTarget` caller — the aim, the trigger, the
overlay ring and the frag solver — so they agree on it too. It's tunable live
through `window.__touchCone`. A desktop has no cone: the cursor is a point, and
its trigger is a separate finger.

The overlay's green ring is not a preview of that selection. It marks only the
enemy the aim is actually locked onto this frame: `aimState.targetId` while the
aim loop is steering, or frag aim's target while it is solving a throw. An enemy
that would be picked but has no shot on it, or no lock at all, leaves every
ring red.

# What doesn't change

- Autoshoot, in full. It rides the bind layer, which the mobile branch reads —
  including the shot-then-quickswap it drives itself.
- Auto-quickswap's emission, for the same reason. Only its fire edge moved; see
  above.
- Every solver: the aim lead, bank shots, the blast simulation, the dodge
  planner, the frag sweep. They compute world-space answers and know nothing
  about how those answers reach the wire.
- The netcode smoothing, the overlay, ESP, name tags, the ping readout — none
  of them touches input.
- The desktop path itself, which is untouched and still tested by the same
  harness.
