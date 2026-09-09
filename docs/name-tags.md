# Enemy name tags

survev already builds the label. Every Player owns a `nameText` — a PIXI.Text
child of its own container, anchored under the sprite — and the per-frame
player update fills it in for **everyone**:

```js
this.nameText.text = info.name;
this.nameText.visible = !isActivePlayer && sameGroup;
```

then shows it only for teammates. So an enemy's tag is already built, already
carrying the right name, and already following the sprite through zoom, layer
and death. The only thing between it and the screen is that `visible`
assignment.

Taking that over rather than drawing labels of our own is what makes the enemy
tag pixel-identical to the teammate one — same font, same offset, same scaling
with the camera, same disappearance when the player dies or the ceiling hides
them — and it costs one property read per player per frame. `nameText` is one
of the names survev leaves readable (like `playerPool` and `pings`), so none of
this needs a `mangled.js` entry.

The hook is an **accessor on the Text instance**, not a write from our own
tick, and that is for ordering rather than tidiness: the game assigns `visible`
once per frame per player, in the same update that assigns the interpolated
position our netcode hook rides on, and the sample loop is not ordered against
that — anything we wrote would be overwritten before the next render about half
the time. The accessor ORs our decision onto the game's, so the local player's
own name stays hidden, a teammate stays visible for the game's own reason, and
turning the toggle off restores stock behaviour on the very next assignment.
It is installed per *instance* for the same reason the netcode hooks are, and
only while the feature is on — with it switched off, no label built afterwards
gets an accessor. The tick keeps running once anything *is* hooked, so
switching it off hands every label back rather than leaving one forced on.

It ships **on**, alongside the netcode smoothing and the ping readout rather
than with the cheats: it reads a label the game has already built, positioned
and filled in, and touches no input or gameplay state.

The tags also wait for the local player to resolve. Without one there is no
side to be on, and the sampler's reading of that state — "everyone is an enemy"
— would paint the squad red for the frames before it fills in. Our own sprite
is excluded by object identity rather than by id, since the pool holds us too
and identity can't be defeated by an `__id` that hasn't arrived.

`__nameTagDiag()` reports the whole path when a name doesn't show: whether the
tick reaches the pool, who it thinks we are, how many labels are hooked, and
per live player what the label holds against what the renderer is being told.
`missingLabel` is the one entry that means a code change rather than a setting
— it counts live players with no `nameText`, i.e. the bundle stopped calling
the label that. `visible` next to `worldVisible` separates "we never forced it"
from "we did and something above it is hidden anyway".

Colour is the ESP overlay's enemy red (`#ff3c3c`) against the teammate cyan, so
the two features read as one thing rather than as two different opinions about
who is dangerous. It is applied by assigning `style.fill`, which bumps the
style's ID and makes PIXI rebuild the text texture — so it is written only when
the colour actually changes, not every frame. The fill to restore is read off
the label at install rather than assumed, and who counts as an enemy is
re-derived every tick rather than latched, because pool entries are recycled:
the object that held an enemy last round can hold a squadmate in the next one.

That enemy test is `isHostileTo`, the same one the sampler uses — squadmates
share a `groupId`, faction teammates share a non-zero `teamId` — so the tags
and the overlay cannot disagree about who is on which side.

Names come from `getPlayerInfo(id).name`, which is the raw name: survev's
`anonPlayerNames` setting is applied by `getPlayerName()` on the paths that
respect it, and the in-world label never went through that function.
