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
  const GAME_CAMERA  = M.game.camera;
  const CAM_INTERP_W = M.camera?.interpWindow;
  const CAM_INTERP_ON = M.camera?.interpEnabled;
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
    // Cheap no-op once attached; survev's menu markup is static, so this only
    // does work on the first tick and after any rebuild.
    try { ensureElgTab(); } catch {}
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

    // Keep the render-smoothing hooks attached to the live Game. Runs before
    // buildSample so a match that is still missing a roster/local player (the
    // lobby, the first moments of a round) still gets its camera hooked.
    netcodeTick(found.game);
    try { updatePingUI(found.game, now); } catch {}

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

  // Hold-to-aim. While the aimbot key is held, real mousemove events are
  // swallowed at the capture phase and a solved screen-space aim point
  // is dispatched to the canvas every animation frame. Survev keeps the
  // local player viewport-centered and derives aim from
  // (mouseScreenPos − playerScreenPos), so a screen-space offset translates
  // directly into world-space aim direction.
  let aimHeld = false;
  let aimRafId = 0;
  const AIM_CURSOR_RADIUS = 400; // pixels from viewport center; well outside the player

  // Aimbot master switch and activation key. The bind is stored the way survev
  // stores its own — a legacy `KeyboardEvent.keyCode` — so the row can share
  // its markup, its naming and its capture rules; `null` means unbound, which
  // is what Backspace does on survev's rows and is equivalent to switching the
  // aimbot off. Declared up here, rather than beside the settings panel,
  // because SETTINGS_SPECS binds rows to it and would hit the temporal dead
  // zone. Off by default: the cheats stay inert until they are turned on in
  // the MOD tab, so a fresh profile plays as stock survev.
  const AIMBOT = {
    enabled: 0,
    bind: 16, // Shift. keyCode doesn't distinguish left from right, so both work.
  };

  // Enemy overlay master switch. Same hoisting reason, same default, as AIMBOT.
  const ESP = {
    enabled: 0,
  };

  // True while the MOD tab is waiting for the user to press their new bind, so
  // the handlers below don't treat that press as an activation. Both listeners
  // are capture-phase on window and ours is registered first (at load), so the
  // flag is the only thing that can keep them apart.
  let bindCapture = false;

  // keyCode → display name, transcribed from the bundle's own table so our row
  // reads exactly like survev's ("ESC", "Space", "←", "Numpad 1"). Letters,
  // digits, numpad digits and function keys are derived instead of listed —
  // the table's entries across those ranges are just the obvious name — and
  // anything unlisted falls back to `Key <code>`, which is its fallback too.
  const KEY_NAMES = {
    8: 'Backspace', 9: 'Tab', 12: 'Clear', 13: 'Enter', 16: 'Shift', 17: 'Control',
    18: 'Alt', 19: 'Pause', 20: 'Capslock', 27: 'ESC', 32: 'Space', 33: 'Page Up',
    34: 'Page Down', 35: 'End', 36: 'Home', 37: '←', 38: '↑', 39: '→', 40: '↓',
    41: 'Select', 42: 'Print', 43: 'Execute', 44: 'Printscreen', 45: 'Insert',
    46: 'Delete', 91: 'Windows Key', 93: 'Context Menu', 95: 'Sleep', 106: '*',
    107: '+', 108: 'Separator', 109: '-', 110: '.', 111: '/', 144: 'Num Lock',
    145: 'Scroll Lock', 186: ';', 187: '=', 188: ',', 189: '-', 190: '.',
    191: '/', 192: 'Backquote', 219: '[', 220: '\\', 221: ']', 222: "'",
    224: 'Meta',
  };

  function keyName(code) {
    if (code == null) return '';
    if (code >= 48 && code <= 57) return String(code - 48);
    if (code >= 65 && code <= 90) return String.fromCharCode(code);
    if (code >= 96 && code <= 105) return `Numpad ${code - 96}`;
    if (code >= 112 && code <= 123) return `F${code - 111}`;
    return KEY_NAMES[code] || `Key ${code}`;
  }

  // Keys survev refuses to bind: bare modifiers that never arrive alone in a
  // usable way, the OS menu keys, and the function row. Pressing one leaves
  // the row armed rather than binding it, exactly as in the Keybinds tab.
  const UNBINDABLE = new Set([17, 18, 91, 93, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123]);
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
    followFraction: 0.3,
    // After an enemy dies it stays lockable (acts alive) for this many ms,
    // so its corpse/last position can still be aimed at briefly.
    deadLingerMs: 600,
    // How much of the measured round trip to lead by, as a fraction. The state
    // we can see is one one-way delay old and a shot fired now arrives one
    // one-way delay later, so an un-compensated server resolves the shot
    // against a world a full RTT ahead of anything on screen — hence 1. Drop
    // to 0 against a server that rewinds (lag compensation), where the shot is
    // judged against the world we actually saw and any ping lead is overshoot.
    pingLeadK: 1,
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

    // Score against where each enemy is on the clock, not where the last
    // sample caught them: the user aims at the sprite, and the sprite is drawn
    // from the clock.
    const scoreOf = (e) => {
      const p = livePos(e.id, e);
      const dx = p.x - mouseWorldX;
      const dy = p.y - mouseWorldY;
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

  // The snapshot pair on the recovered server clock (the netcode section
  // below) that brackets pseudotime `tMs`: the two points p1@t1, p2@t2 that
  // the target's motion is believed to run through, in the same timebase and
  // off the same per-tick rings the renderer draws from.
  //
  // The aim path reads these rather than the 20ms sample ring because the
  // sample ring is the wrong instrument for motion. Positions arrive at the
  // server tick rate (~20Hz) and we sample them every SAMPLE_MS, so most
  // sample gaps see the position unchanged and the occasional one sees a whole
  // tick of movement at once: any velocity differenced from that is a comb —
  // runs of zero punched through by spikes of 2-3x true speed — and every lead
  // point built from it inherits the spikes. A snapshot pair spans exactly one
  // tick of real motion over an exactly-known interval, with the arrival
  // jitter already taken out by the clock fit.
  //
  // Returns null when the clock has not converged, the id has no ring, the
  // ring belongs to a different (recycled) entity, or it has gone stale —
  // callers fall back to the sample path.
  function clockPairAt(id, tMs) {
    if (!netClock.ready) return null;
    const st = netSnapsById.get(id);
    if (!st || st.id !== id) return null;
    const s = st.snaps;
    if (!s || s.length < 2) return null;
    // A ring that stopped being written is a player the server is no longer
    // streaming to us; extending its line would walk a ghost across the map.
    // NET_SNAP_CAP ticks is ~400ms at 20Hz.
    if (netClock.n - 1 - s[s.length - 1].n > NET_SNAP_CAP) return null;
    let i = s.length - 2;
    while (i > 0 && pseudotimeOf(s[i].n) > tMs) i--;
    const p1 = s[i];
    const p2 = s[i + 1];
    const t1 = pseudotimeOf(p1.n);
    const t2 = pseudotimeOf(p2.n);
    if (t1 === t2) return null;
    return { p1, p2, t1, t2 };
  }

  // Evaluate a pair at any pseudotime:
  //
  //     p1 * (t - t2)/(t1 - t2) + p2 * (t1 - t)/(t1 - t2)
  //
  // the same unclamped two-point lerp renderOnClock draws with, so a `t` past
  // t2 continues the line the renderer is already extending rather than
  // stopping at the last thing the server said. Asking for a *future* t is
  // what makes this the aim primitive: the point we want to shoot at is the
  // target's position at the pseudotime the bullet gets there.
  function pairAt(pair, tMs) {
    const d = pair.t1 - pair.t2;
    const w1 = (tMs - pair.t2) / d;
    const w2 = (pair.t1 - tMs) / d;
    return {
      x: pair.p1.x * w1 + pair.p2.x * w2,
      y: pair.p1.y * w1 + pair.p2.y * w2,
    };
  }

  // Position + velocity on the clock at `tMs`, for callers that want a state
  // rather than a line (target selection, the overlay, diagnostics).
  function stateOnClock(id, tMs) {
    const pair = clockPairAt(id, tMs);
    if (!pair) return null;
    const p = pairAt(pair, tMs);
    const perSec = 1000 / (pair.t2 - pair.t1);
    p.xv = (pair.p2.x - pair.p1.x) * perSec;
    p.yv = (pair.p2.y - pair.p1.y) * perSec;
    return p;
  }

  // Where an entity is *as drawn* — render time, not true clock time, so this
  // answers "what is under the cursor" against the sprite the user is actually
  // looking at. Falls back to the position carried by the sample.
  function livePos(id, fallback) {
    return stateOnClock(id, renderNowMs()) || fallback;
  }

  // The local player as drawn. The game centres the camera on the rendered
  // position, and every screen↔world conversion in the aim path is relative to
  // that centre, so this has to be on render time too — the sampled position
  // is up to a sample old, and true clock time is half a tick ahead of the
  // camera. The shot's own origin is solved separately, on true time.
  function liveSelf(sample) {
    const self = sample?.self;
    if (!self || self.id == null) return self;
    const s = stateOnClock(self.id, renderNowMs());
    return s ? { ...self, x: s.x, y: s.y, xv: s.xv, yv: s.yv } : self;
  }

  // The world point perfect aim wants the shot to go through, and the point it
  // has to be aimed *from*.
  //
  // Both sides of the shot are read off the clock at the pseudotime they
  // actually happen at, rather than being extrapolated by hand:
  //
  //   the shot spawns at   t_now + ping   — the input we send now reaches the
  //                                         server one one-way delay later,
  //                                         and the state we are looking at
  //                                         already left it one one-way delay
  //                                         ago, so the world the server
  //                                         resolves the shot in is a full
  //                                         round trip ahead of this frame;
  //   it connects at       t_now + ping + travel.
  //
  // So with the target's line running through p1@t1 and p2@t2, perfect aim is
  // that line evaluated at `t_now + ping + travel`:
  //
  //     p1 * (T - t2)/(t1 - t2) + p2 * (t1 - T)/(t1 - t2),  T = t_now+ping+travel
  //
  // and the origin is our own line evaluated at `t_now + ping` — spawn time,
  // not impact time: the bullet leaves when the input lands, and where we walk
  // during its flight cannot change where it was fired from.
  //
  // `travel` depends on the answer, so it is solved by fixed-point iteration.
  // Each pass shrinks the residual by the target-to-bullet speed ratio (~0.12
  // for a sprinting player and a mid-tier gun), so three passes land within a
  // few millimetres against a ~1 unit player radius.
  //
  // reactionMs is latency, not a shorter lead — it is fake ping, and is
  // carried alongside the real one. A human reacting late is acting on a view
  // of the world reactionMs old, and pays for that by having to lead
  // reactionMs further, so the two moves cancel on a target holding a constant
  // velocity and only a *change* in its motion is picked up late. Both halves
  // are needed: delaying the view without extending the lead would aim behind
  // every moving target, and extending the lead without delaying the view
  // would aim past it. Written out, the viewpoint is
  //
  //     t_v  = t_now - reactionMs
  //
  // and the lead from it is `reactionMs + ping + travel`, which puts the
  // evaluation back at t_now + ping + travel — the shot's real impact time,
  // reached with information we are only allowed to have had reactionMs ago.
  // At reactionMs = 0 the viewpoint is now, the pair is the newest, and the
  // expression above is exactly perfect aim.
  //
  // pingLeadK scales the round trip, and `player` is the local player's sample
  // (its id is what puts our own line on the clock; x/y are the fallback).
  function reactionTarget(player, enemy, now) {
    const tNow = performance.now();
    const pingMs = AIM_HUMAN.pingLeadK ? (medianPingMs() ?? 0) * AIM_HUMAN.pingLeadK : 0;
    const bulletSpeed = player.bulletSpeed ?? 1e8;
    const viewMs = tNow - AIM_HUMAN.reactionMs;      // what we let ourselves know
    const leadMs = AIM_HUMAN.reactionMs + pingMs;    // and what that costs us

    const pair = clockPairAt(enemy.id, viewMs);
    // Off-clock fallback, for a clock that cannot answer yet: the sample ring's
    // state at the same viewpoint, carried forward on the velocity perceived
    // there. Same timeline, coarser instrument.
    const seen = pair ? null : (enemyStateAt(enemy.id, now - AIM_HUMAN.reactionMs)
      || { x: enemy.x, y: enemy.y, xv: enemy.xv ?? 0, yv: enemy.yv ?? 0 });
    const at = pair
      ? (travelMs) => pairAt(pair, viewMs + leadMs + travelMs)
      : (travelMs) => {
        const d = (leadMs + travelMs) / 1000;
        return { x: seen.x + seen.xv * d, y: seen.y + seen.yv * d };
      };

    // Our own line is taken at the newest pair rather than the delayed
    // viewpoint: reaction time is a limit on tracking a target, not on knowing
    // where we ourselves are standing. It is still evaluated at spawn time,
    // which is the same instant either way.
    const selfPair = player.id != null ? clockPairAt(player.id, tNow) : null;
    const from = selfPair
      ? pairAt(selfPair, viewMs + leadMs)
      : { x: player.x, y: player.y };

    let hit = at(0);
    for (let i = 0; i < 3; i++) {
      const travelMs = Math.hypot(hit.x - from.x, hit.y - from.y) / bulletSpeed * 1000;
      hit = at(travelMs);
    }
    return { x: hit.x, y: hit.y, fromX: from.x, fromY: from.y };
  }

  function dispatchAim() {
    const target = document.querySelector('canvas') || document.body;
    if (!target) return;
    if (!pageSamples.length) return;

    const last_sample = pageSamples[pageSamples.length - 1];
    const player = liveSelf(last_sample);
    const enemies = last_sample.enemies;
    if (!player) return;

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
      // Bearing from where the shot will actually be fired from, not from
      // where we are drawn this frame — the game only ever gets the direction,
      // and the server pairs it with our position at the moment the input
      // lands. Over a 100ms round trip at full sprint those two origins are a
      // world unit apart, which is a couple of degrees at duel range.
      aimState.theta = Math.atan2(aimState.aimY - tgt.fromY, aimState.aimX - tgt.fromX);
    } else {
      aimState.targetId = null;
    }

    const x = Math.round(window.innerWidth / 2 + Math.cos(aimState.theta) * AIM_CURSOR_RADIUS);
    const y = Math.round(window.innerHeight / 2 - Math.sin(aimState.theta) * AIM_CURSOR_RADIUS);
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

  function aimFrame() {
    // Switching the aimbot off mid-hold drops the hold here rather than
    // leaving the loop spinning until the key comes up.
    if (!aimHeld || !AIMBOT.enabled) { releaseAim(); return; }
    dispatchAim();
    aimRafId = requestAnimationFrame(aimFrame);
  }

  // Drop the hold and every bit of state it accumulated. Also called when the
  // bind changes out from under a held key, where no keyup for the old bind is
  // ever going to arrive.
  function releaseAim() {
    aimHeld = false;
    if (aimRafId) { cancelAnimationFrame(aimRafId); aimRafId = 0; }
    aimState.targetId = null;
    aimState.aimX = null;
    aimState.aimY = null;
    aimState.lastFrameAt = 0;
  }

  window.addEventListener('keydown', (e) => {
    if (bindCapture || !AIMBOT.enabled || AIMBOT.bind == null || e.keyCode !== AIMBOT.bind) return;
    if (!aimHeld) {
      aimHeld = true;
      // Fresh hold: drop the prior aim point so dispatchAim re-seeds the glide
      // from wherever the user's real cursor currently points.
      aimState.aimX = null;
      aimState.aimY = null;
      aimState.lastFrameAt = 0;
      if (!aimRafId) aimRafId = requestAnimationFrame(aimFrame);
    }
    // Suppress the browser's default behavior for the bind so it doesn't steal
    // focus from the canvas.
    e.preventDefault();
  }, true);

  window.addEventListener('keyup', (e) => {
    if (AIMBOT.bind == null || e.keyCode !== AIMBOT.bind) return;
    releaseAim();
  }, true);

  // Capture-phase mousemove suppressor: while the aimbot key is held, drop any real
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
    }
    if (!aimHeld || !e.isTrusted) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  // Live-tunable auto-quickswap settings. Declared here (rather than beside
  // the auto-quickswap code below) because SETTINGS_SPECS binds a slider to it
  // and would hit the temporal dead zone otherwise.
  const AUTO_SWAP = {
    enabled: 0,        // master switch; 0 = never synthesize a swap
    // Minimum fireDelay, in seconds, for a gun to be treated as
    // slow-firing. The default sits just under the 0.5s USAS-12 so the
    // set is snipers, pump/semi shotguns, the S&W 500 and the potato
    // cannon — weapons whose post-shot dead time comfortably exceeds a
    // sidearm's switchDelay. Lower it toward 0.3 to also catch the M1014,
    // Saiga-12, SPAS-16 and M1100; raise it to restrict to bolt-actions.
    slowFireThreshold: 0.5,
  };

  // Live-tunable netcode-smoothing settings — hoisted up here for the same
  // temporal-dead-zone reason as AUTO_SWAP. What each knob does, and why the
  // smoothing is needed at all, is documented at the netcode section below.
  const NETCODE = {
    enabled: 1,        // master switch; 0 = stock survev behaviour
    // Window handed to survev's own lerp for everything that is NOT a player
    // — loot, obstacles, projectiles, the gas circle — as
    // `mean gap + jitterK * mean-abs-deviation`. Players bypass that lerp
    // entirely and render on the recovered clock instead, so this only ever
    // affects those other entities. Kept small because a window wider than the
    // real gap leaves each lerp unfinished, which is its own discontinuity.
    jitterK: 0.5,
    // Weight half-life of the clock regression, in packets (~5s at 20Hz).
    // Deliberately long: we are recovering a clock, and the whole point is
    // that individual arrivals barely move it.
    clockHalfLife: 100,
    // Playout delay, in ticks: the render is taken at `t_now - renderLag *
    // tick` instead of at t_now. Half a tick is the natural setting — the
    // newest snapshot's pseudotime is on average half a tick old by the time
    // any given frame renders, so this is the offset that centres the render
    // on the data instead of leaning permanently past its end. 0 restores
    // rendering at t_now (pure extrapolation, lowest latency, worst overshoot
    // on turns and stops); netcode_sim.js measures the trade either way. Aim
    // is unaffected — it solves on true clock time, not render time.
    renderLag: 0.5,
  };

  // Ping readout shown above the team panel. Hoisted for the same
  // temporal-dead-zone reason as AUTO_SWAP and NETCODE.
  const PING_UI = {
    enabled: 1,
  };

  // ---------------------------------------------------------------------
  // Settings UI, injected as a third tab in survev's own Escape menu next to
  // Settings and Keybinds.
  //
  // survev's menu is plain DOM: `#btn-game-tabs` holds one `.btn-game-tab-select`
  // per tab, each pane is a `#ui-game-tab-<name>.ui-game-tab`, and switching
  // does
  //     gameTabs.css('display','none'); gameTabBtns.removeClass('btn-game-menu-selected');
  //     $('#ui-game-tab-' + tab).css('display','block');
  //     $('#btn-game-' + tab).addClass('btn-game-menu-selected');
  //
  // The catch is that `gameTabs`/`gameTabBtns` are jQuery collections captured
  // once when the Game is constructed, so anything injected afterwards is
  // invisible to them: survev would neither hide our pane when switching away
  // nor fire its handler for our button. So we run our own switching logic
  // over live queries. Once a new round re-runs init() our elements *are* in
  // its collections and it drives them natively — both paths converge on the
  // same DOM state, so it doesn't matter which is in charge.
  //
  // Everything is built from survev's own classes so it looks native, and the
  // pane is re-attached on demand because the menu markup can be rebuilt.
  // ---------------------------------------------------------------------

  // One row per tunable. `kind: 'toggle'` renders a button, `kind: 'keybind'` a
  // survev-style keybind row, anything else a slider; `section` starts a new
  // heading above the row. `id` is the settled name the value is persisted
  // under, so renaming a store or a field doesn't silently orphan saved values.
  const SETTINGS_SPECS = [
    { id: 'aimbot.enabled', store: AIMBOT, key: 'enabled', label: 'Aimbot', kind: 'toggle',
      section: 'Aimbot' },
    { id: 'aimbot.bind',  store: AIMBOT, key: 'bind', label: 'Aimbot key', kind: 'keybind' },
    { id: 'esp.enabled',  store: ESP,    key: 'enabled', label: 'ESP overlay', kind: 'toggle',
      section: 'ESP' },
    { id: 'aim.reactionMs',     store: AIM_HUMAN, key: 'reactionMs',     label: 'Reaction',  unit: 'ms', min: 0,    max: 400,  step: 5,    decimals: 0,
      section: 'Aim humanization' },
    { id: 'aim.followFraction', store: AIM_HUMAN, key: 'followFraction', label: 'Follow',                min: 0.01, max: 1,    step: 0.01, decimals: 2 },
    { id: 'aim.deadLingerMs',   store: AIM_HUMAN, key: 'deadLingerMs',   label: 'Linger',    unit: 'ms', min: 0,    max: 2000, step: 50,   decimals: 0 },
    { id: 'aim.pingLeadK',      store: AIM_HUMAN, key: 'pingLeadK',      label: 'Ping lead',             min: 0,    max: 1.5,  step: 0.05, decimals: 2 },
    { id: 'swap.enabled',       store: AUTO_SWAP, key: 'enabled',        label: 'Auto-quickswap', kind: 'toggle',
      section: 'Auto-quickswap' },
    { id: 'swap.slowFire',      store: AUTO_SWAP, key: 'slowFireThreshold', label: 'Slow-fire', unit: 's', min: 0.1, max: 2,   step: 0.05, decimals: 2 },
    { id: 'net.enabled',        store: NETCODE,   key: 'enabled',        label: 'Smoothing', kind: 'toggle',
      section: 'Netcode smoothing' },
    { id: 'net.jitterK',        store: NETCODE,   key: 'jitterK',        label: 'Jitter buf',            min: 0,    max: 5,    step: 0.1,  decimals: 1 },
    { id: 'net.clockHalfLife',  store: NETCODE,   key: 'clockHalfLife',  label: 'Clock',     unit: ' pkt', min: 5,  max: 400,  step: 5,    decimals: 0 },
    { id: 'net.renderLag',      store: NETCODE,   key: 'renderLag',      label: 'Playout',   unit: ' tick', min: 0, max: 2,   step: 0.05, decimals: 2 },
    { id: 'hud.ping',           store: PING_UI,   key: 'enabled',        label: 'Ping readout', kind: 'toggle',
      section: 'HUD' },
  ];

  // ---------------------------------------------------------------------
  // Persistence. Everything in SETTINGS_SPECS is written to localStorage on
  // change and restored at load, under our own key — survev keeps its config
  // in `surviv_config` and we stay out of it.
  //
  // Values are validated on the way back in rather than trusted: the store
  // objects are read every frame by the aim, netcode and overlay paths, and a
  // hand-edited or stale entry that put a NaN in one of them would be a
  // silent, permanent breakage with no obvious cause. Anything that fails its
  // spec is dropped and the coded default stands.
  // ---------------------------------------------------------------------
  const SETTINGS_STORAGE_KEY = 'elg_settings';

  function saveSettings() {
    try {
      const out = {};
      for (const spec of SETTINGS_SPECS) out[spec.id] = spec.store[spec.key];
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(out));
    } catch {}
  }

  function loadSettings() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    } catch { return; }
    if (!saved || typeof saved !== 'object') return;
    for (const spec of SETTINGS_SPECS) {
      if (!(spec.id in saved)) continue;
      const v = saved[spec.id];
      if (spec.kind === 'keybind') {
        // null is a real value here — it is what an unbound row saves as.
        if (v === null) { spec.store[spec.key] = null; continue; }
        if (Number.isInteger(v) && v >= 0 && v <= 255 && !UNBINDABLE.has(v)) spec.store[spec.key] = v;
      } else if (spec.kind === 'toggle') {
        if (v === 0 || v === 1) spec.store[spec.key] = v;
      } else if (Number.isFinite(v)) {
        // Clamp instead of reject: a value outside the current range is what a
        // retuned slider leaves behind, and the nearest legal value is what the
        // user would get by dragging to the end anyway.
        spec.store[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
      }
    }
  }

  loadSettings();

  const ELG_TAB = 'elg';
  const ELG_TAB_BTN_ID = `btn-game-${ELG_TAB}`;
  const ELG_TAB_PANE_ID = `ui-game-tab-${ELG_TAB}`;
  const ELG_LIST_ID = `ui-${ELG_TAB}-list`;
  const ELG_STYLE_ID = `${ELG_TAB}-style`;
  const ELG_LIST_MIN_H = 295; // survev's keybind-list height; see ELG_STYLE below

  // survev's stylesheet only targets its own two tabs by id, so ours gets an
  // equivalent rule rather than inheriting one. Values are copied from the
  // shipped CSS so the tab is dimensionally identical to the others:
  //
  //   #ui-game-tab-keybinds>#ui-keybind-list { pointer-events:all; height:295px; overflow-y:scroll }
  //
  // Keybinds is the model rather than Settings because Settings gets its height
  // from `ui-game-tab-settings-desktop`, a class the bundle adds and removes as
  // the layout switches between desktop and mobile — copying that would mean
  // tracking the layout too. Keybinds sizes its inner list unconditionally.
  //
  // 295px is the floor, not the final height: fitElgPane measures the box on
  // show and grows the list until "Return to Game" lands on the bottom edge.
  //
  // `pointer-events:all` is load-bearing: the whole `#ui-game` HUD is
  // click-through, so a pane that doesn't opt back in cannot be scrolled or
  // clicked at all.
  //
  // The slider rows themselves get no rules at all: they use survev's exact
  // markup, so `.ui-slider-container > p { width:75px }` and
  // `.ui-slider-container > .slider { width:260px }` style them identically to
  // the volume sliders. That 75px label column wraps to two lines for survev's
  // own labels too, which is why ours are kept to a comparable length rather
  // than the column being widened — widening it is what made them stop
  // matching.
  const ELG_STYLE = `
    #${ELG_TAB_PANE_ID} > #${ELG_LIST_ID} {
      pointer-events: all;
      height: ${ELG_LIST_MIN_H}px;
      overflow-y: scroll;
      /* Belt-and-braces against the same promotion: nothing in the pane is
         wider than the track, so clipping here can only ever hide a stray
         pixel, never content. */
      overflow-x: hidden;
    }
    #${ELG_LIST_ID} .elg-heading {
      display: block;
      width: auto;
      margin: 14px 0 2px;
      font-size: 12px;
      opacity: 0.75;
      text-transform: uppercase;
      /* #ui-game-menu p nudges labels up by 4px to sit beside their slider;
         a block heading has no slider to line up with. */
      bottom: 0;
    }
    #${ELG_LIST_ID} .elg-heading:first-child { margin-top: 0; }
    /* Tab buttons are 30px tall but #btn-game-tabs sets line-height:36px,
       which is invisible on survev's icon-only tabs and off-centre on ours. */
    #${ELG_TAB_BTN_ID} { line-height: 30px; }
  `;

  function ensureElgStyles() {
    if (document.getElementById(ELG_STYLE_ID)) return;
    const head = document.head || document.documentElement;
    if (!head) return;
    const style = document.createElement('style');
    style.id = ELG_STYLE_ID;
    style.textContent = ELG_STYLE;
    head.appendChild(style);
  }

  // Show the named tab and hide every other one, using live queries so our
  // injected pane participates.
  function elgSelectTab(tab) {
    document.querySelectorAll('.ui-game-tab').forEach((el) => {
      el.style.display = el.id === `ui-game-tab-${tab}` ? 'block' : 'none';
    });
    document.querySelectorAll('.btn-game-tab-select').forEach((el) => {
      el.classList.toggle('btn-game-menu-selected', el.id === `btn-game-${tab}`);
    });
    if (tab === ELG_TAB) fitElgPane();
  }

  // Grow (or shrink) the row list so the pane fills the menu box and
  // "Return to Game" ends up flush with its bottom edge, where it sits on
  // survev's own tabs.
  //
  // The 295px copied from the keybinds tab is only a starting point. On
  // desktop the menu is a fixed 495px box (`.ui-game-menu-desktop`) and the
  // keybinds *pane* is 345px — 295px of list plus 50px for its
  // restore-defaults button. Our pane has no height of its own, so it comes up
  // 50px short and that shortfall is exactly the gap under the button.
  // Measured rather than hardcoded, because the number depends on the row set
  // and on which of survev's layouts is live; self-limiting, since after one
  // pass the slack is zero and repeat calls return early. Under the mobile
  // media query the menu is `height: initial` and hugs its content, so the
  // slack is zero to begin with and this does nothing.
  function fitElgPane() {
    const menu = document.getElementById('ui-game-menu');
    const list = document.getElementById(ELG_LIST_ID);
    const resume = document.getElementById('btn-game-resume');
    if (!menu || !list || !resume || !list.offsetParent) return;
    const menuStyle = getComputedStyle(menu);
    const contentBottom = menu.getBoundingClientRect().bottom
      - parseFloat(menuStyle.paddingBottom || '0')
      - parseFloat(menuStyle.borderBottomWidth || '0');
    const slack = contentBottom
      - resume.getBoundingClientRect().bottom
      - parseFloat(getComputedStyle(resume).marginBottom || '0');
    if (Math.abs(slack) < 1) return;
    const h = Math.round(list.getBoundingClientRect().height + slack);
    list.style.height = `${Math.max(ELG_LIST_MIN_H, h)}px`;
  }

  // Refit on resize: the menu panel is sized off the viewport, so the slack
  // changes with it. Only does work while our tab is the visible one.
  window.addEventListener('resize', () => {
    try { fitElgPane(); } catch {}
  });

  function buildElgPane() {
    const pane = document.createElement('div');
    pane.id = ELG_TAB_PANE_ID;
    pane.className = 'ui-game-tab';
    pane.style.display = 'none';

    // Rows live in an inner scroll container, mirroring how the keybinds tab
    // wraps its list — the pane itself stays unsized so the menu lays out
    // exactly as it does for survev's own tabs.
    const list = document.createElement('div');
    list.id = ELG_LIST_ID;
    pane.appendChild(list);

    for (const spec of SETTINGS_SPECS) {
      if (spec.section) {
        const heading = document.createElement('p');
        heading.className = 'slider-text elg-heading';
        heading.textContent = spec.section;
        list.appendChild(heading);
      }

      // Keybind rows are survev's own markup, class for class: a
      // `.ui-keybind-container` holding a `.btn-keybind-desc` anchor and a
      // `.btn-keybind-display` box, with `.btn-keybind-desc-selected` applied
      // while armed. That gets the shipped stylesheet to lay ours out exactly
      // like the rows in the Keybinds tab, and the behaviour matches too:
      // Escape cancels, Backspace unbinds, and the keys survev won't take
      // leave the row armed instead of binding.
      //
      // Capture is a capture-phase window listener so the key never reaches the
      // game, and `bindCapture` keeps the aimbot's own listener — registered
      // first, at load, so it runs first — from engaging on the press.
      if (spec.kind === 'keybind') {
        const row = document.createElement('div');
        row.className = 'ui-keybind-container';
        const desc = document.createElement('a');
        desc.className = 'btn-game-menu btn-darken btn-keybind-desc';
        desc.textContent = spec.label;
        const display = document.createElement('div');
        display.className = 'btn-keybind-display';
        let listening = false;
        const paint = () => {
          display.textContent = keyName(spec.store[spec.key]);
          desc.classList.toggle('btn-keybind-desc-selected', listening);
        };
        const stop = () => {
          listening = false;
          bindCapture = false;
          window.removeEventListener('keydown', onCapture, true);
          paint();
        };
        function onCapture(ev) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          // Rejected key: stay armed and wait for another, as survev does.
          if (UNBINDABLE.has(ev.keyCode)) return;
          if (ev.keyCode !== 27) {
            // A held old bind will never get its keyup once this changes, so
            // drop the hold rather than leaving the aim loop running forever.
            releaseAim();
            spec.store[spec.key] = ev.keyCode === 8 ? null : ev.keyCode;
            saveSettings();
          }
          stop();
        }
        paint();
        desc.addEventListener('click', (e) => {
          e.stopPropagation();
          if (listening) { stop(); return; }
          listening = true;
          bindCapture = true;
          paint();
          window.addEventListener('keydown', onCapture, true);
        });
        row.appendChild(desc);
        row.appendChild(display);
        list.appendChild(row);
        continue;
      }

      // Toggles reuse the menu-button look; sliders reuse the volume-slider
      // markup, so both inherit survev's styling rather than fighting it.
      if (spec.kind === 'toggle') {
        const btn = document.createElement('a');
        btn.className = 'btn-game-menu btn-darken';
        const paint = () => {
          btn.textContent = `${spec.label}: ${spec.store[spec.key] ? 'ON' : 'OFF'}`;
        };
        paint();
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          spec.store[spec.key] = spec.store[spec.key] ? 0 : 1;
          paint();
          saveSettings();
        });
        list.appendChild(btn);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'slider-container ui-slider-container';
      const label = document.createElement('p');
      label.className = 'slider-text';
      // Kept terse so it wraps no worse than survev's own "Master Volume" in
      // the shared 75px label column.
      const paintLabel = (v) => {
        label.textContent = `${spec.label}: ${Number(v).toFixed(spec.decimals)}${spec.unit || ''}`;
      };
      paintLabel(spec.store[spec.key]);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'slider';
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String(spec.step);
      slider.value = String(spec.store[spec.key]);
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        spec.store[spec.key] = v;
        paintLabel(v);
      });
      // Persist on `change`, not `input`: a drag fires `input` per pixel, and
      // the value that matters is the one the user let go on.
      slider.addEventListener('change', saveSettings);
      // The menu sits over the game canvas; keep drags from reaching it.
      slider.addEventListener('mousedown', (e) => e.stopPropagation());
      row.appendChild(label);
      // A whitespace text node between the two inline-blocks, exactly as
      // survev's own markup has from its source indentation. It is the only
      // soft-wrap opportunity in the row, and without it the 75px label plus
      // the 260px track (335px) cannot break inside the menu's 320px content
      // box — the line overflows, and since `overflow-y: scroll` promotes
      // `overflow-x` from `visible` to `auto` (CSS Overflow 3), that surfaces
      // as a horizontal scrollbar. With it, the track wraps below the label
      // and the row matches the volume sliders.
      row.appendChild(document.createTextNode(' '));
      row.appendChild(slider);
      list.appendChild(row);
    }
    return pane;
  }

  function buildElgTabButton() {
    const container = document.createElement('div');
    container.className = 'btn-game-container';
    const btn = document.createElement('a');
    btn.id = ELG_TAB_BTN_ID;
    btn.className = 'btn-game-tab-select btn-game-menu btn-darken';
    btn.dataset.tab = ELG_TAB;
    // survev's own tabs are empty anchors with a sprite layered on top; we have
    // no sprite to reuse, so this one carries a text label instead.
    btn.textContent = 'MOD';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      elgSelectTab(ELG_TAB);
    });
    container.appendChild(btn);
    return container;
  }

  // Attach (or re-attach) the tab. Cheap no-op once present, so it can be
  // called from the sample loop without any lifecycle tracking of its own.
  function ensureElgTab() {
    ensureElgStyles();
    const tabs = document.getElementById('btn-game-tabs');
    const menu = document.getElementById('ui-game-menu');
    if (!tabs || !menu) return;

    if (!document.getElementById(ELG_TAB_BTN_ID)) {
      tabs.appendChild(buildElgTabButton());
      // survev's handler can't hide a pane it never captured, so mirror its
      // switch whenever one of its own tabs is clicked.
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.btn-game-tab-select');
        if (!btn || btn.id === ELG_TAB_BTN_ID) return;
        const pane = document.getElementById(ELG_TAB_PANE_ID);
        if (pane) pane.style.display = 'none';
        document.getElementById(ELG_TAB_BTN_ID)?.classList.remove('btn-game-menu-selected');
      });
    }
    if (!document.getElementById(ELG_TAB_PANE_ID)) {
      // "Return to Game" is not part of any tab — it is a sibling pinned after
      // all of them, so every pane renders above it. Appending to the menu puts
      // our pane *below* it instead; insert before it to sit where survev's own
      // panes do. Falling back to append keeps this working if that button is
      // ever renamed or removed.
      const resume = document.getElementById('btn-game-resume');
      // A rebuild throws away whatever row was mid-capture along with its
      // listener, so clear the flag it owns or the bind would stay swallowed.
      bindCapture = false;
      const pane = buildElgPane();
      if (resume && resume.parentElement === menu) menu.insertBefore(pane, resume);
      else menu.appendChild(pane);
    }
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
        // Gate the action, not the edge tracking: keeping `wasDown` current
        // while disabled means re-enabling mid-hold doesn't fire a swap off a
        // trigger pull that started before the toggle flipped.
        if (isDown && !autoSwapFireWasDown && AUTO_SWAP.enabled) autoSwapOnFirePressed(game);
        autoSwapFireWasDown = isDown;
      } else {
        autoSwapFireWasDown = false;
      }
    } catch {}
    requestAnimationFrame(autoSwapFrameTick);
  }
  requestAnimationFrame(autoSwapFrameTick);

  // ---------------------------------------------------------------------
  // Netcode smoothing: kill the stutter survev shows on a jittery link.
  //
  // How survev renders motion. Positions only ever arrive in server update
  // packets. On each packet the client records the raw inter-arrival gap on
  // the camera:
  //     camera[interpWindow] = (now - lastUpdateTime) / 1000
  // and every entity (players, loot, obstacles, projectiles, the gas circle)
  // renders itself at
  //     lerp(clamp(posInterpTicker / camera[interpWindow], 0, 1),
  //          visualPosOld, pos)
  // where `posInterpTicker` accumulates frame dt and resets to 0 whenever a
  // packet brings a *different* position. Segments are chained, so
  // `visualPosOld` of one segment is the `pos` of the previous one.
  //
  // Two things go wrong the moment the link is anything but perfect:
  //
  //   1. The window is the RAW previous gap, so it is wrong for the interval
  //      it is actually used on. On a link jittering 20/80/20/80ms the client
  //      spends the 80ms intervals playing back at 4x and then sitting frozen
  //      for 60ms, and the 20ms intervals crawling at 1/4 speed and snapping.
  //      That alternating sprint/freeze *is* the stutter.
  //   2. `clamp(..., 0, 1)` means a late packet freezes every entity dead
  //      until it lands, then teleports it.
  //
  // The fix has two independent parts.
  //
  //   A. A recovered server clock, which is what actually removes the stutter.
  //      Updates are numbered by arrival, and arrival time is fit against that
  //      index with a slow exponentially-weighted linear regression. The fit
  //      gives each packet a `pseudotime`: when it would have arrived on a
  //      jitter-free link. Players are then rendered by lerping between the
  //      last two snapshots on that clock, so the render time advances
  //      smoothly and is never yanked by one late arrival. The discontinuities
  //      stop existing rather than being blended away afterwards.
  //
  //      Numbering by arrival is exact here: survev runs over a WebSocket, so
  //      TCP guarantees no loss and no reordering, and the arrival count *is*
  //      the tick index. That would not hold over UDP.
  //
  //   B. A jitter-buffered window for everything that is not a player — loot,
  //      obstacles, projectiles, the gas circle. Those still go through
  //      survev's own lerp, so the raw inter-arrival gap it divides by is
  //      replaced with an EWMA of the mean plus an allowance proportional to
  //      measured deviation. One accessor on one camera field reaches all of
  //      them at once.
  //
  //   The render is deliberately unclamped — a render time past the newest
  //   snapshot extrapolates along the same line rather than freezing — but it
  //   is taken half a tick behind the clock rather than at `t_now`, so most
  //   frames interpolate between two snapshots we hold instead of extending
  //   past the newest one. That halves the overshoot on direction changes and
  //   on stops, for a playout delay that still leaves the render ahead of
  //   stock survev's. `renderLag` tunes it; netcode_sim.js has the numbers at
  //   either setting.
  //
  // Everything here is a pure render-path change: no input, no packet, and no
  // gameplay state is touched, and `enabled = 0` restores stock behaviour live.
  // ---------------------------------------------------------------------

  // (NETCODE itself is declared up beside AUTO_SWAP so the settings menu can
  // bind to it without hitting the temporal dead zone.)

  // Bounds on a *plausible* server update gap. Outside this band the sample is
  // a tab-blur, a round change or a join hitch rather than a real tick, and is
  // kept out of the average (the extrapolator covers the gap instead).
  const NET_MIN_UPDATE_MS = 10;
  const NET_MAX_UPDATE_MS = 400;
  const NET_EWMA_ALPHA = 0.1;   // ~10-packet horizon, matching the overlay's
  // Snapshots retained per player. Only the newest two are rendered from; the
  // rest are headroom so a TCP burst can be recorded without dropping ticks.
  const NET_SNAP_CAP = 8;

  const netStats = {
    hookedCamera: null,
    rawMs: 0,       // last raw inter-arrival the game handed us
    meanMs: 0,      // EWMA of the gap
    devMs: 0,       // EWMA of |gap - mean|, our jitter measure
    windowMs: 0,    // what we hand back in place of the raw gap
    updates: 0,
    playersHooked: 0,   // cumulative across rounds, not a live count
  };

  // Fold one server-update gap into the jitter-buffer estimate. Called from
  // the camera setter, i.e. exactly once per update packet.
  function recordUpdateInterval(sec) {
    const ms = Number(sec) * 1000;
    if (!Number.isFinite(ms)) return;
    netStats.rawMs = ms;
    netStats.updates++;
    if (ms < NET_MIN_UPDATE_MS || ms > NET_MAX_UPDATE_MS) return;
    if (!netStats.meanMs) {
      // Seed straight from the first gap rather than ramping up from zero.
      netStats.meanMs = ms;
      netStats.devMs = 0;
    } else {
      // Deviation is folded against the pre-update mean, so a step change in
      // the link shows up as jitter for a few packets and widens the buffer
      // before the mean has finished chasing it.
      netStats.devMs = NET_EWMA_ALPHA * Math.abs(ms - netStats.meanMs)
        + (1 - NET_EWMA_ALPHA) * netStats.devMs;
      netStats.meanMs = NET_EWMA_ALPHA * ms + (1 - NET_EWMA_ALPHA) * netStats.meanMs;
    }
    const target = netStats.meanMs + NETCODE.jitterK * netStats.devMs;
    // Floor at exactly the mean, with no inflation. A window wider than the
    // gap leaves each lerp unfinished when the next packet starts a new
    // segment, which is a seam the blend then has to hide — so on a link with
    // no jitter to absorb, any padding here is pure cost: it manufactures the
    // very discontinuity the smoother exists to remove. At dev == 0 this makes
    // the window equal the gap, t reach exactly 1, and the whole path collapse
    // to stock behaviour.
    netStats.windowMs = Math.min(Math.max(target, netStats.meanMs), NET_MAX_UPDATE_MS);
  }

  // ---------------------------------------------------------------------
  // Pseudotime clock.
  //
  // The window estimate above fixes the *rate* at which we play positions
  // back, but not the *phase*: survev restarts each entity's lerp the instant
  // a packet lands (`posInterpTicker = 0`), so every arrival's jitter is
  // injected straight into the render. Blending the resulting discontinuity
  // away treats the symptom.
  //
  // Instead, recover the server's tick clock. Updates are numbered by arrival
  // — safe here because survev runs over a WebSocket, so TCP guarantees no
  // loss and no reordering, and the arrival count *is* the tick index — and we
  // fit arrival time against that index with an exponentially-weighted least
  // squares. The fit gives every packet a `pseudotime`: when it would have
  // arrived on a jitter-free link. Rendering against that clock means the
  // render time advances smoothly and is never yanked by one late arrival, so
  // the discontinuities stop existing rather than being hidden.
  //
  // The render is unclamped, so a stall is extrapolated through rather than
  // frozen, and it is taken at `t_now - renderLag * tick` rather than at
  // t_now. Rendering at t_now exactly means the newest snapshot's pseudotime
  // is always a little in the past, so every frame leans past the end of the
  // data; half a tick of playout centres the render on the data instead. The
  // extrapolation is still there when it is needed — during a stall there is
  // nothing else — but it stops being the steady state. netcode_sim.js
  // measures both settings; see the trade note at the bottom of it.
  // ---------------------------------------------------------------------

  // The fit is kept as mean-centred sufficient statistics that each arrival
  // updates in place, rather than as a buffer of arrivals re-summed per packet.
  // Decaying the accumulated moments by `lam` and folding the new sample in at
  // weight 1 is algebraically the same weighted least squares, so this is a
  // form change, not a behaviour change — except that the taper now runs over
  // every packet ever seen instead of stopping at a window edge.
  //
  // Centring is what makes the running form safe. Accumulating raw Σn² would
  // lose the fit to rounding within minutes, exactly as the batch version's
  // per-packet re-centring existed to prevent; carrying deviations from the
  // running weighted mean instead keeps every stored quantity bounded — `cnn`
  // settles at the weighted spread of the index and stays there, however long
  // the match runs. The means themselves grow, but only linearly, and only as
  // the operands of small differences.
  const netClock = {
    n: 0,             // next packet index
    count: 0,         // arrivals folded in, for the warm-up gate
    sw: 0,            // Σ w
    mn: 0,            // weighted mean packet index
    mt: 0,            // weighted mean arrival time (ms)
    cnn: 0,           // Σ w (n - mn)^2
    cnt: 0,           // Σ w (n - mn)(t - mt)
    slope: 0,         // ms per tick
    ready: false,
  };

  function resetNetClock() {
    netClock.n = 0;
    netClock.count = 0;
    netClock.sw = 0;
    netClock.mn = 0;
    netClock.mt = 0;
    netClock.cnn = 0;
    netClock.cnt = 0;
    netClock.slope = 0;
    netClock.ready = false;
    // Packet indices restart, so every retained snapshot's index now points at
    // the wrong pseudotime. (Declared below, beside the ring it indexes.)
    netSnapsById.clear();
  }

  // Fold one arrival into the clock. Called once per update packet.
  function clockOnPacket(nowMs) {
    const n = netClock.n++;
    // `clockHalfLife` is live-tunable. Moments already banked stay weighted as
    // the old horizon banked them, so a slider move re-converges over a few
    // half-lives rather than landing instantly. The slope is a ratio of two
    // moments carrying the same stale weighting, so the transit is smooth.
    const lam = Math.pow(0.5, 1 / Math.max(NETCODE.clockHalfLife, 1));

    // Weighted Welford: decay, then fold the new sample in at weight 1. The
    // deviations are taken against the *old* mean and closed against the
    // *new* one, which is what makes the centred moments update exactly
    // rather than approximately.
    const dn = n - netClock.mn;
    const dt = nowMs - netClock.mt;
    const sw = lam * netClock.sw + 1;
    const k = 1 / sw;                  // share of the mean the new sample takes
    const mn = netClock.mn + k * dn;
    const mt = netClock.mt + k * dt;
    netClock.cnn = lam * netClock.cnn + dn * (n - mn);
    netClock.cnt = lam * netClock.cnt + dn * (nowMs - mt);
    netClock.sw = sw;
    netClock.mn = mn;
    netClock.mt = mt;
    netClock.count++;

    if (netClock.count < 4 || !(netClock.cnn > 1e-9)) return;
    const slope = netClock.cnt / netClock.cnn;
    if (!Number.isFinite(slope)) return;
    netClock.slope = slope;
    netClock.ready = true;
  }

  // Evaluated about the fit's centroid rather than about n = 0. The affine
  // form needs an intercept reconstructed as `mt - slope * mn`, two large
  // numbers differencing to a small one; this asks for no such cancellation.
  const pseudotimeOf = (n) => netClock.mt + netClock.slope * (n - netClock.mn);

  // The pseudotime the *render* is taken at, as opposed to the true clock time
  // everything else asks about. Held `renderLag` ticks behind now, so the lerp
  // spends most of its time interpolating between two snapshots it actually
  // has rather than extending past the newest one. Anything that has to agree
  // with what is on screen — the overlay's rings, "which sprite is under the
  // cursor" — reads this; the aim solution does not, because a shot is
  // resolved against the server's present, not against our playout.
  const renderNowMs = () => performance.now() - netClock.slope * NETCODE.renderLag;


  // Entity id -> the smoothing state holding that player's snapshot ring, so
  // the aim path can read the same per-tick positions the renderer draws from
  // without holding a Player reference. Populated by snapshotPlayers below;
  // entries can outlive the entity, which is why every read revalidates
  // `st.id` (a pooled Player object gets recycled onto a new entity, and its
  // ring goes with it).
  const netSnapsById = new Map();

  // Record where every player was as of the packet that has just *finished*
  // being applied. The camera write we hook sits at the top of survev's update
  // handler, before the entity updates, so netData still holds the previous
  // packet's positions at this point — hence index n-1. Sampling here rather
  // than on a render frame is what keeps a TCP burst intact: eight packets
  // landing together still produce eight snapshots a tick apart, which is
  // exactly what the clock needs to play them back at the right rate.
  function snapshotPlayers(game) {
    const idx = netClock.n - 1;
    if (idx < 0) return;
    const roster = findRosterOnGame(game) || game?.[GAME_ROSTER];
    const pool = roster?.playerPool;
    if (!pool || typeof pool[POOL_GETALL] !== 'function') return;
    const players = pool[POOL_GETALL]() || [];
    for (const player of players) {
      const st = netSmoothState.get(player);
      if (!st) continue;
      const pos = player[PLAYER_NET]?.[PLAYER_POS];
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') continue;
      // The pool hands the same Player object to a new entity when the old one
      // is released, so a ring is only this id's history from the tick the id
      // last changed. Without the reset the first snapshot pair after a recycle
      // spans two different players and reads as a teleport-speed velocity.
      const id = Number(player.__id ?? 0);
      if (st.id !== id) {
        st.id = id;
        st.snaps.length = 0;
        if (id) netSnapsById.set(id, st);
      }
      const last = st.snaps[st.snaps.length - 1];
      if (last && last.n === idx) continue;
      // Discard a ring whose newest entry can no longer be read against the
      // current clock: indices running backwards mean the clock was reset
      // under us (new round, new camera), and a long gap means the entity was
      // out of the pool for a while, so the pair straddling the gap would
      // report the whole absence as one tick of movement.
      if (last && (last.n > idx || idx - last.n > NET_SNAP_CAP)) st.snaps.length = 0;
      st.snaps.push({ n: idx, x: pos.x, y: pos.y });
      if (st.snaps.length > NET_SNAP_CAP) st.snaps.shift();
    }
  }

  // Position on the recovered clock. Given the last two snapshots p1@t1 and
  // p2@t2 in pseudotime, render at
  //     p1 * (t_now - t2)/(t1 - t2) + p2 * (t1 - t_now)/(t1 - t2)
  // which is the standard two-point lerp written over (t1 - t2); the weights
  // sum to 1 for any t_now. It is deliberately unclamped, so t_now past t2
  // extrapolates along the same line rather than freezing.
  //
  // Returns null before the clock has converged or while a player has fewer
  // than two snapshots, in which case the caller falls back to survev's lerp.
  function renderOnClock(st, nowMs) {
    if (!netClock.ready) return null;
    const s = st.snaps;
    if (s.length < 2) return null;
    const p1 = s[s.length - 2];
    const p2 = s[s.length - 1];
    const t1 = pseudotimeOf(p1.n);
    const t2 = pseudotimeOf(p2.n);
    const d = t1 - t2;
    if (!d) return null;
    const w1 = (nowMs - t2) / d;
    const w2 = (t1 - nowMs) / d;
    return { x: p1.x * w1 + p2.x * w2, y: p1.y * w1 + p2.y * w2 };
  }

  // Swap the camera's interpolation-window field for an accessor: the game
  // still writes the raw gap (which we meter), but every reader gets the
  // jitter-buffered value instead. Re-runs when a new round swaps in a fresh
  // Camera; the old one is garbage either way.
  function installCameraInterpHook(game) {
    if (!CAM_INTERP_W) return null;
    const camera = findCameraOnGame(game);
    if (!camera) return null;
    if (camera === netStats.hookedCamera) return camera;
    let raw = Number(camera[CAM_INTERP_W]) || 0;
    try {
      const desc = Object.getOwnPropertyDescriptor(camera, CAM_INTERP_W);
      if (desc && !desc.configurable) return;
      Object.defineProperty(camera, CAM_INTERP_W, {
        configurable: true,
        enumerable: true,
        get() {
          if (!NETCODE.enabled || !netStats.windowMs) return raw;
          return netStats.windowMs / 1000;
        },
        // This fires exactly once per server update packet, which makes it our
        // packet clock as well as the window measurement.
        set(v) {
          raw = v;
          recordUpdateInterval(v);
          try {
            clockOnPacket(performance.now());
            snapshotPlayers(game);
          } catch {}
        },
      });
    } catch {
      return null;
    }
    // Fresh camera, fresh link statistics.
    netStats.hookedCamera = camera;
    netStats.meanMs = 0;
    netStats.devMs = 0;
    netStats.windowMs = 0;
    netStats.updates = 0;
    resetNetClock();
    return camera;
  }

  // Per-player smoothing state, keyed off the Player instance itself so pooled
  // entities that go inactive drop out with no bookkeeping.
  const netSmoothState = new WeakMap();

  // Recompute a player's rendered position. Driven from the property setter
  // rather than a rAF loop because the game assigns the interpolated position
  // exactly once per frame per player, immediately before everything that
  // reads it (sprite placement, camera follow, minimap) — so this runs once
  // per frame with the right ordering and no loop of our own.
  function updatePlayerSmoothing(st, base) {
    st.out = renderOnClock(st, renderNowMs()) || base;
    st.haveOut = true;
  }

  // Replace a Player's interpolated-position field with an accessor. It has to
  // be per-instance: survev declares it as a class field, so every Player gets
  // its own data property that would shadow anything installed on the
  // prototype (the same reason the constructor setter traps stopped firing —
  // see the capture notes at the top of this file).
  function installPlayerSmoothing(player) {
    if (!player || netSmoothState.has(player)) return;
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(player, PLAYER_POS2);
    } catch {
      return;
    }
    if (desc && !desc.configurable) return;
    const st = {
      base: player[PLAYER_POS2] || { x: 0, y: 0 },
      out: null,
      haveOut: false,
      snaps: [],            // [{ n, x, y }] positions tagged by packet index
      id: 0,                // entity id the ring belongs to; see snapshotPlayers
    };
    try {
      Object.defineProperty(player, PLAYER_POS2, {
        configurable: true,
        enumerable: true,
        get() {
          // Passthrough when disabled, so the toggle is live and total.
          return (NETCODE.enabled && st.haveOut) ? st.out : st.base;
        },
        set(v) {
          st.base = v;
          if (!NETCODE.enabled || !v) {
            st.haveOut = false;
            return;
          }
          try {
            updatePlayerSmoothing(st, v);
          } catch {
            st.haveOut = false;
          }
        },
      });
    } catch {
      return;
    }
    netSmoothState.set(player, st);
    netStats.playersHooked++;
  }

  // Called from the sample loop: keep the camera hook attached to the live
  // Game and make sure every Player in the pool is smoothed. Both guards are
  // cheap no-ops once installed.
  function netcodeTick(game) {
    if (!game) return;
    try {
      const camera = installCameraInterpHook(game);
      // survev exposes interpolation as a user setting; with it off the client
      // snaps to each packet and there is nothing for us to smooth, so it is
      // held on. Re-asserted every tick so it survives the user toggling it,
      // and a new round swapping in a fresh camera.
      if (camera && CAM_INTERP_ON && camera[CAM_INTERP_ON] !== true) {
        camera[CAM_INTERP_ON] = true;
      }
      const roster = findRosterOnGame(game) || game?.[GAME_ROSTER];
      const pool = roster?.playerPool;
      const players = (pool && typeof pool[POOL_GETALL] === 'function' ? pool[POOL_GETALL]() : []) || [];
      for (const player of players) installPlayerSmoothing(player);
    } catch {}
  }

  // ---------------------------------------------------------------------
  // Ping readout, pinned above the team panel in the top-left HUD.
  //
  // survev already measures round-trip time: it stamps `seqSendTime` when it
  // sends an input carrying a sequence number, and on the update that acks
  // that sequence it pushes `now - seqSendTime` onto `game.pings`. It just
  // never surfaces the number — the array only feeds a console summary and
  // the debug HUD graph. So we read the samples it is already collecting
  // rather than generating traffic of our own.
  //
  // `pings` is one of the field names survev leaves readable (like
  // `posInterpTicker` and `playerPool`), so it needs no mangled.js entry.
  //
  // The element is inserted as the first child of `#ui-top-left`, which is the
  // container holding `#ui-team` — so it sits directly above the team panel,
  // whose first row is the local player. It inherits that container's
  // click-through behaviour and is explicitly pointer-events:none so it can
  // never eat a click meant for the game.
  // ---------------------------------------------------------------------

  const PING_SAMPLE_CAP = 12;    // recent RTT samples kept for the median
  const PING_REFRESH_MS = 250;   // redraw cadence; faster just makes it flicker
  const PING_GOOD_MS = 60;
  const PING_OK_MS = 120;

  const pingState = {
    el: null,
    dot: null,
    text: null,
    samples: [],
    sourceArray: null,   // identity of the game's array, to spot replacement
    consumed: 0,         // how much of it we've already folded in
    lastRenderAt: 0,
    currentMs: null,
  };

  // Pull any new RTT samples out of the game's own array. survev sorts it and
  // then replaces it wholesale every 20 seconds (after logging a summary), so
  // tracking length alone would both miss the reset and mistake the sorted
  // leftovers for fresh data — hence the identity check.
  function harvestPings(game) {
    const arr = game?.pings;
    if (!Array.isArray(arr)) return;
    if (arr !== pingState.sourceArray) {
      pingState.sourceArray = arr;
      pingState.consumed = 0;
    }
    if (arr.length < pingState.consumed) pingState.consumed = 0;
    for (let i = pingState.consumed; i < arr.length; i++) {
      const v = Number(arr[i]);
      if (!Number.isFinite(v) || v < 0) continue;
      pingState.samples.push(v);
      if (pingState.samples.length > PING_SAMPLE_CAP) pingState.samples.shift();
    }
    pingState.consumed = arr.length;
  }

  // Median rather than mean or latest: a single retransmit or GC pause
  // otherwise makes the number leap around and read as unreliable.
  function medianPingMs() {
    if (!pingState.samples.length) return null;
    const sorted = pingState.samples.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function ensurePingEl() {
    const host = document.getElementById('ui-top-left');
    if (!host) return null;
    if (pingState.el && pingState.el.isConnected && pingState.el.parentElement === host) {
      return pingState.el;
    }
    const el = document.createElement('div');
    el.style.cssText = [
      'display:flex', 'align-items:center', 'gap:6px',
      'margin:0 0 4px 2px', 'padding:0',
      'font:700 13px/1.2 system-ui,sans-serif',
      'color:#fff', 'text-shadow:0 1px 2px rgba(0,0,0,0.9)',
      'pointer-events:none', 'user-select:none', 'white-space:nowrap',
    ].join(';');
    const dot = document.createElement('span');
    dot.style.cssText = [
      'width:8px', 'height:8px', 'border-radius:50%',
      'background:#7f8c8d', 'box-shadow:0 0 3px rgba(0,0,0,0.8)',
      'flex:0 0 auto',
    ].join(';');
    const text = document.createElement('span');
    el.appendChild(dot);
    el.appendChild(text);
    // First child of #ui-top-left puts it directly above #ui-team.
    host.insertBefore(el, host.firstChild);
    pingState.el = el;
    pingState.dot = dot;
    pingState.text = text;
    return el;
  }

  function updatePingUI(game, now) {
    // Harvest before the enabled check: the aim path leads by this RTT (see
    // reactionTarget), so hiding the readout must not also stop measuring it.
    harvestPings(game);
    if (!PING_UI.enabled) {
      if (pingState.el) pingState.el.style.display = 'none';
      return;
    }
    if (now - pingState.lastRenderAt < PING_REFRESH_MS) return;
    pingState.lastRenderAt = now;

    const el = ensurePingEl();
    if (!el) return;
    const ms = medianPingMs();
    pingState.currentMs = ms;
    if (ms == null) {
      // In a match but no acked input yet — say so rather than showing a stale
      // or invented number.
      el.style.display = 'flex';
      pingState.dot.style.background = '#7f8c8d';
      pingState.text.textContent = '– ms';
      return;
    }
    el.style.display = 'flex';
    pingState.dot.style.background =
      ms < PING_GOOD_MS ? '#2ecc71' : ms < PING_OK_MS ? '#f1c40f' : '#e74c3c';
    pingState.text.textContent = `${Math.round(ms)} ms`;
  }

  // ---------------------------------------------------------------------
  // Target overlay: a fixed-position canvas above the game canvas that
  // draws a circle around whichever enemy the cheat is currently aiming
  // at (or *would* aim at if the aimbot key were held). Used as a debugging /
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

  // Where the overlay should draw an entity: the recovered clock's position,
  // which is what the game itself renders from, with the sample interpolator
  // above as the fallback for anything the clock can't place (still
  // converging, or just came into view). Drawing rings
  // from a different position source than the sprites they circle is visible
  // as a lag between the two on any jittery link.
  function overlayPos(id, fallbackX, fallbackY) {
    return stateOnClock(id, renderNowMs()) || interpPos(id, fallbackX, fallbackY);
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

  // Find the enemy that the cheat is currently locked onto, OR — when the
  // aimbot key isn't held — the enemy that *would* be picked right now if it
  // were. This intentionally bypasses stickiness in the preview path so
  // the circle tracks the user's mouse in real time before they engage.
  function getCurrentAimTarget(sample) {
    if (!sample) return null;
    const player = liveSelf(sample);
    const enemies = sample.enemies;
    if (!player || !enemies || !enemies.length) return null;

    if (aimHeld && aimState.targetId != null) {
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
      const p = livePos(e.id, e);
      const dx = p.x - mwx;
      const dy = p.y - mwy;
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

    // ESP off: keep the loop (and the canvas) alive but draw nothing, so
    // flipping the toggle back on resumes on the very next frame. Sampling,
    // aim and netcode are untouched — this is a display switch only.
    overlayCanvas.style.display = ESP.enabled ? 'block' : 'none';
    if (!ESP.enabled) {
      requestAnimationFrame(overlayFrame);
      return;
    }

    const sample = pageSamples[pageSamples.length - 1];
    if (sample && sample.self && sample.enemies && sample.enemies.length) {
      const player = sample.self;
      // Rendered player position, i.e. what the camera is centred on.
      const pi = stateOnClock(player.id, renderNowMs())
        || interpPos('__self__', player.x, player.y);
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
        const ei = overlayPos(e.id, e.x, e.y);
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
        const ti = overlayPos(target.id, target.x, target.y);
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

        // Aim-assist X: the lead point reactionTarget solves for — reaction
        // lag, round-trip lead and bullet flight — drawn from the same
        // function the bot steers by, so what is on screen is the actual
        // solution and not a second, prettier model of it. Only meaningful
        // when the player holds a projectile weapon with a known bullet speed.
        const selfBulletSpeed = player.bulletSpeed;
        if (selfBulletSpeed && selfBulletSpeed > 0) {
          const lead = reactionTarget(player, target, Date.now());
          const axs = cx + (lead.x - pi.x) * scale;
          const ays = cy - (lead.y - pi.y) * scale;
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
      // is non-null only while the aimbot key is held and a target is engaged, so this
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

  // Netcode-smoothing diagnostics. `cameraHooked: false` while in a match
  // means the camera field lookup failed — re-derive mangled.js. A `windowMs`
  // that sits far above `meanMs` means the link is genuinely jittery and the
  // buffer has widened to cover it; if that costs too much latency, lower
  // `jitterK` in the settings panel.
  window.__netcodeDiag = () => ({
    settings: { ...NETCODE },
    cameraHooked: !!netStats.hookedCamera,
    updates: netStats.updates,
    rawMs: Number(netStats.rawMs.toFixed(1)),
    meanMs: Number(netStats.meanMs.toFixed(1)),
    jitterMs: Number(netStats.devMs.toFixed(1)),
    windowMs: Number(netStats.windowMs.toFixed(1)),
    playersHooked: netStats.playersHooked,
    // Reported straight from the sample buffer rather than from the readout's
    // cached value, so it is right even with the readout switched off.
    pingMs: medianPingMs(),
    pingSamples: pingState.samples.length,
    clockReady: netClock.ready,
    // Recovered tick length. Should sit at the server tick (~50ms) regardless
    // of how much the link is jittering; if it doesn't, the fit is being
    // dragged by something other than the tick rate.
    tickMs: netClock.ready ? Number(netClock.slope.toFixed(2)) : null,
    snapRings: netSnapsById.size,
  });

  // What the aim path is doing right now, for the enemy it would engage if
  // Shift went down this instant. `source: 'sample'` means the clock declined
  // the lookup and it fell back to the 20ms ring — expected for the first
  // second of a round or an enemy that just came into view, a standing problem
  // otherwise. `leadMs` is reactionTarget's lead broken into its parts: the
  // first two are the delay we hold ourselves to plus the measured round trip
  // (both measured from the delayed viewpoint), the third is bullet flight.
  window.__aimDiag = () => {
    const sample = pageSamples[pageSamples.length - 1];
    const target = sample ? getCurrentAimTarget(sample) : null;
    if (!target) return { target: null, clockReady: netClock.ready };
    const self = sample.self;
    const now = Date.now();
    const tNow = performance.now();
    const pair = clockPairAt(target.id, tNow - AIM_HUMAN.reactionMs);
    const seen = stateOnClock(target.id, tNow) || { xv: 0, yv: 0 };
    const aimAt = reactionTarget(self, target, now);
    const drawn = livePos(target.id, target);
    const pingMs = medianPingMs();
    return {
      target: { id: target.id, name: target.name },
      source: pair ? 'clock' : 'sample',
      tickMs: pair ? Number((pair.t2 - pair.t1).toFixed(2)) : null,
      speed: Number(Math.hypot(seen.xv, seen.yv).toFixed(2)),
      leadMs: {
        reaction: AIM_HUMAN.reactionMs,
        ping: Number(((pingMs ?? 0) * AIM_HUMAN.pingLeadK).toFixed(1)),
        travel: self.bulletSpeed
          ? Number((Math.hypot(aimAt.x - aimAt.fromX, aimAt.y - aimAt.fromY)
            / self.bulletSpeed * 1000).toFixed(1))
          : null,
      },
      // How far ahead of the drawn sprite the crosshair is being placed, and
      // how far the firing origin sits ahead of where we are drawn.
      leadUnits: Number(Math.hypot(aimAt.x - drawn.x, aimAt.y - drawn.y).toFixed(2)),
      originAheadUnits: Number(Math.hypot(aimAt.fromX - self.x, aimAt.fromY - self.y).toFixed(2)),
    };
  };

  post('status', { ok: true, message: 'Injector loaded.', url: location.href, isTop: window.top === window });
  // console.log(`[${SOURCE}] inject.js TAIL reached, starting sampleLoop @ ${SAMPLE_MS}ms`);
  setInterval(sampleLoop, SAMPLE_MS);
})();
