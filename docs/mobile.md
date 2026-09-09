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

The cost of the strict reading is real and worth knowing: **you cannot shoot
scenery** — a crate, a door — while both switches are on, because there is no
gesture left that means "fire at that". Turning Autoshoot off in the MOD tab
hands the trigger straight back.

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

Both the aim helper's selection and the overlay's green preview ring go through
the one function, so they cannot drift apart —
[the same reason `isEngageable` is asked in one place](aiming.md#selection-and-declining-to-aim).

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
