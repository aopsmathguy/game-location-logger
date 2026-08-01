(() => {
  const SOURCE = 'enemy-location-logger';
  // console.log(`[${SOURCE}] inject.js HEAD reached, url=${location.href}, isTop=${window.top === window}`);

  // Mangled-name dictionary loaded from mangled.js (which runs before us
  // via the manifest's content_scripts ordering). Every survev bundle
  // identifier we depend on flows through this object — when survev
  // re-mangles, mangled.js is the only file that needs updating.
  const M = window.__SURVEV_MANGLED__;
  if (!M) {
    console.error(`[${SOURCE}] mangled.js did not run before inject.js — aborting`);
    return;
  }
  // Local short aliases. The semantic name is on the left (kept stable
  // across bundle re-mangles); the value on the right is the current
  // mangled key we use for bracket-access. Don't add raw mangled string
  // literals anywhere else in this file.
  const PLAYER_NET   = M.player.netData;
  const PLAYER_LOC   = M.player.localData;
  const PLAYER_POS   = M.player.pos;
  const PLAYER_DIR   = M.player.dir;
  const PLAYER_POS2  = M.player.posAlt;
  const NET_WEAPON   = M.netData.activeWeapon;
  const NET_DEAD     = M.netData.dead;
  const NET_DOWNED   = M.netData.downed;
  const LOC_ZOOM     = M.localData.zoom;
  const LOC_CURIDX   = M.localData.curWeapIdx;
  const LOC_SLOTS    = M.localData.weapons;
  const GAME_LOCAL   = M.game.localPlayer;
  const GAME_ROSTER  = M.game.roster;
  const GAME_BINDS   = M.game.inputBinds;
  const POOL_GETALL  = M.pool.getAll;

  const SAMPLE_MS = 20;
  const STATUS_MS = 3000;
  const DEEP_SEARCH_MS = 4000;
  const MAX_NODES = 12000;
  const MAX_PROPS = 40;
  let lastSignature = '';
  let lastStatusAt = 0;
  let lastDeepSearchAt = 0;
  let lastFound = null;
  let pageSamples = [];
  let capturedGame = null;
  // playerId -> { x, y, ts } from the previous sample. Used to derive
  // velocity by differencing positions over time, since survev's network
  // protocol does not transmit a velocity field for players (only `pos`
  // and `dir`).
  const prevSample = new Map();
  const PREV_SAMPLE_TTL_MS = 5000;

  // gun type (as stored in `me[netData].activeWeapon` — see mangled.js)
  // -> projectile speed in world units/sec, derived offline from the
  // survev client bundle:
  //   - the asset/definitions dump holds bullet defs (`bullet_xxx: { speed: NN }`)
  //   - the gameplay dump's gun definitions reference these via `bulletType`
  // Melees, throwables, and fists are intentionally absent — they have no
  // projectile, and the lookup will return undefined. Dual variants share
  // their base gun's bullet, so they share its speed. This table is static
  // (no runtime capture), so it must be re-derived if survev ships new guns.
  const GUN_BULLET_SPEED = {
    mp5: 85, mac10: 75, ump9: 100, vector: 88, vector45: 82, scorpion: 90,
    vss: 110, famas: 110, hk416: 105, m4a1: 98, mk12: 132, l86: 134,
    m249: 125, qbb97: 118, scout_elite: 164, ak47: 100, scar: 108,
    scarssr: 108, an94: 110, groza: 104, grozas: 106, dp28: 110, bar: 114,
    imbel: 92, pkp: 120, model94: 156, mkg45: 126, blr: 160, mosin: 178,
    sv98: 182, awc: 136, m39: 125, svd: 127, garand: 144, barrett: 214,
    ash12: 85,
    m870: 66, m1100: 66, mp220: 66, saiga: 66,
    spas12: 88, spas16: 88, m1014: 118, usas: 72,
    m9: 85, m9_dual: 85, m9_cursed: 85, m93r: 85, m93r_dual: 85,
    glock: 70, glock_dual: 70, p30l: 94, p30l_dual: 94,
    ot38: 112, ot38_dual: 112, ots38: 115, ots38_dual: 115,
    colt45: 106, colt45_dual: 106, m1911: 80, m1911_dual: 80, m1a1: 80,
    deagle: 115, deagle_dual: 115, sw500: 150,
    flare_gun: 4, flare_gun_dual: 4,
    potato_cannon: 100, potato_smg: 100, potato_lmg: 100, bugle: 100
  };

  function looksLikePlayer(obj) {
    // The Player class (`er`) declares many of its sprite fields with real
    // readable names that are stable across builds: bodySprite, helmetSprite,
    // meleeSprite, etc. If an object has several of these, it's a Player.
    try {
      if (!obj || typeof obj !== 'object') return false;
      return (
        'bodySprite' in obj &&
        'helmetSprite' in obj &&
        'meleeSprite' in obj &&
        'footLSprite' in obj &&
        'handLContainer' in obj
      );
    } catch {
      return false;
    }
  }

  // Find the game's reference to the roster (`tr` instance) by walking its
  // own props. The roster's class fields use real readable names, so this is
  // stable across re-mangling. Returns the roster object or null.
  function findRosterOnGame(game) {
    try {
      if (!game || typeof game !== 'object') return null;
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        const v = game[names[i]];
        if (v && typeof v === 'object' && looksLikeRoster(v)) return v;
      }
    } catch {}
    return null;
  }

  // Find the game's reference to the local Player by walking own props.
  // The local player is the only field on `Rr` that holds a Player directly
  // (the rest live in `playerPool`). Returns the player or null. Returns
  // null both when the field doesn't exist and when it's still in its
  // pre-join `null` state.
  function findLocalPlayerOnGame(game) {
    try {
      if (!game || typeof game !== 'object') return null;
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        const v = game[names[i]];
        if (v && typeof v === 'object' && looksLikePlayer(v)) return v;
      }
    } catch {}
    return null;
  }

  function getCurrentWeapon(me) {
    // netData.activeWeapon is the active weapon string (e.g. "ak47",
    // "fists", "machete"). Falls back to walking localData.weapons[curWeapIdx]
    // in case the network field hasn't propagated yet.
    try {
      const fromNet = me?.[PLAYER_NET]?.[NET_WEAPON];
      if (typeof fromNet === 'string' && fromNet) return fromNet;
      const slots = me?.[PLAYER_LOC]?.[LOC_SLOTS];
      const idx = me?.[PLAYER_LOC]?.[LOC_CURIDX];
      if (Array.isArray(slots) && Number.isFinite(idx)) {
        const slot = slots[idx];
        if (slot && typeof slot.type === 'string') return slot.type;
      }
    } catch {}
    return '';
  }

  const SCOPE_PATTERN = /^(?:1|2|4|8|15)xscope$/;

  // The active scope string lives on the local player's localData or
  // netData under a mangled key we don't know up-front. Walk both
  // objects' own enumerable string fields looking for any value that matches
  // the scope pattern — adapts automatically across bundle re-mangles.
  function getCurrentScope(me) {
    try {
      const sources = [me?.[PLAYER_LOC], me?.[PLAYER_NET], me];
      for (const src of sources) {
        if (!src || typeof src !== 'object') continue;
        const keys = Object.keys(src);
        for (let i = 0; i < keys.length; i++) {
          const v = src[keys[i]];
          if (typeof v === 'string' && SCOPE_PATTERN.test(v)) return v;
        }
      }
    } catch {}
    return '1xscope';
  }

  // Scope → world-unit radius lookup, mirroring survev's
  // `GameConfig.scopeZoomRadius` (shared/gameConfig.ts). These have been
  // stable for years; if the game ever rebalances scopes, update this table.
  // We previously trapped `data.zoom = stream.readUint8()` via a setter on
  // Object.prototype to avoid hardcoding this table, but the trap proved
  // unreliable in production (the bundle's hot path never reached our
  // setter), so we now just look it up directly from the player at sample
  // time and fall back to this table.
  const SCOPE_RADIUS_DESKTOP = {
    '1xscope':  28,
    '2xscope':  36,
    '4xscope':  48,
    '8xscope':  68,
    '15xscope': 104
  };
  const SCOPE_RADIUS_MOBILE = {
    '1xscope':  32,
    '2xscope':  40,
    '4xscope':  48,
    '8xscope':  64,
    '15xscope': 88
  };

  // Touch-first device check. Survev's own client picks the mobile scope
  // table when this is true, so we mirror the same heuristic here. We pick
  // the table once at load time — extensions don't migrate between desktop
  // and mobile mid-session.
  const IS_MOBILE_DEVICE = (() => {
    try {
      const ua = (navigator.userAgent || '');
      return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    } catch {
      return false;
    }
  })();
  const SCOPE_RADIUS_TABLE = IS_MOBILE_DEVICE ? SCOPE_RADIUS_MOBILE : SCOPE_RADIUS_DESKTOP;

  // Set of every legitimate radius across both tables. Used by the direct
  // localData scan below to recognize the zoom field by its value rather
  // than its (mangled) name.
  const ALL_SCOPE_RADII = new Set([
    ...Object.values(SCOPE_RADIUS_DESKTOP),
    ...Object.values(SCOPE_RADIUS_MOBILE)
  ]);

  // Cached mangled key for `m_localData.m_zoom` once we've identified it on
  // a particular localData shape. Reset whenever we swap captured games
  // (different round / respawn — see swapCapturedGame).
  let cachedZoomKey = null;
  // Cached mangled own-prop name on the game (Rr) that holds the Camera
  // instance, and the mangled name on the camera for m_zoom. Also reset on
  // game swap. See findCameraOnGame / readCameraZoom below.
  let cachedCameraKey = null;
  let cachedCameraZoomKey = null;

  // Read the current scope radius (world units) from the active player's
  // localData. The bundle stores it via `this[localData][<mangled>] = e.zoom`.
  // We scan for an own number-valued prop whose value matches the EXPECTED
  // radius for the current scope string — that disambiguates against
  // health/boost, which can also legitimately equal 40 for mobile 2xscope
  // users at 40%. Returns null if we can't find it; callers fall back to
  // the table lookup.
  function readZoomRadiusFromPlayer(me, scope) {
    const expected = SCOPE_RADIUS_TABLE[scope];
    if (expected == null) return null;
    const lzr = me?.[PLAYER_LOC];
    if (!lzr || typeof lzr !== 'object') return null;
    try {
      if (cachedZoomKey) {
        const v = lzr[cachedZoomKey];
        if (v === expected) return v;
        // Cached key still resolves to a number? Trust it across scope
        // changes — the player just hasn't gotten the matching scope-string
        // update yet, or our scope detection is lagging by a tick.
        if (typeof v === 'number' && ALL_SCOPE_RADII.has(v)) return v;
        cachedZoomKey = null;
      }
      const keys = Object.keys(lzr);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (lzr[k] === expected) {
          cachedZoomKey = k;
          return expected;
        }
      }
    } catch {}
    return null;
  }

  // Locate the Camera instance on a captured game. The bundle's Camera class
  // (survev client/src/camera.ts, mangled to `ct` in the gameplay bundle) has a
  // very distinct shape: a ppu field initialized to 16, two zoom scalars
  // both initialized to 1.5, and a Vec2 pos. We match by that shape rather
  // than by a pinned mangled name so we survive re-mangling.
  function looksLikeCamera(obj) {
    if (!obj || typeof obj !== 'object') return false;
    try {
      const names = Object.getOwnPropertyNames(obj);
      if (names.length < 6 || names.length > 25) return false;
      let ppu16 = false, smallNumbers = 0, hasPosVec = false;
      for (let i = 0; i < names.length; i++) {
        const v = obj[names[i]];
        if (v === 16) ppu16 = true;
        else if (typeof v === 'number' && v > 0.05 && v < 20) smallNumbers++;
        else if (v && typeof v === 'object' &&
                 typeof v.x === 'number' && typeof v.y === 'number') hasPosVec = true;
      }
      return ppu16 && smallNumbers >= 2 && hasPosVec;
    } catch {
      return false;
    }
  }

  function findCameraOnGame(game) {
    if (!game || typeof game !== 'object') return null;
    try {
      if (cachedCameraKey) {
        const c = game[cachedCameraKey];
        if (c && looksLikeCamera(c)) return c;
        cachedCameraKey = null;
      }
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        const v = game[names[i]];
        if (v && typeof v === 'object' && looksLikeCamera(v)) {
          cachedCameraKey = names[i];
          return v;
        }
      }
    } catch {}
    return null;
  }

  // Return the camera's m_zoom — the CURRENT (interpolated) zoom factor,
  // not m_targetZoom. The game lerps `m_zoom` toward `m_targetZoom` over
  // several frames each time the scope changes (zoomFast ? 3 : 1.4-2), so
  // sizing overlays by the target zoom makes them "jump" at scope change
  // while the visible viewport is still mid-lerp. We disambiguate the two
  // co-resident zoom scalars by computing the value m_targetZoom *should*
  // have from the known formula
  //     m_targetZoom = (maxScreenDim * 0.5) / (scopeRadius * ppu)
  // — whichever small scalar matches that is targetZoom, the other is
  // m_zoom. In steady state the two are equal and either returns the right
  // value; during a transition, only m_zoom drifts away from expected.
  function readCameraZoom(camera, expectedTargetZoom) {
    if (!camera || typeof camera !== 'object') return null;
    try {
      const names = Object.getOwnPropertyNames(camera);
      const candidates = [];
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        const v = camera[n];
        if (typeof v === 'number' && v > 0.05 && v < 20 && v !== 16) {
          candidates.push([n, v]);
        }
      }
      if (!candidates.length) return null;
      if (candidates.length === 1) return candidates[0][1];
      // targetZoom = closest to expected; m_zoom = the next-closest (of the
      // remaining fields). When the two are equal — steady state — this
      // correctly returns that shared value.
      candidates.sort((a, b) =>
        Math.abs(a[1] - expectedTargetZoom) - Math.abs(b[1] - expectedTargetZoom)
      );
      return candidates[1][1];
    } catch {
      return null;
    }
  }

  // Compute the visible-world width in world units. Matches survev's camera
  // math from client/src/game.ts:447ff — for screens at 16:9 or wider this
  // collapses to 2*radius, and for narrower aspects (e.g. 4:3) it shrinks
  // proportionally. Downstream callers use this to convert mouse pixel
  // offsets into world coordinates, so getting the aspect right matters.
  //
  // We prefer the camera's live m_zoom over the target scope radius so the
  // overlay tracks the smoothly-lerped viewport the user actually sees,
  // instead of snapping to the new target the instant the scope changes.
  function getViewportWorldUnits(scope, me, game) {
    const fromPlayer = me ? readZoomRadiusFromPlayer(me, scope) : null;
    const fromTable = SCOPE_RADIUS_TABLE[scope] ?? SCOPE_RADIUS_TABLE['1xscope'];
    const radius = fromPlayer ?? fromTable;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const maxScreenDim = Math.max(Math.min(W, H) * (16 / 9), Math.max(W, H));
    const camera = game ? findCameraOnGame(game) : null;
    if (camera) {
      const expectedTargetZoom = (maxScreenDim * 0.5) / (radius * 16);
      const mZoom = readCameraZoom(camera, expectedTargetZoom);
      // pixels-per-world-unit = ppu * m_zoom; viewport width = W / that.
      if (mZoom && mZoom > 0) return W / (16 * mZoom);
    }
    return (W * 2 * radius) / maxScreenDim;
  }

  // Standalone zoom logger — fires from sampleLoop unconditionally so we see
  // a value even when buildSample short-circuits (lobby, no roster, no pos).
  // Tries to read the captured game's local player to get the live radius;
  // falls back to the static table when nothing is captured yet.
  function logZoomTick() {
    let me = null;
    let scope = '1xscope';
    let stage = 'no-game';
    try {
      const game = capturedGame;
      if (game) {
        stage = 'no-player';
        me = findLocalPlayerOnGame(game) || game?.[GAME_LOCAL] || null;
        if (me) {
          stage = 'player';
          scope = getCurrentScope(me) || '1xscope';
        }
      }
    } catch (err) {
      stage = 'error:' + (err && err.message ? err.message : 'unknown');
    }
    const fromPlayer = me ? readZoomRadiusFromPlayer(me, scope) : null;
    const fromTable = SCOPE_RADIUS_TABLE[scope] ?? SCOPE_RADIUS_TABLE['1xscope'];
    const radius = fromPlayer ?? fromTable;
    const source = fromPlayer != null ? 'player' : 'table';
    const W = window.innerWidth;
    const H = window.innerHeight;
    const maxScreenDim = Math.max(Math.min(W, H) * (16 / 9), Math.max(W, H));
    const viewportDiam = (W * 2 * radius) / maxScreenDim;
    const pxPerUnit = W / viewportDiam;
    // console.log(
    //   `[${SOURCE}] zoom radius=${radius} (scope=${scope}, source=${source}, stage=${stage}, viewport=${viewportDiam.toFixed(1)} world units, ratio=${pxPerUnit.toFixed(2)} px/unit @ ${W}px wide)`
    // );
  }

  // ---------------------------------------------------------------------
  // Primary capture: the app singleton, via a temporary Function.prototype
  // .bind() wrapper.
  //
  // survev keeps its whole object graph module-private. The app singleton is
  // an anonymous `Ri = new class { … }` and the Game instance lives on its
  // `game` field, so nothing reachable from window/document/canvas leads to
  // either one.
  //
  // We used to capture the Game purely by trapping Object.prototype setters
  // for the names its constructor assigns (see installGameCaptureTrap below).
  // That stopped working, because the current bundle declares every one of
  // those names as a CLASS FIELD:
  //
  //     var Jr = class { nHb; GHBZo; PZa; RPY; … game-class fields …
  //         constructor(e, t, n, …) { this.nHb = e, this.GHBZo = t, … } }
  //
  // Class fields are installed with [[DefineOwnProperty]] before the
  // constructor body runs, so `this.nHb = e` writes into an own slot that
  // already exists and never walks the prototype chain — our setter cannot
  // fire. The app singleton's `game = null` field has the same problem.
  //
  // What the bundle does still route through a real builtin is `.bind()`:
  //
  //     this.teamMenu = new Li(…, this.onTeamMenuJoinGame.bind(this), …)
  //     this.config.addModifiedListener(this.onConfigModified.bind(this))
  //
  // Both pass the app singleton as bind's `thisArg`, the first from the app's
  // own constructor at module-evaluation time. A thin wrapper around
  // Function.prototype.bind sees it, and from there we read `app.game` live
  // on every sample tick — `game` is a real readable field name, in the same
  // stable-across-builds class as `playerInfo` / `bodySprite`, not a mangled
  // one. The wrapper uninstalls itself as soon as it captures (and
  // unconditionally after BIND_HOOK_TTL_MS) so we don't sit on a hot builtin.
  // ---------------------------------------------------------------------
  let capturedApp = null;
  const BIND_HOOK_TTL_MS = 120000;
  const bindHookState = { installed: false, uninstalledReason: '', calls: 0 };
  let originalBindDescriptor = null;

  // Own fields the app singleton declares. All real readable names.
  const APP_FIELDS = ['game', 'pixi', 'config', 'localization', 'audioManager', 'teamMenu'];

  function hasOwnProp(obj, key) {
    try {
      return Object.prototype.hasOwnProperty.call(obj, key);
    } catch {
      return false;
    }
  }

  function looksLikeApp(obj) {
    if (!obj || typeof obj !== 'object') return false;
    // Cheap gate first — .bind() is hot and almost nothing else on the page
    // owns a `game` property. Note we check OWN props rather than using
    // `in`: the Object.prototype traps below can add inherited names.
    if (!hasOwnProp(obj, 'game')) return false;
    for (let i = 0; i < APP_FIELDS.length; i++) {
      if (!hasOwnProp(obj, APP_FIELDS[i])) return false;
    }
    return true;
  }

  function uninstallBindHook(reason) {
    if (!bindHookState.installed) return;
    try {
      if (originalBindDescriptor) {
        Object.defineProperty(Function.prototype, 'bind', originalBindDescriptor);
      }
    } catch {}
    bindHookState.installed = false;
    bindHookState.uninstalledReason = reason;
  }

  function noteBindThisArg(thisArg) {
    bindHookState.calls++;
    if (capturedApp) return;
    if (!looksLikeApp(thisArg)) return;
    capturedApp = thisArg;
    uninstallBindHook('captured');
  }

  function installBindHook() {
    try {
      const originalBind = Function.prototype.bind;
      if (typeof originalBind !== 'function') return;
      originalBindDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'bind');
      // Non-arrow so `arguments` forwards verbatim; `arguments[0]` is bind's
      // thisArg (the receiver is the function being bound, not what we want).
      const hook = function bind() {
        try { noteBindThisArg(arguments[0]); } catch {}
        return originalBind.apply(this, arguments);
      };
      // Keep the wrapper indistinguishable from the builtin for any code that
      // feature-detects on name/arity.
      Object.defineProperty(hook, 'length', { value: 1, configurable: true });
      Object.defineProperty(hook, 'name', { value: 'bind', configurable: true });
      Object.defineProperty(Function.prototype, 'bind', {
        value: hook,
        writable: true,
        enumerable: false,
        configurable: true
      });
      bindHookState.installed = true;
      setTimeout(
        () => uninstallBindHook(capturedApp ? 'captured' : 'timeout'),
        BIND_HOOK_TTL_MS
      );
    } catch {}
  }

  installBindHook();

  // Read the live Game ref off the captured app singleton. `app.game` is
  // assigned once the bundle finishes loading and could in principle be
  // reassigned per round, so we re-read it every call instead of caching.
  // Returns null until the Game has been init()'d — the roster (and hence
  // the game-like shape) only exists after the user joins a match.
  function gameFromApp() {
    const app = capturedApp;
    if (!app) return null;
    const direct = safeRead(app, 'game');
    if (isGameLike(direct)) return direct;
    // A truthy-but-not-game-like `app.game` is the normal pre-join state
    // (the roster only exists after Game.init()), so don't burn a scan of
    // every app field on it each tick. Only fall back to the value-shape
    // walk when there is no `game` field at all — i.e. it got mangled.
    if (direct) return null;
    try {
      const names = Object.getOwnPropertyNames(app);
      for (let i = 0; i < names.length; i++) {
        const v = safeRead(app, names[i]);
        if (v && typeof v === 'object' && isGameLike(v)) return v;
      }
    } catch {}
    return null;
  }

  // Fallback capture: Object.prototype setter traps.
  //
  // This is the pre-existing path, kept because it costs nothing and still
  // works on any build that does NOT pre-declare its constructor-assigned
  // names as class fields. On the current bundle it never fires — see the
  // block above for why.
  //
  // We install a setter trap on Object.prototype for properties that the
  // game class's constructor body assigns from positional params
  // (`this.<A> = e, this.<B> = t, …` — names live in mangled.js's
  // `seedNames`). Where those are not pre-declared as class fields, the
  // assignments walk the prototype chain and fire our setter with `this` =
  // the new game instance. We verify shape before capturing to avoid false
  // positives, then restore Object.prototype on success.
  //
  // Two robustness features:
  //
  //  1. We seed the trap with all nine names from the bundle's constructor
  //     body, not just three. If a future survev build re-mangles one or two,
  //     the others still fire.
  //
  //  2. After install, we asynchronously fetch the page's own script
  //     resources, regex-discover any class whose constructor body assigns 5+
  //     positional params to non-field property names, and retroactively
  //     install traps on those names too. This auto-adapts when survev ships
  //     a new build.
  //
  // Both capture paths rely on this script being loaded as a `world: "MAIN"`
  // content script (see manifest.json) so it runs at document_start in the
  // page world, BEFORE survev's bundle parses — otherwise the app singleton's
  // constructor (and its `.bind()` calls) could race ahead of us during
  // cached reloads.
  const trapState = {
    installed: new Set(),
    originals: new Map(),
    candidatesAdded: 0,
    discoveryStatus: 'pending',
    // Objects whose trap fired but weren't yet recognizable as a game (the
    // constructor body hadn't finished assigning the roster). We re-check
    // them in a microtask, and again on each sample tick as a fallback.
    pendingCandidates: [],
    pendingChecksScheduled: 0,
    pendingChecksRan: 0
  };

  // Replace the captured game ref with a freshly-detected Rr instance and
  // wipe per-game derived state (velocity cache, dedup signature, lastFound)
  // so the next sample tick rebuilds against the new game from scratch.
  function swapCapturedGame(game) {
    if (!game || game === capturedGame) return;
    capturedGame = game;
    lastFound = null;
    lastSignature = '';
    prevSample.clear();
    lastDeepSearchAt = 0;
    cachedZoomKey = null;
    cachedCameraKey = null;
    cachedCameraZoomKey = null;
  }

  function tryCaptureFromCandidate(obj) {
    if (!obj) return false;
    if (obj === capturedGame) return true;
    if (looksLikeGame(obj)) {
      swapCapturedGame(obj);
      return true;
    }
    return false;
  }

  function flushPendingCandidates() {
    trapState.pendingChecksRan++;
    // Walk a copy in case capture mutates the list. Drop null refs and
    // candidates that have now been recognized; keep the rest for a future
    // re-check (their constructor body may not have finished assigning the
    // roster yet).
    const list = trapState.pendingCandidates;
    const keep = [];
    for (let i = 0; i < list.length; i++) {
      const ref = list[i];
      const obj = ref && ref.deref ? ref.deref() : ref;
      if (!obj) continue;
      if (tryCaptureFromCandidate(obj)) continue;
      keep.push(ref);
    }
    trapState.pendingCandidates = keep;
  }

  function looksLikeRoster(obj) {
    // The roster class (`tr`) declares its fields with the *real* readable
    // names — these are not minified in the bundle and are stable across
    // builds. If an object has all of them, it's the roster.
    try {
      if (!obj || typeof obj !== 'object') return false;
      return (
        'playerInfo' in obj &&
        'playerStatus' in obj &&
        'playerIds' in obj &&
        'teamInfo' in obj &&
        'groupInfo' in obj
      );
    } catch {
      return false;
    }
  }

  function looksLikeGame(obj) {
    // An Rr instance holds the roster on one of its own minified fields
    // (mapped by mangled.js as `game.roster`), so we don't anchor on the
    // field NAME — we anchor
    // on the field VALUE shape. This survives any future re-mangling of
    // Rr's fields. We scan a bounded number of own props to avoid pathology.
    try {
      if (!obj || typeof obj !== 'object') return false;
      let names;
      try { names = Object.getOwnPropertyNames(obj); } catch { return false; }
      if (names.length < 8) return false; // Rr has 50+ fields, weed out tiny objects
      const cap = Math.min(names.length, 200);
      for (let i = 0; i < cap; i++) {
        const v = obj[names[i]];
        if (v && typeof v === 'object' && looksLikeRoster(v)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function installTrapName(name) {
    if (trapState.installed.has(name)) return;
    try {
      trapState.originals.set(
        name,
        Object.getOwnPropertyDescriptor(Object.prototype, name) || null
      );
      Object.defineProperty(Object.prototype, name, {
        configurable: true,
        enumerable: false,
        set(value) {
          // Always materialize as an own property so the assignment "works"
          // for any object on the page (defensive against name collisions
          // with non-game classes that happen to share the same minified
          // name). After this defineProperty, subsequent writes to `name`
          // on `this` go straight to the own slot and never re-enter this
          // setter — so leaving the trap on Object.prototype indefinitely
          // costs nothing for already-seen objects, but still fires for
          // every brand-new Rr the bundle constructs (e.g. on respawn /
          // new round), letting us swap the captured game ref.
          Object.defineProperty(this, name, {
            value,
            writable: true,
            configurable: true,
            enumerable: true
          });
          if (this === capturedGame) return;
          // The trap fires on the FIRST line of Rr's constructor body, at
          // which point the roster (`<roster> = new tr(...)`) has not been
          // assigned yet — so a synchronous shape check would always fail.
          // Stash the candidate and re-check post-microtask, after the
          // constructor body has finished. The sample loop also re-checks
          // as a redundant fallback.
          if (looksLikeGame(this)) {
            swapCapturedGame(this);
            return;
          }
          try {
            const ref = typeof WeakRef === 'function' ? new WeakRef(this) : this;
            trapState.pendingCandidates.push(ref);
            trapState.pendingChecksScheduled++;
            queueMicrotask(flushPendingCandidates);
          } catch {}
        },
        get() {
          return undefined;
        }
      });
      trapState.installed.add(name);
    } catch {}
  }

  function installGameCaptureTrap() {
    // Seed list lives in mangled.js (`seedNames`). If survev re-mangles,
    // the runtime discovery pass below will add more on top of these.
    for (const name of M.seedNames) installTrapName(name);
  }

  // Async fallback: fetch every <script src> on the page, parse class
  // bodies, and install traps on any plausible game-class constructor
  // assignments we discover. This is the robust path that survives bundle
  // re-mangling.
  async function discoverAndInstallExtraTraps() {
    if (capturedGame) {
      trapState.discoveryStatus = 'skipped';
      return;
    }
    let scripts;
    try {
      scripts = Array.from(document.querySelectorAll('script[src]'));
    } catch {
      trapState.discoveryStatus = 'no-scripts';
      return;
    }
    if (!scripts.length) {
      trapState.discoveryStatus = 'no-scripts';
      return;
    }

    const fetchOne = async (url) => {
      try {
        const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
        if (!res.ok) return '';
        return await res.text();
      } catch {
        return '';
      }
    };

    // Try only same-origin scripts (cross-origin will CORS-fail and
    // pollute the console; the survev bundle is same-origin anyway).
    const here = location.origin;
    const targets = scripts
      .map((s) => s.src)
      .filter((u) => {
        try { return new URL(u).origin === here; } catch { return false; }
      });

    let added = 0;
    for (const url of targets) {
      if (capturedGame) break;
      const src = await fetchOne(url);
      if (!src) continue;

      // Find every class declaration with a constructor. We use a forgiving
      // regex that matches "class { …fields… constructor(params){ …body… }".
      // The body capture is bounded to keep the regex linear-ish.
      const classRe = /class\s*(?:[A-Za-z_$][\w$]*\s*)?\{([\s\S]{0,4000}?)constructor\s*\(([^)]*)\)\s*\{([\s\S]{0,2000}?)\}/g;
      let m;
      while ((m = classRe.exec(src)) !== null) {
        const fieldBlock = m[1];
        const paramList = m[2]
          .split(',')
          .map((p) => p.trim())
          .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
        const body = m[3];
        if (paramList.length < 5) continue;

        // Field declarations look like `name;` or `name = expr;`. Pull every
        // identifier that ends with `;` or `=` at the top level of fieldBlock.
        const declared = new Set();
        const fieldRe = /\b([A-Za-z_$][\w$]*)\s*[;=]/g;
        let fm;
        while ((fm = fieldRe.exec(fieldBlock)) !== null) {
          declared.add(fm[1]);
        }

        // Find `this.X = paramName` assignments in the body.
        const assignRe = /this\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)/g;
        const localCandidates = [];
        let am;
        while ((am = assignRe.exec(body)) !== null) {
          const fieldName = am[1];
          const rhs = am[2];
          if (!paramList.includes(rhs)) continue;
          if (declared.has(fieldName)) continue;
          localCandidates.push(fieldName);
        }

        // Heuristic: a manager/game class typically pipes 5+ constructor
        // params into instance fields. Player/sprite classes won't.
        if (localCandidates.length >= 5) {
          for (const name of localCandidates) {
            if (trapState.installed.has(name) || capturedGame) continue;
            installTrapName(name);
            added++;
          }
        }
      }
    }
    trapState.candidatesAdded = added;
    trapState.discoveryStatus = capturedGame ? 'captured' : 'installed';
  }

  installGameCaptureTrap();
  // Fire-and-forget. The seed traps cover the current bundle; this only
  // matters if survev re-mangles names in a future build.
  discoverAndInstallExtraTraps().catch(() => {});

  // function post(type, payload) {
  //   window.postMessage({ source: SOURCE, type, payload }, '*');
  // }

  post = (...a) => {}

  function getXY(pos) {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
    return { x: Number(pos.x.toFixed(2)), y: Number(pos.y.toFixed(2)) };
  }

  function getDir(dir) {
    if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number') return null;
    return { x: Number(dir.x.toFixed(4)), y: Number(dir.y.toFixed(4)) };
  }

  // Derive a per-second velocity from the previous sample for `id`. Returns
  // null on the first observation (no previous data) or if Δt is too small
  // to be meaningful. Mutates `prevSample` to store the new (x, y, ts).
  function deriveVelocity(id, x, y, ts) {
    const prev = prevSample.get(id);
    prevSample.set(id, { x, y, ts });
    if (!prev) return null;
    const dt = (ts - prev.ts) / 1000;
    if (!(dt > 0.01)) return null;
    return {
      xv: Number(((x - prev.x) / dt).toFixed(2)),
      yv: Number(((y - prev.y) / dt).toFixed(2))
    };
  }

  function pruneVelocityCache(now) {
    for (const [id, entry] of prevSample) {
      if (now - entry.ts > PREV_SAMPLE_TTL_MS) prevSample.delete(id);
    }
  }

  // Same shape contract as `looksLikeGame`, but used post-capture by
  // `findRoot` and `safeReadGame`. We don't anchor on minified field names —
  // we walk the object's own props until we find the roster (recognizable
  // by its stable readable field names: playerInfo, playerStatus, …).
  function isGameLike(game) {
    return looksLikeGame(game);
  }

  function safeRead(obj, key) {
    try {
      const val = obj?.[key];
      if (val && typeof val === 'object' && typeof val.then === 'function') {
        if (typeof val.catch === 'function') val.catch(() => {});
        return undefined;
      }
      return val;
    } catch {
      return undefined;
    }
  }

  function safeReadGame(candidate) {
    try {
      if (isGameLike(candidate)) return candidate;
      const nested = candidate?.game;
      if (isGameLike(nested)) return nested;
    } catch {}
    return null;
  }

  function sameOriginFrameList(win) {
    const out = [];
    try {
      for (let i = 0; i < win.frames.length; i++) {
        let child;
        try {
          child = win.frames[i];
          void child.location?.href;
          out.push(child);
        } catch {}
      }
    } catch {}
    return out;
  }

  function rankProps(names) {
    const hot = [
      'game', 'pixi', 'app', 'renderer', 'engine', 'scene', 'world', 'client', 'manager',
      'Mi', '__reactFiber', '__reactProps', '__vue__'
    ];
    return [...names].sort((a, b) => {
      const ah = hot.includes(a) ? 0 : 1;
      const bh = hot.includes(b) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      const an = /^\d+$/.test(a) ? 1 : 0;
      const bn = /^\d+$/.test(b) ? 1 : 0;
      if (an !== bn) return an - bn;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  function childEntries(obj) {
    const out = [];
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return out;

    const tag = Object.prototype.toString.call(obj);
    if (tag === '[object Window]') {
      const direct = ['document', 'frames', 'top', 'parent', 'self'];
      for (const key of direct) {
        const val = safeRead(obj, key);
        if (val && val !== obj) out.push([key, val]);
      }
      for (const frame of sameOriginFrameList(obj)) out.push(['<frame>', frame]);
    }

    let names = [];
    try { names = Object.getOwnPropertyNames(obj); } catch { return out; }
    names = rankProps(names).slice(0, MAX_PROPS);

    for (const key of names) {
      if (key === 'window' || key === 'self' || key === 'top' || key === 'parent') continue;
      const val = safeRead(obj, key);
      if (!val) continue;
      const t = typeof val;
      if (t !== 'object' && t !== 'function') continue;
      out.push([key, val]);
    }

    if (Array.isArray(obj) || tag.includes('HTMLCollection') || tag.includes('NodeList')) {
      const len = Math.min(Number(obj.length) || 0, 20);
      for (let i = 0; i < len; i++) {
        const val = safeRead(obj, i);
        if (val && (typeof val === 'object' || typeof val === 'function')) out.push([String(i), val]);
      }
    }

    return out;
  }

  function deepFindGame() {
    const roots = [];
    roots.push(['window', window]);
    if (document) roots.push(['document', document]);
    if (document?.documentElement) roots.push(['documentElement', document.documentElement]);
    if (document?.body) roots.push(['body', document.body]);
    try {
      const canvases = document?.querySelectorAll?.('canvas') || [];
      for (let i = 0; i < Math.min(canvases.length, 5); i++) roots.push([`canvas${i}`, canvases[i]]);
    } catch {}
    for (const frame of sameOriginFrameList(window)) roots.push(['<frame>', frame]);

    const seen = new WeakSet();
    const queue = [];
    for (const [path, value] of roots) {
      if (value && (typeof value === 'object' || typeof value === 'function')) queue.push([path, value, 0]);
    }

    let visited = 0;
    while (queue.length && visited < MAX_NODES) {
      const [path, obj, depth] = queue.shift();
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) continue;
      if (seen.has(obj)) continue;
      seen.add(obj);
      visited++;

      const direct = safeReadGame(obj);
      if (direct) return { rootName: path, game: direct, visited };

      if (depth >= 4) continue;
      const children = childEntries(obj);
      for (const [key, child] of children) {
        if (!child || (typeof child !== 'object' && typeof child !== 'function')) continue;
        if (seen.has(child)) continue;
        queue.push([`${path}.${key}`, child, depth + 1]);
      }
    }

    return null;
  }

  function findRoot() {
    if (lastFound?.game && isGameLike(lastFound.game)) return lastFound;

    // Primary path: read the live game ref off the captured app singleton.
    // Goes first so that if the bundle ever swaps in a fresh Game instance
    // (new round / rejoin) we follow it rather than clinging to a stale one.
    const fromApp = gameFromApp();
    if (fromApp) {
      swapCapturedGame(fromApp);
      lastFound = { rootName: 'appSingleton', game: fromApp };
      return lastFound;
    }

    // Belt-and-braces: re-run the deferred shape check on any candidates
    // that fired the trap but weren't recognizable at trap-fire time.
    if (!capturedGame && trapState.pendingCandidates.length) {
      flushPendingCandidates();
    }

    if (capturedGame && isGameLike(capturedGame)) {
      lastFound = { rootName: 'prototypeTrap', game: capturedGame };
      return lastFound;
    }

    const directCandidates = [
      ['window.Mi', safeRead(window, 'Mi')],
      ['window.game', safeRead(window, 'game')],
      ['window.__game', safeRead(window, '__game')]
    ];
    for (const [name, candidate] of directCandidates) {
      const game = safeReadGame(candidate);
      if (game) {
        lastFound = { rootName: name, game };
        return lastFound;
      }
    }

    const now = Date.now();
    if (now - lastDeepSearchAt < DEEP_SEARCH_MS) return null;
    lastDeepSearchAt = now;

    const found = deepFindGame();
    if (found) {
      lastFound = found;
      return found;
    }
    return null;
  }

  // Build a sample, or return { reason } if the game isn't ready yet.
  // Reasons:
  //   'no-roster'  -> couldn't find the roster on the game (shouldn't happen
  //                   post-capture; would mean the bundle changed shape)
  //   'no-player'  -> the local player slot is null. This is the lobby state:
  //                   the user hasn't joined a match yet, OR is between rounds.
  //   'no-pos'     -> player exists but has no position vector. Either the
  //                   first server update hasn't arrived, or the position
  //                   field has been re-mangled.
  function buildSample(found) {
    const game = found.game;
    // Prefer the value-shape lookup over the minified field name; fall back
    // to the minified name only if the walk fails (defensive belt-and-braces).
    const roster = findRosterOnGame(game) || game?.[GAME_ROSTER];
    if (!roster) return { reason: 'no-roster' };

    const me = findLocalPlayerOnGame(game) || game?.[GAME_LOCAL];
    if (!me) return { reason: 'no-player' };

    const selfId = Number(me.__id ?? me.playerId ?? 0) || null;
    const selfPos = getXY(me[PLAYER_POS] ?? me.pos);
    if (!selfPos) return { reason: 'no-pos', selfId };
    const selfDir = getDir(me[PLAYER_DIR]);
    const sampleTs = Date.now();
    const selfVel = selfId != null
      ? deriveVelocity(selfId, selfPos.x, selfPos.y, sampleTs)
      : null;
    const selfWeapon = getCurrentWeapon(me);
    const selfBulletSpeed = selfWeapon && Object.prototype.hasOwnProperty.call(GUN_BULLET_SPEED, selfWeapon)
      ? GUN_BULLET_SPEED[selfWeapon]
      : null;
    const selfScope = getCurrentScope(me);
    const selfViewportWorldUnits = getViewportWorldUnits(selfScope, me, game);

    const getInfo = (id) => {
      try {
        return roster.getPlayerInfo?.(id) ?? null;
      } catch {
        return null;
      }
    };

    const selfInfo = selfId != null ? getInfo(selfId) : null;
    const playerStatus = roster.playerStatus ?? {};
    const selfStatus = selfId != null ? playerStatus[selfId] || null : null;

    // Enemies live in the Player entity pool (`roster.playerPool` — `playerPool`
    // is a real readable name on `tr`), not in `playerStatus`. `playerStatus`
    // only carries minimap state for players on the local team — it never
    // contains enemies in non-faction modes. The pool, on the other hand,
    // holds the actual Player objects that the server has streamed to us
    // (i.e. enemies currently within view radius).
    const pool = roster.playerPool;
    const players = (pool && typeof pool[POOL_GETALL] === 'function' ? pool[POOL_GETALL]() : []) || [];
    const enemies = [];
    const seenIds = new Set();

    for (const player of players) {
      if (!player || !player.active) continue;
      const id = Number(player.__id ?? 0);
      if (!Number.isFinite(id) || id === 0) continue;
      if (selfId != null && id === selfId) continue;

      const info = getInfo(id) ?? {};
      const sameGroup =
        selfInfo && info && selfInfo.groupId != null && info.groupId != null && selfInfo.groupId === info.groupId;
      const sameTeam =
        selfInfo && info && selfInfo.teamId != null && info.teamId != null &&
        selfInfo.teamId !== 0 && info.teamId !== 0 && selfInfo.teamId === info.teamId;

      if (sameGroup || sameTeam) continue;

      const pos = getXY(player[PLAYER_POS] ?? player[PLAYER_POS2]);
      if (!pos) continue;
      const dir = getDir(player[PLAYER_DIR]);

      // The Player entity doesn't carry health directly; pull it from
      // playerStatus if a minimap entry happens to exist (faction modes,
      // team-vis), otherwise leave null.
      const status = playerStatus[id] || null;
      const vel = deriveVelocity(id, pos.x, pos.y, sampleTs);

      seenIds.add(id);
      enemies.push({
        id,
        x: pos.x,
        y: pos.y,
        xv: vel ? vel.xv : null,
        yv: vel ? vel.yv : null,
        dirX: dir ? dir.x : null,
        dirY: dir ? dir.y : null,
        visible: true,
        // The Player class has no own `dead`/`downed` fields — they live
        // on the netData object (same one we use for getCurrentWeapon).
        dead: Boolean(player[PLAYER_NET]?.[NET_DEAD]),
        downed: Boolean(player[PLAYER_NET]?.[NET_DOWNED] ?? player.downed),
        health: status && typeof status.health === 'number' ? Number(status.health.toFixed(2)) : null,
        role: status?.role || '',
        layer: Number.isFinite(player.layer) ? player.layer : null,
        teamId: Number.isFinite(info.teamId) ? info.teamId : null,
        groupId: Number.isFinite(info.groupId) ? info.groupId : null,
        name: info.name || ''
      });
    }

    // Also surface any enemies known via minimap status (e.g. faction modes
    // where the server explicitly reveals foes on the minimap) that we
    // didn't already capture from the entity pool.
    // DISABLED: minimap status entries can linger with stale positions after
    // a player leaves the view radius, producing ghost targets.
    // for (const [rawId, status] of Object.entries(playerStatus)) {
    //   const id = Number(rawId);
    //   if (!Number.isFinite(id) || id === 0) continue;
    //   if (selfId != null && id === selfId) continue;
    //   if (seenIds.has(id)) continue;
    //   if (!status) continue;
    //
    //   const info = getInfo(id) ?? {};
    //   const sameGroup =
    //     selfInfo && info && selfInfo.groupId != null && info.groupId != null && selfInfo.groupId === info.groupId;
    //   const sameTeam =
    //     selfInfo && info && selfInfo.teamId != null && info.teamId != null &&
    //     selfInfo.teamId !== 0 && info.teamId !== 0 && selfInfo.teamId === info.teamId;
    //   if (sameGroup || sameTeam) continue;
    //
    //   const pos = getXY(status.posTarget ?? status.pos);
    //   if (!pos) continue;
    //   const vel = deriveVelocity(id, pos.x, pos.y, sampleTs);
    //
    //   enemies.push({
    //     id,
    //     x: pos.x,
    //     y: pos.y,
    //     xv: vel ? vel.xv : null,
    //     yv: vel ? vel.yv : null,
    //     dirX: null,
    //     dirY: null,
    //     visible: Boolean(status.visible),
    //     dead: Boolean(status.dead),
    //     downed: Boolean(status.downed),
    //     health: typeof status.health === 'number' ? Number(status.health.toFixed(2)) : null,
    //     role: status.role || '',
    //     layer: null,
    //     teamId: Number.isFinite(info.teamId) ? info.teamId : null,
    //     groupId: Number.isFinite(info.groupId) ? info.groupId : null,
    //     name: info.name || ''
    //   });
    // }

    pruneVelocityCache(sampleTs);
    enemies.sort((a, b) => a.id - b.id);

    return {
      ts: sampleTs,
      url: location.href,
      isTop: window.top === window,
      rootName: found.rootName,
      self: {
        id: selfId,
        x: selfPos.x,
        y: selfPos.y,
        xv: selfVel ? selfVel.xv : null,
        yv: selfVel ? selfVel.yv : null,
        dirX: selfDir ? selfDir.x : null,
        dirY: selfDir ? selfDir.y : null,
        weapon: selfWeapon || '',
        bulletSpeed: selfBulletSpeed,
        scope: selfScope,
        viewportWorldUnits: selfViewportWorldUnits,
        // Matches the enemy shape so downstream code can treat self and
        // enemies uniformly. `visible` is trivially true (we wouldn't have
        // built a sample otherwise); the rest are pulled from the same
        // sources we use for enemies.
        visible: true,
        dead: Boolean(me[PLAYER_NET]?.[NET_DEAD]),
        downed: Boolean(me[PLAYER_NET]?.[NET_DOWNED] ?? me.downed),
        health: selfStatus && typeof selfStatus.health === 'number' ? Number(selfStatus.health.toFixed(2)) : null,
        role: selfStatus?.role || '',
        layer: Number.isFinite(me.layer) ? me.layer : null,
        teamId: Number.isFinite(selfInfo?.teamId) ? selfInfo.teamId : null,
        groupId: Number.isFinite(selfInfo?.groupId) ? selfInfo.groupId : null,
        name: selfInfo?.name || ''
      },
      enemies
    };
  }

  function sampleLoop() {
    logZoomTick();
    const found = findRoot();
    const now = Date.now();

    if (!found) {
      if (now - lastStatusAt > STATUS_MS) {
        // Distinguish "we can't reach the app at all" (a real breakage —
        // the bundle changed shape) from "we have the app, the Game just
        // hasn't been init()'d yet" (normal: the user is still in the menu,
        // the roster only exists once a match is joined).
        const appGame = capturedApp ? safeRead(capturedApp, 'game') : null;
        const message = !capturedApp
          ? 'App singleton not captured. The bundle may have changed shape — re-run fetch_survev_js.py + derive_mangled.py, and reload the page (the capture hook must be installed before survev\'s bundle runs).'
          : appGame
            ? 'App captured and the Game object exists, but it has not been initialized yet. Click Play and join a match.'
            : 'App captured, but it has no Game object yet. The bundle is still loading.';
        post('status', {
          ok: false,
          message,
          url: location.href,
          isTop: window.top === window,
          app: {
            captured: !!capturedApp,
            hasGame: !!appGame,
            bindHook: {
              installed: bindHookState.installed,
              calls: bindHookState.calls,
              uninstalledReason: bindHookState.uninstalledReason
            }
          },
          trap: {
            installedNames: Array.from(trapState.installed),
            extraCandidatesAdded: trapState.candidatesAdded,
            discoveryStatus: trapState.discoveryStatus,
            pendingChecksScheduled: trapState.pendingChecksScheduled,
            pendingChecksRan: trapState.pendingChecksRan,
            pendingCandidatesRemaining: trapState.pendingCandidates.length,
            captured: !!capturedGame
          }
        });
        lastStatusAt = now;
      }
      return;
    }

    const sample = buildSample(found);
    if (!sample || !sample.self) {
      if (now - lastStatusAt > STATUS_MS) {
        const reason = sample?.reason || 'unknown';
        const messageByReason = {
          'no-roster': 'Game captured, but the roster (`tr`) is not on it. The bundle field shape may have changed.',
          'no-player': 'Game captured, but the local player slot is null. Click Play and join a match — `game.localPlayer` only gets populated when the first server update arrives.',
          'no-pos': 'Local player exists, but has no position vector yet. The first server update may not have arrived.',
          'unknown': 'Game found, but sample build failed for an unknown reason.'
        };
        post('status', {
          ok: false,
          message: messageByReason[reason],
          reason,
          rootName: found.rootName,
          url: location.href,
          isTop: window.top === window
        });
        lastStatusAt = now;
      }
      return;
    }

    const signature = JSON.stringify({ self: sample.self, enemies: sample.enemies });
    if (signature === lastSignature) return;
    lastSignature = signature;

    pageSamples.push(sample);
    updateInterpState(sample);
    post('sample', sample);

    if (now - lastStatusAt > STATUS_MS) {
      post('status', {
        ok: true,
        message: 'Logging positions.',
        rootName: found.rootName,
        samplesOnPage: pageSamples.length,
        enemiesTracked: sample.enemies.length,
        url: location.href,
        isTop: window.top === window
      });
      lastStatusAt = now;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === 'clear-page-log') {
      pageSamples = [];
      lastSignature = '';
      post('status', { ok: true, message: 'Cleared in-page sample cache.' });
    }
  });

  // Alt-to-randomize-aim. While Alt is held, real mousemove events are
  // swallowed at the capture phase and a fresh random screen-space point
  // is dispatched to the canvas every animation frame. Survev keeps the
  // local player viewport-centered and derives aim from
  // (mouseScreenPos − playerScreenPos), so a screen-space offset translates
  // directly into world-space aim direction.
  let shiftHeld = false;
  let shiftRafId = 0;
  const SHIFT_AIM_RADIUS = 400; // pixels from viewport center; well outside the player
  function dist(a, b){
    return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5
  }
  // Detect spoofed enemies: fake players inserted client-side that sit close
  // to the local player and orbit at a constant relative direction (i.e. their
  // (enemy - self) vector tracks the local player). A real enemy's bearing
  // changes as we move; a spoof's bearing stays locked. We require the local
  // player to have actually moved over the window so a stationary real enemy
  // isn't falsely flagged.
  const SPOOF_WINDOW = 12;
  const SPOOF_MIN_OBS = 6;
  const SPOOF_SELF_MOVE_MIN = 6; // world units the local player must travel
  const SPOOF_BEARING_LOCK = 0.99; // mean resultant length on unit circle
  function isSpoofedEnemy(enemyId, samples){
    const recent = samples.slice(-SPOOF_WINDOW);
    if (recent.length < SPOOF_MIN_OBS) return false;
    let cx = 0, cy = 0, n = 0;
    for (const s of recent){
      const e = s.enemies.find((en) => en.id === enemyId);
      if (!e) continue;
      const dx = e.x - s.self.x;
      const dy = e.y - s.self.y;
      const r = Math.hypot(dx, dy);
      if (r < 1e-6) continue;
      cx += dx / r;
      cy += dy / r;
      n++;
    }
    if (n < SPOOF_MIN_OBS) return false;
    const first = recent[0].self;
    const last = recent[recent.length - 1].self;
    const selfMoved = Math.hypot(last.x - first.x, last.y - first.y);
    if (selfMoved < SPOOF_SELF_MOVE_MIN) return false;
    const meanLen = Math.hypot(cx, cy) / n;
    return meanLen > SPOOF_BEARING_LOCK;
  }
  // Survev layer semantics: 0 = aboveground, 1 = underground (bunker),
  // 2/3 = stair/transition (visible from both). A player on layer 0 can't
  // see/hit a player on layer 1 and vice versa; players on 2/3 can interact
  // with both. Returns true when bullets/melee from self can reach enemy.
  // Treats a null layer as 0 (the survev default for spawn).
  function canInteract(selfLayer, enemyLayer) {
    const s = Number.isFinite(selfLayer) ? selfLayer : 0;
    const e = Number.isFinite(enemyLayer) ? enemyLayer : 0;
    if (s === 2 || s === 3) return true;
    if (s === 0) return e !== 1;
    if (s === 1) return e !== 0;
    return true;
  }

  // Auto-aim humanization. Tunable live from devtools via `window.__aimHuman`.
  const AIM_HUMAN = {
    // Human reaction delay, in ms. We aim using the enemy's state as it was
    // perceived this many ms ago, then extrapolate that perceived state
    // *forward* by the same delay along its then-velocity. Net effect: a
    // target moving at constant velocity is tracked perfectly (the forward
    // extrapolation exactly cancels the lag), and only a *change* in the
    // target's motion is reacted to — lagged by reactionMs. "Perfect aim
    // given lag."
    reactionMs: 140,
    // Fraction of the remaining world-space distance between the aim point
    // and the target point that we close per reference frame (AIM_REF_DT).
    // dt-corrected each frame so the closing rate is frame-rate independent.
    // 1.0 ⇒ instant snap; smaller ⇒ a slower glide onto the target.
    followFraction: 0.15,
    // After an enemy dies it stays lockable (acts alive) for this many ms,
    // so its corpse/last position can still be aimed at briefly.
    deadLingerMs: 600,
  };
  // id -> Date.now() when the enemy was first observed dead; lets pickTarget
  // keep a just-killed target lockable for AIM_HUMAN.deadLingerMs.
  const deadSince = new Map();
  window.__aimHuman = AIM_HUMAN;
  // Frame time the followFraction is calibrated against (60fps).
  const AIM_REF_DT = 1 / 60;

  const aimState = {
    theta: 0,        // current aim angle (derived from the aim point each frame)
    targetId: null,  // committed enemy id
    aimX: null,      // current aim point on the world map (null until first engage)
    aimY: null,
    lastFrameAt: 0,  // Date.now() of the previous frame, for dt
  };

  // The user's real mouse position in screen space, kept up-to-date by the
  // capture-phase mousemove listener even while we're suppressing those
  // events from reaching the canvas. pickTarget reads this so the cheat
  // engages whichever enemy the user is *pointing at*, classic aim-assist
  // style — the user roughs in the direction with their real mouse, the
  // cheat snaps onto whichever live enemy best matches that bearing.
  const realMouse = { x: 0, y: 0, hasMoved: false };

  // World→pixel scale (pixels per world unit) for the current frame. The
  // sample's stored viewportWorldUnits is at most SAMPLE_MS old, and during
  // a scope-zoom lerp the game's rendered zoom slides across ~1s of frames;
  // we re-read the camera's live m_zoom per frame so overlays stay glued
  // to whatever the user sees instead of jumping at each new sample.
  // Falls back to the sample's cached viewportWorldUnits before the camera
  // is located, and to an arbitrary default before a sample exists.
  function getLivePxPerWorldUnit(sample) {
    const game = capturedGame;
    if (game) {
      const cam = findCameraOnGame(game);
      if (cam) {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const maxScreenDim = Math.max(Math.min(W, H) * (16 / 9), Math.max(W, H));
        const scope = sample?.self?.scope || '1xscope';
        const radius = SCOPE_RADIUS_TABLE[scope] ?? SCOPE_RADIUS_TABLE['1xscope'];
        const expectedTargetZoom = (maxScreenDim * 0.5) / (radius * 16);
        const mZoom = readCameraZoom(cam, expectedTargetZoom);
        if (mZoom && mZoom > 0) return 16 * mZoom;
      }
    }
    return window.innerWidth / (sample?.self?.viewportWorldUnits || 56);
  }

  // Pick the enemy whose world position is closest (in Euclidean distance)
  // to the world point under the user's real mouse cursor. Survev keeps the
  // local player viewport-centered, so the mouse offset from screen center
  // — divided by the world-to-screen pixel scale — is the world offset
  // from the player. Adding it to the player's world position gives us
  // a "where the user is pointing in the world" point that we score every
  // visible enemy against.
  function pickTarget(player, enemies, now) {
    const candidates = [];
    for (const e of enemies) {
      if (e.dead) {
        // Keep a just-killed enemy lockable for a short linger window. Record
        // when we first saw it dead, then drop it once the window elapses.
        if (!deadSince.has(e.id)) deadSince.set(e.id, now);
        if (now - deadSince.get(e.id) >= AIM_HUMAN.deadLingerMs) continue;
      } else {
        deadSince.delete(e.id);
      }
      if (isSpoofedEnemy(e.id, pageSamples)) continue;
      if (!canInteract(player.layer, e.layer)) continue;
      candidates.push(e);
    }
    if (!candidates.length) return [null, 0];

    const scale = getLivePxPerWorldUnit(pageSamples[pageSamples.length - 1]);
    let mouseWorldX, mouseWorldY;
    if (realMouse.hasMoved) {
      mouseWorldX = player.x + (realMouse.x - window.innerWidth / 2) / scale;
      mouseWorldY = player.y - (realMouse.y - window.innerHeight / 2) / scale;
    } else {
      mouseWorldX = player.x;
      mouseWorldY = player.y;
    }

    const scoreOf = (e) => {
      const dx = e.x - mouseWorldX;
      const dy = e.y - mouseWorldY;
      return dx * dx + dy * dy;
    };

    let best = candidates[0];
    let bestScore = scoreOf(best);
    for (let i = 1; i < candidates.length; i++) {
      const s = scoreOf(candidates[i]);
      if (s < bestScore) { bestScore = s; best = candidates[i]; }
    }
    return [best, dist(player, best)];
  }

  // Reconstruct an enemy's world state (position + velocity) as it was at
  // wall-clock time `atTs` (Date.now() ms), by linearly interpolating between
  // the two recorded samples that bracket `atTs`. Used to look up where a
  // target was perceived `reactionMs` ago. Returns null if the enemy doesn't
  // appear in any retained sample; clamps to the nearest endpoint when `atTs`
  // falls outside the recorded window.
  function enemyStateAt(id, atTs) {
    let lo = null, hi = null;
    // pageSamples is in ascending-ts order; walk back from newest.
    for (let i = pageSamples.length - 1; i >= 0; i--) {
      const s = pageSamples[i];
      const e = s.enemies.find((en) => en.id === id);
      if (!e) continue;
      if (s.ts <= atTs) { lo = { ts: s.ts, e }; break; }
      hi = { ts: s.ts, e };
    }
    const pick = (h) => ({ x: h.e.x, y: h.e.y, xv: h.e.xv ?? 0, yv: h.e.yv ?? 0 });
    if (!lo && !hi) return null;
    if (!lo) return pick(hi);
    if (!hi) return pick(lo);
    const span = hi.ts - lo.ts;
    const f = span > 0 ? (atTs - lo.ts) / span : 0;
    const lerp = (a, b) => a + (b - a) * f;
    return {
      x:  lerp(lo.e.x, hi.e.x),
      y:  lerp(lo.e.y, hi.e.y),
      xv: lerp(lo.e.xv ?? 0, hi.e.xv ?? 0),
      yv: lerp(lo.e.yv ?? 0, hi.e.yv ?? 0),
    };
  }

  // The world point "perfect aim given lag" wants the cursor on right now.
  // Take the enemy's perceived state from `reactionMs` ago, extrapolate it
  // forward by reactionMs along that perceived velocity (this is the lag
  // cancellation — constant-velocity targets land exactly on their true
  // current position), then add bullet lead so the shot connects.
  function reactionTarget(player, enemy, now) {
    const past = enemyStateAt(enemy.id, now - AIM_HUMAN.reactionMs)
      || { x: enemy.x, y: enemy.y, xv: enemy.xv ?? 0, yv: enemy.yv ?? 0 };
    const D = AIM_HUMAN.reactionMs / 1000;
    // Reaction-extrapolate the perceived position to the present.
    const rx = past.x + past.xv * D;
    const ry = past.y + past.yv * D;
    // Bullet lead: time for the projectile to travel from me to that point,
    // then advance the target one more tHit along the perceived velocity.
    const bulletSpeed = player.bulletSpeed ?? 1e8;
    const tHit = Math.hypot(rx - player.x, ry - player.y) / bulletSpeed;
    return { x: rx + past.xv * tHit, y: ry + past.yv * tHit };
  }

  function dispatchAim() {
    const target = document.querySelector('canvas') || document.body;
    if (!target) return;
    if (!pageSamples.length) return;

    const last_sample = pageSamples[pageSamples.length - 1];
    const player = last_sample.self;
    const enemies = last_sample.enemies;

    const now = Date.now();
    const dt = aimState.lastFrameAt ? Math.max(0.001, (now - aimState.lastFrameAt) / 1000) : AIM_REF_DT;
    aimState.lastFrameAt = now;

    const [enemy] = pickTarget(player, enemies, now);
    if (enemy) {
      aimState.targetId = enemy.id;
      const tgt = reactionTarget(player, enemy, now);
      // First frame of an engagement: start the glide from where the user's
      // real cursor is pointing in the world, not from a stale/zero point.
      if (aimState.aimX == null) {
        const scale = getLivePxPerWorldUnit(last_sample);
        if (realMouse.hasMoved) {
          aimState.aimX = player.x + (realMouse.x - window.innerWidth / 2) / scale;
          aimState.aimY = player.y - (realMouse.y - window.innerHeight / 2) / scale;
        } else {
          aimState.aimX = player.x;
          aimState.aimY = player.y;
        }
      }
      // Close a frame-rate-independent fraction of the remaining world-space
      // gap toward the target point this frame.
      const k = 1 - Math.pow(1 - AIM_HUMAN.followFraction, dt / AIM_REF_DT);
      aimState.aimX += (tgt.x - aimState.aimX) * k;
      aimState.aimY += (tgt.y - aimState.aimY) * k;
      aimState.theta = Math.atan2(aimState.aimY - player.y, aimState.aimX - player.x);
    } else {
      aimState.targetId = null;
    }

    const x = Math.round(window.innerWidth / 2 + Math.cos(aimState.theta) * SHIFT_AIM_RADIUS);
    const y = Math.round(window.innerHeight / 2 - Math.sin(aimState.theta) * SHIFT_AIM_RADIUS);
    try {
      target.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y
      }));
    } catch {}
  }

  function shiftFrame() {
    if (!shiftHeld) { shiftRafId = 0; return; }
    dispatchAim();
    shiftRafId = requestAnimationFrame(shiftFrame);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift') return;
    if (!shiftHeld) {
      shiftHeld = true;
      // Fresh hold: drop the prior aim point so dispatchAim re-seeds the glide
      // from wherever the user's real cursor currently points.
      aimState.aimX = null;
      aimState.aimY = null;
      aimState.lastFrameAt = 0;
      if (!shiftRafId) shiftRafId = requestAnimationFrame(shiftFrame);
    }
    // Suppress the browser's default Shift behavior so it doesn't steal
    // focus from the canvas.
    e.preventDefault();
  }, true);

  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Shift') return;
    shiftHeld = false;
    if (shiftRafId) { cancelAnimationFrame(shiftRafId); shiftRafId = 0; }
    aimState.targetId = null;
    aimState.aimX = null;
    aimState.aimY = null;
    aimState.lastFrameAt = 0;
  }, true);

  // Capture-phase mousemove suppressor: while Shift is held, drop any real
  // (trusted) mouse movement so only our per-frame synthetic events reach
  // the game. Synthetic events (isTrusted === false) pass through. We also
  // *record* the real mouse position on every trusted move (even when
  // suppressing) so pickTarget can engage whichever enemy the user is
  // pointing at.
  window.addEventListener('mousemove', (e) => {
    if (e.isTrusted) {
      realMouse.x = e.clientX;
      realMouse.y = e.clientY;
      realMouse.hasMoved = true;
      updateAimMenuVisibility(e.clientX, e.clientY);
    }
    if (!shiftHeld || !e.isTrusted) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  // Live-tunable auto-quickswap settings. Declared here (rather than beside
  // the auto-quickswap code below) because AIM_MENU_SPECS binds a slider to
  // it and would hit the temporal dead zone otherwise.
  const AUTO_SWAP = {
    // Minimum fireDelay, in seconds, for a gun to be treated as
    // slow-firing. The default sits just under the 0.5s USAS-12 so the
    // set is snipers, pump/semi shotguns, the S&W 500 and the potato
    // cannon — weapons whose post-shot dead time comfortably exceeds a
    // sidearm's switchDelay. Lower it toward 0.3 to also catch the M1014,
    // Saiga-12, SPAS-16 and M1100; raise it to restrict to bolt-actions.
    slowFireThreshold: 0.5,
  };

  // ---------------------------------------------------------------------
  // Top-right settings menu for live-tuning the AIM_HUMAN parameters and
  // the auto-quickswap threshold. Hidden by default; revealed only while
  // the real cursor is in the top-right corner zone (or while the user is
  // dragging one of its controls). Each row is a slider bound to one key
  // on a settings object, so edits take effect on the very next frame.
  // ---------------------------------------------------------------------
  const AIM_MENU_SPECS = [
    { store: AIM_HUMAN, key: 'reactionMs',     label: 'Reaction (ms)',  min: 0,   max: 400,  step: 5,    decimals: 0 },
    { store: AIM_HUMAN, key: 'followFraction', label: 'Follow frac',    min: 0.01, max: 1,    step: 0.01, decimals: 2 },
    { store: AIM_HUMAN, key: 'deadLingerMs',   label: 'Dead linger (ms)', min: 0, max: 2000, step: 50,   decimals: 0 },
    { store: AUTO_SWAP, key: 'slowFireThreshold', label: 'Slow-fire ≥ (s)', min: 0.1, max: 2, step: 0.05, decimals: 2,
      section: 'Auto-quickswap' },
  ];
  // px from the top-right corner within which the menu reveals itself. The
  // zone has to cover the whole panel, or moving the cursor down toward the
  // lowest slider hides the menu before you can grab it — hence the extra
  // height for the auto-quickswap section.
  const AIM_MENU_ZONE_W = 280;
  const AIM_MENU_ZONE_H = 320;
  let aimMenuEl = null;
  let aimMenuInteracting = false; // true while a slider is being dragged

  function ensureAimMenu() {
    if (aimMenuEl && aimMenuEl.isConnected) return aimMenuEl;
    const parent = document.body || document.documentElement;
    if (!parent) return null;
    const panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'width:220px',
      'padding:10px 12px', 'box-sizing:border-box',
      'background:rgba(15,17,22,0.92)', 'color:#e6e6e6',
      'font:12px/1.4 system-ui,sans-serif', 'border:1px solid #3a3f4b',
      'border-radius:8px', 'z-index:2147483647', 'pointer-events:auto',
      'display:none', 'user-select:none', 'box-shadow:0 4px 16px rgba(0,0,0,0.4)'
    ].join(';');
    const title = document.createElement('div');
    title.textContent = 'Aim humanization';
    title.style.cssText = 'font-weight:600;margin-bottom:8px;opacity:0.85';
    panel.appendChild(title);

    for (const spec of AIM_MENU_SPECS) {
      if (spec.section) {
        const heading = document.createElement('div');
        heading.textContent = spec.section;
        heading.style.cssText = 'font-weight:600;margin:12px 0 4px;padding-top:8px;'
          + 'border-top:1px solid #3a3f4b;opacity:0.85';
        panel.appendChild(heading);
      }
      const row = document.createElement('label');
      row.style.cssText = 'display:block;margin:8px 0';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:3px';
      const name = document.createElement('span');
      name.textContent = spec.label;
      const val = document.createElement('span');
      val.style.cssText = 'opacity:0.8;font-variant-numeric:tabular-nums';
      val.textContent = Number(spec.store[spec.key]).toFixed(spec.decimals);
      head.appendChild(name); head.appendChild(val);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(spec.min); slider.max = String(spec.max); slider.step = String(spec.step);
      slider.value = String(spec.store[spec.key]);
      slider.style.cssText = 'width:100%;cursor:pointer;accent-color:#5b9dff';
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        spec.store[spec.key] = v;
        val.textContent = v.toFixed(spec.decimals);
      });
      row.appendChild(head); row.appendChild(slider);
      panel.appendChild(row);
    }

    // Keep the menu open across a drag even if the cursor strays out of the
    // corner zone, and never let menu interaction reach the game canvas.
    panel.addEventListener('mousedown', (e) => { aimMenuInteracting = true; e.stopPropagation(); });
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('wheel', (e) => e.stopPropagation());
    window.addEventListener('mouseup', () => { aimMenuInteracting = false; });

    parent.appendChild(panel);
    aimMenuEl = panel;
    return panel;
  }

  function updateAimMenuVisibility(x, y) {
    const inZone = x >= window.innerWidth - AIM_MENU_ZONE_W && y <= AIM_MENU_ZONE_H;
    const menu = ensureAimMenu();
    if (!menu) return;
    menu.style.display = (inZone || aimMenuInteracting) ? 'block' : 'none';
  }

  // ---------------------------------------------------------------------
  // Auto-quickswap after firing a slow-firerate gun. When the user
  // left-clicks while holding a sniper/shotgun, we synthesize a
  // SwapWeapSlots keydown so the swap fires on the *next* server tick,
  // right after the shot input. The game zeroes `gunSwitchCooldown` on
  // a swap input (server zeros gunSwitchCooldown on SwapWeapSlots), so the other gun is ready
  // to fire as soon as its own switchDelay elapses — materially faster
  // than waiting out the slow gun's fireDelay. Classic two-gun
  // quickswitch.
  // ---------------------------------------------------------------------

  // Every gun's fireDelay in seconds, transcribed from the gun defs in the
  // asset/definitions dump. A weapon counts as slow-firing when its delay
  // is at or above AUTO_SWAP.slowFireThreshold, so this table (not a
  // hand-picked list) decides membership and the threshold slider retunes
  // it live. Static, like GUN_BULLET_SPEED — re-derive when survev ships
  // new guns or rebalances existing ones. Guns absent from the table never
  // auto-swap.
  const GUN_FIRE_DELAY = {
    // SMGs / ARs / LMGs
    mp5: 0.09, mac10: 0.045, ump9: 0.35, vector: 0.038, vector45: 0.044,
    scorpion: 0.055, vss: 0.16, famas: 0.35, hk416: 0.075, m4a1: 0.082,
    mk12: 0.18, l86: 0.19, m249: 0.08, qbb97: 0.1, ak47: 0.1, scar: 0.09,
    an94: 0.24, groza: 0.078, grozas: 0.078, dp28: 0.115, bar: 0.12,
    imbel: 0.092, pkp: 0.1, ash12: 0.1, m1a1: 0.095,
    // DMRs / snipers
    scout_elite: 1, scarssr: 0.3, model94: 0.7, mkg45: 0.17, blr: 0.8,
    mosin: 1.75, sv98: 1.5, awc: 1.5, m39: 0.23, svd: 0.25, garand: 0.23,
    barrett: 0.925,
    // Shotguns
    m870: 0.9, m1100: 0.3, mp220: 0.2, saiga: 0.4, spas12: 0.75,
    spas16: 0.35, m1014: 0.4, usas: 0.5,
    // Pistols
    m9: 0.12, m9_dual: 0.08, m9_cursed: 0.12, m93r: 0.28, m93r_dual: 0.18,
    glock: 0.06, glock_dual: 0.03, p30l: 0.14, p30l_dual: 0.09, ot38: 0.4,
    ot38_dual: 0.2, ots38: 0.36, ots38_dual: 0.18, colt45: 0.12,
    colt45_dual: 0.13, m1911: 0.13, m1911_dual: 0.085, deagle: 0.16,
    deagle_dual: 0.12, sw500: 0.65,
    // Special / event
    flare_gun: 0.4, flare_gun_dual: 0.3, potato_cannon: 1.2,
    potato_smg: 0.09, potato_lmg: 0.07, bugle: 1,
  };

  // Never auto-swap on these, no matter how low the threshold goes.
  // Burst-fire guns would have their remaining shots truncated by a swap
  // mid-burst; the flare gun and bugle are utility items where the user
  // wants the gun they already had, not a quickswitch.
  const AUTO_SWAP_NEVER = new Set([
    'ump9', 'famas', 'm93r', 'm93r_dual', 'an94',
    'flare_gun', 'flare_gun_dual', 'bugle',
  ]);

  function isSlowFireGun(weapon) {
    if (AUTO_SWAP_NEVER.has(weapon)) return false;
    const delay = GUN_FIRE_DELAY[weapon];
    return typeof delay === 'number' && delay >= AUTO_SWAP.slowFireThreshold;
  }

  // Survev collects inputs once per tick (~16ms) and `flush()` advances
  // `keysOld := keys` at end-of-tick. A 30ms gap between the user's
  // mousedown and the swap signal guarantees the Fire input lands on
  // its own tick *before* the SwapWeapSlots input, so the server shoots
  // first and swaps second.
  const AUTO_SWAP_FIRE_TO_SWAP_MS = 30;

  function autoSwapOtherSlotHasGun(me) {
    try {
      const slots = me?.[PLAYER_LOC]?.[LOC_SLOTS];
      const idx = me?.[PLAYER_LOC]?.[LOC_CURIDX];
      if (!Array.isArray(slots) || !Number.isFinite(idx)) return false;
      const other = slots[idx === 0 ? 1 : 0];
      return !!(other && typeof other.type === 'string' && other.type);
    } catch {
      return false;
    }
  }

  // Input enum values from the asset/definitions dump. Stable because
  // these are part of the client/server input protocol.
  const AUTO_SWAP_INPUT_FIRE = 4;
  const AUTO_SWAP_INPUT_EQUIP_MELEE = 13;
  const AUTO_SWAP_INPUT_EQUIP_LAST = 19;
  const AUTO_SWAP_INPUT_EQUIP_OTHER = 20;

  // These inputs have no default keybind in the bundle and no UI-flag
  // analog like SwapWeapSlots does — the bundle only emits them when
  // `game[inputBinds].isBindPressed(N.<Input>)` returns true in
  // the input loop. To trigger one without a bind, we wrap
  // `isBindPressed` and return true for the queued input the next time
  // the input loop polls it — once, then we drop it from the set so we
  // don't keep emitting it on every subsequent tick. Using a Set makes
  // this independent of which keybinds (if any) the user has assigned.
  let autoSwapHookedDmk = null;
  const autoSwapPendingInputs = new Set();

  function autoSwapEnsureHook(binds) {
    if (!binds || binds === autoSwapHookedDmk) return;
    if (typeof binds.isBindPressed !== 'function') return;
    const orig = binds.isBindPressed;
    binds.isBindPressed = function(input) {
      if (autoSwapPendingInputs.has(input)) {
        autoSwapPendingInputs.delete(input);
        return true;
      }
      return orig.call(this, input);
    };
    autoSwapHookedDmk = binds;
  }

  function autoSwapEmitInput(game, input) {
    autoSwapEnsureHook(game?.[GAME_BINDS]);
    autoSwapPendingInputs.add(input);
  }

  // Edge-trigger on the user's Fire bind, whatever key/button that is.
  // `game[inputBinds].isBindDown(4)` is the same source of truth the
  // input loop reads, so this is keybind-agnostic.
  let autoSwapFireWasDown = false;

  function autoSwapOnFirePressed(game) {
    const me = findLocalPlayerOnGame(game);
    if (!me) { console.log('[autoswap] skip: no local player'); return; }
    const weapon = getCurrentWeapon(me);
    if (!weapon) { console.log('[autoswap] skip: no current weapon'); return; }
    if (!isSlowFireGun(weapon)) {
      const delay = GUN_FIRE_DELAY[weapon];
      const why = delay === undefined ? 'unknown fireDelay'
        : AUTO_SWAP_NEVER.has(weapon) ? 'never-swap list'
        : `fireDelay ${delay}s < ${AUTO_SWAP.slowFireThreshold}s threshold`;
      console.log(`[autoswap] skip: ${weapon} — ${why}`);
      return;
    }
    if (autoSwapOtherSlotHasGun(me)) {
      // Two-gun case: swap to the other gun. SwapWeapSlots/EquipOtherGun
      // resets gunSwitchCooldown so the other gun is ready as soon as
      // its own switchDelay elapses — beats waiting out the slow gun's
      // fireDelay.
      console.log(`[autoswap] queued swap after ${weapon} shot`);
      setTimeout(() => autoSwapEmitInput(game, AUTO_SWAP_INPUT_EQUIP_OTHER), AUTO_SWAP_FIRE_TO_SWAP_MS);
    } else {
      // Single-gun case: tap melee then return to the gun via
      // EquipLastWeap. Same gunSwitchCooldown-reset trick — switching
      // to melee cancels the slow gun's post-fire animation, and
      // EquipLastWeap brings us back without depending on which slot
      // index the gun lives in. Stagger the two inputs by one tick
      // each so Fire/EquipMelee/EquipLastWeap each land on their own
      // server tick in order.
      console.log(`[autoswap] queued melee-tap after ${weapon} shot`);
      setTimeout(() => autoSwapEmitInput(game, AUTO_SWAP_INPUT_EQUIP_MELEE), AUTO_SWAP_FIRE_TO_SWAP_MS);
      setTimeout(() => autoSwapEmitInput(game, AUTO_SWAP_INPUT_EQUIP_LAST), AUTO_SWAP_FIRE_TO_SWAP_MS * 2);
    }
  }

  function autoSwapFrameTick() {
    try {
      const game = capturedGame;
      const binds = game?.[GAME_BINDS];
      if (binds && typeof binds.isBindDown === 'function') {
        autoSwapEnsureHook(binds);
        const isDown = !!binds.isBindDown(AUTO_SWAP_INPUT_FIRE);
        if (isDown && !autoSwapFireWasDown) autoSwapOnFirePressed(game);
        autoSwapFireWasDown = isDown;
      } else {
        autoSwapFireWasDown = false;
      }
    } catch {}
    requestAnimationFrame(autoSwapFrameTick);
  }
  requestAnimationFrame(autoSwapFrameTick);

  // ---------------------------------------------------------------------
  // Target overlay: a fixed-position canvas above the game canvas that
  // draws a circle around whichever enemy the cheat is currently aiming
  // at (or *would* aim at if Shift were pressed). Used as a debugging /
  // confidence aid for the red-team work — lets us visually confirm that
  // pickTarget is selecting the enemy we expect under various mouse
  // positions, stickiness windows, and humanization knobs.
  // ---------------------------------------------------------------------

  let overlayCanvas = null;
  let overlayCtx = null;

  // Interpolation state: stores previous positions/velocities per enemy id
  // so the overlay can lerp smoothly between sample ticks.
  let interpPrev = {};   // { [id]: { x, y, xv, yv } }
  let interpCurr = {};   // { [id]: { x, y, xv, yv } }
  let interpT0 = 0;      // performance.now() when interpCurr was captured

  // Interpolation window = a live estimate of how often positions actually
  // update, rather than a fixed constant. survev streams positions at the
  // server tick rate; packets arrive with network jitter and are only
  // observed on our SAMPLE_MS sample boundaries, so the raw inter-arrival
  // time bounces around. We smooth it with a per-update EWMA — weighting
  // every update equally, i.e. *assuming* updates are evenly spaced — so a
  // single late/early packet can't whip the window around and make the
  // overlay jump. The lerp then advances at the typical cadence and reaches
  // `curr` right about when the next packet is due, giving smooth predictions
  // regardless of exactly when each packet lands.
  const UPDATE_EWMA_ALPHA = 0.1;        // ~10-update (~1s) smoothing horizon
  const MIN_INTERP_WINDOW = SAMPLE_MS;  // floor: never lerp faster than we sample
  const MAX_INTERP_WINDOW = 500;        // ceiling: reject huge gaps (tab blur, game swap, join lag)
  let ewmaUpdateMs = 0;                 // EWMA of the update interval (ms); 0 = not yet seeded
  let lastUpdateAt = 0;                 // performance.now() of the previous position update
  let interpWindowMs = SAMPLE_MS;       // window currently used by interpPos (clamped EWMA)

  function updateInterpState(sample) {
    if (!sample || !sample.enemies) return;
    const now = performance.now();
    // Only advance when the sample actually changed (new positions).
    const newMap = {};
    for (const e of sample.enemies) {
      newMap[e.id] = { x: e.x, y: e.y, xv: e.xv ?? 0, yv: e.yv ?? 0 };
    }
    // Add self so player position interpolates too.
    if (sample.self) {
      newMap['__self__'] = {
        x: sample.self.x, y: sample.self.y,
        xv: sample.self.xv ?? 0, yv: sample.self.yv ?? 0,
      };
    }
    // Check if positions actually changed.
    let changed = false;
    for (const id in newMap) {
      const c = interpCurr[id];
      const n = newMap[id];
      if (!c || c.x !== n.x || c.y !== n.y) { changed = true; break; }
    }
    if (!changed && Object.keys(newMap).length === Object.keys(interpCurr).length) return;
    // Fold the time since the previous position update into the cadence EWMA.
    // The raw interval is clamped to [MIN, MAX] so quantization/jitter can't
    // drive the window below our sample rate and a huge gap (tab blur, game
    // swap, join lag) can't poison the average. The first interval seeds the
    // EWMA directly so we don't ramp up slowly from a stale default.
    if (lastUpdateAt) {
      const interval = Math.min(Math.max(now - lastUpdateAt, MIN_INTERP_WINDOW), MAX_INTERP_WINDOW);
      ewmaUpdateMs = ewmaUpdateMs
        ? UPDATE_EWMA_ALPHA * interval + (1 - UPDATE_EWMA_ALPHA) * ewmaUpdateMs
        : interval;
      interpWindowMs = ewmaUpdateMs;
    }
    lastUpdateAt = now;
    interpPrev = interpCurr;
    interpCurr = newMap;
    interpT0 = now;
  }

  // Returns interpolated { x, y, xv, yv } for a given entity id at the
  // current time. Velocity is lerped between prev/curr samples too so
  // consumers (e.g. lead-point prediction) evolve smoothly instead of
  // stepping at sample ticks.
  function interpPos(id, fallbackX, fallbackY) {
    const curr = interpCurr[id];
    const prev = interpPrev[id];
    if (!curr) return { x: fallbackX, y: fallbackY, xv: 0, yv: 0 };
    const win = interpWindowMs > 0 ? interpWindowMs : SAMPLE_MS;
    const elapsed = performance.now() - interpT0;
    const t = Math.min(elapsed / win, 1);
    if (!prev) {
      // No previous data — extrapolate from current using velocity.
      const dt = elapsed / 1000;
      return { x: curr.x + curr.xv * dt, y: curr.y + curr.yv * dt, xv: curr.xv, yv: curr.yv };
    }
    // Lerp from prev to curr, then extrapolate past t=1 with velocity.
    if (t <= 1) {
      return {
        x: prev.x + (curr.x - prev.x) * t,
        y: prev.y + (curr.y - prev.y) * t,
        xv: prev.xv + (curr.xv - prev.xv) * t,
        yv: prev.yv + (curr.yv - prev.yv) * t,
      };
    }
    const overshoot = (elapsed - win) / 1000;
    return {
      x: curr.x + curr.xv * overshoot,
      y: curr.y + curr.yv * overshoot,
      xv: curr.xv,
      yv: curr.yv,
    };
  }

  // Create the overlay element on demand. Returns true if the canvas is
  // attached to the DOM and ready to draw. We re-attach if the SPA has
  // ripped it out (some game UIs nuke unrecognized children of body).
  function ensureOverlayCanvas() {
    const parent = document.body || document.documentElement;
    if (!parent) return false;
    if (!overlayCanvas) {
      overlayCanvas = document.createElement('canvas');
      overlayCanvas.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'width:100vw',
        'height:100vh',
        'pointer-events:none',
        'z-index:2147483647'
      ].join(';');
      overlayCtx = overlayCanvas.getContext('2d');
    }
    if (overlayCanvas.width !== window.innerWidth) overlayCanvas.width = window.innerWidth;
    if (overlayCanvas.height !== window.innerHeight) overlayCanvas.height = window.innerHeight;
    if (!overlayCanvas.isConnected) parent.appendChild(overlayCanvas);
    return true;
  }

  window.addEventListener('resize', () => {
    if (overlayCanvas) {
      overlayCanvas.width = window.innerWidth;
      overlayCanvas.height = window.innerHeight;
    }
  });

  // Find the enemy that the cheat is currently locked onto, OR — when Shift
  // isn't held — the enemy that *would* be picked right now if Shift were
  // pressed. This intentionally bypasses stickiness in the preview path so
  // the circle tracks the user's mouse in real time before they engage.
  function getCurrentAimTarget(sample) {
    if (!sample) return null;
    const player = sample.self;
    const enemies = sample.enemies;
    if (!enemies || !enemies.length) return null;

    if (shiftHeld && aimState.targetId != null) {
      const committed = enemies.find((e) => e.id === aimState.targetId);
      if (committed && !committed.dead && canInteract(player.layer, committed.layer)) return committed;
    }

    // Otherwise compute fresh best-by-mouse-distance with no commitment.
    const scale = getLivePxPerWorldUnit(sample);
    let mwx, mwy;
    if (realMouse.hasMoved) {
      mwx = player.x + (realMouse.x - window.innerWidth / 2) / scale;
      mwy = player.y - (realMouse.y - window.innerHeight / 2) / scale;
    } else {
      mwx = player.x;
      mwy = player.y;
    }
    let best = null;
    let bestScore = Infinity;
    for (const e of enemies) {
      if (e.dead) continue;
      if (e.name === "VERY BAD AT GAME") continue;
      if (isSpoofedEnemy(e.id, pageSamples)) continue;
      if (!canInteract(player.layer, e.layer)) continue;
      const dx = e.x - mwx;
      const dy = e.y - mwy;
      const s = dx * dx + dy * dy;
      if (s < bestScore) {
        bestScore = s;
        best = e;
      }
    }
    return best;
  }

  function overlayFrame() {
    if (!ensureOverlayCanvas()) {
      requestAnimationFrame(overlayFrame);
      return;
    }
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const sample = pageSamples[pageSamples.length - 1];
    if (sample && sample.self && sample.enemies && sample.enemies.length) {
      const player = sample.self;
      // Interpolated player position for smooth camera.
      const pi = interpPos('__self__', player.x, player.y);
      const scale = getLivePxPerWorldUnit(sample);
      // Survev player hitbox is ~1 world unit; 1.6× makes the ring sit just
      // outside the body sprite at default zoom.
      const radius = scale * 1.6;
      const target = getCurrentAimTarget(sample);
      const targetId = target ? target.id : null;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;

      // Draw a ring around every live enemy so the user can see threats at a
      // glance. The current aim target is drawn last in green so it stays on top.
      // Downed players get a yellow ring. Enemies on a layer we can't reach
      // (e.g. they're in a bunker while we're aboveground) are dimmed to
      // alpha=0.5 to signal that they're not lockable.
      for (const e of sample.enemies) {
        if (e.dead) continue;
        if (isSpoofedEnemy(e.id, pageSamples)) continue;
        if (e.id === targetId) continue;
        const ei = interpPos(e.id, e.x, e.y);
        const sx = cx + (ei.x - pi.x) * scale;
        const sy = cy - (ei.y - pi.y) * scale;
        const reachable = canInteract(player.layer, e.layer);
        const colorRgb = e.downed ? '255, 220, 40' : '255, 60, 60';
        const ringAlpha = reachable ? 1 : 0.5;
        const lineAlpha = reachable ? 0.6 : 0.3;
        const ringColor = `rgba(${colorRgb}, ${ringAlpha})`;
        const lineColor = `rgba(${colorRgb}, ${lineAlpha})`;
        ctx.lineWidth = 4;
        ctx.strokeStyle = ringColor;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.stroke();

        // Line from player (center) to enemy
        ctx.lineWidth = 3;
        ctx.strokeStyle = lineColor;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }

      if (target) {
        const ti = interpPos(target.id, target.x, target.y);
        const sx = cx + (ti.x - pi.x) * scale;
        const sy = cy - (ti.y - pi.y) * scale;

        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(64, 255, 89, 0.95)';
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.stroke();

        // Line from player (center) to aim target
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(64, 255, 89, 0.55)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sx, sy);
        ctx.stroke();

        // Small crosshair tick at center for unambiguous "this enemy" indication.
        ctx.beginPath();
        ctx.moveTo(sx - 4, sy);
        ctx.lineTo(sx + 4, sy);
        ctx.moveTo(sx, sy - 4);
        ctx.lineTo(sx, sy + 4);
        ctx.stroke();

        // Aim-assist X: lead point accounting for bullet travel time and
        // target velocity. Only meaningful when the player holds a projectile
        // weapon with a known bullet speed.
        const selfBulletSpeed = player.bulletSpeed;
        if (selfBulletSpeed && selfBulletSpeed > 0) {
          const tvx = ti.xv ?? 0;
          const tvy = ti.yv ?? 0;
          const dxw = ti.x - pi.x;
          const dyw = ti.y - pi.y;
          const distW = Math.sqrt(dxw * dxw + dyw * dyw);
          const tHit = distW / selfBulletSpeed;
          const ax = ti.x + tvx * tHit;
          const ay = ti.y + tvy * tHit;
          const axs = cx + (ax - pi.x) * scale;
          const ays = cy - (ay - pi.y) * scale;
          const xSize = 10;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.beginPath();
          ctx.moveTo(axs - xSize, ays - xSize);
          ctx.lineTo(axs + xSize, ays + xSize);
          ctx.moveTo(axs + xSize, ays - xSize);
          ctx.lineTo(axs - xSize, ays + xSize);
          ctx.stroke();
        }
      }

      // Actual aimbot aim location: the world-space point the bot is currently
      // steering the crosshair toward (aimState.aimX/aimY). This is the genuine
      // post-humanization aim that dispatchAim derives theta from and sends to
      // the game each frame — distinct from the white lead-X above, which is an
      // idealized instantaneous lead point recomputed in the overlay. aimState
      // is non-null only while Shift is held and a target is engaged, so this
      // reticle appears exactly when the bot is actively aiming.
      if (aimState.aimX != null && aimState.aimY != null) {
        const axs = cx + (aimState.aimX - pi.x) * scale;
        const ays = cy - (aimState.aimY - pi.y) * scale;
        const reticle = 12;
        const tick = 5;
        const aimColor = 'rgba(0, 229, 255, 0.95)';

        // Thin guide line from player (center) to the aim point.
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(axs, ays);
        ctx.stroke();

        // Reticle ring.
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = aimColor;
        ctx.beginPath();
        ctx.arc(axs, ays, reticle, 0, Math.PI * 2);
        ctx.stroke();

        // Crosshair ticks straddling the ring.
        ctx.beginPath();
        ctx.moveTo(axs - reticle - tick, ays); ctx.lineTo(axs - reticle + tick, ays);
        ctx.moveTo(axs + reticle - tick, ays); ctx.lineTo(axs + reticle + tick, ays);
        ctx.moveTo(axs, ays - reticle - tick); ctx.lineTo(axs, ays - reticle + tick);
        ctx.moveTo(axs, ays + reticle - tick); ctx.lineTo(axs, ays + reticle + tick);
        ctx.stroke();

        // Center dot.
        ctx.fillStyle = aimColor;
        ctx.beginPath();
        ctx.arc(axs, ays, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    requestAnimationFrame(overlayFrame);
  }
  requestAnimationFrame(overlayFrame);

  // Capture-path diagnostics. `appCaptured: false` means the bind hook never
  // saw the app singleton — that's the failure mode to investigate. Exposed
  // as a devtools global (same idiom as `window.__aimHuman`) because this
  // build has no frozen exports object to hang it off; call
  // `window.__captureDiag()` from the console.
  window.__captureDiag = () => ({
    appCaptured: !!capturedApp,
    appHasGame: !!(capturedApp && safeRead(capturedApp, 'game')),
    gameCaptured: !!capturedGame,
    rootName: lastFound?.rootName || null,
    bindHook: { ...bindHookState },
    trap: {
      installedNames: Array.from(trapState.installed),
      extraCandidatesAdded: trapState.candidatesAdded,
      discoveryStatus: trapState.discoveryStatus,
      pendingCandidatesRemaining: trapState.pendingCandidates.length
    }
  });

  post('status', { ok: true, message: 'Injector loaded.', url: location.href, isTop: window.top === window });
  // console.log(`[${SOURCE}] inject.js TAIL reached, starting sampleLoop @ ${SAMPLE_MS}ms`);
  setInterval(sampleLoop, SAMPLE_MS);
})();
