(() => {
  const SOURCE = 'enemy-location-logger';
  // console.log(`[${SOURCE}] inject.js HEAD reached, url=${location.href}, isTop=${window.top === window}`);
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

  // gun type (as stored in `me.TUfS.yCa`) -> projectile speed in world
  // units/sec, derived offline from the survev client bundle:
  //   - js_dump/CjGi1tJP.js holds the bullet definitions (`bullet_xxx: { speed: NN }`)
  //   - js_dump/CizGBfZ6.js gun definitions reference these via `bulletType`
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
    sv98: 182, awc: 136, m39: 125, svd: 127, garand: 144,
    m870: 66, m1100: 66, mp220: 66, saiga: 66,
    spas12: 88, spas16: 88, m1014: 118, usas: 72,
    m9: 85, m9_dual: 85, m9_cursed: 85, m93r: 85, m93r_dual: 85,
    glock: 70, glock_dual: 70, p30l: 94, p30l_dual: 94,
    ot38: 112, ot38_dual: 112, ots38: 115, ots38_dual: 115,
    colt45: 106, colt45_dual: 106, m1911: 80, m1911_dual: 80, m1a1: 80,
    deagle: 115, deagle_dual: 115,
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
    // `TUfS.yCa` is the active weapon string (e.g. "ak47", "fists",
    // "machete"). Falls back to walking the slot array (`NjFD.EcBDWN[JMs]`)
    // in case the network field hasn't propagated yet.
    try {
      const fromBzo = me?.TUfS?.yCa;
      if (typeof fromBzo === 'string' && fromBzo) return fromBzo;
      const slots = me?.NjFD?.EcBDWN;
      const idx = me?.NjFD?.JMs;
      if (Array.isArray(slots) && Number.isFinite(idx)) {
        const slot = slots[idx];
        if (slot && typeof slot.type === 'string') return slot.type;
      }
    } catch {}
    return '';
  }

  const SCOPE_PATTERN = /^(?:1|2|4|8|15)xscope$/;

  // The active scope string lives on the local player's localData (`NjFD`) or
  // netData (`TUfS`) under a mangled key we don't know up-front. Walk both
  // objects' own enumerable string fields looking for any value that matches
  // the scope pattern — adapts automatically across bundle re-mangles.
  function getCurrentScope(me) {
    try {
      const sources = [me?.NjFD, me?.TUfS, me];
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
  // NjFD scan below to recognize the zoom field by its value rather than its
  // (mangled) name.
  const ALL_SCOPE_RADII = new Set([
    ...Object.values(SCOPE_RADIUS_DESKTOP),
    ...Object.values(SCOPE_RADIUS_MOBILE)
  ]);

  // Cached mangled key for `m_localData.m_zoom` once we've identified it on
  // a particular NjFD shape. Reset whenever we swap captured games (different
  // round / respawn — see swapCapturedGame).
  let cachedZoomKey = null;
  // Cached mangled own-prop name on the game (Rr) that holds the Camera
  // instance, and the mangled name on the camera for m_zoom. Also reset on
  // game swap. See findCameraOnGame / readCameraZoom below.
  let cachedCameraKey = null;
  let cachedCameraZoomKey = null;

  // Read the current scope radius (world units) from the active player's
  // localData. The bundle stores it via `this.NjFD.<mangled> = e.zoom` (see
  // js_dump/CizGBfZ6.js — currently `gfAvB`, but we don't pin the name). We scan
  // for an own number-valued prop whose value matches the EXPECTED radius
  // for the current scope string — that disambiguates against health/boost,
  // which can also legitimately equal 40 for mobile 2xscope users at 40%.
  // Returns null if we can't find it; callers fall back to the table lookup.
  function readZoomRadiusFromPlayer(me, scope) {
    const expected = SCOPE_RADIUS_TABLE[scope];
    if (expected == null) return null;
    const lzr = me?.NjFD;
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
  // (survev client/src/camera.ts, mangled to `ct` in js_dump/CizGBfZ6.js) has a
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
        me = findLocalPlayerOnGame(game) || game?.zSsh || null;
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

  // The game class instance (`Mi.game`, internally `Rr`) is held in a
  // module-private `var` inside an ES module bundle, so it is not reachable
  // by walking from window/document/canvas. We install a setter trap on
  // Object.prototype for properties that the Rr constructor body assigns
  // from positional params (`this.WNNSH = e, this.iTj = t, ...`), but which
  // are NOT pre-declared as class fields — so those assignments walk the
  // prototype chain and fire our setter with `this` = the new game instance.
  // We verify shape before capturing to avoid false positives, then restore
  // Object.prototype on success.
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
  // We also rely on this script being loaded as a `world: "MAIN"` content
  // script (see manifest.json) so it runs at document_start in the page
  // world, BEFORE survev's bundle parses — otherwise `new Rr(...)` could
  // race ahead of us during cached reloads.
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
    // (currently `DaWsN`), so we don't anchor on the field NAME — we anchor
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
          // which point the roster (`DaWsN = new tr(...)`) has not been
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
    // Seed list: every property name the Rr constructor body assigns from a
    // positional parameter. Verified against js_dump/CizGBfZ6.js bundle. If
    // survev re-mangles, the runtime discovery pass below will add more.
    const seedNames = [
      'WNNSH', 'iTj', 'ntj', 'TrCLH', 'evqDZ',
      'Dmk', 'Qepa', 'ugKI', 'eOhlCd'
    ];
    for (const name of seedNames) installTrapName(name);
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
    const roster = findRosterOnGame(game) || game?.DaWsN;
    if (!roster) return { reason: 'no-roster' };

    const me = findLocalPlayerOnGame(game) || game?.zSsh;
    if (!me) return { reason: 'no-player' };

    const selfId = Number(me.__id ?? me.playerId ?? 0) || null;
    const selfPos = getXY(me.rvyyT ?? me.pos);
    if (!selfPos) return { reason: 'no-pos', selfId };
    const selfDir = getDir(me.EZOCU);
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

    // Enemies live in the Player entity pool (`DaWsN.playerPool`), not in
    // `playerStatus`. `playerStatus` only carries minimap state for players on
    // the local team — it never contains enemies in non-faction modes. The
    // pool, on the other hand, holds the actual Player objects that the server
    // has streamed to us (i.e. enemies currently within view radius).
    const pool = roster.playerPool;
    const players = (pool && typeof pool.PcLNdX === 'function' ? pool.PcLNdX() : []) || [];
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

      const pos = getXY(player.rvyyT ?? player.iUBbYp);
      if (!pos) continue;
      const dir = getDir(player.EZOCU);

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
        // The Player class has no own `dead`/`downed` fields — they live on
        // the netData object (`TUfS`) under mangled names. Bundle source:
        //   `r.dead  = s.TUfS.IAdYkx`
        //   `r.downed = s.TUfS.QXz`
        // (`TUfS` is the same netData we already use for `getCurrentWeapon`.)
        dead: Boolean(player.TUfS?.IAdYkx),
        downed: Boolean(player.TUfS?.QXz ?? player.downed),
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
        dead: Boolean(me.TUfS?.IAdYkx),
        downed: Boolean(me.TUfS?.QXz ?? me.downed),
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
        post('status', {
          ok: false,
          message: 'Game root not found yet.',
          url: location.href,
          isTop: window.top === window,
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
          'no-player': 'Game captured, but the local player slot is null. Click Play and join a match — `zSsh` only gets populated when the first server update arrives.',
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
  // Humanization parameters for the auto-aim. All angles are radians, all
  // times are milliseconds. Tunable live from devtools via `window.__aimHuman`
  // (assigned just below). The point of this block is to give the cheat a
  // real player's behavioral fingerprint — reaction latency, biomechanical
  // jitter, imperfect lead, target stickiness — so a behavioral anti-cheat
  // can't trivially flag the perfectly-locked, zero-latency snap profile.
  const AIM_HUMAN = {
    // All quantities below that previously drew an IID gaussian sample now
    // come from an Ornstein–Uhlenbeck-style AR(1) walk whose stationary
    // distribution is the same N(mean, std²) the IID draw used to target.
    // Each walk has its own relaxation rate `alpha` (1/sec) — larger alpha
    // means faster reversion to the mean (shorter autocorrelation time
    // τ ≈ 1/alpha). Temporally correlated noise matches real human traits
    // (hand tremor, miscalibration, reaction time) better than white noise.
    //
    // Reaction delay between target acquisition and the cursor starting to
    // move. Drawn from a walk with stationary N(mean, std²), clamped to
    // [min, ∞). 180±40ms matches typical visual-motor reaction-time
    // research; faster players sit around 130–150ms. alpha=0.05 ⇒ τ≈20s,
    // i.e. reaction drifts slowly across a session.
    reactionMs:       { mean: 140, std: 40, min: 90, alpha: 0.05 },
    // Same, but for switching from one engaged target to another. Players
    // already in the loop react faster than fresh acquisitions.
    switchReactionMs: { mean: 130, std: 30, min: 60, alpha: 0.05 },

    // Maximum angular speed of the cursor in rad/sec. Caps how fast we can
    // rotate the aim — equivalent to a real player's mouse sensitivity ceiling.
    // 14 rad/s ≈ 800 deg/s, fast but well within human reach.
    maxAngularSpeed: 28,
    // Per-frame fraction of the remaining angular distance to traverse.
    // With ~16ms RAF, 0.22 closes ~90% of the gap in ~160ms — a fast
    // human flick-then-track curve.
    followGain: 0.22,

    // Per-frame noise added to the cursor angle. Models hand tremor.
    // 0.012 rad ≈ 0.7° steady-state deviation. alpha=15 ⇒ τ≈67ms, so the
    // tremor varies smoothly across a few frames instead of flipping sign
    // every frame the way an IID draw would.
    jitterStd:   0.002,
    jitterAlpha: 15,

    // Per-acquisition offset added to the lead-predicted angle. Drawn from
    // a walk with stationary N(0, aimErrorStd²); autocorrelation across
    // acquisitions models the player's calibration drifting slowly across
    // the session rather than reshuffling at every target switch.
    aimErrorStd:   0.003,
    aimErrorAlpha: 0.05,

    // Lead-prediction accuracy: actualLead = perfectLead × leadFactor, where
    // leadFactor follows a walk with stationary N(leadFactorMean,
    // leadFactorStd²), clamped to [0, 1.5]. <1 means under-leading
    // (typical), >1 means over-leading.
    leadFactorMean:  0.9,
    leadFactorStd:   0.15,
    leadFactorAlpha: 0.05,

    // Target stickiness. Once committed, prefer the current target over a
    // newly-nearest one unless the new target is at least `switchAdvantage`×
    // closer. Combined with a minimum hold time.
    switchAdvantage: 0.70,
    stickyMs:        500,

    // After the committed target dies, keep the cursor pinned to the corpse
    // for this long before allowing a switch. Models a real player's
    // follow-through — humans don't instantly flick away from a kill, they
    // confirm it for a beat first.
    deadLingerMs:    400,

    // Idle behavior when no target is visible: the cursor's "desired"
    // angle drifts around theta along a walk with stationary N(0,
    // idleWanderStd²). alpha=3 ⇒ τ≈333ms, producing a wandering gaze
    // rather than a frame-by-frame jitter.
    idleWanderStd:   0.15,
    idleWanderAlpha: 3,

    // NOTE: the visible-world width is derived per-frame from the player's
    // current scope radius (see getViewportWorldUnits above) and published
    // on `sample.self.viewportWorldUnits`. Downstream scoring reads it from
    // there instead of a static config value.
  };
  // Expose for live tuning from the devtools console without reloading.
  window.__aimHuman = AIM_HUMAN;

  // Persistent aim state across animation frames.
  const aimState = {
    theta: 0,                              // current cursor angle (world space)
    targetId: null,                        // currently committed enemy id
    targetAcquiredAt: 0,                   // ms when we committed to current target
    targetDeadAt: 0,                       // ms when committed target was first seen dead (0 if alive)
    reactionUntil: 0,                      // ms before which we don't move toward the target
    aimErrorOffset: 0,                     // aim error used this engagement (rad)
    leadFactor: AIM_HUMAN.leadFactorMean,  // lead-prediction accuracy used this engagement
    lastFrameAt: 0,                        // for computing dt between RAF ticks
    // Walk state for each AR(1) process. Each field carries the most recent
    // walk value; ouStep mutates it in place each step. Per-frame walks
    // (jitter, wander) are advanced on every dispatchAim tick using the
    // RAF dt. Per-acquisition walks (aimError, leadFactor, reaction) are
    // advanced on each target commit using the elapsed time since the last
    // commit. Initialized at the walk's mean — ouStep relaxes each toward
    // stationary within a few time constants.
    jitterWalk:         0,
    wanderWalk:         0,
    aimErrorWalk:       0,
    leadFactorWalk:     AIM_HUMAN.leadFactorMean,
    reactionWalk:       AIM_HUMAN.reactionMs.mean,
    switchReactionWalk: AIM_HUMAN.switchReactionMs.mean,
    lastAcqAt:          0                  // for computing dt between per-acquisition walk steps
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

  // Box-Muller normal sample. Discards the second output for simplicity.
  // Only used as the innovation term inside `ouStep`; call sites don't
  // draw IID gaussians directly anymore.
  function gaussian(mean, std) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Ornstein–Uhlenbeck-style AR(1) walk step. Given previous value X(t),
  // elapsed time δ (seconds), relaxation rate α (1/sec), and target mean μ
  // and std σ, returns X(t+δ) drawn from a process whose stationary
  // distribution is N(μ, σ²). Derived from the user-supplied update rule
  //     X(t+δ) = (1 − δα)·X(t) + σ·√(1 − (1−δα)²)·Z,   Z ~ N(0,1)
  // scaled/shifted for non-zero mean:
  //     Y(t+δ) = μ + (1−δα)·(Y(t) − μ) + σ·√(1−(1−δα)²)·Z.
  // The decay factor is clamped to [0, 1] so the walk stays stable even
  // if a caller passes a large δ (a long pause between target commits,
  // for instance) — at decay=0 we draw a fresh stationary sample, which
  // is the correct limit.
  function ouStep(prev, dt, alpha, mean, sigma) {
    let decay = 1 - dt * alpha;
    if (decay < 0) decay = 0;
    else if (decay > 1) decay = 1;
    return mean + decay * (prev - mean) + sigma * Math.sqrt(1 - decay * decay) * gaussian(0, 1);
  }

  // Shortest signed arc from a to b on the unit circle, in (-π, π]. Used for
  // cursor easing so the slew always rotates the short way around.
  function shortestArc(a, b) {
    let d = (b - a) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d <= -Math.PI) d += 2 * Math.PI;
    return d;
  }

  // Pick the enemy whose world position is closest (in Euclidean distance)
  // to the world point under the user's real mouse cursor. Survev keeps the
  // local player viewport-centered, so the mouse offset from screen center
  // — divided by the world-to-screen pixel scale — is the world offset
  // from the player. Adding it to the player's world position gives us
  // a "where the user is pointing in the world" point that we score every
  // visible enemy against.
  //
  // Stickiness still applies on top: once committed, we hold a target for
  // `stickyMs` regardless, and past that window we only switch if the new
  // best is materially closer to the mouse than the current one. This both
  // humanizes the cheat and prevents frame-to-frame flicker when two enemies
  // are roughly equidistant from the cursor.
  function pickTarget(player, enemies, now) {
    // Dead-linger: if the committed target just died, keep aiming at the
    // corpse for `deadLingerMs` before releasing. Models a human's
    // follow-through after a kill. We check this *before* filtering out
    // dead enemies so the corpse is still a valid return value.
    if (aimState.targetId != null) {
      const currentAny = enemies.find((e) => e.id === aimState.targetId);
      if (currentAny && currentAny.dead) {
        if (aimState.targetDeadAt === 0) aimState.targetDeadAt = now;
        if (now - aimState.targetDeadAt < AIM_HUMAN.deadLingerMs) {
          return [currentAny, dist(player, currentAny)];
        }
        // Linger expired — fall through to normal selection (which will
        // pick a new live target and dispatchAim will clear targetDeadAt).
      } else if (currentAny && !currentAny.dead) {
        // Target is alive again (or still alive) — clear any stale death ts.
        aimState.targetDeadAt = 0;
      }
    }

    const candidates = [];
    for (const e of enemies) {
      if (e.dead) continue;
      if (isSpoofedEnemy(e.id, pageSamples)) continue;
      candidates.push(e);
    }
    if (!candidates.length) return [null, 0];

    // Project the user's real mouse cursor into world space. Screen Y is
    // flipped because screen-down is world-down for the cursor but our world
    // angles use positive-Y-up. If the mouse hasn't moved yet, fall back to
    // "the user is pointing at themselves" so we still pick *some* enemy
    // until they move the mouse.
    const scale = getLivePxPerWorldUnit(pageSamples[pageSamples.length - 1]);
    let mouseWorldX, mouseWorldY;
    if (realMouse.hasMoved) {
      mouseWorldX = player.x + (realMouse.x - window.innerWidth / 2) / scale;
      mouseWorldY = player.y - (realMouse.y - window.innerHeight / 2) / scale;
    } else {
      mouseWorldX = player.x;
      mouseWorldY = player.y;
    }

    // Score = squared Euclidean distance in world space from the enemy to
    // the mouse-projected world point. We use squared distance because
    // sqrt is monotonic — the ordering is identical and we save 60 sqrts
    // per frame.
    const scoreOf = (e) => {
      const dx = e.x - mouseWorldX;
      const dy = e.y - mouseWorldY;
      return dx * dx + dy * dy;
    };

    let best = candidates[0];
    let bestScore = scoreOf(best);
    for (let i = 1; i < candidates.length; i++) {
      const s = scoreOf(candidates[i]);
      if (s < bestScore) {
        bestScore = s;
        best = candidates[i];
      }
    }

    // No commitment yet — take the closest-to-mouse enemy.
    if (aimState.targetId == null) return [best, dist(player, best)];

    // Current target still alive & in the candidate set?
    const current = candidates.find((c) => c.id === aimState.targetId);
    if (!current) return [best, dist(player, best)];

    // Hold during the sticky window regardless of mouse position.
    if (now - aimState.targetAcquiredAt < AIM_HUMAN.stickyMs) {
      return [current, dist(player, current)];
    }

    // Past sticky: only switch if the best is materially closer to the mouse.
    // switchAdvantage<1 means the new squared-distance must be at least that
    // fraction of the current squared-distance (e.g. 0.7 → new must be at
    // ≥√(1-0.7) ≈ 55% the linear distance to switch).
    if (best.id === current.id) return [current, dist(player, current)];
    const currentScore = scoreOf(current);
    if (bestScore < currentScore * AIM_HUMAN.switchAdvantage) {
      return [best, dist(player, best)];
    }
    return [current, dist(player, current)];
  }

  // Compute the lead-predicted angle to an enemy, scaled by `leadFactor` so
  // we can model imperfect human prediction. With leadFactor=1 this matches
  // the perfect-aim version; with leadFactor<1 we under-lead (the typical
  // human failure mode).
  function leadAngle(player, enemy, distance, leadFactor) {
    const bulletSpeed = player.bulletSpeed ?? 1e8;
    const tHit = (distance / bulletSpeed) * leadFactor;
    const tx = enemy.x + (enemy.xv ?? 0) * tHit;
    const ty = enemy.y + (enemy.yv ?? 0) * tHit;
    return Math.atan2(ty - player.y, tx - player.x);
  }

  function dispatchAim() {
    const target = document.querySelector('canvas') || document.body;
    if (!target) return;
    if (!pageSamples.length) return;

    const last_sample = pageSamples[pageSamples.length - 1];
    const player = last_sample.self;
    const enemies = last_sample.enemies;

    const now = performance.now();
    const dt = aimState.lastFrameAt ? Math.max(0.001, (now - aimState.lastFrameAt) / 1000) : 0.016;
    aimState.lastFrameAt = now;

    // Advance the per-frame walks (hand tremor and idle wander). Each
    // carries temporally-correlated noise in place of the IID gaussians
    // previously drawn here, so successive frames see a smoothly-varying
    // offset rather than white noise.
    aimState.jitterWalk = ouStep(
      aimState.jitterWalk, dt, AIM_HUMAN.jitterAlpha, 0, AIM_HUMAN.jitterStd
    );
    aimState.wanderWalk = ouStep(
      aimState.wanderWalk, dt, AIM_HUMAN.idleWanderAlpha, 0, AIM_HUMAN.idleWanderStd
    );

    const [enemy, distance] = pickTarget(player, enemies, now);
    // Acquisition / switch bookkeeping. New commit → advance the
    // per-acquisition walks (reaction, aim error, lead factor) using the
    // elapsed time since the previous commit as δ, then snapshot the
    // walk values into the engagement-scoped fields that dispatchAim reads
    // below. This models slowly-varying human traits across a session
    // instead of re-rolling them independently at every target switch.
    if (enemy) {
      if (aimState.targetId !== enemy.id) {
        const isSwitch = aimState.targetId != null;
        const dtAcq = aimState.lastAcqAt ? (now - aimState.lastAcqAt) / 1000 : 1;
        aimState.reactionWalk = ouStep(
          aimState.reactionWalk, dtAcq, AIM_HUMAN.reactionMs.alpha,
          AIM_HUMAN.reactionMs.mean, AIM_HUMAN.reactionMs.std
        );
        aimState.switchReactionWalk = ouStep(
          aimState.switchReactionWalk, dtAcq, AIM_HUMAN.switchReactionMs.alpha,
          AIM_HUMAN.switchReactionMs.mean, AIM_HUMAN.switchReactionMs.std
        );
        aimState.aimErrorWalk = ouStep(
          aimState.aimErrorWalk, dtAcq, AIM_HUMAN.aimErrorAlpha,
          0, AIM_HUMAN.aimErrorStd
        );
        aimState.leadFactorWalk = ouStep(
          aimState.leadFactorWalk, dtAcq, AIM_HUMAN.leadFactorAlpha,
          AIM_HUMAN.leadFactorMean, AIM_HUMAN.leadFactorStd
        );
        aimState.lastAcqAt = now;

        const rawReaction = isSwitch ? aimState.switchReactionWalk : aimState.reactionWalk;
        const reactionMin = isSwitch ? AIM_HUMAN.switchReactionMs.min : AIM_HUMAN.reactionMs.min;
        aimState.targetId = enemy.id;
        aimState.targetAcquiredAt = now;
        aimState.targetDeadAt = 0;
        aimState.reactionUntil = now + Math.max(reactionMin, rawReaction);
        aimState.aimErrorOffset = aimState.aimErrorWalk;
        aimState.leadFactor = Math.max(0, Math.min(1.5, aimState.leadFactorWalk));
      }
    } else {
      aimState.targetId = null;
    }

    // Decide where the cursor *wants* to be this frame.
    let desired;
    if (enemy && now >= aimState.reactionUntil) {
      desired = leadAngle(player, enemy, distance, aimState.leadFactor) + aimState.aimErrorOffset;
    } else if (enemy) {
      // In reaction window — cursor stays put (still drifting via jitter/idle).
      desired = aimState.theta;
    } else {
      // No target — offset the desired angle by the wander walk so theta
      // drifts smoothly instead of sitting perfectly still.
      desired = aimState.theta + aimState.wanderWalk;
    }

    // Slew toward desired with a per-frame fraction, capped by max angular
    // speed. This produces the flick-then-settle curve real players show
    // instead of a 1-frame teleport.
    const arc = shortestArc(aimState.theta, desired);
    const maxStep = AIM_HUMAN.maxAngularSpeed * dt;
    let step = arc * AIM_HUMAN.followGain;
    if (step > maxStep) step = maxStep;
    else if (step < -maxStep) step = -maxStep;
    aimState.theta += step;

    // Hand tremor.
    aimState.theta += aimState.jitterWalk;

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
      // Snap the synthetic cursor to wherever the user's real mouse currently
      // points so the slew starts from "where I'm looking" instead of from
      // last session's leftover theta. Without this, the very first frame
      // of a new hold flicks across the screen.
      if (realMouse.hasMoved) {
        const mdx = realMouse.x - window.innerWidth / 2;
        const mdy = -(realMouse.y - window.innerHeight / 2);
        aimState.theta = Math.atan2(mdy, mdx);
      }
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
    // Drop per-session aim state so the next hold starts with a fresh
    // reaction delay and a sensible dt on frame 0.
    aimState.targetId = null;
    aimState.targetDeadAt = 0;
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
    }
    if (!shiftHeld || !e.isTrusted) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  // ---------------------------------------------------------------------
  // Auto-quickswap after firing a slow-firerate gun. When the user
  // left-clicks while holding a sniper/shotgun, we synthesize a
  // SwapWeapSlots keydown so the swap fires on the *next* server tick,
  // right after the shot input. The game zeroes `gunSwitchCooldown` on
  // a swap input (see CizGBfZ6 line 14804), so the other gun is ready
  // to fire as soon as its own switchDelay elapses — materially faster
  // than waiting out the slow gun's fireDelay. Classic two-gun
  // quickswitch.
  // ---------------------------------------------------------------------

  // Guns whose fireDelay (CjGi1tJP.js) is ≥ 0.3s and which fire one shot
  // per click — the regime where quickswapping beats waiting. Burst-fire
  // weapons (ump9, famas) are excluded because swapping mid-burst
  // truncates the remaining shots; auto-fire weapons aren't here because
  // the user would just keep holding the trigger.
  const SLOW_FIRE_GUNS = new Set([
    // Bolt/lever-action rifles + DMRs that aim before firing
    'mosin', 'sv98', 'awc', 'scout_elite', 'blr', 'model94',
    // Pump-action and semi-auto shotguns
    'm870', 'm1100', 'spas12', 'spas16', 'mp220', 'saiga', 'm1014', 'usas',
  ]);

  // Survev collects inputs once per tick (~16ms) and `flush()` advances
  // `keysOld := keys` at end-of-tick. A 30ms gap between the user's
  // mousedown and the swap signal guarantees the Fire input lands on
  // its own tick *before* the SwapWeapSlots input, so the server shoots
  // first and swaps second.
  const AUTO_SWAP_FIRE_TO_SWAP_MS = 30;

  function autoSwapOtherSlotHasGun(me) {
    try {
      const slots = me?.NjFD?.EcBDWN;
      const idx = me?.NjFD?.JMs;
      if (!Array.isArray(slots) || !Number.isFinite(idx)) return false;
      const other = slots[idx === 0 ? 1 : 0];
      return !!(other && typeof other.type === 'string' && other.type);
    } catch {
      return false;
    }
  }

  // Input enum values from CjGi1tJP_formatted.js:21384. Stable because
  // these are part of the client/server input protocol.
  const AUTO_SWAP_INPUT_FIRE = 4;
  const AUTO_SWAP_INPUT_EQUIP_OTHER = 20;

  // EquipOtherGun has no default keybind (CizGBfZ6_formatted.js:15263)
  // and no UI-flag analog like SwapWeapSlots does — the bundle only
  // emits it when `Dmk.isBindPressed(I.EquipOtherGun)` returns true
  // (line 14789-14793). To trigger it without a bind, we wrap
  // `isBindPressed` and return true for input 20 the next time the
  // input loop polls — once, then we clear the flag so we don't keep
  // emitting EquipOtherGun on every subsequent tick.
  let autoSwapHookedDmk = null;
  let autoSwapEmitEquipOther = false;

  function autoSwapEnsureHook(binds) {
    if (!binds || binds === autoSwapHookedDmk) return;
    if (typeof binds.isBindPressed !== 'function') return;
    const orig = binds.isBindPressed;
    binds.isBindPressed = function(input) {
      if (input === AUTO_SWAP_INPUT_EQUIP_OTHER && autoSwapEmitEquipOther) {
        autoSwapEmitEquipOther = false;
        return true;
      }
      return orig.call(this, input);
    };
    autoSwapHookedDmk = binds;
  }

  function autoSwapRequestSwap(game) {
    autoSwapEnsureHook(game?.Dmk);
    autoSwapEmitEquipOther = true;
  }

  // Edge-trigger on the user's Fire bind, whatever key/button that is.
  // `game.Dmk.isBindDown(4)` is the same source of truth the input loop
  // reads (CizGBfZ6_formatted.js:14788), so this is keybind-agnostic.
  let autoSwapFireWasDown = false;

  function autoSwapOnFirePressed(game) {
    const me = findLocalPlayerOnGame(game);
    if (!me) { console.log('[autoswap] skip: no local player'); return; }
    const weapon = getCurrentWeapon(me);
    if (!weapon) { console.log('[autoswap] skip: no current weapon'); return; }
    if (!SLOW_FIRE_GUNS.has(weapon)) { console.log(`[autoswap] skip: ${weapon} not in slow-fire set`); return; }
    if (!autoSwapOtherSlotHasGun(me)) { console.log(`[autoswap] skip: other slot empty (holding ${weapon})`); return; }
    console.log(`[autoswap] queued swap after ${weapon} shot`);
    setTimeout(() => autoSwapRequestSwap(game), AUTO_SWAP_FIRE_TO_SWAP_MS);
  }

  function autoSwapFrameTick() {
    try {
      const game = capturedGame;
      const binds = game?.Dmk;
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
  let interpT0 = 0;      // timestamp when interpCurr was captured
  const INTERP_WINDOW = SAMPLE_MS; // ms over which we lerp prev→curr

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
    const elapsed = performance.now() - interpT0;
    const t = INTERP_WINDOW > 0 ? Math.min(elapsed / INTERP_WINDOW, 1) : 1;
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
    const overshoot = (elapsed - INTERP_WINDOW) / 1000;
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

    // While engaged, show the actual committed target (respects stickiness,
    // including the dead-linger window when we're still pinned to a corpse).
    if (shiftHeld && aimState.targetId != null) {
      const committed = enemies.find((e) => e.id === aimState.targetId);
      if (committed && !committed.dead) return committed;
      if (
        committed && committed.dead &&
        aimState.targetDeadAt &&
        performance.now() - aimState.targetDeadAt < AIM_HUMAN.deadLingerMs
      ) {
        return committed;
      }
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
      // Downed players get a yellow ring.
      for (const e of sample.enemies) {
        if (e.dead) continue;
        if (isSpoofedEnemy(e.id, pageSamples)) continue;
        if (e.id === targetId) continue;
        const ei = interpPos(e.id, e.x, e.y);
        const sx = cx + (ei.x - pi.x) * scale;
        const sy = cy - (ei.y - pi.y) * scale;
        const ringColor = e.downed ? 'rgba(255, 220, 40, 0.90)' : 'rgba(255, 60, 60, 0.85)';
        const lineColor = e.downed ? 'rgba(255, 220, 40, 0.50)' : 'rgba(255, 60, 60, 0.45)';
        ctx.lineWidth = 4;
        ctx.strokeStyle = ringColor;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.stroke();

        // Line from player (center) to enemy
        ctx.lineWidth = 1.5;
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
        ctx.lineWidth = 1.5;
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
    }

    requestAnimationFrame(overlayFrame);
  }
  requestAnimationFrame(overlayFrame);

  post('status', { ok: true, message: 'Injector loaded.', url: location.href, isTop: window.top === window });
  // console.log(`[${SOURCE}] inject.js TAIL reached, starting sampleLoop @ ${SAMPLE_MS}ms`);
  setInterval(sampleLoop, SAMPLE_MS);
})();
