# How inject.js finds the game

survev keeps its entire object graph module-private: the app singleton is an
anonymous `Ri = new class { … }` and the Game instance lives on its `game`
field, so neither is reachable by walking from `window`.

**Primary path — `Function.prototype.bind` wrapper.** The app singleton wires
its callbacks through `.bind(this)` (e.g.
`this.onTeamMenuJoinGame.bind(this)` in its own constructor, and
`this.onConfigModified.bind(this)` in `tryLoad`). inject.js installs a thin
wrapper around `Function.prototype.bind` at `document_start`, recognizes the
app by its own class fields (`game`, `pixi`, `config`, `localization`,
`audioManager`, `teamMenu` — all real readable names), keeps the reference,
and uninstalls itself immediately. `app.game` is then re-read live on every
sample tick, so a Game swapped in for a new round is picked up for free.

**Fallback path — `Object.prototype` setter traps.** The original approach:
trap the property names that the Game constructor body assigns from
positional parameters (the `seedNames` list in `mangled.js`), so constructing
a Game fires the setter with `this` == the new instance. This **no longer
fires on current builds**, because they pre-declare every one of those names
as a class field (`var Jr = class { nHb; GHBZo; … }`), and class fields are
installed with `[[DefineOwnProperty]]` before the constructor body runs — the
assignment hits an existing own slot and never walks the prototype chain. It
is kept because it costs nothing and still works on builds that don't declare
their fields. Same for the runtime script-scan that adds extra trap names
(it already skips names it sees declared as class fields).

If the console reports `App singleton not captured`, that's the real
breakage signal: the app's field shape changed. Check
`window.__enemyLocationLogger.getDiagnostics()` for the capture state.
