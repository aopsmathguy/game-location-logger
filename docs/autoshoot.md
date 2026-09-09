# Autoshoot

Holds the trigger exactly while the shot is on, and lets go the moment it
isn't. Off by default; "Autoshoot" in the MOD tab.

It rides on the aim helper rather than standing alone: the aimbot decides where
the crosshair points and whether a shot exists at all, and autoshoot only
decides whether to pull. So it does nothing unless the aimbot is enabled **and
its key is held** — without that the crosshair isn't on anyone and "can the
enemy be hit" has no meaning.

None of what follows has a mobile variant. Everything here presses through
survev's own bind layer, and the mobile input path reads that same layer for
`shootStart`/`shootHold`, so it arrives on a phone unchanged — the activation
is the only thing that differs, and there the trigger *is* the activation. See
[On a phone](mobile.md#on-a-phone).

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

# How it pulls

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
