# ESP render

"ESP" in the MOD tab's ESP section stops art that isn't part of the collision
set from covering art that is. **Building roofs** come off entirely, so a house
shows its inside. Everything else that hides a body without stopping one —
**bushes**, the **rubble a destroyed obstacle leaves behind**, **tree canopies**
and **smoke** — is faded to `0.3` instead. Canopies are on the collidable side
of the game's own line and the first two are not, but they read at one depth on
purpose: the fade means "you can see through this", and what is solid is what
the ESP overlay and `__bulletGeom` already answer.

It is a display switch and nothing more. No geometry is read from it, nothing
about aim, sampling or input changes, and it is deliberately **independent of
the "ESP overlay" toggle above it**: it puts nothing on the overlay canvas, so
gating it behind the canvas would only be surprising. Off by default, and
persisted like every other row.

# Roofs

A house's inside is already being rendered. Its floor, its walls, the loot and
the players in it all draw on the same layer as the world outside, and the roof
is only a sprite laid over the top of them at `zOrd = 750 - zIdx`. `Building`
keeps both halves of that art in one `imgs` array with each entry tagged
`isCeiling`, so switching off the ceiling ones leaves the building standing,
its layer, its bounds and its zoom regions untouched, and reveals what was
underneath.

`renderable = false` per sprite, for the same reason the debug render uses it
on the layer containers: the game rewrites both of the other candidates on
every update — `positionSprite` sets a ceiling img's `alpha` from
`ceiling.fadeAlpha`, and a `removeOnDamaged` img gets a `visible` — so anything
written there is gone within a frame. `renderable` it never touches, and PIXI
checks it before drawing.

This does **not** open up a bunker. Underground art lives on
`renderer.layers[2]`, which the renderer masks down to the stairwell openings
the whole time the local player is aboveground, so there is no roof to hide:
those sprites are being clipped away, not covered up.

# Bushes and rubble

Obstacles are sorted by the game's own rule for what an object is. `collidable`
is its line between an object and scenery — a bush carries a collider and
doesn't stop you — and a destroyed obstacle keeps its collider object but stops
colliding, so both are art in front of nothing, and both are faded to `0.3`
rather than removed: a bush is still cover from being *seen*, and rubble still
says an obstacle was there. A door's casing is a second sprite the obstacle
positions alongside its own, so a dead door's frame fades with it rather than
staying solid around nothing.

A **skinned player's disguise** falls out of the same rule: the client builds a
skin as an obstacle and sets `collidable = def.collidable && !isSkin`, so a
skin is never collidable and always faded here, leaving the player sprite it
was covering plainly readable underneath.

# Tree canopies

A tree is collidable. It stops a bullet and it is cover, so removing it would
make the view lie about exactly the thing the view is for — but its leaves are
drawn on top of whoever is standing under them, which is the problem this mode
exists to solve. So canopy art is faded to `0.3` instead — the same value the
bushes and rubble above get: the tree still reads as a tree, and the player
under it reads as a player.

Which art counts as a canopy comes from the game's own rule rather than a list
of type names that would rot on the next content patch. `sprite.zOrd` is the
obstacle def's `img.zIdx`, and `Obstacle.render` treats `>= 50` as "this draws
above the player" — it lifts exactly those onto the player's layer and pushes
them past their z-order. Tree canopies sit at 200 and 801. Tables, pipes and
statue tops share the rule and get the same treatment, for the same reason:
they are all art the game deliberately puts in front of a body.

The alpha is written straight onto the sprite rather than through an accessor,
because an obstacle only assigns `sprite.alpha` on the rare frame it swaps a
texture — spawn, death, a button toggling. That is also what makes the value
to restore free: every sprite carries its own `imgAlpha`, which is the number
the game last put there, so a table that ships at `0.8` goes back to `0.8`
rather than to a blanket `1`.

# Smoke

A smoke cloud is the canopy problem out of a different barn. It is not an
obstacle, it is in no collision set, it stops neither a bullet nor a body — and
it is drawn over everyone inside it, which is the thing this mode exists to
stop. So it is faded to the same `0.3`, and a tree seen through smoke reads at
one depth instead of two.

The smoke barn hangs off the `Game` rather than the map, and keeps its
particles in a plain array beside its entity pool. Both are mangled, so the
pair is found by what the array's entries are: a particle declares
`radTarget`, `fadeTicker`, `rotVel`, `interior` and `sprite` as readable
fields, and nothing else on the `Game` carries that set. As with the obstacle
and building pools, that needs one live entry — one smoke thrown this round —
and until then the barn is simply unidentified. Arrays are skipped rather than
descended into during the scan: the `Game` keeps `pings` and `updateIntervals`
beside its barns, both one entry per server update and both unbounded over a
match.

Unlike a canopy's, smoke's alpha is **rewritten every frame** — the barn sets
`alpha = clamp(1 - fadeTicker / fadeDuration) * 0.9` in the same tick that
renders the particle, so there is no point in a frame where a value written
from the overlay's own loop is the one that gets drawn. So the write is
intercepted rather than repeated: an own accessor keeps the game's number and
hands back the lower of it and `0.3`. The barn goes on assigning exactly as it
did, and a puff's own fade-out still plays, because those values are under the
cap and pass straight through. What is capped is how solid the cloud gets, not
how it dies.

Because each particle is capped rather than the cloud, a **dense cloud still
builds up** where many particles overlap — every one of them is at most as
opaque as a tree canopy, but they composite. That is the honest reading of a
per-sprite cap; hiding smoke outright is the alternative, and it would put the
mode back to lying about what is on screen.

# Handing sprites back

Each held property — `renderable` for what is hidden, `alpha` for what is
faded, the `alpha` accessor for what is capped — is tracked by a pair of
`Set`s swapped each frame: one holds what is
currently held, the other collects the frame being built, and anything in the
first that the new frame didn't re-claim is handed back before the swap.

That is what restores a sprite when a pool entry is recycled into a different
object, when the toggle goes off, and when the round ends. It is also what
moves one cleanly between the two states: a tree that gets destroyed stops
being canopy and starts being rubble, so the same frame that hides it also
gives its alpha back. Swapping rather than allocating keeps a per-frame pass
over a few hundred sprites free of garbage.

`renderable` is only ever set back to `true`, which is the value the game ships
sprites with and never writes itself; a faded `alpha` goes back to the sprite's
own `imgAlpha`; a capped one has its accessor deleted and the game's own last
number assigned in its place, which puts a plain data property back where PIXI
put one.

`window.__espDiag()` reports what the mode found, including live
`hiddenSprites`, `fadedSprites` and `cappedSprites` counts. `buildings: 0` in
a live match means `findBuildingPool` hasn't identified the building pool —
roofs are still up, and if it stays that way once a match is running,
`mangled.js` may need re-deriving. `smokeBarnKey: null` only means no smoke has
been thrown yet.
