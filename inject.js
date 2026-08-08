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
  const PLAYER_DIR2  = M.player?.dirAlt;
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
  // instance, plus the camera's own identified members: the zero-arg
  // `pixelsPerUnit()` method, the m_ppu field and the live m_zoom field.
  // All reset on game swap. See findCameraOnGame / identifyCameraScale.
  let cachedCameraKey = null;
  let cachedCameraScaleFn = null;
  let cachedCameraPpuKey = null;
  let cachedCameraZoomKey = null;
  // Date.now() of the last failed identifyCameraScale, so we retry on a
  // slow cadence instead of probing the camera every single frame.
  let cameraScaleProbedAt = 0;
  const CAMERA_PROBE_RETRY_MS = 500;

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

  // survev's camera pixels-per-unit is `m_ppu * m_zoom`, and m_ppu is a
  // hardcoded 16 (client/src/camera.ts). Used both as an identification
  // fingerprint and as the fallback multiplier.
  const CAMERA_PPU = 16;

  // Every scope change retargets the camera but does NOT snap it: the game
  // does `m_zoom = lerp(dt * rate, m_zoom, m_targetZoom)` once per frame
  // (client/src/game.ts, rate = zoomFast ? 3 : m_targetZoom > m_zoom ? 2 :
  // 1.4), so the rendered scale slides toward the new scope across ~0.3-1s.
  // Anything drawn off m_targetZoom is therefore wrong for the whole
  // transition and only converges at the end.
  //
  // The two zoom scalars sit side by side on the camera under mangled names
  // and are numerically identical in steady state, so they can't be told
  // apart by inspection alone. Instead we identify them by EXPERIMENT, on a
  // throwaway clone of the camera: the camera exposes a zero-arg
  // `pixelsPerUnit()` returning m_ppu * m_zoom, so we call each zero-arg
  // method on the clone, then double each candidate scalar and see whose
  // change the method's result follows. The scalar the render transform
  // actually reads is m_zoom, by definition — no name pinning, no guessing
  // from the expected target, and correct mid-lerp.
  //
  // Probing the clone (same prototype, own fields copied) rather than the
  // live camera means any method with side effects — the screen-shake apply
  // is also zero-arg — mutates the copy and nothing the game can see.
  function makeCameraProbe(camera) {
    const probe = Object.create(Object.getPrototypeOf(camera));
    const names = Object.getOwnPropertyNames(camera);
    for (let i = 0; i < names.length; i++) {
      const v = camera[names[i]];
      probe[names[i]] = (v && typeof v === 'object' &&
                         typeof v.x === 'number' && typeof v.y === 'number')
        ? { x: v.x, y: v.y }
        : v;
    }
    return probe;
  }

  // Zero-arg function-valued members of the camera, instance first then up
  // the prototype chain (class methods live on the prototype). Read through
  // descriptors so we never trip an accessor just by looking.
  function cameraZeroArgMethodNames(camera) {
    const out = [];
    const seen = new Set();
    for (let o = camera; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      const names = Object.getOwnPropertyNames(o);
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (n === 'constructor' || seen.has(n)) continue;
        seen.add(n);
        const d = Object.getOwnPropertyDescriptor(o, n);
        if (d && typeof d.value === 'function' && d.value.length === 0) out.push(n);
      }
    }
    return out;
  }

  // Numeric own fields that could plausibly be a zoom factor. m_ppu (16) is
  // excluded by value: it also scales pixelsPerUnit, so the doubling test
  // alone can't separate it from m_zoom.
  function cameraZoomCandidateKeys(camera) {
    const out = [];
    const names = Object.getOwnPropertyNames(camera);
    for (let i = 0; i < names.length; i++) {
      const v = camera[names[i]];
      if (typeof v === 'number' && isFinite(v) &&
          v > 0.05 && v < 20 && v !== CAMERA_PPU) out.push(names[i]);
    }
    return out;
  }

  // Fill cachedCameraScaleFn / PpuKey / ZoomKey. Returns true on success.
  function identifyCameraScale(camera) {
    try {
      const probe = makeCameraProbe(camera);
      const zoomKeys = cameraZoomCandidateKeys(probe);
      if (!zoomKeys.length) return false;
      let ppuKey = null;
      const names = Object.getOwnPropertyNames(probe);
      for (let i = 0; i < names.length; i++) {
        if (probe[names[i]] === CAMERA_PPU) { ppuKey = names[i]; break; }
      }
      const methods = cameraZeroArgMethodNames(probe);
      for (let i = 0; i < methods.length; i++) {
        const fn = probe[methods[i]];
        let base;
        try { base = fn.call(probe); } catch { continue; }
        if (typeof base !== 'number' || !isFinite(base) || base <= 0) continue;
        // Exactly one candidate must drive the result, and proportionally —
        // that rules out a method that merely happens to return a number.
        let hit = null;
        for (let j = 0; j < zoomKeys.length; j++) {
          const k = zoomKeys[j];
          const orig = probe[k];
          let doubled;
          try {
            probe[k] = orig * 2;
            doubled = fn.call(probe);
          } catch {
            doubled = null;
          } finally {
            probe[k] = orig;
          }
          if (typeof doubled !== 'number' || !isFinite(doubled)) continue;
          if (Math.abs(doubled - base * 2) <= Math.abs(base) * 1e-9) {
            if (hit) { hit = null; break; }  // ambiguous, don't trust it
            hit = k;
          }
        }
        if (!hit) continue;
        cachedCameraScaleFn = methods[i];
        cachedCameraZoomKey = hit;
        cachedCameraPpuKey = ppuKey;
        return true;
      }
    } catch {}
    return false;
  }

  // Pixels per world unit as the game is rendering it RIGHT NOW. Prefers the
  // camera's own pixelsPerUnit(), falls back to m_ppu * m_zoom by the
  // identified field names, and returns null if the camera is unusable —
  // callers then fall back to scope-radius math.
  function readCameraPxPerUnit(camera) {
    if (!camera || typeof camera !== 'object') return null;
    if (!cachedCameraScaleFn && !cachedCameraZoomKey) {
      const now = Date.now();
      // In steady state the doubling test is still decisive, so a failure
      // here means the camera's shape changed; retry on a slow cadence.
      if (now - cameraScaleProbedAt >= CAMERA_PROBE_RETRY_MS) {
        cameraScaleProbedAt = now;
        identifyCameraScale(camera);
      }
    }
    if (cachedCameraScaleFn) {
      try {
        const fn = camera[cachedCameraScaleFn];
        if (typeof fn === 'function') {
          const px = fn.call(camera);
          if (typeof px === 'number' && isFinite(px) && px > 0) return px;
        }
      } catch {}
      cachedCameraScaleFn = null;
    }
    if (cachedCameraZoomKey) {
      const zoom = camera[cachedCameraZoomKey];
      const ppu = cachedCameraPpuKey ? camera[cachedCameraPpuKey] : CAMERA_PPU;
      if (typeof zoom === 'number' && isFinite(zoom) && zoom > 0 &&
          typeof ppu === 'number' && isFinite(ppu) && ppu > 0) return ppu * zoom;
      cachedCameraZoomKey = null;
      cachedCameraPpuKey = null;
    }
    return null;
  }

  // Pixels per world unit, by whatever source is available. The camera is
  // authoritative — it is literally the scale the renderer draws with, so
  // overlays stay glued to the game through a scope-zoom lerp. Without a
  // camera we fall back to the scope radius, which matches survev's own
  // camera math (client/src/game.ts): for screens at 16:9 or wider the
  // viewport collapses to 2*radius world units, and for narrower aspects
  // (e.g. 4:3) it shrinks proportionally. That fallback is only correct in
  // steady state — it is the target zoom, not the lerped one.
  function getPxPerWorldUnit(scope, me, game) {
    const camera = game ? findCameraOnGame(game) : null;
    if (camera) {
      const px = readCameraPxPerUnit(camera);
      if (px) return px;
    }
    const fromPlayer = me ? readZoomRadiusFromPlayer(me, scope) : null;
    const radius = fromPlayer ?? SCOPE_RADIUS_TABLE[scope] ?? SCOPE_RADIUS_TABLE['1xscope'];
    const W = window.innerWidth;
    const H = window.innerHeight;
    const maxScreenDim = Math.max(Math.min(W, H) * (16 / 9), Math.max(W, H));
    return maxScreenDim / (2 * radius);
  }

  // Visible-world width in world units. Downstream callers use this to
  // convert mouse pixel offsets into world coordinates, so getting the
  // aspect right matters.
  function getViewportWorldUnits(scope, me, game) {
    return window.innerWidth / getPxPerWorldUnit(scope, me, game);
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
    cachedCameraScaleFn = null;
    cachedCameraPpuKey = null;
    cachedCameraZoomKey = null;
    cameraScaleProbedAt = 0;
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

  // Same-side test, from two `roster.getPlayerInfo()` records. Asked in one
  // place so the sampler and the name tags can't disagree about who is an
  // enemy: squadmates share a `groupId`, faction teammates share a non-zero
  // `teamId` (0 means "no faction", so it never makes two players allies).
  // With no info for either side the answer is "enemy" — that is the shape
  // the sampler has always had, and an unknown player is one we want to see.
  function isHostileTo(selfInfo, info) {
    const sameGroup =
      selfInfo && info && selfInfo.groupId != null && info.groupId != null && selfInfo.groupId === info.groupId;
    const sameTeam =
      selfInfo && info && selfInfo.teamId != null && info.teamId != null &&
      selfInfo.teamId !== 0 && info.teamId !== 0 && selfInfo.teamId === info.teamId;
    return !(sameGroup || sameTeam);
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
      if (!isHostileTo(selfInfo, info)) continue;

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
    try { ensureElgTab(); refitElgPaneIfVisible(); } catch {}
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
    nameTagTick(found.game);
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

  // What the overlay fades an enemy to when it can't be shot because it is on
  // a layer we can't reach — a bunker while we're aboveground.
  const UNREACHABLE_ALPHA = 0.5;

  // Enemy overlay master switch. Same hoisting reason, same default, as AIMBOT.
  const ESP = {
    enabled: 0,
    // Dim an enemy whose shot line is blocked by map geometry — see the
    // line-of-sight block in the overlay. On by default, but it only shows
    // once the overlay itself is on.
    losDim: 1,
    // Alpha the ring and its connecting line drop to when blocked. Defaults to
    // the wrong-layer fade: both mean "no shot on this one", so they read as
    // the same state rather than as a hierarchy of two different problems.
    blockedAlpha: UNREACHABLE_ALPHA,
  };

  // Bank shots: when the direct line is walled off, look for a one-bounce path
  // off a reflecting surface and aim at that instead. Same hoisting reason, and
  // same off-by-default, as AIMBOT and ESP: with it off a blocked target is
  // simply shot at through the wall, which is worse aim but is also stock
  // behaviour, and the search is the most expensive thing in the aim path.
  const BANK = {
    enabled: 0,
    // Take a bounce even when the direct line is open. Trick-shot mode: worse
    // in every measurable way and much better to watch.
    prefer: 0,
  };

  // Autoshoot: hold the trigger exactly while the shot is on. Rides on the aim
  // helper and only acts while its key is held — see the autoshoot block for
  // what "the shot is on" means. Same hoisting reason, same off-by-default, as
  // AIMBOT and ESP.
  const AUTOSHOOT = {
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

  // ---------------------------------------------------------------------
  // Bullet-blocking geometry
  // ---------------------------------------------------------------------
  //
  // survev has no separate "wall" entity: every solid thing in the world —
  // walls, trees, crates, rocks, barrels, bunker stairwells — is an Obstacle,
  // and buildings/structures carry only ceilings, floors and stair volumes,
  // none of which stop a bullet. So the obstacle pool *is* the bullet
  // collision set (plus players, which we don't treat as cover).
  //
  // The Obstacle class keeps every collision field under a real readable name
  // across re-mangles — `collider`, `collidable`, `dead`, `height`, `layer`,
  // `isWindow`, `isWall`, `isDoor`, `type` — so none of this needs a new
  // mangled.js entry; the only mangled thing on the path is the pool's getAll,
  // which we already have as POOL_GETALL.
  //
  // `collider` is already in world space. The Obstacle rebuilds it on every
  // update as `collider.transform(def.collision, pos, oriToRad(ori), scale)`,
  // and since `ori` is a quarter-turn count, a rotated AABB stays axis
  // aligned — so the only two shapes that ever come back are
  //     { type: 0, pos: {x,y}, rad }          circle
  //     { type: 1, min: {x,y}, max: {x,y} }   aabb
  // A door's `pos`/`ori` are resent when it swings, so its collider tracks the
  // open state for free.
  //
  // Scope: the server only streams objects inside the local player's view
  // radius, so the pool holds what is on screen plus a margin — which is
  // exactly the set a shot at a *visible* enemy can pass through. There is no
  // client-side source for the collision geometry of off-screen map objects
  // (the join-time map message carries type/pos/ori/scale but the per-type
  // `collision` shapes live in bundle-private defs).

  const COLLIDER_CIRCLE = 0;
  const COLLIDER_AABB = 1;
  // GameConfig.bullet.height — an obstacle shorter than this is shot over
  // (`obstacle.height < bullet.height` is the game's own reject test).
  const BULLET_HEIGHT = 0.25;

  // GameConfig.player.radius. A player's centre is always at least this far
  // from any collidable surface — that's what the collision resolution
  // guarantees — so a blocker reported closer than this to our shot origin is
  // one we are *inside*, which no real position can be. That only happens when
  // the origin has been extrapolated into geometry (sprinting at a wall pushes
  // it up to ~2.4 units forward over a 200ms reaction + ping), and without the
  // guard it would read as "blocked" against every enemy on screen.
  const PLAYER_RADIUS = 1;

  // Obstacle types that bounce a bullet instead of just eating it —
  // `reflectBullets` on the obstacle def. Metal walls, barrels, lockers,
  // vault doors, shipping-container walls, appliances.
  //
  // This has to be a static table because the client Obstacle *doesn't keep
  // the flag*: `thAfw` copies `collidable`, `destructible`, `height`,
  // `isWall`, `isWindow`, `isBush` and the door/button blocks off the def and
  // drops the rest, and the def module itself is bundle-private. What the
  // instance does keep is `type`, and type names are content, not identifiers,
  // so they survive re-mangling — unlike everything in mangled.js, this list
  // only goes stale when survev ships new map objects.
  //
  // Derived offline from the definitions chunk in js_dump/ (MapObjectDefs) by
  // evaluating the def factories and reading `reflectBullets` off each merged
  // obstacle def: 724 obstacle defs, all carrying the flag explicitly, 166
  // true. Every one of them is also collidable, non-window and at least
  // bullet-height, i.e. every reflector is a blocker.
  //
  // Reflection is a server decision — the client is only told after the fact,
  // via `reflectCount`/`reflectObjId` on the bullet — and it is capped at
  // GameConfig.bullet.maxReflect (3) with damage decaying by reflectDistDecay
  // (1.5). A player carrying a pan is a reflector too (equipped or stowed, it
  // presents a reflecting segment), but that's a player, not map geometry.
  const REFLECTS_BULLETS = new Set([
    'airdrop_crate_01', 'airdrop_crate_01sv', 'airdrop_crate_01x',
    'airdrop_crate_02', 'airdrop_crate_02de', 'airdrop_crate_02h',
    'airdrop_crate_02sv', 'airdrop_crate_02tr', 'airdrop_crate_02x',
    'airdrop_crate_03', 'airdrop_crate_03dev', 'airdrop_crate_03po',
    'airdrop_crate_04', 'airdrop_crate_04po', 'airdrop_crate_05', 'barrel_01',
    'barrel_01b', 'barrel_01bd', 'barrel_01bh', 'barrel_01f', 'barrel_01w',
    'bathhouse_rocks_01', 'bollard_01', 'cell_door_01', 'class_shell_01',
    'class_shell_02', 'class_shell_03', 'cobalt_wall_int_4',
    'container_05_collider', 'container_wall_side',
    'container_wall_side_open', 'container_wall_top', 'control_panel_01',
    'control_panel_02', 'control_panel_02b', 'control_panel_03',
    'control_panel_04', 'control_panel_06', 'control_panel_07',
    'crossing_door_01', 'deposit_box_01', 'deposit_box_02', 'deposit_box_03',
    'eye_door_01', 'fire_ext_01', 'grill_01', 'hedgehog_wall',
    'house_door_02', 'locker_01', 'locker_02', 'locker_03',
    'metal_wall_column_4x8', 'metal_wall_column_5x12', 'metal_wall_ext_10',
    'metal_wall_ext_12', 'metal_wall_ext_12_5', 'metal_wall_ext_13',
    'metal_wall_ext_16', 'metal_wall_ext_18', 'metal_wall_ext_2',
    'metal_wall_ext_23', 'metal_wall_ext_2x2', 'metal_wall_ext_3',
    'metal_wall_ext_4', 'metal_wall_ext_43', 'metal_wall_ext_5',
    'metal_wall_ext_6', 'metal_wall_ext_7', 'metal_wall_ext_8',
    'metal_wall_ext_9', 'metal_wall_ext_short_6', 'metal_wall_ext_short_7',
    'metal_wall_ext_thick_12', 'metal_wall_ext_thick_16',
    'metal_wall_ext_thick_20', 'metal_wall_ext_thick_23',
    'metal_wall_ext_thick_28', 'metal_wall_ext_thick_5',
    'metal_wall_ext_thick_6', 'metal_wall_ext_thick_8',
    'metal_wall_ext_thicker_10', 'metal_wall_ext_thicker_11',
    'metal_wall_ext_thicker_12', 'metal_wall_ext_thicker_13',
    'metal_wall_ext_thicker_14', 'metal_wall_ext_thicker_15',
    'metal_wall_ext_thicker_16', 'metal_wall_ext_thicker_17',
    'metal_wall_ext_thicker_18', 'metal_wall_ext_thicker_19',
    'metal_wall_ext_thicker_1_5', 'metal_wall_ext_thicker_20',
    'metal_wall_ext_thicker_21', 'metal_wall_ext_thicker_22',
    'metal_wall_ext_thicker_23', 'metal_wall_ext_thicker_24',
    'metal_wall_ext_thicker_25', 'metal_wall_ext_thicker_26',
    'metal_wall_ext_thicker_27', 'metal_wall_ext_thicker_28',
    'metal_wall_ext_thicker_29', 'metal_wall_ext_thicker_30',
    'metal_wall_ext_thicker_32', 'metal_wall_ext_thicker_34',
    'metal_wall_ext_thicker_35', 'metal_wall_ext_thicker_4',
    'metal_wall_ext_thicker_42', 'metal_wall_ext_thicker_48',
    'metal_wall_ext_thicker_49', 'metal_wall_ext_thicker_5',
    'metal_wall_ext_thicker_6', 'metal_wall_ext_thicker_7',
    'metal_wall_ext_thicker_8', 'metal_wall_ext_thicker_9', 'oven_01',
    'power_box_01', 'propane_01', 'recorder_01', 'recorder_02', 'recorder_03',
    'recorder_04', 'recorder_05', 'recorder_06', 'recorder_07', 'recorder_08',
    'recorder_09', 'recorder_10', 'recorder_11', 'recorder_12', 'recorder_13',
    'recorder_14', 'refrigerator_01', 'refrigerator_01b', 'silo_01',
    'silo_01po', 'stove_01', 'stove_02', 'switch_01', 'switch_01o',
    'switch_01p', 'switch_01y', 'switch_02', 'switch_03', 'toilet_03',
    'toilet_04', 'toilet_05', 'vault_door_bathhouse', 'vault_door_chrys_01',
    'vault_door_chrys_02', 'vault_door_eye', 'vault_door_main',
    'vault_door_reserve', 'vending_01', 'warehouse_column',
    'warehouse_wall_edge', 'warehouse_wall_edge_2', 'warehouse_wall_int',
    'warehouse_wall_side', 'wheel_01', 'wheel_02', 'wheel_03',
    'workshop_wall_edge', 'workshop_wall_mid_1', 'workshop_wall_mid_2',
    'workshop_wall_mid_3', 'workshop_wall_right',
  ]);

  // Does a bullet bounce off this obstacle? Note this says nothing about
  // whether the bullet gets *through*: a reflector is still solid, so it
  // blocks the original line either way. What it changes is what happens
  // after — a shot into one comes back out at the mirror angle rather than
  // dying there, so a reflector between us and a target is cover that shoots
  // back, and the near face of one is a place to bank a shot from.
  function reflectsBullets(o) {
    return !!o && REFLECTS_BULLETS.has(o.type);
  }

  // survev's util.sameLayer, which is what the bullet path actually tests
  // against — deliberately *not* canInteract above. They disagree for a
  // shooter on a stairs layer: canInteract says a player on 2/3 can engage
  // anything, but sameLayer(2, 1) is false, so ground-floor obstacles are the
  // ones that block them.
  function sameLayerAs(a, b) {
    const x = Number.isFinite(a) ? a : 0;
    const y = Number.isFinite(b) ? b : 0;
    return (x & 1) === (y & 1) || Boolean(x & 2 && y & 2);
  }

  function looksLikeGameMap(v) {
    try {
      return !!v && typeof v === 'object' &&
        'deadObstacleIds' in v && 'mapLoaded' in v && 'terrain' in v && 'mapDef' in v;
    } catch {
      return false;
    }
  }

  // An Obstacle, by the readable fields its class declares. `collider` alone
  // isn't enough — Loot and DeadBody carry one too — but the door/window/bush
  // trio is unique to Obstacle.
  function looksLikeObstacle(v) {
    try {
      return !!v && typeof v === 'object' &&
        'collider' in v && 'collidable' in v && 'isWindow' in v && 'isBush' in v;
    } catch {
      return false;
    }
  }

  let cachedMapKey = null;
  let cachedObstaclePoolKey = null;

  // `map` is a real readable field on the Game class (`this.map = new gn(...)`),
  // so the fast path is a direct read; the own-prop scan is there for the build
  // where that stops being true.
  function findMapOnGame(game) {
    if (!game || typeof game !== 'object') return null;
    try {
      if (looksLikeGameMap(game.map)) return game.map;
      if (cachedMapKey) {
        const m = game[cachedMapKey];
        if (looksLikeGameMap(m)) return m;
        cachedMapKey = null;
      }
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        const v = game[names[i]];
        if (looksLikeGameMap(v)) {
          cachedMapKey = names[i];
          return v;
        }
      }
    } catch {}
    return null;
  }

  // The map holds three entity pools under mangled names — obstacles,
  // buildings, structures — so we identify the obstacle one by what its
  // entries are rather than by what it's called. That needs the pool to hold
  // at least one live obstacle, which in a running match it always does; until
  // then this returns null and the caller reports no geometry rather than
  // wrong geometry.
  function findObstaclePool(map) {
    if (!map || typeof map !== 'object') return null;
    const isObstaclePool = (v) => {
      if (!v || typeof v !== 'object' || typeof v[POOL_GETALL] !== 'function') return false;
      const all = v[POOL_GETALL]();
      if (!Array.isArray(all) || !all.length) return false;
      return looksLikeObstacle(all[0]);
    };
    try {
      if (cachedObstaclePoolKey) {
        const p = map[cachedObstaclePoolKey];
        if (isObstaclePool(p)) return p;
        cachedObstaclePoolKey = null;
      }
      const names = Object.getOwnPropertyNames(map);
      for (let i = 0; i < names.length; i++) {
        if (isObstaclePool(map[names[i]])) {
          cachedObstaclePoolKey = names[i];
          return map[names[i]];
        }
      }
    } catch {}
    return null;
  }

  // The pool's getAll returns its raw backing array, recycled-but-inactive
  // entries included — hence the `active` filter the game itself applies at
  // every call site.
  function getObstacles() {
    const map = findMapOnGame(capturedGame);
    if (!map) return [];
    const pool = findObstaclePool(map);
    if (!pool) return [];
    const all = pool[POOL_GETALL]();
    return Array.isArray(all) ? all : [];
  }

  // The game's own reject test for "can a bullet fired on `layer` stop against
  // this obstacle", lifted from the bullet/tracer collision path.
  function blocksBullets(o, layer) {
    return !!o && o.active && !o.dead && o.collidable && !o.isWindow &&
      o.height >= BULLET_HEIGHT && !!o.collider && sameLayerAs(layer, o.layer);
  }

  // Ports of collider.intersectSegment's two branches, returning the distance
  // from p0 to the entry point (the direction is normalized, so the parameter
  // *is* the distance) or null. Kept faithful to the game's arithmetic,
  // epsilons included, so a hit here is a hit there.
  function segHitCircle(x0, y0, x1, y1, cx, cy, rad) {
    let dx = x1 - x0;
    let dy = y1 - y0;
    const len = Math.max(Math.hypot(dx, dy), 1e-6);
    dx /= len; dy /= len;
    const ox = x0 - cx;
    const oy = y0 - cy;
    const s = ox * dx + oy * dy;
    const c = ox * ox + oy * oy - rad * rad;
    if (c > 0 && s > 0) return null;
    const disc = s * s - c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    let t = -s - sq;
    if (t < 0) t = -s + sq;
    return t <= len ? t : null;
  }

  function segHitAabb(x0, y0, x1, y1, minX, minY, maxX, maxY) {
    const EPS = 1e-5;
    let tMin = 0;
    let tMax = Number.MAX_VALUE;
    let dx = x1 - x0;
    let dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len > EPS) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
    let ax = Math.abs(dx);
    let ay = Math.abs(dy);
    // A segment exactly parallel to an axis would divide by zero on that axis;
    // the game nudges the component instead of special-casing the slab.
    if (ax < EPS) { dx = EPS * 2; ax = dx; }
    if (ay < EPS) { dy = EPS * 2; ay = dy; }
    const t1x = (minX - x0) / dx;
    const t2x = (maxX - x0) / dx;
    tMin = Math.max(tMin, Math.min(t1x, t2x));
    tMax = Math.min(tMax, Math.max(t1x, t2x));
    if (tMin > tMax) return null;
    const t1y = (minY - y0) / dy;
    const t2y = (maxY - y0) / dy;
    tMin = Math.max(tMin, Math.min(t1y, t2y));
    tMax = Math.min(tMax, Math.max(t1y, t2y));
    if (tMin > tMax) return null;
    if (tMin > len) return null;
    return tMin;
  }

  function segHitCollider(x0, y0, x1, y1, col) {
    if (!col) return null;
    if (col.type === COLLIDER_AABB) {
      const { min, max } = col;
      if (!min || !max) return null;
      return segHitAabb(x0, y0, x1, y1, min.x, min.y, max.x, max.y);
    }
    if (col.type === COLLIDER_CIRCLE) {
      const p = col.pos;
      if (!p) return null;
      return segHitCircle(x0, y0, x1, y1, p.x, p.y, col.rad);
    }
    return null;
  }

  // Nearest bullet-blocking obstacle along the segment, or null for a clear
  // line. Reads the pool directly and allocates nothing per obstacle, so it's
  // safe to call per target per frame.
  //
  // `minDist` drops hits closer than that to the origin: a shot origin sitting
  // inside a collider (hugging a wall, or the barrel offset pushing the muzzle
  // into one) otherwise reports distance 0 and reads as blocked forever.
  // Broad phase: does the collider's bounding box overlap the segment's? Four
  // comparisons that reject the great majority of a streamed-in pool before
  // the exact test runs, which is what makes a per-enemy-per-frame call cheap.
  function colliderNearSegment(col, loX, loY, hiX, hiY) {
    if (col.type === COLLIDER_AABB) {
      return col.max.x >= loX && col.min.x <= hiX && col.max.y >= loY && col.min.y <= hiY;
    }
    const r = col.rad;
    return col.pos.x + r >= loX && col.pos.x - r <= hiX &&
           col.pos.y + r >= loY && col.pos.y - r <= hiY;
  }

  function firstBulletHit(x0, y0, x1, y1, layer, minDist = 0) {
    const obstacles = getObstacles();
    const loX = Math.min(x0, x1), hiX = Math.max(x0, x1);
    const loY = Math.min(y0, y1), hiY = Math.max(y0, y1);
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!blocksBullets(o, layer)) continue;
      if (!colliderNearSegment(o.collider, loX, loY, hiX, hiY)) continue;
      const d = segHitCollider(x0, y0, x1, y1, o.collider);
      if (d === null || d < minDist || d >= bestDist) continue;
      bestDist = d;
      best = o;
    }
    if (!best) return null;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    return {
      id: Number(best.__id ?? 0),
      type: best.type,
      reflects: reflectsBullets(best),
      dist: bestDist,
      x: x0 + ((x1 - x0) / len) * bestDist,
      y: y0 + ((y1 - y0) / len) * bestDist,
    };
  }

  // Same sweep, but it only has to answer yes/no, so it stops at the first
  // blocker instead of sorting for the nearest.
  //
  // `exclude` drops one obstacle from consideration. That's for the legs of a
  // bank shot, which start or end *on* a reflector's surface and would
  // otherwise always report it as blocking them.
  function hasLineOfSight(x0, y0, x1, y1, layer, minDist = 0, exclude = null) {
    const obstacles = getObstacles();
    const loX = Math.min(x0, x1), hiX = Math.max(x0, x1);
    const loY = Math.min(y0, y1), hiY = Math.max(y0, y1);
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (o === exclude) continue;
      if (!blocksBullets(o, layer)) continue;
      if (!colliderNearSegment(o.collider, loX, loY, hiX, hiY)) continue;
      const d = segHitCollider(x0, y0, x1, y1, o.collider);
      if (d !== null && d >= minDist) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // One-bounce (bank) shots
  // ---------------------------------------------------------------------
  //
  // When the direct line is walled off, a reflector can still carry the shot:
  // survev bounces bullets off `reflectBullets` surfaces (see the table
  // above), so a metal wall you can see is a shot at someone you can't.
  //
  // The mirror trick makes the geometry a straight line. Reflecting the
  // *target* across the plane of a face turns the two-leg path into one
  // segment: where P->E' crosses the plane is exactly the point a bullet
  // aimed at E' bounces from to arrive at E, and |P - E'| is the whole path
  // length. So aiming at the mirrored target *is* aiming at the bounce, and
  // the number the lead solver wants for flight time falls out of the same
  // construction.
  //
  // Only axis-aligned faces are candidates. A collider is either an AABB or a
  // circle, and a circle has no mirror plane — the reflection point is the
  // root of a quartic (Alhazen's problem), so those are skipped for now and a
  // barrel or a tree never offers a bank.
  // Scratch for the candidate list, reused so a per-frame search doesn't churn.
  const bankCandidates = [];
  // How many faces get the expensive treatment. Candidates are tried
  // shortest-path-first, so this bounds the cost of a scene where nothing
  // works — a room full of metal walls with every bounce blocked would
  // otherwise run two line-of-sight sweeps per face before giving up — while
  // only ever discarding long-way-round shots nobody wants to take anyway.
  const BANK_MAX_CANDIDATES = 12;
  // And how far around the houses the shot is allowed to go, as a multiple of
  // the direct distance. A bounce is always longer than the shot it replaces,
  // and survev decays a reflected bullet's damage over that extra distance
  // (`reflectDistDecay`), so a path several times the direct one arrives late,
  // weak, and on a lead that has long stopped being a prediction. Rejecting
  // those early is most of what keeps a crowded room cheap.
  const BANK_MAX_PATH_MULT = 3;

  // barrel_01's collision radius, and the smallest circle worth banking off:
  // two of them.
  //
  // A curved mirror's sensitivity goes as 1/r. Move the bounce point along a
  // circle by a hair and the surface normal turns by that distance over the
  // radius, and the outgoing leg turns by twice that — so on a barrel every
  // centimetre of error in where the bullet actually meets the surface swings
  // the far leg by about two thirds of a degree, and neither the lead nor the
  // extrapolated origin is anywhere near that accurate. A flat face has no
  // such term at all, which is why only circles need a size floor. The check
  // is against the *live* collider, so a damaged silo that has shrunk below
  // the floor stops qualifying, which is correct — it really has got harder.
  const BARREL_RADIUS = 1.75;
  const BANK_MIN_CIRCLE_RAD = 2 * BARREL_RADIUS;

  const BANK_FACE = 0;
  const BANK_CIRCLE = 1;

  // Signed shortest-arc difference between two bearings, in radians. Used by
  // the circle bounce below and by autoshoot's "has the crosshair arrived yet"
  // test.
  function angleDelta(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // The shortest one-bounce path from (fromX, fromY) to a moving target.
  //
  // `at(travelMs)` returns the target's lead point for a given flight time, so
  // path length and lead are solved together: a different surface means a
  // different path length means a different lead, which is why each candidate
  // runs its own fixed point before it is validated rather than the search
  // running once against a single guessed lead.
  //
  // Candidates are tried shortest-path-first and the first one that survives
  // validation wins, so the expensive part — two line-of-sight sweeps — runs
  // once or twice in the normal case rather than over every surface.
  //
  // Returns { x, y, rx, ry, dist, obstacle } where (x, y) is the point to aim
  // at, (rx, ry) is where the bullet meets the surface, and `dist` is the
  // total path length. Null when nothing works.
  function bankSolve(fromX, fromY, layer, at, bulletSpeed, minDist) {
    const t0 = at(0);
    const obstacles = getObstacles();
    const maxPath = Math.hypot(t0.x - fromX, t0.y - fromY) * BANK_MAX_PATH_MULT;
    bankCandidates.length = 0;

    // Cheap pass: geometry only, against the un-refined lead point. Anything
    // that fails here cannot be rescued by a better flight time.
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!blocksBullets(o, layer) || !reflectsBullets(o)) continue;
      const col = o.collider;

      if (col.type === COLLIDER_CIRCLE) {
        if (col.rad < BANK_MIN_CIRCLE_RAD) continue;
        // Cheapest possible reject first: no path touching this circle can be
        // shorter than reaching its near side and leaving from it.
        const pl = Math.hypot(fromX - col.pos.x, fromY - col.pos.y);
        const el = Math.hypot(t0.x - col.pos.x, t0.y - col.pos.y);
        if (pl - col.rad + el - col.rad > maxPath) continue;
        const hit = circleBounce(fromX, fromY, t0.x, t0.y, col.pos.x, col.pos.y, col.rad);
        if (!hit || hit.dist > maxPath) continue;
        bankCandidates.push({
          kind: BANK_CIRCLE, o, cx: col.pos.x, cy: col.pos.y, rad: col.rad, dist: hit.dist,
        });
        continue;
      }

      const { min, max } = col;
      for (let f = 0; f < 4; f++) {
        // f 0,1: the planes x = min.x / x = max.x, spanning y.
        // f 2,3: the planes y = min.y / y = max.y, spanning x.
        const axis = f >> 1;
        const nrm = (f & 1) ? 1 : -1;
        const c = axis === 0 ? (nrm > 0 ? max.x : min.x) : (nrm > 0 ? max.y : min.y);
        const lo = axis === 0 ? min.y : min.x;
        const hi = axis === 0 ? max.y : max.x;
        // Both ends have to sit on the outside of the plane. A specular
        // bounce cannot reach a target behind the surface it bounces off,
        // and this is also what rules out the box's three other faces.
        const pOut = axis === 0 ? fromX - c : fromY - c;
        const tOut = axis === 0 ? t0.x - c : t0.y - c;
        if (pOut * nrm <= 0 || tOut * nrm <= 0) continue;
        const hit = mirrorCross(fromX, fromY, t0.x, t0.y, axis, c, lo, hi);
        if (!hit || hit.dist > maxPath) continue;
        bankCandidates.push({ kind: BANK_FACE, o, axis, c, lo, hi, nrm, dist: hit.dist });
      }
    }
    if (!bankCandidates.length) return null;
    bankCandidates.sort((a, b) => a.dist - b.dist);

    const tried = Math.min(bankCandidates.length, BANK_MAX_CANDIDATES);
    for (let i = 0; i < tried; i++) {
      const cand = bankCandidates[i];
      // Same fixed point the direct solve uses, over this candidate's path
      // length: each pass shrinks the residual by the target-to-bullet speed
      // ratio. It ends with `hit` and `tp` consistent, so what gets validated
      // below is the settled geometry — the target may well have moved off a
      // face's extent, or around behind the surface, while the lead converged.
      let tp = t0;
      let hit = bankSolveOne(cand, fromX, fromY, tp.x, tp.y);
      for (let pass = 0; pass < 3 && hit; pass++) {
        tp = at(hit.dist / bulletSpeed * 1000);
        hit = bankSolveOne(cand, fromX, fromY, tp.x, tp.y);
      }
      if (!hit) continue;

      // Both legs have to be clear of everything else. The reflector itself is
      // excluded from both, since both touch it by construction.
      //
      // Nothing here needs to re-check that the bullet meets *this* face of
      // the reflector rather than another one of the same box: the side test
      // put P strictly outside the face's plane and mirrorCross put R inside
      // the face's extent, so the whole incoming leg lies in that plane's
      // outside half-space and can only touch the box at R. (Probed over 54k
      // random candidates: an explicit entry-point check never once caught a
      // real case, and rejected 5% of valid ones on the floating-point tie of
      // a segment ending exactly on a boundary.) A circle is convex and the
      // bounce point is on the arc both ends can see, so the same holds there.
      if (!hasLineOfSight(fromX, fromY, hit.rx, hit.ry, layer, minDist, cand.o)) continue;
      if (!hasLineOfSight(hit.rx, hit.ry, tp.x, tp.y, layer, 0, cand.o)) continue;

      return {
        x: hit.ax, y: hit.ay,
        rx: hit.rx, ry: hit.ry,
        dist: hit.dist,
        obstacle: cand.o,
      };
    }
    return null;
  }

  // One candidate against one target point. Returns the bounce point, the
  // total path length, and the point to aim at — for a face that's the
  // mirrored target, for a circle it's the bounce point itself. Both give the
  // same bearing, which is all the game is ever told: a circle has no mirror
  // plane, but the bullet still leaves along P->R either way.
  function bankSolveOne(cand, fromX, fromY, tx, ty) {
    if (cand.kind === BANK_CIRCLE) {
      const hit = circleBounce(fromX, fromY, tx, ty, cand.cx, cand.cy, cand.rad);
      if (!hit) return null;
      return { rx: hit.rx, ry: hit.ry, dist: hit.dist, ax: hit.rx, ay: hit.ry };
    }
    const hit = mirrorCross(fromX, fromY, tx, ty, cand.axis, cand.c, cand.lo, cand.hi);
    if (!hit) return null;
    const tOut = cand.axis === 0 ? tx - cand.c : ty - cand.c;
    if (tOut * cand.nrm <= 0) return null;
    return { rx: hit.rx, ry: hit.ry, dist: hit.dist, ax: hit.mx, ay: hit.my };
  }

  // Mirror (tx, ty) across the plane (axis, c), then intersect the straight
  // line from (x0, y0) to that mirror with the plane. Returns the mirrored
  // point, the crossing, and the total path length |P - E'| — or null if the
  // line runs parallel to the plane, crosses outside the segment, or crosses
  // beyond the face's finite extent [lo, hi].
  function mirrorCross(x0, y0, tx, ty, axis, c, lo, hi) {
    const mx = axis === 0 ? 2 * c - tx : tx;
    const my = axis === 0 ? ty : 2 * c - ty;
    const dx = mx - x0;
    const dy = my - y0;
    const denom = axis === 0 ? dx : dy;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((axis === 0 ? c - x0 : c - y0)) / denom;
    if (!(t > 0 && t < 1)) return null;
    const rx = x0 + dx * t;
    const ry = y0 + dy * t;
    const along = axis === 0 ? ry : rx;
    if (along < lo || along > hi) return null;
    return { mx, my, rx, ry, dist: Math.hypot(dx, dy) };
  }

  // Bisection steps for the circle bounce. The search arc is at most half the
  // circle, so 28 halvings put it under 1e-8 rad — a nanometre of arc on a
  // barrel, and far below what the lead itself is accurate to.
  const CIRCLE_BOUNCE_ITERS = 28;

  // Where a bullet bounces off a reflecting circle: the point R on it whose
  // radius bisects the angle P-R-E. That is the reflection law written for a
  // curved mirror — the normal anywhere on a circle *is* its radius, and a
  // specular bounce puts the normal exactly between the incoming and outgoing
  // rays, so the bisector condition and "angle in equals angle out" are the
  // same statement.
  //
  // This is Alhazen's problem, which has no closed form worth having (it
  // reduces to a quartic), so it is solved numerically. In circle-centred
  // coordinates with R(θ) = C + r(cosθ, sinθ) and
  //     u = normalize(P - R),  v = normalize(E - R),  n = (cosθ, sinθ)
  // "the radius bisects" says u + v points along n, so the root to find is
  //     f(θ) = cross(u + v, n) = 0
  //
  // The visibility condition is what makes that tractable rather than a
  // quartic root-finding exercise. R can only be a bounce point if both ends
  // can see it, and R is visible from P exactly when
  // |θ - bearing(P)| < acos(r / |P - C|). Each constraint is therefore an arc
  // centred on that point's bearing and less than half the circle wide, so
  // their intersection is a single arc, and f changes sign exactly once across
  // it. Bisecting that arc converges on the one bounce that physically exists
  // and never meets the quartic's other roots, which live on the arcs facing
  // away from one end or the other.
  function circleBounce(px, py, ex, ey, cx, cy, rad) {
    const pdx = px - cx, pdy = py - cy;
    const edx = ex - cx, edy = ey - cy;
    const pl = Math.hypot(pdx, pdy);
    const el = Math.hypot(edx, edy);
    // A point inside the circle has no exterior bounce. (Neither end should
    // ever be inside — a player can't stand in a barrel — but the extrapolated
    // origin can be, and acos of a ratio over 1 is NaN.)
    if (!(pl > rad) || !(el > rad)) return null;

    const bearP = Math.atan2(pdy, pdx);
    // The two visibility arcs, measured relative to P's bearing so the wrap is
    // handled once. Both are narrower than half the circle, so this intersects
    // as a plain interval — the wrapped part of E's arc can never reach back
    // around into P's.
    const half = angleDelta(Math.atan2(edy, edx), bearP);
    let lo = Math.max(-Math.acos(rad / pl), half - Math.acos(rad / el));
    let hi = Math.min(Math.acos(rad / pl), half + Math.acos(rad / el));
    if (!(hi > lo)) return null;

    const f = (s) => {
      const th = bearP + s;
      const nx = Math.cos(th), ny = Math.sin(th);
      const rx = cx + rad * nx, ry = cy + rad * ny;
      let ux = px - rx, uy = py - ry;
      let vx = ex - rx, vy = ey - ry;
      const ul = Math.hypot(ux, uy) || 1e-9;
      const vl = Math.hypot(vx, vy) || 1e-9;
      ux /= ul; uy /= ul; vx /= vl; vy /= vl;
      return (ux + vx) * ny - (uy + vy) * nx;
    };

    // Step just inside the tangent points: exactly on one the incoming ray
    // grazes the surface, which is a degenerate bounce, not a shot.
    const inset = (hi - lo) * 1e-6;
    lo += inset;
    hi -= inset;
    let flo = f(lo);
    let fhi = f(hi);
    if (!(flo === 0 || fhi === 0 || (flo < 0) !== (fhi < 0))) return null;

    let mid = lo;
    for (let i = 0; i < CIRCLE_BOUNCE_ITERS; i++) {
      mid = (lo + hi) * 0.5;
      const fm = f(mid);
      if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else { hi = mid; fhi = fm; }
    }

    const th = bearP + mid;
    const rx = cx + rad * Math.cos(th);
    const ry = cy + rad * Math.sin(th);
    return {
      rx, ry,
      dist: Math.hypot(rx - px, ry - py) + Math.hypot(ex - rx, ey - ry),
    };
  }

  // Plain-object snapshot of the collision set, for inspection and for drawing.
  // Copies the numbers out because the Obstacle replaces its `collider` object
  // wholesale on every update, so a held reference silently goes stale.
  // Pass a layer to get only what would block a shot fired on it; omit it for
  // everything the pool currently holds, with `blocksBullets` then answered
  // against the local player's own layer.
  function bulletColliders(layer) {
    const wantAll = !Number.isFinite(layer);
    const me = wantAll && capturedGame ? findLocalPlayerOnGame(capturedGame) : null;
    const refLayer = wantAll ? (Number.isFinite(me?.layer) ? me.layer : 0) : layer;
    const out = [];
    for (const o of getObstacles()) {
      if (!o || !o.active) continue;
      if (!wantAll && !blocksBullets(o, refLayer)) continue;
      const c = o.collider;
      if (!c) continue;
      const shape = c.type === COLLIDER_AABB
        ? { kind: 'aabb', minX: c.min.x, minY: c.min.y, maxX: c.max.x, maxY: c.max.y }
        : { kind: 'circle', x: c.pos.x, y: c.pos.y, rad: c.rad };
      out.push({
        id: Number(o.__id ?? 0),
        type: o.type,
        layer: Number.isFinite(o.layer) ? o.layer : 0,
        height: o.height,
        dead: !!o.dead,
        collidable: !!o.collidable,
        isWall: !!o.isWall,
        isWindow: !!o.isWindow,
        isDoor: !!o.isDoor,
        isBush: !!o.isBush,
        blocksBullets: blocksBullets(o, refLayer),
        reflectsBullets: reflectsBullets(o),
        shape,
      });
    }
    return out;
  }

  // Console handle: `__wallDiag()` for a one-line state read, and the raw
  // helpers for poking at the geometry from devtools.
  window.__bulletGeom = {
    list: bulletColliders,
    firstHit: firstBulletHit,
    los: hasLineOfSight,
    obstacles: getObstacles,
    reflects: reflectsBullets,
    reflectorTypes: REFLECTS_BULLETS,
    // Bank solve against a stationary point, for poking at the geometry from
    // devtools. The aim path calls bankSolve directly with a lead function.
    bank: (x0, y0, tx, ty, layer = 0, minDist = PLAYER_RADIUS) =>
      bankSolve(x0, y0, layer, () => ({ x: tx, y: ty }), 1e8, minDist),
  };
  window.__wallDiag = () => {
    const map = findMapOnGame(capturedGame);
    const pool = map ? findObstaclePool(map) : null;
    const all = pool ? (pool[POOL_GETALL]() || []) : [];
    const me = capturedGame ? findLocalPlayerOnGame(capturedGame) : null;
    const layer = Number.isFinite(me?.layer) ? me.layer : 0;
    return {
      gameCaptured: !!capturedGame,
      mapFound: !!map,
      mapKey: cachedMapKey,
      poolFound: !!pool,
      poolKey: cachedObstaclePoolKey,
      pooled: all.length,
      active: all.filter((o) => o && o.active).length,
      blockingOnMyLayer: all.filter((o) => blocksBullets(o, layer)).length,
      reflectingOnMyLayer: all.filter((o) => blocksBullets(o, layer) && reflectsBullets(o)).length,
      reflectingTypes: [...new Set(all
        .filter((o) => blocksBullets(o, layer) && reflectsBullets(o))
        .map((o) => o.type))],
      myLayer: layer,
    };
  };

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
    // How long a just-killed enemy stays in play after dying, in ms. Inside
    // that window it counts as a live player in every respect — it competes
    // for "nearest the cursor" on equal terms and gets shot at like anything
    // else — and once the timer is up it drops out entirely.
    deadLingerMs: 600,
    // How much of the measured round trip to lead by, as a fraction. The state
    // we can see is one one-way delay old and a shot fired now arrives one
    // one-way delay later, so an un-compensated server resolves the shot
    // against a world a full RTT ahead of anything on screen — hence 1. Drop
    // to 0 against a server that rewinds (lag compensation), where the shot is
    // judged against the world we actually saw and any ping lead is overshoot.
    pingLeadK: 1,
  };
  // id -> Date.now() when the enemy was first seen dead, so the linger window
  // is measured from the death rather than restarted every frame.
  const deadSince = new Map();

  // Players the aim path must never engage, as the raw text of the MOD tab's
  // box: one name per line, kept verbatim so what the user typed is what comes
  // back. Hoisted with the other stores because SETTINGS_SPECS binds a row to
  // it. Empty by default — nobody is spared until a name is put here.
  const AIM_WHITELIST = {
    names: '',
  };

  // Longest whitelist accepted from localStorage, and the cap the box enforces
  // as it is typed. Nothing about the feature needs a limit; the stored entry
  // does, since it is hand-editable and is parsed back into a set on load.
  const WHITELIST_MAX_CHARS = 4000;

  // Derived lookup set, rebuilt only when the text actually changes: this is
  // asked once per enemy per frame, and the text changes at typing speed.
  let whitelistCache = { text: null, set: new Set() };

  function whitelistSet() {
    const text = typeof AIM_WHITELIST.names === 'string' ? AIM_WHITELIST.names : '';
    if (whitelistCache.text === text) return whitelistCache.set;
    const set = new Set();
    for (const line of text.split('\n')) {
      const name = line.trim().toLowerCase();
      if (name) set.add(name);
    }
    whitelistCache = { text, set };
    return set;
  }

  // Is this someone we've promised not to shoot? Matched on the trimmed line,
  // case-insensitively: the name is being retyped from memory rather than
  // copied out of the game, and survev won't hand out two names that differ
  // only in case anyway.
  function isWhitelistedName(name) {
    if (typeof name !== 'string' || !name) return false;
    const set = whitelistSet();
    if (!set.size) return false;
    return set.has(name.trim().toLowerCase());
  }

  // Is this enemy someone the aim path should be dealing with at all?
  //
  // Not on the whitelist, and alive — or dead and still inside
  // AIM_HUMAN.deadLingerMs. Inside that window
  // a corpse is treated exactly as a live player — same candidacy for "nearest
  // the cursor", same shot solve, same trigger — which is the point: the kill
  // often lands before the last of the burst does, and dropping the target the
  // instant the server says "dead" throws away shots that were already on
  // their way to being useful.
  //
  // Every part of the aim path asks this one question rather than testing
  // `e.dead` itself, so target selection, the overlay's marker and autoshoot
  // cannot disagree about whether a body is still in play.
  function isEngageable(e, now) {
    if (!e) return false;
    // A whitelisted name is never engaged, alive or dead: the aim path behaves
    // as though they were not on the field at all. Asked here rather than at
    // each call site so target selection, the overlay's green marker and
    // autoshoot all honour it from one test — the same reason the linger
    // window lives here.
    if (isWhitelistedName(e.name)) return false;
    if (!e.dead) { deadSince.delete(e.id); return true; }
    if (!deadSince.has(e.id)) deadSince.set(e.id, now);
    return now - deadSince.get(e.id) < AIM_HUMAN.deadLingerMs;
  }

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
  // a scope-zoom lerp the game's rendered scale slides across ~0.3-1s of
  // frames; we re-read the camera's live scale per frame so overlays stay
  // glued to whatever the user sees instead of jumping at each new sample.
  // Falls back to the sample's cached viewportWorldUnits before the camera
  // is located, and to an arbitrary default before a sample exists.
  function getLivePxPerWorldUnit(sample) {
    const game = capturedGame;
    if (game) {
      const cam = findCameraOnGame(game);
      if (cam) {
        const px = readCameraPxPerUnit(cam);
        if (px) return px;
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
      if (!isEngageable(e, now)) continue;
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

    // Is that shot actually available? The layer to test on is our own, since
    // that is the layer the bullet is fired on.
    const layer = player.layer;
    const directClear = hasLineOfSight(
      from.x, from.y, hit.x, hit.y, layer, PLAYER_RADIUS,
    );
    // Walled off: go looking for a bounce. The mirrored point comes back as
    // the thing to aim at, so everything downstream — the glide, the bearing,
    // the overlay — needs no idea that this shot is going the long way round.
    //
    // `prefer` looks for one even when the direct line is wide open, which
    // turns the fallback into a trick-shot mode: the bounce is taken whenever
    // the geometry offers one inside BANK_MAX_PATH_MULT, and only a target
    // with no usable surface anywhere near it gets shot at straight. It is
    // strictly worse aim — a longer flight, a bigger lead, and the damage
    // decay survev applies to a reflected bullet — so it is worth turning on
    // because it is funny, not because it is good.
    const bank = (BANK.enabled && (BANK.prefer || !directClear))
      ? bankSolve(from.x, from.y, layer, at, bulletSpeed, PLAYER_RADIUS)
      : null;
    if (bank) {
      return {
        x: bank.x, y: bank.y, fromX: from.x, fromY: from.y,
        blocked: false, bank,
      };
    }
    return {
      x: hit.x, y: hit.y, fromX: from.x, fromY: from.y,
      blocked: !directClear, bank: null,
    };
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

    // Whoever is nearest the cursor, every frame — no commitment, no carrying
    // a target through a kill. If they can't actually be shot, the aim helper
    // does nothing at all rather than dragging the crosshair onto someone
    // unreachable: `blocked` is the solver's own verdict, meaning no clear
    // line and no bounce either.
    const [enemy] = pickTarget(player, enemies, now);
    const tgt = enemy ? reactionTarget(player, enemy, now) : null;
    const engage = !!tgt && !tgt.blocked;

    if (engage) {
      aimState.targetId = enemy.id;
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
      // Hand the cursor back. Dropping the glide anchor matters: without it,
      // re-engaging would sweep the crosshair across from wherever the last
      // target stood instead of starting from where the mouse is now.
      aimState.targetId = null;
      aimState.aimX = null;
      aimState.aimY = null;
    }

    let x;
    let y;
    if (engage) {
      x = Math.round(window.innerWidth / 2 + Math.cos(aimState.theta) * AIM_CURSOR_RADIUS);
      y = Math.round(window.innerHeight / 2 - Math.sin(aimState.theta) * AIM_CURSOR_RADIUS);
    } else {
      // The user's own cursor, replayed. Their real mousemoves are being
      // swallowed for as long as the key is held, so the game sees only what
      // we send it — sending their position straight back is what "no aimbot"
      // has to mean here. Before they have ever moved the mouse there is no
      // position to replay, so nothing is sent and the game keeps the aim it
      // already had.
      if (!realMouse.hasMoved) return;
      x = Math.round(realMouse.x);
      y = Math.round(realMouse.y);
    }
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

  // True while the caret is in one of our own multi-line boxes. This listener
  // is capture-phase on window, so it runs *before* the event reaches the box
  // and cannot be stopped from there — it has to ask. Without it, a bind on a
  // printable key (or Shift, the default) would engage the aimbot mid-word and
  // swallow the character with its preventDefault.
  function typingInElgField() {
    const el = document.activeElement;
    return !!el && el.tagName === 'TEXTAREA' && el.classList.contains(ELG_TEXTAREA_CLASS);
  }

  window.addEventListener('keydown', (e) => {
    if (bindCapture || typingInElgField()) return;
    if (!AIMBOT.enabled || AIMBOT.bind == null || e.keyCode !== AIMBOT.bind) return;
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

  // Enemy name tags: show every enemy's name under their sprite, the way the
  // game already shows a teammate's, in red instead of the teammate cyan. Same
  // hoisting reason again, and independent of the ESP overlay — see the
  // name-tag block further down. On by default: it reads the label the game
  // has already built and touches no input or gameplay state, so it sits with
  // the netcode smoothing and the ping readout rather than with the cheats
  // that ship off.
  const NAME_TAGS = {
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
    { id: 'aimbot.whitelist', store: AIM_WHITELIST, key: 'names', label: 'Never aim at',
      kind: 'textarea', rows: 4, maxLength: WHITELIST_MAX_CHARS,
      placeholder: 'One player name per line' },
    { id: 'esp.enabled',  store: ESP,    key: 'enabled', label: 'ESP overlay', kind: 'toggle',
      section: 'ESP' },
    { id: 'esp.losDim',   store: ESP,    key: 'losDim',  label: 'Dim blocked', kind: 'toggle' },
    { id: 'esp.blockedAlpha', store: ESP, key: 'blockedAlpha', label: 'Blocked fade',      min: 0,    max: 1,    step: 0.05, decimals: 2 },
    { id: 'names.enemy',  store: NAME_TAGS, key: 'enabled', label: 'Enemy names', kind: 'toggle',
      section: 'Name tags' },
    { id: 'bank.enabled', store: BANK,  key: 'enabled', label: 'Bank shots', kind: 'toggle',
      section: 'Bank shots' },
    { id: 'bank.prefer',  store: BANK,  key: 'prefer',  label: 'Prefer banks', kind: 'toggle' },
    { id: 'autoshoot.enabled', store: AUTOSHOOT, key: 'enabled', label: 'Autoshoot', kind: 'toggle',
      section: 'Autoshoot' },
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
      } else if (spec.kind === 'textarea') {
        // Truncated rather than rejected, for the same reason a slider clamps:
        // an over-long entry is still mostly the user's list.
        if (typeof v === 'string') spec.store[spec.key] = v.slice(0, spec.maxLength || 4000);
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
  const ELG_TEXTAREA_CLASS = `${ELG_TAB}-textarea`;
  const ELG_LIST_H = 295;    // survev's keybind-list height; see ELG_STYLE below
  const ELG_LIST_MIN_H = 90; // floor for fitElgPane, ~three rows

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
  // 295px is only the starting height: fitElgPane measures the box on show and
  // grows (or shrinks) the list until "Return to Game" lands on the bottom
  // edge, so every pixel between the tab buttons and that button is scrollable
  // row space.
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
      height: ${ELG_LIST_H}px;
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
    /* survev has no textarea anywhere in its UI, so this one has no shipped
       markup to borrow and gets rules of its own. They are deliberately plain:
       the menu's own dark panel is the background, so a translucent fill and a
       hairline border is all it takes to read as part of it. */
    #${ELG_LIST_ID} .elg-textarea-row { margin: 4px 0 8px; }
    #${ELG_LIST_ID} .elg-textarea-label {
      display: block;
      width: auto;
      margin: 0 0 4px;
      /* Same reason as .elg-heading: no slider on the row to line up with. */
      bottom: 0;
    }
    #${ELG_LIST_ID} .${ELG_TEXTAREA_CLASS} {
      /* Load-bearing for the same reason the list needs it — the HUD around
         it is click-through, so the box cannot be focused without this. */
      pointer-events: all;
      display: block;
      /* border-box + 100% is what keeps the box inside the track no matter how
         the menu is scaled; a fixed width is what put a horizontal scrollbar on
         the slider rows. */
      box-sizing: border-box;
      width: 100%;
      resize: vertical;
      font-family: inherit;
      font-size: 12px;
      line-height: 1.4;
      color: #fff;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 3px;
      padding: 4px 6px;
      outline: none;
    }
    #${ELG_LIST_ID} .${ELG_TEXTAREA_CLASS}:focus { border-color: rgba(255, 255, 255, 0.6); }
    #${ELG_LIST_ID} .${ELG_TEXTAREA_CLASS}::placeholder { color: rgba(255, 255, 255, 0.35); }
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
  // survev's own tabs. Everything above that button is then the scroll
  // container, so the rows get every spare pixel and the button never floats
  // in the middle of the box.
  //
  // The 295px copied from the keybinds tab is only a starting point. On
  // desktop the menu is a fixed 495px box (`.ui-game-menu-desktop`) and the
  // keybinds *pane* is 345px — 295px of list plus 50px for its
  // restore-defaults button. Our pane has no height of its own, so it comes up
  // 50px short and that shortfall is exactly the gap under the button.
  // Measured rather than hardcoded, because the number depends on the row set
  // and on which of survev's layouts is live; self-limiting, since the list
  // height moves the button one-for-one, so after one pass the slack is zero
  // and repeat calls return early. Under the mobile media query the menu is
  // `height: initial` and hugs its content, so the slack is zero to begin with
  // and this does nothing.
  //
  // Everything is measured in *layout* pixels (offsetTop/offsetHeight), not
  // through getBoundingClientRect: `#ui-center` carries a `scale(.85)` under
  // two of survev's media queries — including plain `max-width:1200px`, so on
  // most windows — and rects come back scaled while `style.height` is set
  // unscaled. Mixing the two made the computed height come out *smaller* than
  // the 295px it started at, so the fit clamped to the floor and silently did
  // nothing: the button sat 50px above the bottom edge with dead space beneath
  // it and the list stayed at its minimum.
  function fitElgPane() {
    const menu = document.getElementById('ui-game-menu');
    const list = document.getElementById(ELG_LIST_ID);
    const resume = document.getElementById('btn-game-resume');
    if (!menu || !list || !resume || !list.offsetParent) return;
    const menuStyle = getComputedStyle(menu);
    // offsetTop is relative to the offsetParent, so the two measurements have
    // to share one. The menu is statically positioned, which puts both it and
    // the button in `#ui-center`'s frame; the other branch covers the menu
    // ever gaining a `position`, which would reparent the button onto it.
    let contentBottom;
    if (resume.offsetParent === menu) {
      contentBottom = menu.clientHeight - parseFloat(menuStyle.paddingBottom || '0');
    } else if (resume.offsetParent === menu.offsetParent) {
      contentBottom = menu.offsetTop + menu.offsetHeight
        - parseFloat(menuStyle.paddingBottom || '0')
        - parseFloat(menuStyle.borderBottomWidth || '0');
    } else return;
    const slack = contentBottom
      - (resume.offsetTop + resume.offsetHeight)
      - parseFloat(getComputedStyle(resume).marginBottom || '0');
    if (Math.abs(slack) < 1) return;
    const h = `${Math.max(ELG_LIST_MIN_H, Math.round(list.offsetHeight + slack))}px`;
    // Skip the redundant write when the fit wants a height the floor won't
    // give it: the slack never reaches zero there, so without this the loop
    // would restyle the list on every tick.
    if (list.style.height !== h) list.style.height = h;
  }

  // Refit on resize: the menu panel is sized off the viewport, so the slack
  // changes with it. Only does work while our tab is the visible one.
  window.addEventListener('resize', () => {
    try { fitElgPane(); } catch {}
  });

  // A resize that lands while the menu is shut can't be measured — the pane
  // has no box — so the height it leaves behind is stale the next time the tab
  // is opened. Called once per sample tick from the loop that attaches the tab,
  // this catches that case on show, and covers the paths that reach our pane
  // without going through elgSelectTab (survev drives it natively once its own
  // collections have picked it up).
  //
  // Both checks read an inline `display`, which every one of those paths sets:
  // ours and survev's tab switches on the pane, and survev's Escape handler on
  // the menu. So a tick with the menu closed costs two property reads and
  // forces no layout.
  function refitElgPaneIfVisible() {
    const pane = document.getElementById(ELG_TAB_PANE_ID);
    if (!pane || pane.style.display === 'none') return;
    const menu = document.getElementById('ui-game-menu');
    if (!menu || menu.style.display === 'none') return;
    fitElgPane();
  }

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

      // A multi-line box, for a setting that is a list rather than a number.
      // Every key event is stopped at the box so the game never sees the
      // typing: survev's own key handler is a bubble-phase listener on window,
      // so stopping here is enough to keep "wasd" from walking the player and
      // a digit from swapping weapons. Our aimbot listener is capture-phase and
      // runs before this, so it asks `typingInElgField()` instead. Escape is
      // deliberately let through, after blurring, so it still closes the menu.
      if (spec.kind === 'textarea') {
        const row = document.createElement('div');
        row.className = 'elg-textarea-row';
        const label = document.createElement('p');
        label.className = 'slider-text elg-textarea-label';
        label.textContent = spec.label;
        const box = document.createElement('textarea');
        box.className = ELG_TEXTAREA_CLASS;
        box.rows = spec.rows || 4;
        box.spellcheck = false;
        box.maxLength = spec.maxLength || 4000;
        if (spec.placeholder) box.placeholder = spec.placeholder;
        box.value = String(spec.store[spec.key] ?? '');
        // Saved per keystroke, unlike the sliders: typing fires `input` at
        // human speed rather than per pixel of a drag, and `change` alone would
        // lose the edit when the menu is closed with the box still focused.
        box.addEventListener('input', () => {
          spec.store[spec.key] = box.value;
          saveSettings();
        });
        for (const type of ['keydown', 'keyup', 'keypress']) {
          box.addEventListener(type, (e) => {
            if (e.key === 'Escape') { box.blur(); return; }
            e.stopPropagation();
          });
        }
        box.addEventListener('mousedown', (e) => e.stopPropagation());
        row.appendChild(label);
        row.appendChild(box);
        list.appendChild(row);
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

  // ---- Synthetic inputs -------------------------------------------------
  //
  // Most of these inputs have no default keybind in the bundle and no UI-flag
  // analog like SwapWeapSlots does — the bundle only emits them when
  // `game[inputBinds].isBindPressed(N.<Input>)` returns true in the input
  // loop. And the fire flags on the outgoing packet are built straight off
  // that object too:
  //     shootStart = inputBinds.isBindPressed(Input.Fire)
  //     shootHold  = inputBinds.isBindDown(Input.Fire)
  // so wrapping the same two methods is enough to press or hold anything
  // without owning a keybind for it, independent of what the user has bound.
  //
  //   pendingInputs    — one-shot. Consumed by the next isBindPressed poll,
  //                      then dropped, so it doesn't re-emit on every later
  //                      tick. Right for the equip inputs, which have exactly
  //                      one reader: the loop that copies pressed inputs onto
  //                      the outgoing message.
  //   framePressInputs — pressed for a whole frame, read without consuming.
  //                      Necessary for Fire, which has *two* readers per
  //                      frame, and they run in the wrong order: the player
  //                      update polls isBindPressed(Fire) for the dry-fire
  //                      sound, and it runs earlier in Game.update than the
  //                      input-message build that turns the same poll into
  //                      `shootStart`. A one-shot token gets eaten by the
  //                      first and never reaches the packet, so a press-fired
  //                      gun silently never shoots. Whoever arms one of these
  //                      disarms it on their next tick, which is what keeps it
  //                      to a single frame — exactly what survev's own
  //                      keysOld/keys edge gives a real key press.
  //   heldInputs       — level. isBindDown reports true for as long as it's in
  //                      the set; whoever adds it owns taking it back out.
  //
  // Anything that wants to observe the *user* has to read through
  // realBindDown, or it will see our own synthetic input and feed back on
  // itself — auto-quickswap's fire-edge detector being the live example.
  let bindHookTarget = null;
  let origIsBindDown = null;
  let origIsBindPressed = null;
  const pendingInputs = new Set();
  const framePressInputs = new Set();
  const heldInputs = new Set();

  function ensureBindHook(binds) {
    if (!binds || binds === bindHookTarget) return;
    if (typeof binds.isBindPressed !== 'function' || typeof binds.isBindDown !== 'function') return;
    const origPressed = binds.isBindPressed;
    const origDown = binds.isBindDown;
    binds.isBindPressed = function(input) {
      if (framePressInputs.has(input)) return true;
      if (pendingInputs.has(input)) {
        pendingInputs.delete(input);
        return true;
      }
      return origPressed.call(this, input);
    };
    binds.isBindDown = function(input) {
      if (heldInputs.has(input)) return true;
      return origDown.call(this, input);
    };
    origIsBindPressed = origPressed;
    origIsBindDown = origDown;
    bindHookTarget = binds;
  }

  // The user's own state of an input, with our synthetic layer bypassed.
  function realBindDown(binds, input) {
    if (!binds) return false;
    try {
      const fn = (binds === bindHookTarget && origIsBindDown) ? origIsBindDown : binds.isBindDown;
      return typeof fn === 'function' && !!fn.call(binds, input);
    } catch {
      return false;
    }
  }

  function autoSwapEmitInput(game, input) {
    ensureBindHook(game?.[GAME_BINDS]);
    pendingInputs.add(input);
  }

  // Press an input for the whole of the coming frame. The caller disarms it on
  // its next tick — see framePressInputs above for why one-shot isn't enough
  // for Fire.
  function pressInputThisFrame(game, input) {
    ensureBindHook(game?.[GAME_BINDS]);
    framePressInputs.add(input);
  }

  // Hold or release an input at the level `on` asks for. The rising edge also
  // presses it, so `shootStart` goes true on the first frame of a hold rather
  // than only `shootHold` — a server that arms the trigger on the start flag
  // then still sees the shot begin.
  function setInputHeld(binds, input, on) {
    ensureBindHook(binds);
    if (!on) { heldInputs.delete(input); return; }
    if (!heldInputs.has(input)) framePressInputs.add(input);
    heldInputs.add(input);
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
    autoSwapQueueAfterShot(game, me, weapon);
  }

  // Queue the post-shot swap for a slow gun. Shared by auto-quickswap, which
  // triggers off the user's own trigger pull, and autoshoot, which triggers
  // off its own — `log` is off for the latter, which would otherwise print a
  // line per shot forever.
  function autoSwapQueueAfterShot(game, me, weapon, log = true) {
    if (autoSwapOtherSlotHasGun(me)) {
      // Two-gun case: swap to the other gun. SwapWeapSlots/EquipOtherGun
      // resets gunSwitchCooldown so the other gun is ready as soon as
      // its own switchDelay elapses — beats waiting out the slow gun's
      // fireDelay.
      if (log) console.log(`[autoswap] queued swap after ${weapon} shot`);
      setTimeout(() => autoSwapEmitInput(game, AUTO_SWAP_INPUT_EQUIP_OTHER), AUTO_SWAP_FIRE_TO_SWAP_MS);
    } else {
      // Single-gun case: tap melee then return to the gun via
      // EquipLastWeap. Same gunSwitchCooldown-reset trick — switching
      // to melee cancels the slow gun's post-fire animation, and
      // EquipLastWeap brings us back without depending on which slot
      // index the gun lives in. Stagger the two inputs by one tick
      // each so Fire/EquipMelee/EquipLastWeap each land on their own
      // server tick in order.
      if (log) console.log(`[autoswap] queued melee-tap after ${weapon} shot`);
      setTimeout(() => autoSwapEmitInput(game, AUTO_SWAP_INPUT_EQUIP_MELEE), AUTO_SWAP_FIRE_TO_SWAP_MS);
      setTimeout(() => autoSwapEmitInput(game, AUTO_SWAP_INPUT_EQUIP_LAST), AUTO_SWAP_FIRE_TO_SWAP_MS * 2);
    }
  }

  function autoSwapFrameTick() {
    try {
      const game = capturedGame;
      const binds = game?.[GAME_BINDS];
      if (binds && typeof binds.isBindDown === 'function') {
        ensureBindHook(binds);
        // The user's trigger, not ours — autoshoot holds the same input, and
        // reading the wrapped method would make every burst it fires look
        // like a fresh trigger pull.
        const isDown = realBindDown(binds, AUTO_SWAP_INPUT_FIRE);
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
  // Autoshoot
  // ---------------------------------------------------------------------
  //
  // Shoot exactly while the shot is on, and stop the moment it isn't. It rides
  // on the aim helper: the aimbot decides where the crosshair points and
  // whether that shot exists at all (direct or banked), and this only decides
  // whether to pull. So it does nothing unless the aimbot is enabled and its
  // key is held — without that the crosshair isn't on anyone and "can the
  // enemy be hit" has no meaning.
  //
  // How it pulls depends on the gun, in three cases:
  //
  //   slow   — one shot, then the quickswap. A gun whose fireDelay is at or
  //            over AUTO_SWAP.slowFireThreshold spends most of its time in
  //            recovery, and swapping resets gunSwitchCooldown, so shot →
  //            swap → shoot the other one beats waiting out the delay. Exactly
  //            the trick auto-quickswap does off the user's trigger, driven
  //            off ours instead. With two guns it alternates between them;
  //            with one it taps melee and comes back.
  //   auto    — hold the trigger. `fireMode: 'auto'` is the only case survev
  //            reads `isBindDown(Fire)` for, and it keeps firing on its own.
  //   press   — everything else: a press per shot, paced at the gun's
  //            fireDelay, which is as fast as a semi-auto can go.
  //
  // Slow wins over auto where they overlap (the USAS at the default threshold,
  // and more of them if it is dialled down), because the swap beats the wait
  // either way. The press path covers auto guns too, incidentally: `shootStart`
  // is built off `isBindPressed` regardless of fire mode.
  //
  // The AUTOSHOOT store itself lives up beside AIMBOT, for the same
  // temporal-dead-zone reason: SETTINGS_SPECS binds a row to it.

  // Guns with `fireMode: 'auto'`, transcribed from the gun defs in the
  // definitions chunk (74 guns: 28 auto, 5 burst, 41 single — every one
  // carries the field explicitly). Static for the same reason as
  // GUN_BULLET_SPEED and the reflector table: the field lives on a
  // bundle-private def, but the type string is on the entity, and type names
  // are content rather than identifiers, so this survives re-mangling and only
  // goes stale when survev ships new guns.
  //
  // Burst guns (an94, famas, m93r, m93r_dual, ump9) are deliberately absent —
  // holding their trigger does nothing.
  const GUN_AUTO = new Set([
    'ak47', 'ash12', 'bar', 'colt45', 'colt45_dual', 'dp28', 'glock',
    'glock_dual', 'groza', 'grozas', 'hk416', 'imbel', 'm1a1', 'm249',
    'm4a1', 'mac10', 'mp5', 'pkp', 'potato_lmg', 'potato_smg', 'qbb97',
    'saiga', 'scar', 'scorpion', 'spas16', 'usas', 'vector', 'vector45',
  ]);

  // Burst guns, from the same fireMode extraction as GUN_AUTO. They hold, the
  // same as an automatic: a held trigger keeps a burst gun firing burst after
  // burst, and the server paces the gap between them. (The client's dry-fire
  // sound only consults `isBindDown` for `fireMode == 'auto'`, which is what
  // the *sound* does, not what the gun does — firing is resolved server-side
  // off shootStart/shootHold.) Holding also sidesteps the thing that makes
  // pressing them awkward, which is that a press mid-burst restarts it.
  //
  // They are never slow, so they never reach the swap path: every one of them
  // is in AUTO_SWAP_NEVER, which isSlowFireGun rejects outright.
  const GUN_BURST = new Set(['an94', 'famas', 'm93r', 'm93r_dual', 'ump9']);
  // How often to re-press a slow gun while waiting for it to actually go off.
  // The press that fires it can't be the one that also queues the swap: after
  // a swap the new gun still owes its switchDelay, and a press inside that
  // window is silently dropped. Queueing the swap off it anyway would swap
  // straight back off a gun that never fired, and the two guns would trade
  // places forever without a shot between them. So we keep tapping until the
  // magazine confirms a shot went out, and swap off *that*.
  const AUTOSHOOT_SLOW_RETRY_MS = 50;
  // Backstop for when the magazine can't be read at all: press, swap, and give
  // the swap this long to land before trying again.
  const AUTOSHOOT_SWAP_TIMEOUT_MS = 400;

  const autoShootState = {
    nextPressAt: 0,      // Date.now() before which we won't press again
    weapon: '',          // the gun being tracked; a change retires all of this
    ammoAtPress: null,   // magazine as of our press. Lower now means it fired
    swapQueued: false,   // shot confirmed, swap on its way, stop pressing
    swapDeadline: 0,     // ...but resume if the swap never lands
  };

  // What autoshoot should be doing this frame: null for nothing, otherwise
  // 'hold' | 'press' | 'swap' plus the context the tick needs to act on it.
  // The local player's gun and magazine, read every frame regardless of
  // whether we intend to shoot.
  //
  // Tracking has to outlive the shoot decision. The plan below drops to null
  // on any of eight conditions, and several of them flicker constantly
  // mid-engagement — the aim wobbling a hair past tolerance, the target
  // blinking out of a sample, a bank momentarily failing to validate. Folding
  // the magazine reading into that meant a single such frame wiped it, and
  // since the shot -> ammo-update round trip is three to six frames, one
  // flicker anywhere in the window destroyed the very edge the swap triggers
  // on. The gun would fire and then just sit there, which is precisely the
  // "shoots and waits" failure.
  function autoShootObserve() {
    const game = capturedGame;
    const me = game ? findLocalPlayerOnGame(game) : null;
    if (!me) return null;
    const weapon = getCurrentWeapon(me);
    if (!weapon) return null;
    const slots = me[PLAYER_LOC]?.[LOC_SLOTS];
    const idx = me[PLAYER_LOC]?.[LOC_CURIDX];
    const cur = (Array.isArray(slots) && Number.isFinite(idx)) ? slots[idx] : null;
    const ammo = (cur && Number.isFinite(cur.ammo)) ? cur.ammo : null;
    return { game, me, weapon, ammo };
  }

  function autoShootPlan(obs) {
    if (!AUTOSHOOT.enabled || !AIMBOT.enabled || !aimHeld || !obs) return null;
    const { game, me, weapon, ammo } = obs;

    // Has to be a gun at all. This is also what keeps the single-gun swap from
    // eating itself: that path taps melee on the way round, and a Fire press
    // with a melee equipped is a swing, not a shot.
    if (GUN_FIRE_DELAY[weapon] === undefined) return null;

    // A reload in progress is not a reason to hold off: firing cancels it, and
    // rounds already in the magazine are worth more right now than the ones
    // being loaded. That covers the shell-by-shell shotgun reload, where every
    // shell that lands is immediately shootable, and the tactical reload of a
    // part-full magazine, where all of it is.
    //
    // If the server treats the first press as cancel-only and fires on the
    // next, nothing here needs to care: 'hold' keeps shootHold up, and both
    // press paths come back within a frame or AUTOSHOOT_SLOW_RETRY_MS.
    //
    // The magazine being *empty* is the one case that still holds off, and it
    // has to. Interrupting an empty gun's reload cancels it, leaves us with
    // nothing to fire, and the auto-reload starts over — press again and the
    // gun never reloads at all. So this single check is what keeps
    // "interrupt reloads" from meaning "never finish one".
    if (ammo != null && ammo <= 0) return null;

    const sample = pageSamples[pageSamples.length - 1];
    if (!sample || aimState.targetId == null) return null;
    const enemy = sample.enemies.find((e) => e.id === aimState.targetId);
    // Same linger rule the aim uses, so the trigger doesn't quit on a body the
    // aim is still tracking.
    if (!isEngageable(enemy, Date.now())) return null;
    const self = liveSelf(sample);
    if (!self || !canInteract(self.layer, enemy.layer)) return null;

    // "Can be hit" is the aim solver's own answer: a clear direct line, or a
    // bounce it found. Blocked with no bounce means hold fire.
    const shot = reactionTarget(self, enemy, Date.now());
    if (shot.blocked) return null;

    // And the crosshair has to have actually arrived. The aim glides toward
    // the solution at `followFraction` a frame, so early in an engagement the
    // shot exists but we are not yet pointing at it. The tolerance is the
    // target's own angular radius at the range the bullet travels — for a
    // bank that is the whole path length, which is the right denominator,
    // since the far leg is what has to land.
    const dx = shot.x - shot.fromX;
    const dy = shot.y - shot.fromY;
    const dist = Math.hypot(dx, dy);
    const tol = Math.atan2(PLAYER_RADIUS, Math.max(dist, PLAYER_RADIUS));
    if (Math.abs(angleDelta(aimState.theta, Math.atan2(dy, dx))) > tol) return null;

    const mode = isSlowFireGun(weapon) ? 'swap'
      : (GUN_AUTO.has(weapon) || GUN_BURST.has(weapon)) ? 'hold'
      : 'press';
    return { mode, weapon, ammo, game, me };
  }

  function autoShootStep() {
    // Retire last frame's press before deciding on this one. Ours is the tick
    // that arms it, so ours is the tick that has to take it back down — that
    // is what makes a synthetic press exactly one frame wide, the same width
    // survev's own keysOld/keys edge gives a real one.
    framePressInputs.delete(AUTO_SWAP_INPUT_FIRE);

    const obs = autoShootObserve();
    const now = Date.now();

    // A different weapon retires everything the last one had going: its
    // pacing, its pending swap, and its magazine reading. This is the *only*
    // thing that resets tracking — deliberately, since anything that resets on
    // a bad frame loses the shot we are waiting to see.
    if (!obs || obs.weapon !== autoShootState.weapon) {
      autoShootState.weapon = obs ? obs.weapon : '';
      autoShootState.ammoAtPress = null;
      autoShootState.swapQueued = false;
      autoShootState.nextPressAt = 0;
    }

    let plan = null;
    try {
      plan = autoShootPlan(obs);
    } catch {}

    const binds = capturedGame?.[GAME_BINDS];
    // Only the hold path leaves the trigger down. The other two work in
    // presses and must not also be holding it, or an auto gun that counts as
    // slow would keep firing straight through its own swap.
    if (binds) setInputHeld(binds, AUTO_SWAP_INPUT_FIRE, plan?.mode === 'hold');
    else heldInputs.delete(AUTO_SWAP_INPUT_FIRE);

    // Did the shot we pressed for actually go out? The magazine says so, and
    // it is checked against the reading taken at the press rather than against
    // the previous frame, so a gap in the readings can't swallow the drop.
    // This runs off `obs`, not off the plan: once we have pulled the trigger
    // we are committed, and whether the crosshair is still exactly on target
    // three frames later has no bearing on whether to leave the gun we just
    // emptied a round out of.
    if (obs && autoShootState.ammoAtPress != null && obs.ammo != null
        && obs.ammo < autoShootState.ammoAtPress) {
      autoShootState.ammoAtPress = null;
      if (isSlowFireGun(obs.weapon) && !autoShootState.swapQueued) {
        // Swapping resets gunSwitchCooldown, so the other gun beats this one's
        // recovery. With one gun this taps melee and comes straight back.
        autoSwapQueueAfterShot(obs.game, obs.me, obs.weapon, false);
        autoShootState.swapQueued = true;
        autoShootState.swapDeadline = now + AUTOSHOOT_SWAP_TIMEOUT_MS;
      }
    }

    // ...and don't wait on a swap forever. If it never lands — the input got
    // dropped, the other slot turned out to be empty — go back to shooting the
    // gun we have rather than standing there holding it.
    if (autoShootState.swapQueued && now > autoShootState.swapDeadline) {
      autoShootState.swapQueued = false;
    }

    // Nothing to press: an auto gun paces itself, and no plan means no shot.
    // Clearing the gate means the first shot of the next engagement goes out
    // on the frame it becomes available rather than waiting out a stale timer.
    if (!plan || plan.mode === 'hold') {
      autoShootState.nextPressAt = 0;
      return;
    }
    if (autoShootState.swapQueued) return;
    if (now < autoShootState.nextPressAt) return;

    pressInputThisFrame(plan.game, AUTO_SWAP_INPUT_FIRE);
    // Remember the magazine as it was *before* this shot, and don't overwrite
    // it on the retries that follow — the drop is measured from the first
    // press of the volley, not the most recent one.
    if (autoShootState.ammoAtPress == null) autoShootState.ammoAtPress = plan.ammo;

    if (plan.mode === 'swap') {
      // Keep tapping until the shot registers. Without a readable magazine
      // there is nothing to wait for, so fall back to firing once, swapping,
      // and giving that a while to land.
      if (plan.ammo == null) {
        autoSwapQueueAfterShot(plan.game, plan.me, plan.weapon, false);
        autoShootState.swapQueued = true;
        autoShootState.swapDeadline = now + AUTOSHOOT_SWAP_TIMEOUT_MS;
        autoShootState.nextPressAt = now + AUTOSHOOT_SWAP_TIMEOUT_MS;
      } else {
        autoShootState.nextPressAt = now + AUTOSHOOT_SLOW_RETRY_MS;
      }
    } else {
      // A press per frame. Pacing it at the fireDelay instead looks tidier and
      // is measurably slower: a press the gun isn't ready for is dropped, and
      // if that press has already moved the gate forward a whole cycle, the
      // *next* one lands a cycle late — a 130ms gun ends up firing every
      // 224ms. Pressing freely costs nothing, since the server ignores what it
      // can't honour, and adds no packets either: the aim is rewriting the
      // input message every frame during an engagement anyway.
      autoShootState.nextPressAt = 0;
    }
  }

  function autoShootFrameTick() {
    try {
      autoShootStep();
    } catch {
      heldInputs.delete(AUTO_SWAP_INPUT_FIRE);
    }
    requestAnimationFrame(autoShootFrameTick);
  }
  requestAnimationFrame(autoShootFrameTick);

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
  //      Aim direction arrives in the same packet, so it is snapshotted with
  //      the position and played back off the same pair on the same clock —
  //      as an angle along the shortest arc rather than as a vector, and
  //      stopping at the newest snapshot rather than turning past it. See
  //      renderDirOnClock for why it differs from the position path.
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

  // The last few arrivals, kept verbatim so the HUD can report how far the fit
  // actually sits from the packets it is fit to. A ring of raw (n, t) rather
  // than a running sum of squares because the residual worth showing is against
  // the *current* slope, not against whatever the slope happened to be at the
  // moment each packet landed — the latter conflates fit error with the fit's
  // own convergence.
  const CLOCK_RESID_CAP = 60;     // ~3s of arrivals at 20Hz
  const clockResid = {
    n: new Float64Array(CLOCK_RESID_CAP),
    t: new Float64Array(CLOCK_RESID_CAP),
    len: 0,
    head: 0,                      // next slot to overwrite
  };

  // RMS of (arrival time - pseudotime) over the retained arrivals: the spread
  // the clock is smoothing out, in ms. Null until the fit is usable.
  function clockJitterMs() {
    if (!netClock.ready || !clockResid.len) return null;
    let sum = 0;
    for (let i = 0; i < clockResid.len; i++) {
      const d = clockResid.t[i] - pseudotimeOf(clockResid.n[i]);
      sum += d * d;
    }
    return Math.sqrt(sum / clockResid.len);
  }

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
    clockResid.len = 0;
    clockResid.head = 0;
    // Packet indices restart, so every retained snapshot's index now points at
    // the wrong pseudotime. (Declared below, beside the ring it indexes.)
    netSnapsById.clear();
  }

  // Fold one arrival into the clock. Called once per update packet.
  function clockOnPacket(nowMs) {
    const n = netClock.n++;
    clockResid.n[clockResid.head] = n;
    clockResid.t[clockResid.head] = nowMs;
    clockResid.head = (clockResid.head + 1) % CLOCK_RESID_CAP;
    if (clockResid.len < CLOCK_RESID_CAP) clockResid.len++;
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
      // Aim direction rides along in the same snapshot: it arrives in the same
      // packet as the position, so it belongs on the same tick index and gets
      // played back on the same clock. Recorded as null when the packet had no
      // usable dir, which makes the pair unusable and drops that player's dir
      // back to the game's own lerp for as long as it lasts.
      const dir = player[PLAYER_NET]?.[PLAYER_DIR];
      const haveDir = dir && typeof dir.x === 'number' && typeof dir.y === 'number'
        && (dir.x !== 0 || dir.y !== 0);
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
      st.snaps.push({
        n: idx,
        x: pos.x,
        y: pos.y,
        dx: haveDir ? dir.x : null,
        dy: haveDir ? dir.y : null,
      });
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

  // Aim direction on the recovered clock — the same two-snapshot playback as
  // renderOnClock, with two departures.
  //
  // It stops at the newest snapshot: `t` is capped at 1, so the rotation never
  // turns past a direction the server has actually sent. A stall holds the
  // last real direction rather than continuing the turn through it. Nothing is
  // lost in the steady state — the renderer already sits half a tick behind
  // the newest snapshot, so the cap only engages once the data has run out —
  // and it costs nothing on the way back in, because holding an angle and then
  // resuming from it is a rate change, not the position path's positional
  // snap. The lower end is left open: `t` below 0 runs the same segment
  // backwards, which is continuous with the rest of the arc.
  //
  // And it interpolates the *angle*, not the vector. Lerping the two direction
  // vectors componentwise and taking the atan2 of the result sweeps at a
  // non-constant rate (fast at the ends, slow in the middle) and collapses
  // entirely when a player spins ~180° in one tick: the interpolant passes
  // through the origin and the angle it reports there is arbitrary. Walking
  // the arc from a1 to a2 turns at a constant rate and has no degenerate pair.
  //
  // Returns null under the same conditions as renderOnClock, plus a pair with
  // no usable direction on either end — the caller falls back to the game's
  // own dir lerp.
  function renderDirOnClock(st, nowMs) {
    if (!netClock.ready) return null;
    const s = st.snaps;
    if (s.length < 2) return null;
    const p1 = s[s.length - 2];
    const p2 = s[s.length - 1];
    if (p1.dx == null || p2.dx == null) return null;
    const t1 = pseudotimeOf(p1.n);
    const t2 = pseudotimeOf(p2.n);
    const d = t2 - t1;
    if (!d) return null;
    const t = Math.min((nowMs - t1) / d, 1);
    const a1 = Math.atan2(p1.dy, p1.dx);
    const a2 = Math.atan2(p2.dy, p2.dx);
    // Shortest arc: wrap the tick's turn into (-pi, pi] so a turn across the
    // ±pi seam goes the short way round rather than the long way back.
    let delta = a2 - a1;
    delta -= Math.PI * 2 * Math.floor((delta + Math.PI) / (Math.PI * 2));
    const a = a1 + delta * t;
    return { x: Math.cos(a), y: Math.sin(a) };
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

  // Same, for the rendered aim direction — the field the body sprite's
  // rotation is taken from. The game assigns it in the same per-frame block as
  // the position (and skips the assignment for the local player when it is
  // aiming straight off the mouse), so driving it from the setter keeps our
  // playback exactly where the game's own lerp sat.
  function updatePlayerDirSmoothing(st, base) {
    st.dirOut = renderDirOnClock(st, renderNowMs()) || base;
    st.haveDirOut = true;
  }

  // Replace a Player's interpolated position and direction fields with
  // accessors. It has to be per-instance: survev declares them as class
  // fields, so every Player gets its own data property that would shadow
  // anything installed on the prototype (the same reason the constructor
  // setter traps stopped firing — see the capture notes at the top of this
  // file).
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
      dirBase: (PLAYER_DIR2 && player[PLAYER_DIR2]) || { x: 1, y: 0 },
      dirOut: null,
      haveDirOut: false,
      snaps: [],            // [{ n, x, y, dx, dy }] pos+dir tagged by packet index
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
    // The direction hook is optional: an older mangled.js has no `dirAlt`
    // entry, and the position smoothing above is still worth having on its
    // own. A failure here leaves dir on stock behaviour, nothing else.
    if (PLAYER_DIR2) {
      try {
        const dirDesc = Object.getOwnPropertyDescriptor(player, PLAYER_DIR2);
        if (!dirDesc || dirDesc.configurable) {
          Object.defineProperty(player, PLAYER_DIR2, {
            configurable: true,
            enumerable: true,
            get() {
              return (NETCODE.enabled && st.haveDirOut) ? st.dirOut : st.dirBase;
            },
            set(v) {
              st.dirBase = v;
              if (!NETCODE.enabled || !v) {
                st.haveDirOut = false;
                return;
              }
              try {
                updatePlayerDirSmoothing(st, v);
              } catch {
                st.haveDirOut = false;
              }
            },
          });
        }
      } catch {}
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
  // Enemy name tags.
  //
  // survev already builds the label. Every Player owns a `nameText` — a
  // PIXI.Text child of its own container, anchored under the sprite — and the
  // per-frame player update fills it in for *everyone*:
  //
  //     this.nameText.text = info.name;
  //     this.nameText.visible = !isActivePlayer && sameGroup;
  //
  // then shows it only for teammates. So an enemy's tag is already built,
  // already carrying the right name, and already following the sprite through
  // zoom, layer and death; the single thing between it and the screen is that
  // `visible` assignment. Taking that over rather than drawing labels of our
  // own is what makes the enemy tag pixel-identical to the teammate one, and
  // it costs one property read per player per frame.
  //
  // `nameText` is one of the names survev leaves readable (like `playerPool`
  // and `pings`), so none of this needs a mangled.js entry.
  //
  // The hook is an accessor on the Text instance, not a write from our own
  // tick, for ordering: the game assigns `visible` once per frame per player,
  // in the same update that assigns the interpolated position, and our sample
  // loop is not ordered against that — anything we wrote would be overwritten
  // before the next render about half the time. The accessor ORs our decision
  // onto the game's, so the local player's own name stays hidden, a teammate
  // stays visible for the game's own reason, and turning the toggle off
  // restores stock behaviour on the very next assignment.
  // ---------------------------------------------------------------------

  // Enemies get the ESP overlay's enemy red, so the two features read as one
  // thing rather than as two different opinions about who is dangerous. The
  // ally fill is read off the label itself and this is only the fallback for
  // when that read fails — it is the cyan the bundle's own text style ships.
  const NAME_TAG_ENEMY_FILL = 0xff3c3c;
  const NAME_TAG_ALLY_FILL = 0x00ffff;

  // nameText (PIXI.Text) -> { base, enemy, fill, allyFill }
  const nameTagState = new WeakMap();
  // How many labels we have taken over. A WeakMap has no size, and the tick
  // needs to know whether there is anything to hand back once the feature is
  // switched off — see nameTagTick.
  let nameTagsHooked = 0;

  // Replace a name label's `visible` with an accessor. Per-instance, like the
  // netcode hooks above — `visible` is an own data property on every PIXI v7
  // DisplayObject, so a prototype install would be shadowed. If a future PIXI
  // makes it a prototype accessor (v8 does), the underlying setter is called
  // with the effective value instead of being replaced, so the renderer keeps
  // whatever bookkeeping it hangs off the write.
  function installNameTag(text) {
    if (!text || nameTagState.has(text)) return nameTagState.get(text) || null;

    let proto = null;
    try {
      for (let o = Object.getPrototypeOf(text); o && !proto; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, 'visible');
        if (d && (d.get || d.set)) proto = d;
      }
      const own = Object.getOwnPropertyDescriptor(text, 'visible');
      if (own && !own.configurable) return null;
    } catch {
      return null;
    }

    const st = {
      base: !!text.visible,   // what the game last asked for
      eff: !!text.visible,    // what we let the renderer see
      enemy: false,
      // Whatever fill the label was built with, so switching a recycled entity
      // back to a teammate restores the game's colour rather than our idea of it.
      allyFill: safeRead(text.style, 'fill') ?? NAME_TAG_ALLY_FILL,
      fill: safeRead(text.style, 'fill') ?? NAME_TAG_ALLY_FILL,
    };
    const apply = function (self) {
      st.eff = st.base || (NAME_TAGS.enabled === 1 && st.enemy);
      if (proto?.set) proto.set.call(self, st.eff);
    };
    try {
      Object.defineProperty(text, 'visible', {
        configurable: true,
        enumerable: true,
        get() {
          return proto?.get ? proto.get.call(this) : st.eff;
        },
        set(v) {
          st.base = !!v;
          apply(this);
        },
      });
    } catch {
      return null;
    }
    st.apply = apply;
    nameTagState.set(text, st);
    nameTagsHooked++;
    return st;
  }

  // Recolour a label, but only when the colour actually changes: assigning to
  // a TextStyle field bumps its styleID and makes PIXI re-render the text
  // texture, which is not something to do every frame per player.
  function paintNameTag(text, st) {
    // Gated on the toggle as well as on the side, so switching the feature off
    // hands the label back exactly as it was found rather than leaving a red
    // one hidden behind a `visible` we no longer force.
    const want = (NAME_TAGS.enabled === 1 && st.enemy) ? NAME_TAG_ENEMY_FILL : st.allyFill;
    if (st.fill === want) return;
    st.fill = want;
    try { text.style.fill = want; } catch {}
  }

  // Called from the sample loop: hook every live label and refresh which of
  // them belong to enemies. Side-agnostic work only — whether the tag is
  // *shown* is decided in the accessor above, on the game's own clock.
  function nameTagTick(game) {
    if (!game) return;
    // Nothing is hooked while the feature is switched off, so a session that
    // turns it off gets no accessor on any label built afterwards. Once hooked
    // they stay, and the tick keeps running while disabled so a live
    // toggle-off hands every label back instead of leaving it forced on.
    if (NAME_TAGS.enabled !== 1 && nameTagsHooked === 0) return;
    try {
      const roster = findRosterOnGame(game) || game?.[GAME_ROSTER];
      const pool = roster?.playerPool;
      if (!pool || typeof pool[POOL_GETALL] !== 'function') return;
      // Who we are. Without a local player at all there is no side to be on,
      // and "everyone is an enemy" — the sampler's reading of that state —
      // would put a red tag under our own sprite, so that case waits; it is
      // one tick. A *missing id* on a local player we do have is not a reason
      // to stop: the pool holds us too, and object identity excludes us from
      // our own tags without needing `__id` to have arrived.
      const me = findLocalPlayerOnGame(game) || game?.[GAME_LOCAL];
      if (!me) return;
      const selfId = Number(me.__id ?? me.playerId ?? 0) || null;
      let selfInfo = null;
      try { selfInfo = selfId != null ? roster.getPlayerInfo?.(selfId) ?? null : null; } catch {}

      for (const player of pool[POOL_GETALL]() || []) {
        const text = player?.nameText;
        if (!text) continue;
        const st = nameTagState.get(text) || (NAME_TAGS.enabled === 1 ? installNameTag(text) : null);
        if (!st) continue;
        // Pool entries are recycled, so this is re-derived every tick rather
        // than latched at install: the object that held an enemy last round
        // can hold a squadmate in the next one.
        let info = null;
        const id = Number(player.__id ?? 0) || null;
        if (id != null) { try { info = roster.getPlayerInfo?.(id) ?? null; } catch {} }
        // Identity first, id second: `player !== me` is the half that cannot
        // be defeated by a missing or late `__id`, and the id comparison only
        // has to catch a local player the walk found under a different object.
        //
        // With no info for ourselves there is no way to tell a squadmate from
        // an enemy, and isHostileTo's "assume hostile" — right for the sampler,
        // which would rather log a teammate than miss a foe — would paint the
        // squad red. So nothing is an enemy until that resolves. The hooks are
        // still installed, which is what keeps this distinguishable in
        // __nameTagDiag from the tick never having run.
        st.enemy = Boolean(player.active) && player !== me
          && (selfId == null || id !== selfId)
          && selfInfo != null && isHostileTo(selfInfo, info);
        paintNameTag(text, st);
        // The toggle can flip between two of the game's assignments; re-run the
        // decision now so it takes effect on this frame rather than the next one.
        st.apply?.(text);
      }
    } catch {}
  }

  // Why isn't a name showing? Every step of the path in one object: whether
  // the tick can reach the pool at all, who it thinks we are, and — per live
  // player — what the label holds and what the renderer is being told about
  // it. The last four fields are the ones that separate "we never forced it
  // visible" from "we did and something above it is hidden anyway".
  window.__nameTagDiag = () => {
    const game = capturedGame;
    const roster = game ? (findRosterOnGame(game) || game[GAME_ROSTER]) : null;
    const pool = roster?.playerPool;
    const players = (pool && typeof pool[POOL_GETALL] === 'function' ? pool[POOL_GETALL]() : []) || [];
    const me = game ? (findLocalPlayerOnGame(game) || game[GAME_LOCAL]) : null;
    const selfId = Number(me?.__id ?? me?.playerId ?? 0) || null;
    const live = players.filter((p) => p && p.active);
    const infoOf = (id) => { try { return roster?.getPlayerInfo?.(id) ?? null; } catch { return null; } };
    return {
      enabled: NAME_TAGS.enabled === 1,
      gameCaptured: !!game,
      rosterFound: !!roster,
      poolFound: !!pool,
      pooled: players.length,
      live: live.length,
      selfFound: !!me,
      selfId,
      selfGroupId: infoOf(selfId)?.groupId ?? null,
      hooked: nameTagsHooked,
      // A live player with no `nameText` is the one failure that needs a code
      // change rather than a setting: it means the bundle stopped calling the
      // label that, and the hook has nothing to attach to.
      missingLabel: live.filter((p) => !p.nameText).length,
      players: live.map((p) => {
        const text = p.nameText;
        const st = text ? nameTagState.get(text) : null;
        return {
          id: p.__id,
          name: infoOf(p.__id)?.name ?? null,
          self: p === me,
          hooked: !!st,
          enemy: st ? st.enemy : null,
          gameWants: st ? st.base : null,   // what the game last assigned
          visible: text ? text.visible : null,  // what the renderer reads
          text: text ? text.text : null,
          fill: text ? safeRead(text.style, 'fill') : null,
          // A label can be visible and still not draw: PIXI walks up the
          // parents, so an unparented label or a hidden player container
          // hides it regardless.
          parented: text ? !!text.parent : null,
          containerVisible: safeRead(p.container, 'visible') ?? null,
          worldVisible: text ? text.worldVisible : null,
        };
      }),
    };
  };

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

    // Clock readout beside the ping: the fitted tick period (slope of the
    // pseudotime model, ms per packet) and the RMS arrival-vs-pseudotime
    // residual, i.e. how much jitter the fit is absorbing. Both blank until
    // the clock has converged.
    const jitter = clockJitterMs();
    const clockTxt = netClock.ready
      ? ` · ${netClock.slope.toFixed(2)} ms/tick${jitter == null ? '' : ` · ±${jitter.toFixed(1)} ms`}`
      : '';

    if (ms == null) {
      // In a match but no acked input yet — say so rather than showing a stale
      // or invented number.
      el.style.display = 'flex';
      pingState.dot.style.background = '#7f8c8d';
      pingState.text.textContent = `– ms${clockTxt}`;
      return;
    }
    el.style.display = 'flex';
    pingState.dot.style.background =
      ms < PING_GOOD_MS ? '#2ecc71' : ms < PING_OK_MS ? '#f1c40f' : '#e74c3c';
    pingState.text.textContent = `${Math.round(ms)} ms${clockTxt}`;
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

    // Nearest the cursor, recomputed every frame — the same rule pickTarget
    // uses, so the green ring marks whoever the aim helper would engage. It
    // says nothing about whether there is a shot on them; that is what the
    // ring's fade is for.
    const scale = getLivePxPerWorldUnit(sample);
    let mwx, mwy;
    if (realMouse.hasMoved) {
      mwx = player.x + (realMouse.x - window.innerWidth / 2) / scale;
      mwy = player.y - (realMouse.y - window.innerHeight / 2) / scale;
    } else {
      mwx = player.x;
      mwy = player.y;
    }
    const now = Date.now();
    let best = null;
    let bestScore = Infinity;
    for (const e of enemies) {
      if (!isEngageable(e, now)) continue;
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

  // Whether there is a shot on this enemy at all, and the bounce it took to
  // get one. All of it comes from `reactionTarget`, so the ring is showing the
  // state of the shot the aimbot would actually take — and a bankable enemy
  // counts as having one, because it does.
  //
  // Returns { blocked, fade, bank }: `fade` is ESP.blockedAlpha when blocked
  // and 1 otherwise; `bank` is the solution to draw, or null. `blocked` false
  // is the default whenever the answer can't be worked out (dimming is a
  // display aid, and guessing "no shot" would hide enemies).
  const CLEAR_SHOT_STATE = { blocked: false, fade: 1, bank: null };
  function shotState(self, enemy, now) {
    if (!ESP.losDim || !self || !enemy) return CLEAR_SHOT_STATE;
    try {
      const shot = reactionTarget(self, enemy, now);
      if (!Number.isFinite(shot.x) || !Number.isFinite(shot.fromX)) return CLEAR_SHOT_STATE;
      return {
        blocked: shot.blocked,
        fade: shot.blocked ? ESP.blockedAlpha : 1,
        bank: shot.bank,
      };
    } catch {
      return CLEAR_SHOT_STATE;
    }
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
      const losSelf = liveSelf(sample);
      const losNow = Date.now();

      // Draw a ring around every live enemy so the user can see threats at a
      // glance. The current aim target is drawn last in green so it stays on top.
      // Downed players get a yellow ring. Enemies on a layer we can't reach
      // (e.g. they're in a bunker while we're aboveground) are dimmed to
      // UNREACHABLE_ALPHA, and enemies whose shot line is walled off with no
      // bounce available are dimmed to the same level by default (a bank
      // counts as a shot, so those stay bright — see shotState). Either way a
      // ring with no shot behind it gets no connecting line: the line means
      // "this one is takeable", so drawing a faded one would say the opposite
      // twice over.
      for (const e of sample.enemies) {
        if (e.dead) continue;
        if (isSpoofedEnemy(e.id, pageSamples)) continue;
        if (e.id === targetId) continue;
        const ei = overlayPos(e.id, e.x, e.y);
        const sx = cx + (ei.x - pi.x) * scale;
        const sy = cy - (ei.y - pi.y) * scale;
        const reachable = canInteract(player.layer, e.layer);
        const st = reachable ? shotState(losSelf, e, losNow) : CLEAR_SHOT_STATE;
        const shootable = reachable && !st.blocked;
        const colorRgb = e.downed ? '255, 220, 40' : '255, 60, 60';
        const ringAlpha = (reachable ? 1 : UNREACHABLE_ALPHA) * st.fade;
        ctx.lineWidth = 4;
        ctx.strokeStyle = `rgba(${colorRgb}, ${ringAlpha})`;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.stroke();

        if (shootable) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = `rgba(${colorRgb}, 0.6)`;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
      }

      if (target) {
        const ti = overlayPos(target.id, target.x, target.y);
        const sx = cx + (ti.x - pi.x) * scale;
        const sy = cy - (ti.y - pi.y) * scale;
        const st = shotState(losSelf, target, losNow);
        const blockFade = st.fade;

        ctx.lineWidth = 4;
        ctx.strokeStyle = `rgba(64, 255, 89, ${0.95 * blockFade})`;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.stroke();

        // The path the shot actually takes — and only when there is one, same
        // rule as the enemy rings above. A bank shot is drawn as its two legs,
        // bent at the surface it bounces off, so the reason the aim has swung
        // away from the target is visible rather than mysterious; a direct
        // shot is the usual straight line to it. Only the committed target
        // gets this — one bounce per frame, not one per enemy.
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(64, 255, 89, ${0.55 * blockFade})`;
        if (!st.blocked) {
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          if (st.bank) {
            ctx.lineTo(cx + (st.bank.rx - pi.x) * scale, cy - (st.bank.ry - pi.y) * scale);
          }
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }

        // Small crosshair tick at center for unambiguous "this enemy"
        // indication — drawn either way, since the target is still the target.
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
    // Enemies on screen right now that the whitelist is holding fire on. The
    // first thing to check when the aim "does nothing" against someone.
    const spared = (sample?.enemies || [])
      .filter((e) => isWhitelistedName(e.name))
      .map((e) => e.name);
    if (!target) return { target: null, clockReady: netClock.ready, whitelisted: spared };
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
      whitelisted: spared,
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
      // 'direct' when the line is clear, 'bank' when the aim point above is a
      // mirrored one and the shot is going round, 'blocked' when neither is
      // available and the aim is being thrown at a wall.
      shot: aimAt.bank ? 'bank' : (aimAt.blocked ? 'blocked' : 'direct'),
      bank: aimAt.bank ? {
        off: aimAt.bank.obstacle.type,
        at: [Number(aimAt.bank.rx.toFixed(2)), Number(aimAt.bank.ry.toFixed(2))],
        pathUnits: Number(aimAt.bank.dist.toFixed(2)),
        vsDirectUnits: Number(Math.hypot(drawn.x - aimAt.fromX, drawn.y - aimAt.fromY).toFixed(2)),
      } : null,
    };
  };

  post('status', { ok: true, message: 'Injector loaded.', url: location.href, isTop: window.top === window });
  // console.log(`[${SOURCE}] inject.js TAIL reached, starting sampleLoop @ ${SAMPLE_MS}ms`);
  setInterval(sampleLoop, SAMPLE_MS);
})();
