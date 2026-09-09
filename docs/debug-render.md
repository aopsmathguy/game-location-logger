# Debug render

"Debug" in the MOD tab replaces the rendered world with its hitboxes. Ground —
grass, beach, riverbanks, ground patches — all becomes flat white, kept under
the game's own grid so there is still a sense of scale and of how far something
has moved; water keeps whatever colour the biome gives it, because water is
terrain you swim in rather than something with a collider. Every collidable
object is a filled shape drawn straight from `obstacle.collider`: an
axis-aligned rectangle or a circle, no stroke, all one colour. Every player is
a circle of `GameConfig.player.radius` in a second colour, with no
teammate/enemy or downed distinction. Nothing is drawn with a border, because a
border sits *outside* the shape and would make every hitbox read a pixel or two
larger than it is.

The switch works off survev's scene graph rather than off any drawing hook.
`Game.init()` adds a flat list of children to the PIXI stage:

```
map.display.ground     terrain, in world coords, re-transformed to screen each frame
renderer.layers[0]     ┐
renderer.ground        │  every sprite: obstacles, buildings, ceilings,
renderer.layers[1..3]  ┘  players, loot, bullets, particles
debugDisplay
gasRenderer.display    ┐
emoteBarn.container    │  UI, above the world
uiManager.container    ┘  (minimap, indicators, …)
```

So the whole world switches off by setting `renderable = false` on
`renderer.ground` and the four layers. Nothing else on the page changes: the
HUD is DOM, and the minimap is a texture `renderMap()` bakes from a Graphics of
its own rather than from `display.ground`.

`renderable`, not `visible`: the renderer rewrites `visible` on the layers every
frame from the layer-transition alphas, so it would take the flag straight back
off us. It never touches `renderable`, and PIXI checks it before descending into
a container, so one `false` skips the container and its whole subtree.

Our own geometry goes in as three `Graphics` children of `map.display.ground`.
That parent is the one node on the stage already carrying the world→screen
transform, so drawing in world units under it needs no camera read of our own
and cannot drift a frame behind the game's: whatever transform the renderer
resolves for the terrain is the one our shapes get, on the same pass. It also
sits at stage index 0, under everything — which is where a replacement world
belongs. The white sheet is painted *over* the game's terrain rather than
replacing it, so switching the mode back off is one `renderable` flip with the
game's own geometry still intact underneath.

The three layers are split by how often they change:

| Layer | Redrawn |
| --- | --- |
| Ground + water | Once per map, keyed on `map.terrain` identity |
| Obstacle colliders | Only when a cheap signature over the collider set changes |
| Player circles | Every frame |

The signature is a rolling hash of obstacle count, ids, and the collider numbers
quantized to 1/64 of a unit, computed without allocating. It catches an obstacle
entering or leaving the pool, one being destroyed, and a door swinging its
collider onto a new orientation — which is everything that can change a shape on
screen — so the expensive part, clearing and re-tessellating a few hundred
shapes, only runs on frames where the geometry actually moved. Players are
deliberately outside that gate: they move every frame, so gating them would
never pay off.

The ground and water are laid down in the same order `renderTerrain` uses — one
white sheet over the map and its 120-unit margin, then the play area minus the
shore polygon as ocean, then each river's `waterPoly`, with looped rivers taking
`lakeWater` when the biome defines it, then the grid over the lot. The shore is
concave and hand-jittered, so the ocean is cut as a PIXI hole exactly the way
the game cuts it, not approximated with a border. The grid is the game's own:
`GameConfig.map.gridSize` spacing, black at 0.15, over the play area rather than
the margin, and `2 / camera.ppu` wide — our Graphics hangs off
`map.display.ground` and inherits its world→screen scale, so that width lands on
the same pixels survev's grid does.

# Player positions

Players are drawn at `posAlt`, not `pos`. `pos` is where the last packet said
the player was; `posAlt` is the render-interpolated position the game lerps
toward it each frame, and it is the one the body sprite's own `pointToScreen`
is fed — so reading it is what puts the circle exactly where the hidden sprite
was, rather than a fraction of a tick ahead of it.

It is also the field [Netcode smoothing](./netcode.md#netcode-smoothing) installs its
accessor on. So the circles play back on the recovered tick clock whenever
Smoothing is on, respond live to `jitterK`, `clockHalfLife` and `renderLag`,
and fall back to survev's stock lerp the moment it is switched off — the same
playback the sprite itself would have been drawn with, which is the whole point
of a view that claims to show where things really are. `pos` is only the
fallback for a player the game has not interpolated yet.

`window.__debugRenderDiag()` reports what the mode found. `rendererFound: false`
means the layer containers are still on screen and the hitboxes are drawing
underneath them; `mapFound: false` in a live match means `findMapOnGame` lost
the map shape and `mangled.js` may need re-deriving.
