# Zoom

"Zoom" in the MOD tab is a divisor on the camera's scale, from 1 to 2 in
twentieths, defaulting to 1.5. At 1 nothing is hooked at all and the game
renders exactly as it ships. At 2 everything is drawn at half size, which is
four times as much world on the screen. It is a divisor rather than a
multiplier because seeing *more* is the only direction worth a slider — the
game hands out the other one as scopes, and the art stops being legible well
before a third doubling would pay for itself, which is where the range ends.

It is the one thing in the MOD tab that is on out of the box, because it is a
display setting rather than a cheat — it changes what the camera shows and
nothing about input or gameplay state, the same grounds on which the netcode
smoothing and the name tags default on. 1.5 is where most of the extra view is
bought before a player gets too small to read what they are holding.

The world genuinely renders smaller: it is the same scale change a scope makes,
so sprites, terrain, particles, the gas circle and the cursor's own reach into
the world all move together. Nothing is stretched, nothing is redrawn at a size
the rest of the frame disagrees with, and the HUD — which is DOM — is untouched.

## Where the divisor goes

Every path from the camera to the screen funnels through two methods
(client/src/camera.ts), and both have to be divided or the frame comes apart:

```
pixelsPerUnit()  = m_ppu * m_zoom     positions, and the ground and layer
                                      transforms built off pointToScreen
scaleToScreen(x) = x * m_zoom         sprite sizes
```

Note what `scaleToScreen` is not: there is no `m_ppu` in it. Callers holding
world units divide by `m_ppu` themselves first, as in
`scaleToScreen(2 * rad / m_ppu)`, because `m_ppu` is the constant the art was
drawn against. So `m_ppu` — the tempting knob, a hardcoded 16 that nothing ever
writes, and so immune to the per-frame rebuild below — would shrink the world
transform and *double* every sprite standing in it.

`m_zoom` is the factor the two methods share, and it is the one number that
must not be written. survev rebuilds the camera scale from scratch on every
frame of `game.update` (client/src/game.ts):

```
m_targetZoom = maxScreenDim * 0.5 / (zoomRadius * m_ppu)
m_zoom       = lerp(dt * rate, m_zoom, m_targetZoom)
```

So a write to `m_zoom` survives exactly one frame. An accessor that divides
`m_zoom` on read is worse, and worth spelling out because it is the obvious
implementation: that divisor lands inside the lerp's own feedback loop — the
game reads back a value we already divided, lerps it toward the undivided
target, stores that, and reads it back divided again. The fixed point is not
`target / k`; solving `z = (1 - a)·z / k + a·T` for the frame rate's
`a = dt · rate` gives roughly `T/20` at 60fps, i.e. a view that settles
somewhere unrelated to the slider and that moves when the frame rate does.

So the divisor goes on the two methods instead, as own properties on the one
camera instance, and the zoom state machine is left completely alone. That is
also why a scope change still animates: the real `m_zoom` is still lerping
underneath and we only ever divide what it arrives at. Moving the slider
itself snaps, because there is no state of ours to ease.

`pointToScreen`, `screenToPoint` and `pixels` are prototype methods that call
`this.pixelsPerUnit()`, so shadowing it on the instance catches those three as
well: two overrides cover every path the renderer has. The ground container is
transformed by exactly one of them —
`display.ground.scale.set(pointToScreen(1,1) - pointToScreen(0,0))` — which is
why [zoom_sim](../tests/zoom_sim.js) asserts through `pointToScreen` rather
than only on `pixelsPerUnit` directly.

## Finding the methods

Both carry mangled names, so both are identified by experiment on a throwaway
clone of the camera rather than pinned:

- `pixelsPerUnit` is already identified for us. `identifyCameraScale` doubles
  each candidate scalar on the clone and sees whose change the method's result
  follows — which is also what tells us which scalar is `m_zoom`, since
  `m_zoom` and `m_targetZoom` are indistinguishable by inspection.
- `scaleToScreen` is then the one-argument method for which `f(1)` is exactly
  `m_zoom` and `f(2)` is twice it. The only other one-argument scalar method on
  the camera is `pixels`, which is `m_ppu` — a factor of 16 — bigger, and the
  rest take a vector or return nothing. If two methods match, we decline rather
  than pick.

**Both tests are decisive on any single frame, and that is the whole point of
choosing them.** This started out hooking `m_targetZoom`, identified by being
numerically equal to `m_zoom` — which is a real property of the pair, but only
of a lerp that has finished converging. It converges asymptotically and
restarts on every scope change, resize and respawn, so a tolerance tight enough
to trust is one a real match frequently never reaches: the hook never
installed and the view stayed stock, intermittently and for a whole round at a
time. An identification that can only fire in the quiet stretches is not one
that can be relied on to fire at all.

## The hook

Each method is shadowed on the instance by a wrapper that calls the original
and divides. The wrappers declare the same arity as what they wrap, so a later
re-identification finds them exactly where it found the originals. If the
second override fails to install, the first is rolled back — half a hook scales
positions without scaling the sprites standing in them, which is worse than no
hook at all.

Nothing downstream needs to know. Every marker the overlay draws is scaled off
`readCameraPxPerUnit`, i.e. off the camera's own `pixelsPerUnit()`, and survev
converts the mouse back into world coordinates through `screenToPoint` — so the
overlay stays glued to the players and the aim path keeps pointing where the
cursor does, at any zoom. The one reader that goes *behind* the methods is
`readCameraPxPerUnit`'s own fallback, which reads `m_ppu * m_zoom` off the
fields when the method call fails, and it applies the divisor itself. The
minimap bakes its own texture at its own scale and is unaffected; emote
balloons read `m_zoom` directly through a clamp, and so keep their stock size
at their scaled position, which is what that clamp is for.

A new round is a new camera; the hook goes with the old object rather than
being left wrapping methods nothing calls, and each shadowed method is deleted
so the prototype's own shows through again. Setting the slider back to 1
unwraps both outright, so a camera we are done with carries nothing of ours.

`window.__zoomDiag()` reports what was identified and hooked. `hooked: false`
with a camera found means one of the two methods has not been identified —
`scaleFn` and `spriteFn` say which — and the view will be stock. `pxPerUnit` is
what the game is actually rendering at, divisor included, so it should read as
the stock figure over `factor`.
