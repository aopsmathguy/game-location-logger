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
  // The animation the server last told a player to play, and its sequence
  // number, straight off the wire. The dodge bot brackets a grenade cook with
  // them — see trackCookAnims.
  const NET_ANIM     = M.netData?.animType;
  const NET_ANIMSEQ  = M.netData?.animSeq;
  const NET_DEAD     = M.netData.dead;
  const NET_DOWNED   = M.netData.downed;
  const NET_SCALE    = M.netData?.scale;
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

  // Same gun type -> the bulletType it fires, which is the key into
  // BULLET_DAMAGE and BULLET_RANGE below. Derived from the same dump as
  // GUN_BULLET_SPEED, from the `bulletType` field of each gun def, and it is
  // deliberately laid out in the same order and the same groups so the two read
  // side by side.
  //
  // A live round needs none of this — it arrives carrying its own bulletType,
  // and the addBullet hook stamps it on. This is for the round nobody has fired
  // yet: the phantom shot the dodge planner charges for pointing a gun at us
  // (see dodgeAddPhantoms), which has to be priced from the gun alone.
  //
  // The mapping is not the regular `bullet_<gun>` a third of it looks like —
  // shotguns share pellet types, every dual fires its base gun's round, and the
  // potato guns and the bugle all fire the damageless `bullet_invis` — so it is
  // written out rather than derived.
  const GUN_BULLET_TYPE = {
    mp5: 'bullet_mp5', mac10: 'bullet_mac10', ump9: 'bullet_ump9',
    vector: 'bullet_vector', vector45: 'bullet_vector45', scorpion: 'bullet_scorpion',
    vss: 'bullet_vss', famas: 'bullet_famas', hk416: 'bullet_hk416',
    m4a1: 'bullet_m4a1', mk12: 'bullet_mk12', l86: 'bullet_l86',
    m249: 'bullet_m249', qbb97: 'bullet_qbb97', scout_elite: 'bullet_scout',
    ak47: 'bullet_ak47', scar: 'bullet_scar',
    scarssr: 'bullet_scarssr', an94: 'bullet_an94', groza: 'bullet_groza',
    grozas: 'bullet_grozas', dp28: 'bullet_dp28', bar: 'bullet_bar',
    imbel: 'bullet_imbel', pkp: 'bullet_pkp', model94: 'bullet_model94',
    mkg45: 'bullet_mkg45', blr: 'bullet_blr', mosin: 'bullet_mosin',
    sv98: 'bullet_sv98', awc: 'bullet_awc', m39: 'bullet_m39', svd: 'bullet_svd',
    garand: 'bullet_garand', barrett: 'bullet_barrett',
    ash12: 'bullet_ash12',
    m870: 'bullet_buckshot', m1100: 'bullet_birdshot', mp220: 'bullet_buckshot',
    saiga: 'bullet_buckshot',
    spas12: 'bullet_flechette', spas16: 'bullet_flechette', m1014: 'bullet_slug',
    usas: 'bullet_frag',
    m9: 'bullet_m9', m9_dual: 'bullet_m9', m9_cursed: 'bullet_m9_cursed',
    m93r: 'bullet_m93r', m93r_dual: 'bullet_m93r',
    glock: 'bullet_glock', glock_dual: 'bullet_glock', p30l: 'bullet_p30l',
    p30l_dual: 'bullet_p30l',
    ot38: 'bullet_ot38', ot38_dual: 'bullet_ot38', ots38: 'bullet_ots38',
    ots38_dual: 'bullet_ots38',
    colt45: 'bullet_colt45', colt45_dual: 'bullet_colt45', m1911: 'bullet_m1911',
    m1911_dual: 'bullet_m1911', m1a1: 'bullet_m1a1',
    deagle: 'bullet_deagle', deagle_dual: 'bullet_deagle', sw500: 'bullet_sw500',
    flare_gun: 'bullet_flare', flare_gun_dual: 'bullet_flare',
    potato_cannon: 'bullet_invis', potato_smg: 'bullet_invis',
    potato_lmg: 'bullet_invis', bugle: 'bullet_invis',
  };

  // bulletType (as it arrives on the wire, and as stamped onto barn entries by
  // the addBullet hook) -> [damage, falloff], lifted verbatim from
  // survev's `shared/defs/gameObjects/bulletDefs.ts`. Two numbers because those
  // are the only two the server's damage formula needs that aren't already on
  // the client's own barn entry:
  //
  //     finalDamage  = def.damage * damageMult
  //     finalDamage *= 1 / (reflectCount + 1)
  //     distT        = clamp(distanceTraveled / bullet.distance, 0, 1)
  //     finalDamage *= remap(distT, 0, 1, 1, def.falloff)
  //
  // `distance` is deliberately not in here. The instance's own distance —
  // after the reflect decay, the distanceMult, the variance and the ±1 spray
  // jitter — is what the falloff divides by, and the client's barn entry
  // already carries exactly that number under `distance`. Copying the def's
  // would silently use the wrong denominator.
  //
  // `damageMult` is the one factor that can't be recovered: it never goes on
  // the wire (see updateMsg's bullet block), so a perk that scales damage is
  // invisible here and every round is priced at its base value.
  //
  // Same static-table caveat as GUN_BULLET_SPEED: re-derive when survev ships
  // new guns. An unlisted type falls back to DODGE_DMG_REF, which is exactly
  // the flat hit-counting the bot did before this table existed.
  const BULLET_DAMAGE = {
    bullet_mp5: [11, 0.8], bullet_ak47: [13.5, 0.9], bullet_scar: [15, 0.85],
    bullet_an94: [20, 0.94], bullet_groza: [12.5, 0.85], bullet_grozas: [13, 0.87],
    bullet_model94: [44, 0.75], bullet_blr: [56, 0.9], bullet_mosin: [72, 0.95],
    bullet_sv98: [80, 0.96], bullet_awc: [180, 0.94], bullet_scarssr: [81, 0.85],
    bullet_m39: [28, 0.9], bullet_svd: [37, 0.9], bullet_garand: [44, 0.94],
    bullet_buckshot: [12.5, 0.3], bullet_flechette: [8.75, 0.85], bullet_frag: [12, 0.3],
    bullet_slug: [77, 0.85], bullet_birdshot: [4, 0.25], bullet_m9: [13, 0.7],
    bullet_m9_cursed: [13, 0.7], bullet_m93r: [12, 0.7], bullet_p30l: [21, 0.75],
    bullet_ot38: [26, 0.75], bullet_ots38: [32, 0.77], bullet_colt45: [29, 0.7],
    bullet_m1911: [16, 0.7], bullet_m1a1: [13, 0.8], bullet_mkg45: [29, 0.75],
    bullet_deagle: [35, 0.75], bullet_barrett: [99, 0.975], bullet_sw500: [64, 0.92],
    bullet_ash12: [31, 0.875], bullet_mac10: [9.25, 0.6], bullet_ump9: [15, 0.75],
    bullet_vector: [7.5, 0.6], bullet_vector45: [9.5, 0.6], bullet_scorpion: [10.75, 0.77],
    bullet_vss: [24, 0.85], bullet_dp28: [14, 0.9], bullet_bar: [17.5, 0.9],
    bullet_imbel: [12, 0.9], bullet_pkp: [18, 0.9], bullet_glock: [9, 0.5],
    bullet_famas: [17, 0.8], bullet_hk416: [11, 0.85], bullet_m4a1: [14, 0.82],
    bullet_mk12: [23, 0.9], bullet_l86: [27, 0.9], bullet_m249: [14, 0.9],
    bullet_qbb97: [14, 0.9], bullet_scout: [56, 0.92],
    // Zero damage, and the bot drops them rather than dodging them. The flare's
    // falloff of 10 is a real value from the defs and is harmless against a
    // base of 0 — it is kept so the table stays a faithful copy.
    bullet_flare: [0, 10], bullet_invis: [0, 1],
    // Explosion fragments. Flat falloff, and they reach us as `damageSelf`
    // rounds, which is the one way our own shot comes back at us.
    shrapnel_barrel: [2, 1], shrapnel_stove: [5, 1], shrapnel_frag: [20, 1],
    shrapnel_strobe: [3, 1], shrapnel_usas: [5, 1], shrapnel_mirv_mini: [6, 1],
    shrapnel_bomb_iron: [10, 1], shrapnel_cobalt: [5, 1],
  };

  // bulletType -> the def's `distance`, in world units: how far a round of this
  // type flies before it expires.
  //
  // Kept apart from BULLET_DAMAGE on purpose, for the reason that table gives
  // for not carrying distance itself: a live round's range is its own, decayed
  // by reflects and scaled by the wire's distanceMult and variance, and the
  // barn entry already has that number. This is the base value from the def,
  // which is only ever the right one for a round that does not exist yet — the
  // phantom shot in dodgeAddPhantoms, whose range and damage falloff both need
  // a denominator and have no instance to read one from.
  const BULLET_RANGE = {
    bullet_mp5: 100, bullet_mac10: 50, bullet_ump9: 100, bullet_vector: 46,
    bullet_vector45: 45, bullet_scorpion: 120, bullet_vss: 125, bullet_famas: 150,
    bullet_hk416: 175, bullet_m4a1: 165, bullet_mk12: 400, bullet_l86: 425,
    bullet_m249: 220, bullet_qbb97: 200, bullet_scout: 450, bullet_ak47: 200,
    bullet_scar: 175, bullet_scarssr: 200, bullet_an94: 300, bullet_groza: 175,
    bullet_grozas: 185, bullet_dp28: 225, bullet_bar: 275, bullet_imbel: 200,
    bullet_pkp: 200, bullet_model94: 175, bullet_mkg45: 145, bullet_blr: 400,
    bullet_mosin: 500, bullet_sv98: 520, bullet_awc: 300, bullet_m39: 400,
    bullet_svd: 425, bullet_garand: 444, bullet_barrett: 400, bullet_ash12: 70,
    bullet_buckshot: 27, bullet_birdshot: 25, bullet_flechette: 45, bullet_slug: 60,
    bullet_frag: 24, bullet_m9: 100, bullet_m9_cursed: 100, bullet_m93r: 100,
    bullet_glock: 44, bullet_p30l: 100, bullet_ot38: 125, bullet_ots38: 135,
    bullet_colt45: 110, bullet_m1911: 88, bullet_m1a1: 88, bullet_deagle: 120,
    bullet_sw500: 160, bullet_flare: 16, bullet_invis: 1,
  };

  // ---- Throwables -------------------------------------------------------
  //
  // throwable type (the projectile's own `type`, which IS on the wire) -> the
  // physics constants the server integrates it with, transcribed from survev's
  // `shared/defs/gameObjects/throwableDefs.ts`. Same standing as the bullet
  // tables above: static, and re-derived if survev ships new throwables.
  //
  // Only what the blast prediction needs is here. `velZ` and `fuse` are the two
  // that cannot be recovered any other way — neither is on the wire — and they
  // are what make the arc solvable and the detonation datable at all. See
  // dodgeProjFuse and dodgeSimBlast.
  //
  // `impact` types explode on contact rather than on a fuse (the potato-mode
  // guns, snowballs, coconuts), and their `fuse` is survev's own 9999 sentinel.
  // They are listed for completeness and rejected in dodgeAddBlasts: their
  // detonation is a collision, not a clock, and predicting it means predicting
  // whose body they hit.
  //
  // `variance` is added to the fuse at spawn from a uniform draw the wire never
  // carries, so it is genuinely unknowable — it is carried here so the estimate
  // can be biased *early* by it rather than pretending it is zero.
  const THROWABLE_PHYS = {
    frag:        { fuse: 4,   variance: 0,   velZ: 5, speed: 20,    rad: 1,    cookable: 1, impact: 0, blast: 'explosion_frag' },
    mirv:        { fuse: 4,   variance: 0,   velZ: 5, speed: 20,    rad: 1,    cookable: 1, impact: 0, blast: 'explosion_mirv' },
    mirv_mini:   { fuse: 1.8, variance: 0.3, velZ: 5, speed: 20,    rad: 1,    cookable: 1, impact: 0, blast: 'explosion_mirv_mini' },
    martyr_nade: { fuse: 3,   variance: 0.3, velZ: 5, speed: 20,    rad: 1,    cookable: 1, impact: 0, blast: 'explosion_martyr_nade' },
    smoke:       { fuse: 2.5, variance: 0,   velZ: 5, speed: 15,    rad: 1,    cookable: 0, impact: 0, blast: 'explosion_smoke' },
    strobe:      { fuse: 13.5,variance: 0,   velZ: 5, speed: 25,    rad: 1,    cookable: 0, impact: 0, blast: 'explosion_strobe' },
    bomb_iron:   { fuse: 4,   variance: 0,   velZ: 0, speed: 20,    rad: 1,    cookable: 1, impact: 1, blast: 'explosion_bomb_iron' },
    snowball:        { fuse: 9999, variance: 0, velZ: 3.35, speed: 52, rad: 1,    cookable: 1, impact: 1, blast: 'explosion_snowball' },
    snowball_heavy:  { fuse: 9999, variance: 0, velZ: 3.35, speed: 45, rad: 1.25, cookable: 1, impact: 1, blast: 'explosion_snowball_heavy' },
    potato:          { fuse: 9999, variance: 0, velZ: 3.35, speed: 40, rad: 1,    cookable: 1, impact: 1, blast: 'explosion_potato' },
    potato_heavy:    { fuse: 9999, variance: 0, velZ: 3.35, speed: 45, rad: 1.25, cookable: 1, impact: 1, blast: 'explosion_potato_heavy' },
    coconut:         { fuse: 9999, variance: 0, velZ: 3.35, speed: 45, rad: 1.15, cookable: 0, impact: 1, blast: 'explosion_coconut' },
    tomato:          { fuse: 9999, variance: 0, velZ: 3.35, speed: 55, rad: 1,    cookable: 1, impact: 1, blast: 'explosion_tomato' },
  };

  // explosion type -> [damage at the centre, rad.min, rad.max], from
  // `shared/defs/gameObjects/explosionsDefs.ts`. The blast is flat at `damage`
  // out to rad.min and then ramps to zero at rad.max — see dodgeBlastDamage,
  // which is where the ramp's slightly surprising shape is written down.
  //
  // Shrapnel is deliberately not here. Every fuse throwable also throws 8-12
  // pellets at `v2.randomUnit()` directions, which is not a thing a planner can
  // be given an opinion about: the draw happens on the server at detonation and
  // there is no version of it we could be right about. Modelling it would put
  // noise into the loss and nothing else. So this prices the core blast alone,
  // which is the part that is deterministic given a position and a time.
  const BLAST_DEFS = {
    explosion_frag:        [125, 5,    12],
    explosion_mirv:        [125, 5,    12],
    explosion_mirv_mini:   [75,  4,    8],
    explosion_martyr_nade: [80,  4.5,  9],
    explosion_bomb_iron:   [40,  5,    14],
    explosion_smoke:       [0,   5,    12],
    explosion_strobe:      [1,   1.5,  2.5],
  };

  // GameConfig.projectile gravity, from survev's own projectile.ts, where the
  // number is documented as fitted to recorded packets rather than chosen.
  const PROJ_GRAVITY = 10.5;
  // The height a throw leaves the hand at (`spawnHeight` in throwThrowable) and
  // the offset from the thrower's centre it leaves at: `rotate({0.5,-1.0}, aim)`,
  // whose length is what matters to us and not its direction.
  const PROJ_SPAWN_Z = 0.5;
  const PROJ_SPAWN_OFFSET = Math.hypot(0.5, 1.0);
  // Ground drag, applied as `vel /= 1 + dt*drag` and only while the projectile
  // is resting on the floor (or on whatever obstacle is below it) — never in
  // the air, which is what makes the airborne leg a straight line at constant
  // speed. Water is the same law with a harder constant.
  const PROJ_DRAG = 2.3;
  const PROJ_DRAG_WATER = 5;
  // survev's Anim enum, and the two values that bracket a throw.
  const ANIM_COOK = 2;
  const ANIM_THROW = 3;

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
    cachedTouchKey = null;
    touchState.target = null;
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

  // ---------------------------------------------------------------------
  // Touch input
  // ---------------------------------------------------------------------
  //
  // A touch device does not build its input message the way a desktop does,
  // and almost nothing in the aim, frag or dodge paths below would reach the
  // wire unchanged. The relevant half of the bundle's input build is:
  //
  //     if (device.touch) {
  //       const move = touch.getTouchMovement(camera);
  //       const aim  = touch.getAimMovement(player, camera);
  //       if (touch.moveDetected) {
  //         msg.touchMoveDir = normalizeSafe(move.toMoveDir);
  //         msg.touchMoveLen = round(clamp(move.toMoveLen, 0, 1) * 255);
  //       } else msg.touchMoveLen = 0;
  //       msg.toMouseDir = aim.aimMovement.toAimDir;
  //       msg.toMouseLen = clamp(aim.aimMovement.toAimLen / touch.padPosRange, 0, 1)
  //                        * GameConfig.player.throwableMaxMouseDist;
  //     } else { /* moveLeft..moveDown off the binds, aim off the mouse */ }
  //     msg.shootStart = binds.isBindPressed(Fire) || touch.shotDetected;
  //     msg.shootHold  = binds.isBindDown(Fire)    || touch.shotDetected;
  //
  // Three consequences, and they are the whole reason this section exists:
  //
  //   * Aim is not the mouse. The synthetic `mousemove` the aim helper
  //     dispatches every frame is read by nothing here — `toMouseDir` comes
  //     off the right pad, so the aim has to be written where that pad's
  //     reading is instead.
  //   * Movement is not the keys. `moveLeft`..`moveDown` are not on the
  //     message at all, so the dodge bot's four held binds go nowhere.
  //     Movement is one analog vector off the left pad.
  //   * The trigger *is* still the bind layer, `|| shotDetected`. Autoshoot
  //     therefore needs no mobile path of its own — it already presses through
  //     the same isBindPressed/isBindDown pair this branch reads.
  //
  // So this wraps the two pad readers and rewrites what they return. Both are
  // public methods on survev's TouchInput and survive the mangler with their
  // names intact — the same thing the roster fingerprint relies on — which is
  // also what lets the instance be found by shape rather than by a pinned
  // mangled name.

  const touchState = {
    target: null,          // the TouchInput instance we've wrapped
    lastSeenAt: 0,         // performance.now() of the last getAimMovement call

    // The user's own right pad, recorded every frame *before* we overwrite
    // anything. Target selection reads the direction, and the activation reads
    // the trigger — the same division the desktop path draws between the real
    // mouse (who) and the solved aim (where).
    aimDx: 1, aimDy: 0, aimLen: 0, aimTouched: false, shot: false,
    // ...and the values to hand back on release, so letting go returns the aim
    // to where the user's thumb actually is rather than freezing it on the
    // last thing we sent.
    restDx: 1, restDy: 0, restLen: 0,

    // The user's own left pad, likewise read before the dodge bot replaces it.
    moveTouched: false, userMoveDx: 0, userMoveDy: 0,

    // What we want the pads to report this frame.
    driveAim: false, owner: null, driveDx: 1, driveDy: 0,
    // A throw's cursor distance in world units, or < 0 to leave the pull alone.
    // Guns care about the bearing only; a grenade's whole throttle is here.
    driveLen: -1,
    driveMove: false, moveDx: 0, moveDy: 0,
  };

  // survev's TouchInput. Matched on its public method names rather than on a
  // mangled field, and on `aimMovement` to rule out anything that merely
  // forwards to it.
  function looksLikeTouchInput(obj) {
    try {
      return !!obj && typeof obj === 'object'
        && typeof obj.getAimMovement === 'function'
        && typeof obj.getTouchMovement === 'function'
        && typeof obj.setAimDir === 'function'
        && !!obj.aimMovement;
    } catch {
      return false;
    }
  }

  let cachedTouchKey = null;

  function findTouchOnGame(game) {
    if (!game || typeof game !== 'object') return null;
    try {
      if (cachedTouchKey) {
        const t = game[cachedTouchKey];
        if (looksLikeTouchInput(t)) return t;
        cachedTouchKey = null;
      }
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        const v = game[names[i]];
        if (looksLikeTouchInput(v)) {
          cachedTouchKey = names[i];
          return v;
        }
      }
    } catch {}
    return null;
  }

  // Wrap the two pad readers, once per instance. The marker is on the object
  // rather than in a variable because a new round hands us a new Game while
  // reusing the same TouchInput, and wrapping a wrapper would make the second
  // copy record our own driven values as if they were the user's.
  function ensureTouchHook(game) {
    const t = findTouchOnGame(game);
    if (!t) return null;
    if (t === touchState.target) return t;
    if (t.__elgTouchHooked) { touchState.target = t; return t; }

    const origAim = t.getAimMovement;
    const origMove = t.getTouchMovement;
    t.getAimMovement = function(player, camera) {
      const res = origAim.call(this, player, camera);
      // Proof of touch mode, and the only proof that can't be wrong: this
      // method is called from inside the `device.touch` branch and nowhere
      // else, so it firing *is* the branch being taken.
      touchState.lastSeenAt = performance.now();
      try { return touchAimOverride(this, res); } catch { return res; }
    };
    t.getTouchMovement = function(camera) {
      const res = origMove.call(this, camera);
      try { return touchMoveOverride(this, res); } catch { return res; }
    };
    try {
      Object.defineProperty(t, '__elgTouchHooked', { value: true });
    } catch {}
    touchState.target = t;
    return t;
  }

  // True while the game is actually building its input from the pads. Read off
  // our own hook firing rather than off a user-agent string, and allowed to go
  // stale so a desktop that never enters the branch never looks like a phone.
  const TOUCH_STALE_MS = 500;
  function touchActive() {
    return touchState.lastSeenAt > 0 &&
      (performance.now() - touchState.lastSeenAt) < TOUCH_STALE_MS;
  }

  // The pad's full-deflection radius in pixels, which is the denominator the
  // throw throttle is expressed against. It is zero until the first layout, and
  // a zero there would divide the throttle into an unconditional full-strength
  // throw, so fall back to the class's own base value.
  function touchPadRange(touch) {
    const r = Number(touch?.padPosRange);
    return r > 0 ? r : 48;
  }

  const touchAimOut = { aimMovement: null, touched: true };
  const touchMoveOut = { toMoveDir: { x: 1, y: 0 }, toMoveLen: 0 };

  function touchAimOverride(touch, res) {
    const am = res?.aimMovement || touch?.aimMovement;
    if (!am) return res;

    // The user, first. `shotDetected` was computed by the original off the real
    // pull a moment ago and we never write it, so it stays their own trigger no
    // matter what happens to the vector below.
    const dx = Number(am.toAimDir?.x);
    const dy = Number(am.toAimDir?.y);
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx || dy)) {
      touchState.aimDx = dx;
      touchState.aimDy = dy;
    }
    touchState.aimLen = Number(am.toAimLen) || 0;
    touchState.aimTouched = !!res?.touched;
    touchState.shot = !!touch?.shotDetected;

    if (!touchState.driveAim) {
      touchState.restDx = touchState.aimDx;
      touchState.restDy = touchState.aimDy;
      touchState.restLen = touchState.aimLen;
      return res;
    }

    touchWriteAimDir(am, touchState.driveDx, touchState.driveDy);
    if (touchState.driveLen >= 0) {
      // Invert the throttle: the message carries
      // `clamp(toAimLen / padPosRange, 0, 1) * throwableMaxMouseDist`, so a
      // cursor distance of `driveLen` world units is that fraction of the pad.
      const f = Math.min(Math.max(touchState.driveLen / PROJ_MAX_MOUSE_DIST, 0), 1);
      am.toAimLen = touchPadRange(touch) * f;
    }
    // `touched: false` would let the caller hand the aim to the *movement*
    // stick's bearing two lines later, so a driven frame always claims the pad.
    touchAimOut.aimMovement = am;
    return touchAimOut;
  }

  // Write a bearing into a pad reading in place. The game builds a fresh
  // `aimMovement` every frame the pad is touched and only ever `copy`s the
  // vector out of it, so mutating is safe and is one less object per frame on
  // a device that has the least room for them.
  function touchWriteAimDir(am, x, y) {
    const dir = am.toAimDir;
    if (dir && typeof dir === 'object') { dir.x = x; dir.y = y; }
    else am.toAimDir = { x, y };
  }

  function touchMoveOverride(touch, res) {
    // The user's own heading, snapped later by whoever needs it. Recorded
    // before the override for the same reason realBindDown exists: the dodge
    // bot's trigger reads it, and it must not see the bot's own course.
    touchState.moveTouched = !!touch?.moveDetected;
    const mdx = Number(res?.toMoveDir?.x);
    const mdy = Number(res?.toMoveDir?.y);
    if (Number.isFinite(mdx) && Number.isFinite(mdy)) {
      touchState.userMoveDx = mdx;
      touchState.userMoveDy = mdy;
    }

    if (!touchState.driveMove) return res;

    if (!touchState.moveDx && !touchState.moveDy) {
      // Standing still is not a direction. The message gates its whole movement
      // half on `moveDetected`, so putting that down is the only way to ask for
      // nothing — a zero vector would be normalized back to due east and walk
      // us out of cover at full speed.
      if (touch) touch.moveDetected = false;
      touchMoveOut.toMoveLen = 0;
      return touchMoveOut;
    }
    // The pad reports "no touch" by leaving `moveDetected` down, and that field
    // — not the vector we return — is what the message is gated on, so driving
    // means claiming both.
    if (touch) touch.moveDetected = true;
    touchMoveOut.toMoveDir.x = touchState.moveDx;
    touchMoveOut.toMoveDir.y = touchState.moveDy;
    touchMoveOut.toMoveLen = 1;
    return touchMoveOut;
  }

  // Two things drive the aim pad — the gun aim helper and the frag solver — and
  // they must not take it back out from under each other, so a release only
  // lands if it comes from whoever last claimed it.
  function touchDriveAim(owner, dx, dy, len) {
    touchState.driveAim = true;
    touchState.owner = owner;
    touchState.driveDx = dx;
    touchState.driveDy = dy;
    touchState.driveLen = Number.isFinite(len) ? len : -1;
  }

  function touchReleaseAim(owner) {
    if (!touchState.driveAim || touchState.owner !== owner) return;
    touchState.driveAim = false;
    touchState.owner = null;
    touchState.driveLen = -1;
    // Put the pad back where the user's thumb left it. Same reason the desktop
    // path replays the real cursor once on release: without it the game keeps
    // aiming at whatever we last solved for.
    const am = touchState.target?.aimMovement;
    if (!am) return;
    touchWriteAimDir(am, touchState.restDx, touchState.restDy);
    am.toAimLen = touchState.restLen;
  }

  function touchDriveMove(dx, dy) {
    touchState.driveMove = true;
    touchState.moveDx = dx;
    touchState.moveDy = dy;
  }

  function touchReleaseMove() {
    touchState.driveMove = false;
    touchState.moveDx = 0;
    touchState.moveDy = 0;
  }

  // The user's own trigger on a touch device. There are no keybinds to hold, so
  // the activation *is* the shot: pulling the right pad past survev's own
  // `shotDetected` threshold turns the aim helper and autoshoot on together.
  // The bind is still consulted because a paired controller or keyboard goes
  // through it, and it is read past our synthetic layer so autoshoot's own
  // presses can't latch the aim on forever.
  function touchFireHeld() {
    return touchState.shot || realBindDown(capturedGame?.[GAME_BINDS], AUTO_SWAP_INPUT_FIRE);
  }

  function touchFrameTick() {
    try { ensureTouchHook(capturedGame); } catch {}
    requestAnimationFrame(touchFrameTick);
  }
  requestAnimationFrame(touchFrameTick);

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
    enabled: 1,
    bind: 16, // Shift. keyCode doesn't distinguish left from right, so both work.
  };

  // What the overlay fades an enemy to when it can't be shot because it is on
  // a layer we can't reach — a bunker while we're aboveground.
  const UNREACHABLE_ALPHA = 0.5;

  // Enemy overlay master switch. Same hoisting reason, same default, as AIMBOT.
  const ESP = {
    enabled: 1,
    // Dim an enemy whose shot line is blocked by map geometry — see the
    // line-of-sight block in the overlay. On by default, but it only shows
    // once the overlay itself is on.
    losDim: 1,
    // Alpha the ring and its connecting line drop to when blocked. It used to
    // default to UNREACHABLE_ALPHA, the wrong-layer fade, on the argument that
    // both mean "no shot on this one" and should read as one state rather than
    // as a hierarchy of two problems. Tuned apart from it since: a blocked
    // enemy is worth a little less ink than an unreachable one, because there
    // are far more of them at any moment.
    blockedAlpha: 0.4,
    // See-through render: building roofs stop being drawn, so a house shows
    // its inside, and everything else that can be seen or shot through —
    // bushes, destroyed-obstacle rubble, tree canopies, smoke — is faded to
    // ESP_ALPHA. Off by default and independent of `enabled` above — it draws
    // nothing on the overlay canvas, it only changes how the game draws some
    // of its own art. See the ESP render block below.
    esp: 1,
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
    enabled: 1,
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

  // GameConfig.player.radius, unscaled. A player's centre is always at least
  // this far from any collidable surface — that's what the collision resolution
  // guarantees — so a blocker reported closer than this to our shot origin is
  // one we are *inside*, which no real position can be. That only happens when
  // the origin has been extrapolated into geometry (sprinting at a wall pushes
  // it up to ~2.4 units forward over a 200ms reaction + ping), and without the
  // guard it would read as "blocked" against every enemy on screen.
  //
  // This is NOT the radius the game collides bullets against. That one is
  // `netData.scale * GameConfig.player.radius`, cached on the Player as the
  // field the collider is built from:
  //     this.<rad> = this.<netData>.<scale> * <cfg>.player.radius
  //     ... createCircle(player.<pos>, player.<rad>)
  // and `scale` is a real per-player field off the wire, deserialised in the
  // same run as outfit/backpack/helmet/role/perks. Anywhere the *hitbox* is
  // what matters, use dodgeSelfRadius() rather than this. The uses below that
  // still read the bare constant are asking "how far is a body from a wall",
  // which the guarantee above is about, and are unaffected by scale.
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
    reactionMs: 110,
    // Fraction of the remaining world-space distance between the aim point
    // and the target point that we close per reference frame (AIM_REF_DT).
    // dt-corrected each frame so the closing rate is frame-rate independent.
    // 1.0 ⇒ instant snap; smaller ⇒ a slower glide onto the target.
    followFraction: 0.22,
    // How long a just-killed enemy stays in play after dying, in ms. Inside
    // that window it counts as a live player in every respect — it competes
    // for "nearest the cursor" on equal terms and gets shot at like anything
    // else — and once the timer is up it drops out entirely.
    deadLingerMs: 500,
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

  // Where the user is pointing, in whichever currency the device deals in.
  //
  // With a mouse that is a *point* in the world. Survev keeps the local player
  // viewport-centered, so the cursor's offset from screen center — divided by
  // the world-to-screen pixel scale — is its world offset from the player, and
  // adding that to the player's position gives a point every enemy can be
  // scored against.
  //
  // On a pad there is no such point. The right stick gives a bearing and a
  // pull, and the pull is the throw throttle rather than a range, so the same
  // question can only be scored as an angle. Projecting the bearing out to some
  // invented radius instead would pick whichever enemy happened to be standing
  // at that radius.
  const userAimOut = { angular: false, x: 0, y: 0, dx: 1, dy: 0, theta: 0 };
  function userAim(player) {
    const o = userAimOut;
    if (touchActive()) {
      o.angular = true;
      const len = Math.hypot(touchState.aimDx, touchState.aimDy);
      o.dx = len > 1e-6 ? touchState.aimDx / len : 1;
      o.dy = len > 1e-6 ? touchState.aimDy / len : 0;
      o.theta = Math.atan2(o.dy, o.dx);
      o.x = player.x + o.dx;
      o.y = player.y + o.dy;
      return o;
    }
    o.angular = false;
    const scale = getLivePxPerWorldUnit(pageSamples[pageSamples.length - 1]);
    if (realMouse.hasMoved && scale > 0) {
      o.x = player.x + (realMouse.x - window.innerWidth / 2) / scale;
      o.y = player.y - (realMouse.y - window.innerHeight / 2) / scale;
    } else {
      // Before the mouse has ever moved there is nothing to point with, and our
      // own feet are what every path here has always fallen back to.
      o.x = player.x;
      o.y = player.y;
    }
    const dx = o.x - player.x;
    const dy = o.y - player.y;
    const len = Math.hypot(dx, dy);
    o.dx = len > 1e-6 ? dx / len : 1;
    o.dy = len > 1e-6 ? dy / len : 0;
    o.theta = Math.atan2(o.dy, o.dx);
    return o;
  }

  // How badly a world point misses where the user is pointing: squared world
  // distance from the cursor, or radians off the pad's bearing. The two are
  // never compared with each other, only ever used to rank points against each
  // other on the one device in front of us.
  function userAimScore(aim, player, p) {
    if (!aim.angular) {
      const dx = p.x - aim.x;
      const dy = p.y - aim.y;
      return dx * dx + dy * dy;
    }
    const dx = p.x - player.x;
    const dy = p.y - player.y;
    const d = Math.hypot(dx, dy);
    if (!(d > 1e-6)) return 0;
    // Distance is in here only to break ties between two enemies on the same
    // bearing, at a millionth of a radian per unit — far too small to outweigh
    // one.
    return Math.abs(angleDelta(aim.theta, Math.atan2(dy, dx))) + d * 1e-6;
  }

  // Pick the enemy the user is pointing at: the best-scoring live, reachable,
  // non-whitelisted one, by whichever of the two scores this device uses.
  function pickTarget(player, enemies, now) {
    const candidates = [];
    for (const e of enemies) {
      if (!isEngageable(e, now)) continue;
      if (isSpoofedEnemy(e.id, pageSamples)) continue;
      if (!canInteract(player.layer, e.layer)) continue;
      candidates.push(e);
    }
    if (!candidates.length) return [null, 0];

    const aim = userAim(player);

    // Score against where each enemy is on the clock, not where the last
    // sample caught them: the user aims at the sprite, and the sprite is drawn
    // from the clock.
    const scoreOf = (e) => userAimScore(aim, player, livePos(e.id, e));

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
    const pingMs = AIM_HUMAN.pingLeadK ? (smoothedPingMs() ?? 0) * AIM_HUMAN.pingLeadK : 0;
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
      // First frame of an engagement: start the glide from where the user is
      // already pointing, not from a stale/zero point.
      if (aimState.aimX == null) {
        const a = userAim(player);
        if (a.angular) {
          // A bearing and not a point: start the glide at the target's own
          // range along it, so the crosshair sweeps sideways onto them rather
          // than out from under our own feet.
          const d = Math.hypot(tgt.x - player.x, tgt.y - player.y);
          aimState.aimX = player.x + a.dx * d;
          aimState.aimY = player.y + a.dy * d;
        } else {
          aimState.aimX = a.x;
          aimState.aimY = a.y;
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

    if (touchActive()) {
      // No cursor to move: the aim goes onto the pad reading the input message
      // is actually built from. Frag aim owns that pad while a grenade is
      // cooking — it is solving for a throw, and the pull that encodes the
      // throw's strength is the same number a gun bearing would overwrite.
      if (fragActive()) return;
      if (engage) touchDriveAim('aim', Math.cos(aimState.theta), Math.sin(aimState.theta));
      else touchReleaseAim('aim');
      return;
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
    if (!aimEngaged() || !AIMBOT.enabled) { releaseAim(); return; }
    dispatchAim();
    aimRafId = requestAnimationFrame(aimFrame);
  }

  // Drop the hold and every bit of state it accumulated. Also called when the
  // bind changes out from under a held key, where no keyup for the old bind is
  // ever going to arrive.
  function releaseAim() {
    aimHeld = false;
    touchReleaseAim('aim');
    if (aimRafId) { cancelAnimationFrame(aimRafId); aimRafId = 0; }
    aimState.targetId = null;
    aimState.aimX = null;
    aimState.aimY = null;
    aimState.lastFrameAt = 0;
  }

  // Whether the aim helper is on this frame. On a desktop that is the bind
  // being held. A touch device has no bind to hold, so the trigger itself is
  // the activation: pulling the right pad far enough to shoot turns the aim
  // helper and autoshoot on together, which is the only spare gesture a phone
  // has. See touchFireHeld.
  function aimEngaged() {
    return touchActive() ? touchFireHeld() : aimHeld;
  }

  // The desktop loop is started by the keydown that begins the hold; a pad has
  // no such edge to hang it off, so poll for one. Restarting is always a fresh
  // engagement because releaseAim has already dropped the glide seed.
  function aimTouchTick() {
    try {
      if (AIMBOT.enabled && !aimRafId && touchActive() && touchFireHeld()) {
        aimRafId = requestAnimationFrame(aimFrame);
      }
    } catch {}
    requestAnimationFrame(aimTouchTick);
  }
  requestAnimationFrame(aimTouchTick);

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
    if ((!aimEngaged() && !fragActive()) || !e.isTrusted) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  // Live-tunable auto-quickswap settings. Declared here (rather than beside
  // the auto-quickswap code below) because SETTINGS_SPECS binds a slider to it
  // and would hit the temporal dead zone otherwise.
  const AUTO_SWAP = {
    enabled: 1,        // master switch; 0 = never synthesize a swap
    // Minimum fireDelay, in seconds, for a gun to be treated as
    // slow-firing. The default sits just under the 0.5s USAS-12 so the
    // set is snipers, pump/semi shotguns, the S&W 500 and the potato
    // cannon — weapons whose post-shot dead time comfortably exceeds a
    // sidearm's switchDelay. Lower it toward 0.3 to also catch the M1014,
    // Saiga-12, SPAS-16 and M1100; raise it to restrict to bolt-actions.
    slowFireThreshold: 0.4,
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
    clockHalfLife: 170,
    // Playout delay, in ticks: the render is taken at `t_now - renderLag *
    // tick` instead of at t_now. Half a tick is the natural setting — the
    // newest snapshot's pseudotime is on average half a tick old by the time
    // any given frame renders, so this is the offset that centres the render
    // on the data instead of leaning permanently past its end. 0 restores
    // rendering at t_now (pure extrapolation, lowest latency, worst overshoot
    // on turns and stops); netcode_sim.js measures the trade either way. Aim
    // is unaffected — it solves on true clock time, not render time. It is
    // also how far back bullets are drawn from their simulated positions, so
    // tracers and bodies keep depicting the same instant at any setting.
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

  // Debug render: throw the art away and draw the collision geometry instead.
  // Hoisted with the rest for the same temporal-dead-zone reason. Off by
  // default — it is a display switch and touches no gameplay state, but it
  // makes the game unplayable-looking, so it is never on by accident.
  const DEBUG_RENDER = {
    enabled: 0,
  };

  // Dodge bot: while a bullet is on course to hit us, take the movement keys
  // and steer out of the way; hand them straight back when none is. Hoisted
  // with the rest for the temporal-dead-zone reason, and off by default —
  // it is the only thing here that drives movement, so it never engages by
  // accident. The solver, and what each of these knobs actually buys, are in
  // the dodge-bot section below.
  const DODGE = {
    enabled: 1,
    // Draw the plan the search actually returned — the polyline the winning
    // state was reached by, from where the ping lead leaves us out to the end
    // of the horizon — on the ESP overlay canvas, with the legs already spent
    // faded. Display only, and now purely so: the course itself is walked back
    // out of the search whether this is on or not, because the bot holds it and
    // presses it (see dodgeStep); this gates the drawing alone. Off by default,
    // and worth having off: a line redrawn every 16ms over the middle of a
    // firefight is a lot of ink.
    path: 1,
    // Draw, for every grenade in the air, the blast it is going to make: two
    // red rings at the detonation point — the full-damage plateau and the outer
    // edge of any damage at all — and the seconds left on its fuse over the
    // grenade itself.
    //
    // Display only, and independent of whether the bot is on. It is drawn from
    // the same per-packet flight records the planner is scored against, so what
    // is on screen is what the loss is using and not a second opinion about it.
    // Off by default: a 12u circle is a lot of ink for something that is only
    // interesting for a few seconds a match.
    rings: 1,
    // How far ahead a plan is scored. Long enough to see the second bullet
    // of a burst, short enough that the enemy's own aim hasn't gone stale.
    horizon: 1.2,
    // How much daylight halves what a near miss is billed — the scale of the
    // hit test's falloff, in world units off the hitbox. See dodgeDpClearance.
    //
    // This is the whole of the bot's caution, and the errors the geometry
    // cannot see are what it is for: the ping lead is an estimate, the server's
    // idea of where we are is a round trip old, position is snapped to `Grid`
    // at every layer, and none of that shows up anywhere else in the loss. It
    // used to be a hard pad added to our radius, which asserted a distance at
    // which a miss becomes certain; nothing about the doubt it stands for is
    // that sharp, so it grades instead. Raise it and the bot gives rounds a
    // wider berth; drop it and it shaves them.
    clearance: 0.3,
    // Multiplier on the measured round trip when advancing threats to where
    // the server will have them. 1.0 is the derivation in the section header;
    // drop it toward 0 to dodge what is drawn instead of what is real.
    leadK: 1,
    // How long it takes for a hit to be worth half as much, in seconds of
    // plan time. This is the whole of the bot's patience: a plan that eats a
    // round at 0.4s is priced the same as one that eats half a round now, so
    // delay bought near t=0 — where it is worth real information — counts for
    // more than delay bought at the far end of a horizon the plan cannot see
    // past anyway. See DODGE_HIT_COST for what it costs in damage ordering.
    //
    // Long is patient-but-blind: at 5 the discount across the default horizon
    // is 10% and the loss is damage and almost nothing else, which is what this
    // did before the discount existed. Short is twitchy: damage ordering only
    // survives for rounds more than 2^(horizon/halfLife) apart, which is 4x at
    // the default, 16x at 0.2 and 256x at the floor. Below 0.2 that crossover
    // passes mp5-against-awc and the bot will start taking the awc round later
    // over the mp5 round now, which is the point at which it is simply wrong.
    halfLife: 0.85,
    // Cost per second for running exactly opposite the keys the user is
    // holding, scaled by how opposed the heading is. It cannot buy a hit and is
    // not meant to. Comparing the two per leg, which is the only comparison the
    // search ever makes: the weakest hit in the game — a birdshot pellet at full
    // falloff, 1 HP — outweighs a leg run dead against the keys by ~2.4e5 at the
    // defaults, and by ~4600 at the worst corner of the sliders, this knob at 5
    // with the longest horizon, the coarsest step and the shortest half-life.
    //
    // That ratio is the same on every leg of the plan, exactly, because both
    // terms are discounted by the same exp — see DODGE_HIT_COST. It is worth
    // being deliberate about: discount the hit term alone and this margin decays
    // with depth, so the far end of a long horizon becomes a place where the
    // alignment term is comparatively cheap to satisfy and the loss stops
    // meaning one thing all the way out.
    //
    // It picks between escapes that are already equally safe, of which a
    // hit-only loss usually leaves many — and, since there is no takeover
    // threshold any more, it is also the entire mechanism by which the user
    // steers while the bot is on. With nothing on course the hit term is zero
    // everywhere and this term decides alone, with its minimum at exactly the
    // heading being held, so the plan is the user's own keys.
    //
    // 0 therefore no longer means "off". It means the bot has no opinion about
    // where the user wants to go and will drift to whichever heading the sweep
    // reached the cell by first, which is not a thing anyone wants while they
    // are trying to walk somewhere. To stop the bot driving, turn the bot off.
    //
    // The budget is spent against the same clock as the hit term — see
    // dodgeAlignFill — but the total of it over the horizon does not depend on
    // `halfLife`, so this number means what it always meant.
    follow: 1,
    // How much of a hit an enemy's *aim* is worth: the chance that the round
    // they are lined up to fire actually gets fired. Each hostile pointing a
    // gun near us contributes one more threat — a round leaving their gun at
    // the last frame we have — scaled by this. See dodgeAddPhantoms.
    //
    // It exists because everything else here is reactive. A round becomes a
    // cost only once it is in the air, which at any range where flight time is
    // under the round trip is already too late; the line you are standing on is
    // knowable a long time before the shot that punishes it. This is the only
    // term that costs anything for walking down someone's barrel.
    //
    // In the same currency as every other term — the loss is expected HP, and
    // this is the probability half of the expectation — so it is directly
    // comparable to a live round of the same gun. At 0.35 a Barrett lined up on
    // our path outweighs an mp5 round genuinely in the air. At 1 aim is treated
    // as fire and the bot will not stand in a line it could leave. At 0 none of
    // it runs, and the bot is exactly what it was before: rounds only.
    phantom: 0.35,
    // What a grenade's blast is worth, as a multiplier on the damage it would
    // actually do. Unlike `phantom` this is not a probability of anything — a
    // fuse that runs out is not a guess — so 1 is the honest setting and the
    // default. It is a knob at all because a blast is the one threat here whose
    // *timing* is partly inferred, and because a 12u radius is wide enough that
    // a bot answering one moves a long way: turn it down to make the planner
    // weigh a nade against the rounds in the air more cheaply, or to 0 to go
    // back to rounds and firing lines only.
    //
    // Only the core blast is priced. Shrapnel is 12 pellets in directions drawn
    // on the server at detonation, which is not something a plan can be right
    // about — see BLAST_DEFS.
    blast: 1,
    // Seconds one decision covers. horizon/stepS is how many decisions the
    // plan gets, and the search is a shortest path over (cell, time) — see
    // dodgeDpPlan.
    stepS: 0.08,
    // What position is snapped to so that paths can merge. Finer is more
    // faithful and squarely more expensive; 0.2 measured a fifth of a point
    // better than 0.35 for nearly twice the time.
    cell: 0.05,
  };

  // Aim the throw at the instant it is released. Declared up here rather than
  // beside the code that uses it, for the same reason AUTO_SWAP is:
  // SETTINGS_SPECS binds a row to it below and would hit the temporal dead zone
  // otherwise.
  const FRAGBOT = {
    // Off by default. This is the one thing in the mod that changes where a
    // throw *goes* rather than what is known about it — everything else here
    // reads the world or drives our own feet, and a grenade that lands
    // somewhere the user did not point is a different kind of thing.
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
    { id: 'esp.esp', store: ESP, key: 'esp', label: 'ESP', kind: 'toggle' },
    { id: 'names.enemy',  store: NAME_TAGS, key: 'enabled', label: 'Enemy names', kind: 'toggle',
      section: 'Name tags' },
    { id: 'bank.enabled', store: BANK,  key: 'enabled', label: 'Bank shots', kind: 'toggle',
      section: 'Bank shots' },
    { id: 'bank.prefer',  store: BANK,  key: 'prefer',  label: 'Prefer banks', kind: 'toggle' },
    { id: 'autoshoot.enabled', store: AUTOSHOOT, key: 'enabled', label: 'Autoshoot', kind: 'toggle',
      section: 'Autoshoot' },
    { id: 'dodge.enabled',  store: DODGE, key: 'enabled',   label: 'Dodge bot', kind: 'toggle',
      section: 'Dodge bot' },
    { id: 'dodge.path',     store: DODGE, key: 'path',      label: 'Show plan', kind: 'toggle' },
    { id: 'dodge.rings',    store: DODGE, key: 'rings',     label: 'Grenade rings', kind: 'toggle' },
    { id: 'frag.enabled',   store: FRAGBOT, key: 'enabled',  label: 'Frag aim', kind: 'toggle' },
    { id: 'dodge.horizon',  store: DODGE, key: 'horizon',   label: 'Horizon',      unit: 's',  min: 0.2,  max: 2,    step: 0.05, decimals: 2 },
    { id: 'dodge.clearance', store: DODGE, key: 'clearance', label: 'Clearance',               min: 0.05, max: 1.5,  step: 0.05, decimals: 2 },
    { id: 'dodge.halfLife', store: DODGE, key: 'halfLife',  label: 'Hit half-life', unit: 's', min: 0.1,  max: 5,    step: 0.05, decimals: 2 },
    { id: 'dodge.leadK',    store: DODGE, key: 'leadK',     label: 'Ping lead',                min: 0,    max: 2,    step: 0.05, decimals: 2 },
    { id: 'dodge.follow',   store: DODGE, key: 'follow',    label: 'Follow input',             min: 0,    max: 5,    step: 0.1,  decimals: 1 },
    { id: 'dodge.phantom',  store: DODGE, key: 'phantom',   label: 'Firing lines',             min: 0,    max: 1,    step: 0.05, decimals: 2 },
    { id: 'dodge.blast',    store: DODGE, key: 'blast',     label: 'Grenades',                 min: 0,    max: 1,    step: 0.05, decimals: 2 },
    { id: 'dodge.stepS',    store: DODGE, key: 'stepS',     label: 'Step',         unit: 's',  min: 0.03, max: 0.3,  step: 0.01, decimals: 2 },
    { id: 'dodge.cell',     store: DODGE, key: 'cell',      label: 'Grid',         unit: 'u',  min: 0.05, max: 0.5,  step: 0.05, decimals: 2 },
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
    { id: 'debug.render',       store: DEBUG_RENDER, key: 'enabled',     label: 'Debug', kind: 'toggle',
      section: 'Debug' },
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
        // A phone has no key to hold: the trigger is the activation there, so
        // the row would be a dead control. See aimEngaged.
        if (IS_MOBILE_DEVICE || touchActive()) continue;
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
  //   suppressedInputs — the inverse of heldInputs: isBindDown and
  //                      isBindPressed both report false for anything in it,
  //                      whatever the user's keyboard is doing. Needed the
  //                      moment something wants to *drive* an axis rather
  //                      than add to it — the dodge bot's S is worthless if
  //                      the user's W is still going out on the same packet.
  //                      heldInputs wins over it, so the two are kept
  //                      disjoint by whoever sets them.
  const suppressedInputs = new Set();
  // Arrow keys, which the movement path reads raw:
  //     moveLeft = isBindDown(MoveLeft) || keyDown(Left) && !isKeyBound(Left)
  // Nothing in the bind layer can suppress that `keyDown`, but reporting the
  // key as *bound* falsifies the second half of the `&&`, which is what this
  // flag makes isKeyBound do. Set by the dodge bot for as long as it is
  // driving; nothing else uses it.
  const ARROW_KEYCODES = new Set([37, 38, 39, 40]);
  let suppressArrowMovement = false;

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
      if (suppressedInputs.has(input)) return false;
      return origPressed.call(this, input);
    };
    binds.isBindDown = function(input) {
      if (heldInputs.has(input)) return true;
      if (suppressedInputs.has(input)) return false;
      return origDown.call(this, input);
    };
    // Only wrapped when it exists, so a re-mangle that renames it degrades to
    // "the arrow keys still work while the dodge bot drives" rather than to a
    // thrown exception on every input frame.
    if (typeof binds.isKeyBound === 'function') {
      const origKeyBound = binds.isKeyBound;
      binds.isKeyBound = function(key) {
        if (suppressArrowMovement && ARROW_KEYCODES.has(key)) return true;
        return origKeyBound.call(this, key);
      };
    }
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

  // Force an input to read as up regardless of the user's keyboard. No
  // ensureBindHook here on purpose: suppression is only ever meaningful once
  // something is already holding an input through the hook, and taking a key
  // away is not a reason to install one.
  function setInputSuppressed(input, on) {
    if (on) suppressedInputs.add(input);
    else suppressedInputs.delete(input);
  }

  // Edge-trigger on the user's Fire bind, whatever key/button that is.
  // `game[inputBinds].isBindDown(4)` is the same source of truth the
  // input loop reads, so this is keybind-agnostic.
  let autoSwapFireWasDown = false;

  // Auto-quickswap tracing. Off by default — every line below is one per shot
  // — so turn it on at runtime with `window.__SURVEV_LOG_AUTOSWAP__ = true`
  // when you need to see why a gun did or did not get swapped.
  window.__SURVEV_LOG_AUTOSWAP__ = false;
  const autoSwapLog = (msg) => {
    if (window.__SURVEV_LOG_AUTOSWAP__) console.log(`[autoswap] ${msg}`);
  };

  function autoSwapOnFirePressed(game) {
    const me = findLocalPlayerOnGame(game);
    if (!me) { autoSwapLog('skip: no local player'); return; }
    const weapon = getCurrentWeapon(me);
    if (!weapon) { autoSwapLog('skip: no current weapon'); return; }
    if (!isSlowFireGun(weapon)) {
      const delay = GUN_FIRE_DELAY[weapon];
      const why = delay === undefined ? 'unknown fireDelay'
        : AUTO_SWAP_NEVER.has(weapon) ? 'never-swap list'
        : `fireDelay ${delay}s < ${AUTO_SWAP.slowFireThreshold}s threshold`;
      autoSwapLog(`skip: ${weapon} — ${why}`);
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
      if (log) autoSwapLog(`queued swap after ${weapon} shot`);
      setTimeout(() => autoSwapEmitInput(game, AUTO_SWAP_INPUT_EQUIP_OTHER), AUTO_SWAP_FIRE_TO_SWAP_MS);
    } else {
      // Single-gun case: tap melee then return to the gun via
      // EquipLastWeap. Same gunSwitchCooldown-reset trick — switching
      // to melee cancels the slow gun's post-fire animation, and
      // EquipLastWeap brings us back without depending on which slot
      // index the gun lives in. Stagger the two inputs by one tick
      // each so Fire/EquipMelee/EquipLastWeap each land on their own
      // server tick in order.
      if (log) autoSwapLog(`queued melee-tap after ${weapon} shot`);
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
  //            with one it taps melee and comes back. An automatic on this
  //            path holds the trigger for the shot rather than tapping it —
  //            see below.
  //   auto    — hold the trigger. `fireMode: 'auto'` is the only case survev
  //            reads `isBindDown(Fire)` for, and it keeps firing on its own.
  //   press   — everything else: a press per shot, paced at the gun's
  //            fireDelay, which is as fast as a semi-auto can go.
  //
  // Slow wins over auto where they overlap — the USAS-12 at the default
  // threshold, joined by the Saiga-12 at 0.4 and the SPAS-16 at 0.35 as it is
  // dialled down — because the swap beats the wait either way.
  //
  // Those guns take the slow path *holding* the trigger rather than tapping
  // it, which is the one thing the three cases don't otherwise share. A tap
  // sets `shootStart` without `shootHold`, and an automatic empirically will
  // not fire on that: tapped, the magazine simply never moves, so the tap
  // path left every auto gun that counted as slow silent forever rather than
  // merely slow. (Nothing client-side explains it — the input message builds
  // both flags regardless of fire mode — so the gate is server-side.) They
  // hold until the magazine confirms the shell, then release and swap, and
  // that release is also what stops a held auto gun from firing on straight
  // through its own swap.
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
    if (!AUTOSHOOT.enabled || !AIMBOT.enabled || !aimEngaged() || !obs) return null;
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

    const auto = GUN_AUTO.has(weapon) || GUN_BURST.has(weapon);
    const mode = isSlowFireGun(weapon) ? 'swap' : auto ? 'hold' : 'press';
    // Carried separately from `mode` because the swap path needs it too: a
    // slow gun that is also automatic still swaps, but it has to fire first,
    // and tapping one does not fire it.
    return { mode, weapon, ammo, game, me, auto };
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

    // An automatic on the swap path: hold the trigger until its shell is
    // confirmed, then hand it straight back so the swap can happen off an
    // unheld trigger. Dropping out of this the moment `swapQueued` goes up is
    // what keeps the hold from firing on through the swap it just queued.
    const autoHold = !!plan && plan.mode === 'swap' && plan.auto
      && !autoShootState.swapQueued;

    // Only the two hold cases leave the trigger down; the tap cases must not
    // also be holding it. Decided after the swap bookkeeping above rather
    // than before it, so a shell confirmed on this very tick releases the
    // trigger on this tick too instead of a frame later.
    const binds = capturedGame?.[GAME_BINDS];
    if (binds) setInputHeld(binds, AUTO_SWAP_INPUT_FIRE, plan?.mode === 'hold' || autoHold);
    else heldInputs.delete(AUTO_SWAP_INPUT_FIRE);

    // Nothing to press: an auto gun paces itself, and no plan means no shot.
    // Clearing the gate means the first shot of the next engagement goes out
    // on the frame it becomes available rather than waiting out a stale timer.
    if (!plan || plan.mode === 'hold' || autoHold) {
      autoShootState.nextPressAt = 0;
      // The swap triggers off the magazine falling below a reading taken
      // before the shot, and the held gun never reaches the press below that
      // would take one. Without this it fires and never swaps — the same
      // "shoots and waits" failure, arrived at from the other side.
      //
      // An unreadable magazine leaves this null, and the gun then just keeps
      // holding: no confirmation, no swap. That is the safe way to fail here,
      // since it degrades to exactly the automatic's own `hold` behaviour.
      if (autoHold && autoShootState.ammoAtPress == null) {
        autoShootState.ammoAtPress = plan.ammo;
      }
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
  // Dodge bot: hold the movement keys for exactly as long as a bullet is
  // going to hit us, and hand them straight back when one isn't.
  //
  // What is and isn't dodgeable. A player moves at 12 u/s and the guns in
  // GUN_BULLET_SPEED fire between 66 and 214 u/s, so nothing here can
  // out-run a bullet: the only reason a dodge ever works is that the shot
  // was aimed where we were *going*, and a shot led against a path we then
  // leave misses. Clearing our own radius takes ~83ms of movement from a
  // standstill but only ~42ms if we were already strafing across the shot
  // and merely reverse, because then the two paths diverge at 2x speed
  // rather than 1x. That is why the planner is allowed to keep moving. It is
  // not, however, pushed to: standing still carries no penalty of its own and
  // is chosen whenever it happens to be clear of every round in the air.
  //
  // The consequence to be honest about: at knife range there is no dodge.
  // An SMG round from 8 units away arrives in under 100ms, less than the
  // link's own round trip, and no input we send can be in time. This wins
  // ranged exchanges and does nothing at all in a close one.
  //
  // Continuous collision, not sampled. Every threat is solved as a
  // moving-circle-vs-moving-circle quadratic. A per-frame sample is not an
  // option: a Barrett round crosses a player's diameter in 9ms and would
  // step straight over a 16ms frame without ever testing as overlapping.
  //
  // Where the numbers come from. The barn's bullets carry `pos`, `dir`,
  // `speed`, `startPos` and `distance` under real readable names, are
  // advanced client-side every frame, and are deterministic straight lines
  // from spawn — so the whole future path is known, not guessed. Bullets
  // are then truncated at the first wall on their own path, because a round
  // that dies on a crate is not a threat and treating it as one is what
  // walks the bot out of cover.
  //
  // What a round is worth. Not one — its damage in HP, from BULLET_DAMAGE,
  // through survev's own falloff evaluated at the point along the path where
  // it reaches us, halved again per reflect. So both searches minimise expected
  // HP lost rather than expected hit count, and a plan that takes an mp5 round
  // to stay out of an awc's line is correctly the cheap one. The type is not on
  // the barn entry and cannot be inferred from what is — see hookBulletBarn for
  // how it is taken on the way past instead. A round we can't name is priced at
  // DODGE_DMG_REF, which is the flat hit-counting this did before.
  //
  // Clocks. What we render is the server's world one one-way trip ago, and
  // an input we send now is acted on one one-way trip from now, so the
  // bullet the server tests against us has travelled roughly a full round
  // trip further than the one we are looking at. Threats are advanced by
  // `leadK * ping` before anything is solved, the same measured round trip
  // the aim helper leads by, for the same reason.
  //
  // Who is driving. Nobody, whenever the reachability filter leaves no round
  // that could touch us inside the horizon — the overwhelmingly common case,
  // and it costs nothing, the keys are simply the user's. The moment one round
  // survives the filter the planner drives, and it keeps driving until they
  // are all gone again.
  //
  // There is no takeover threshold and no handback timer. There used to be
  // both: a plan was pressed only once the user's own course was proven hit
  // inside `trigger` seconds, and the keys went back after `releaseMs` of that
  // question answering no. Both were answers to something the loss answers
  // better. A threshold has to be crossed, and crossing it is discrete — one
  // frame the user is walking into a round, the next the bot is mid-dodge from
  // a start state it did not choose, the whole lead-up in which the dodge was
  // still cheap having been spent going the wrong way. The timer existed only
  // to stop that threshold flapping, which is a problem the threshold created.
  //
  // What replaces them is that the planner was never a dodge-or-don't decision
  // in the first place. With nothing on course the hit term is zero everywhere
  // and the loss is the alignment term alone, whose minimum is exactly the
  // heading the user is holding — so the bot presses the user's own keys and
  // the handback is continuous rather than an event. As a round closes, its hit
  // term grows against that alignment and the plan bends off the user's heading
  // in proportion to what the round is worth and how sure the geometry is about
  // it. The bot leans out of the way early and cheaply where that is enough,
  // instead of waiting for a threshold and then dodging late and hard.
  //
  // The price is that `follow` is load-bearing rather than a tiebreak: it is
  // the whole of how the user steers while the bot is on, and at 0 the bot has
  // no reason to prefer their heading over any other equally safe one. See
  // DODGE.follow.
  //
  // The user's heading is read through realBindDown, so the bot can never see
  // its own synthetic input and end up following itself.
  // ---------------------------------------------------------------------

  // The four movement binds, from the same Input enum as AUTO_SWAP_INPUT_*.
  const DODGE_INPUT_LEFT = 0;
  const DODGE_INPUT_RIGHT = 1;
  const DODGE_INPUT_UP = 2;
  const DODGE_INPUT_DOWN = 3;
  const DODGE_MOVE_INPUTS = [DODGE_INPUT_LEFT, DODGE_INPUT_RIGHT, DODGE_INPUT_UP, DODGE_INPUT_DOWN];

  // The nine things the server can be asked for: eight unit headings plus
  // standing still, at index 0. World y is up — `moveUp` increments y — so
  // +y is Up and not Down. Diagonals are unit length because the server
  // normalizes the move vector before scaling it by speed; a diagonal is not
  // faster, and treating it as if it were would make the planner believe in
  // an escape it can't execute.
  const DODGE_K = Math.SQRT1_2;
  const DODGE_DIRS = [
    { x: 0, y: 0 },
    { x: 1, y: 0 }, { x: DODGE_K, y: DODGE_K }, { x: 0, y: 1 }, { x: -DODGE_K, y: DODGE_K },
    { x: -1, y: 0 }, { x: -DODGE_K, y: -DODGE_K }, { x: 0, y: -1 }, { x: DODGE_K, y: -DODGE_K },
  ];

  const DODGE_SPEED_FALLBACK = 12;  // GameConfig.player.moveSpeed
  const DODGE_SPEED_MIN = 3;        // below this we assume we weren't moving
  const DODGE_SPEED_MAX = 24;       // above it, a teleport or a bad frame
  const DODGE_SPEED_WINDOW = 10;    // moving deltas the estimate is the max of
  // The floor on how often the planner runs at all. It is a rate limiter and
  // no longer a cadence: a plan is made when the world it was made against has
  // changed and not otherwise — see dodgeStep. Two rAF callbacks inside one
  // 16ms slice still only get one search between them.
  const DODGE_PLAN_MS = 16;
  // How far the ping lead has to move before the standing plan is thrown away
  // rather than re-indexed, as a distance rather than a time: the lead is a
  // position correction, so what matters is how far it slides the plan's own
  // start, and one grid cell is the resolution the search rounded that start to
  // in the first place. At the default cell and full speed that is ~29ms of
  // ping. See dodgePlanTime for the re-indexing the smaller shifts get.
  const DODGE_LEAD_SLACK_CELLS = 1;
  // Movement integration. Fixed in TIME rather than in distance, so the
  // resolution of a leg does not change with our speed — a wade at 9 and a
  // sprint at 12 are sampled equally finely, and the sub-step is the same
  // quantity everywhere it appears (the sweep's segments, the depenetration's
  // cadence, the fallback normal's meaning).
  const DODGE_SUBSTEP_S = 0.01;     // seconds per movement sub-step
  // `stepS` tops out at 0.3, so a leg is at most 30 sub-steps. The cap is a
  // guard against a bad `dur` reaching here, not a budget.
  const DODGE_SUBSTEP_MAX = 64;
  // Depenetration passes per sub-step. Pushing out of one obstacle can push us
  // into another — a doorway, or the seam between two crates — so it iterates.
  // Four resolves every configuration the map actually produces; past that we
  // are in a wedge with no exit and stopping is the honest answer.
  const DODGE_DEPEN_PASSES = 4;
  // Left beyond the surface after a push, so the next sub-step's overlap test
  // reads clear rather than re-firing on a point sitting exactly on the edge.
  const DODGE_DEPEN_EPS = 1e-4;
  // How many threats the per-threat scratch arrays start out sized for. Not a
  // cap: every round that survives the reachability filter is planned against,
  // and dodgeGrowThreats widens the arrays if a fight ever produces more. Sized
  // so that in practice it never has to.
  const DODGE_THREAT_ALLOC = 64;

  // The loss:
  //
  //     sum over threats of  w * f * HIT_COST * exp(-t_hit / tau)
  //         + DODGE.follow * (how opposed each leg is to the keys being held,
  //                           against the same exp)
  //
  // where `w` is the round's damage over DODGE_DMG_REF, `f` is how much of a
  // hit the pass counts as — 1 inside the hitbox, halving for every DODGE.
  // clearance of daylight beyond it, see dodgeDpClearance — and `tau` is
  // DODGE.halfLife over ln2.
  //
  // The first term is the whole of what the bot is for. The second is a tiebreak
  // worth at most `follow` per second against a hit worth ~1e6, and exists
  // because the loss is otherwise flat wherever nothing is near us. See
  // dodgeAlignFill.
  //
  // Everything is discounted against plan time, and by the same factor, because
  // that factor is not a preference — it is the odds the plan is still about the
  // world it was written for. The shooter can lose the line, the round can find
  // a wall, we may simply be somewhere else. A cost the plan predicts for 0.7s
  // out is a cost conditional on none of that having happened, and exp(-t/tau)
  // is what a constant hazard rate on "none of that" looks like.
  //
  // That the discount is the same everywhere matters more than what it is. Apply
  // it to the hit term alone and the ratio between the two terms drifts with
  // depth, which makes the loss an awkward thing to reason about for no gain.
  //
  // This used to be linear — (HIT_COST - t * 1e4) — which is this to first
  // order, with a half-life of 69 seconds. The difference between them is the
  // whole point: a linear bonus prices 0.1s of delay identically whether the
  // round lands at 0.1s or at 1.9s, and those are not worth the same. The first
  // is a round trip of new information. The second is bookkeeping about a world
  // three horizons of replanning away.
  //
  // What the old form bought with its tiny slope was a guarantee: at 2% of the
  // hit term it could only ever break ties between rounds within 2% of each
  // other in damage, so damage ordering was lexicographic. That does not survive
  // a real discount and cannot be made to — holding it would need
  // tau > horizon / ln(1.02), which is the 69 seconds we started with. What is
  // left is the weaker and honest version: damage ordering survives for any pair
  // whose weights differ by more than
  //
  //     exp(horizon / tau)  =  2^(horizon / halfLife)
  //
  // which at the defaults is a factor of 4. Taking an mp5 round now to avoid an
  // awc round later still falls straight out — 11 against 180 is 16x, clear of
  // it with room. What is genuinely new is the near-peer case: an ak round at
  // 0.8s now beats an m4 round now, 18 HP against 14, and it should — 0.8s of
  // replanning is worth more than 4 HP.
  //
  // No discount can talk the bot into a hit. A plan that touches nothing costs
  // alignment and nothing else, every discounted hit term is strictly positive,
  // and zero wins. That holds for any halfLife, which is why the knob is safe
  // at both ends.
  //
  // What this deliberately does not charge for: standing still, turning, and
  // grinding along a wall. All three used to carry a penalty and no longer do,
  // so the only thing that can move the planner off a heading is a round that
  // might land — or, where none might, the keys the user is holding.
  const DODGE_HIT_COST = 1e6;
  // What one unit of cost means, in HP. Roughly a mid-tier round, so a typical
  // threat weighs ~1. It is also the fallback weight for a round whose type we
  // can't name, so an unrecognised bullet degrades to the flat hit-counting the
  // planner did before BULLET_DAMAGE existed rather than to being ignored.
  const DODGE_DMG_REF = 25;

  const dodgeState = {
    engaged: false,
    dirIdx: 0,
    // When dodgeStep last ran its body, throttled by DODGE_PLAN_MS. Not when it
    // last planned — that is dodgePlan.at, and the two are different things now
    // that a plan outlives the frame that made it.
    lastStepAt: 0,
    // Identity of the live rounds the last threat build accepted, as a hash of
    // the barn slots they sit in. This is the one input to a plan that is not
    // packet data: rounds fly and die on the client between updates, so a round
    // going out is news the packet counter cannot carry. Slots are pooled, so a
    // slot leaving the set changes this; a slot handed straight back out to a
    // new round inside one gap would not, which is what dodgeBulletAdds is for.
    liveKey: 0,
    // The same identity, for the grenades in the air. Their own detonation is
    // an event the packet counter does not carry either: a fuse runs out on the
    // server's clock, and the projectile is simply gone from the next update —
    // which is a change of set, and a plan written against it has to be dropped
    // rather than played out against a blast that has already happened.
    blastKey: 0,
    speed: DODGE_SPEED_FALLBACK,
    selfR: PLAYER_RADIUS,
    // The last DODGE_SPEED_WINDOW packet deltas that showed movement, as a
    // ring, and the running total of them. `speed` is the max over the live
    // entries; `speedSamples` says how many there are, and so whether `speed`
    // is a measurement at all or still the seed.
    speedRing: new Float64Array(DODGE_SPEED_WINDOW),
    speedRingIdx: 0,
    speedSamples: 0,
    threats: [],
    walls: [],
    userHitIn: Infinity,
    planHitIn: Infinity,
    planCost: 0,
    leadS: 0,
    planMs: 0,
  };

  function dodgeClamp(v, lo, hi, fallback) {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  }

  // Our own hitbox, as the game will actually test it: scale * the config
  // radius. See PLAYER_RADIUS for where the scaling comes from and why the
  // constant on its own is the wrong number to collide against.
  //
  // This is the same argument dodgeTrackSpeed makes for movement — GameConfig
  // says 12 and the player wades at 9 — one field over in the same config
  // block. A planner solving a 1.0 circle while the server tests 1.2 is wrong
  // in exactly the direction that gets us shot, and silently: there is no error
  // and nothing to see, just a hit test against the wrong body.
  //
  // The bounds are a sanity rail on a value that arrives over the network, not
  // a rule of the game — anything outside them, or missing because mangled.js
  // predates the `scale` entry, falls back to the unscaled radius, which is
  // what this did before it read the field at all.
  function dodgeSelfRadius(me) {
    if (!NET_SCALE) return PLAYER_RADIUS;
    const scale = me?.[PLAYER_NET]?.[NET_SCALE];
    return PLAYER_RADIUS * dodgeClamp(scale, 0.1, 5, 1);
  }

  // Arrow-key state, tracked here because the bundle's movement path ORs the
  // binds with a raw arrow read —
  //     moveLeft = isBindDown(MoveLeft) || keyDown(Left) && !isKeyBound(Left)
  // — and the input manager behind that `keyDown` is not something we hold a
  // reference to. Without this a user who plays on the arrows would have the
  // trigger read their heading as "standing still". Taking the arrows *away*
  // is a separate job, done by the isKeyBound hook in the synthetic-input
  // block: making the key report as bound is what falsifies the `&&`.
  const dodgeArrowDown = new Map([[37, false], [38, false], [39, false], [40, false]]);
  window.addEventListener('keydown', (e) => {
    if (dodgeArrowDown.has(e.keyCode)) dodgeArrowDown.set(e.keyCode, true);
  }, true);
  window.addEventListener('keyup', (e) => {
    if (dodgeArrowDown.has(e.keyCode)) dodgeArrowDown.set(e.keyCode, false);
  }, true);
  window.addEventListener('blur', () => {
    for (const k of dodgeArrowDown.keys()) dodgeArrowDown.set(k, false);
  });

  // ---- Finding the bullets ----------------------------------------------
  //
  // The bullet barn (`bn` in the bundle) is the only object the Game owns
  // that has all of a `bullets` array, a `tracerColors` map and an
  // `addBullet` method — and all three are real readable class fields, not
  // mangled ones, so it is found by shape and needs no mangled.js entry.
  // Same cache-the-key-then-revalidate shape as findObstaclePool.
  let cachedBulletBarnKey = null;

  function looksLikeBulletBarn(v) {
    return !!v && typeof v === 'object' && Array.isArray(v.bullets) &&
      !!v.tracerColors && typeof v.tracerColors === 'object' &&
      typeof v.addBullet === 'function';
  }

  function findBulletBarn(game) {
    if (!game || typeof game !== 'object') return null;
    try {
      if (cachedBulletBarnKey) {
        const v = game[cachedBulletBarnKey];
        if (looksLikeBulletBarn(v)) return hookBulletBarn(v);
        cachedBulletBarnKey = null;
      }
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        if (looksLikeBulletBarn(game[names[i]])) {
          cachedBulletBarnKey = names[i];
          return hookBulletBarn(game[names[i]]);
        }
      }
    } catch {}
    return null;
  }

  // ---- Finding the grenades ---------------------------------------------
  //
  // Same argument, one field shorter. The projectile barn is the only object
  // the Game owns with a `projectilePool`, and that name is a real readable
  // class field in the bundle — as are `pos`, `posZ`, `dir`, `type`, `layer`
  // and `rad` on the entries it pools, because every one of them is copied
  // straight off the wire. The pool's own accessor is the same mangled
  // `m_getPool` every other pool uses, which mangled.js already names.
  let cachedProjBarnKey = null;

  function looksLikeProjBarn(v) {
    return !!v && typeof v === 'object' && !!v.projectilePool &&
      typeof v.projectilePool[POOL_GETALL] === 'function';
  }

  function findProjBarn(game) {
    if (!game || typeof game !== 'object') return null;
    try {
      if (cachedProjBarnKey) {
        const v = game[cachedProjBarnKey];
        if (looksLikeProjBarn(v)) return v;
        cachedProjBarnKey = null;
      }
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        if (looksLikeProjBarn(game[names[i]])) {
          cachedProjBarnKey = names[i];
          return game[names[i]];
        }
      }
    } catch {}
    return null;
  }

  function getProjectiles() {
    const barn = findProjBarn(capturedGame);
    if (!barn) return [];
    const all = barn.projectilePool[POOL_GETALL]();
    return Array.isArray(all) ? all : [];
  }

  // ---- Dating a throw ----------------------------------------------------
  //
  // A grenade's fuse is the one number the blast prediction cannot do without
  // and the wire does not carry. What it does carry is the *animation*: the
  // server calls playAnim(Anim.Cook, fuseTime) the instant the pin comes out
  // and playAnim(Anim.Throw, ...) the instant it leaves the hand, and both ride
  // the player's full update as animType/animSeq. The client copies them into
  // `player.anim.type` and `player.anim.seq` — a plain object under a readable
  // field name, so no mangled.js entry — and those two transitions bracket the
  // cook exactly.
  //
  // That is worth the bookkeeping because cooking is the whole difficulty. An
  // uncooked frag detonates 4s after it is thrown and is at rest for the last
  // second and a half of that; a nade cooked for three detonates about where it
  // lands, and treating the two the same is the difference between a threat the
  // planner has time to answer and one it never sees coming.
  //
  // Sampled per packet rather than per frame, on the same hook and for the same
  // reason as snapshotPlayers: a TCP burst of eight updates has to read as eight
  // ticks of cooking, not as one frame of it.
  const dodgeCook = new Map();     // player __id -> cook state
  // How stale the last sight of a player may be and still count as having
  // watched their cook begin. One tick of slack, because a player standing
  // still sends nothing new to be dirty about and can skip an update.
  const DODGE_COOK_GAP_TICKS = 2;

  // How long a cook has been running, in seconds.
  //
  // Measured in pseudotime — the clock the netcode block recovers — because
  // that is what the tick indices mean, and it is jitter-free by construction.
  // Wall time is the fallback rather than a fabricated tick length: survev's
  // netSyncTps is 33, so a made-up 50ms would inflate every cook by two thirds
  // and read a 2s cook as 3.3s, which is a fifth of a frag's fuse invented out
  // of nothing.
  // Is this player cooking right now, and if so what are they holding?
  //
  // Three ways a cook ends and all three have to be caught, because a cook that
  // does not end is a ring expanding forever on somebody who is holding
  // nothing. Two are transitions — the animation leaves Cook, or the player
  // stops sending updates at all — and the third is the clock: a cook cannot
  // outlive its own fuse, because the server force-throws at `cookTicker >
  // fuseTime` and the Cook animation is given exactly that long to run. If we
  // ever get past it, the grenade left their hand while we were not looking.
  function dodgeCookPhys(st, n) {
    if (!st || st.startN < 0) return null;
    if (n - st.lastN > DODGE_COOK_GAP_TICKS) return null;
    const phys = THROWABLE_PHYS[st.weap];
    if (!phys || phys.impact) return null;
    if (dodgeCookElapsed(st, n) >= phys.fuse) return null;
    return phys;
  }

  function dodgeCookElapsed(st, n) {
    if (netClock.ready && netClock.slope > 0) {
      return Math.max(0, (n - st.startN) * netClock.slope / 1000);
    }
    return Math.max(0, (Date.now() - st.startAt) / 1000);
  }

  function trackCookAnims(game) {
    const n = netClock.n - 1;
    if (n < 0) return;
    const roster = findRosterOnGame(game) || game?.[GAME_ROSTER];
    const pool = roster?.playerPool;
    if (!pool || typeof pool[POOL_GETALL] !== 'function') return;
    const players = pool[POOL_GETALL]() || [];
    for (const p of players) {
      if (!p || !p.active) continue;
      const id = Number(p.__id ?? 0);
      if (!id) continue;
      // netData first, and the render-side `player.anim` only as a fallback.
      //
      // Both carry the same two numbers, but only one of them carries only what
      // the server said. `player.anim` is the animation the client is *playing*:
      // it resets `anim.type` to None locally, without touching `anim.seq`,
      // when the selected animation has no data and when the active weapon
      // stops being a throwable. Neither fires during a real cook, so reading
      // it worked — but a transition detected by a sequence change and then
      // classified by a type that something local may have rewritten is a
      // fragile pair, and the whole fuse estimate hangs off it. netData is the
      // verbatim wire copy and nothing but the packet writes to it.
      const nd = p[PLAYER_NET];
      const anim = p.anim;
      const wireType = NET_ANIM ? nd?.[NET_ANIM] : undefined;
      const wireSeq = NET_ANIMSEQ ? nd?.[NET_ANIMSEQ] : undefined;
      const type = Number(wireType ?? anim?.type);
      const seq = Number(wireSeq ?? anim?.seq);
      if (!Number.isFinite(type) || !Number.isFinite(seq)) continue;
      let st = dodgeCook.get(id);
      if (!st) {
        st = { seq: NaN, startN: -1, startAt: 0, seen: false, lastN: n,
               throwN: -1, cooked: 0, exact: false, weap: '',
               losN: -1, los: true };
        dodgeCook.set(id, st);
      }
      // How long since we last had an update about this player, captured before
      // lastN is moved on. A player only sends updates while we can see them,
      // so a gap here is a gap in the record and not a quiet tick.
      const gap = n - st.lastN;
      st.lastN = n;
      if (seq === st.seq) { st.seen = true; continue; }
      const watched = st.seen && gap <= DODGE_COOK_GAP_TICKS;
      st.seq = seq;
      st.seen = true;
      if (type === ANIM_COOK) {
        st.startN = n;
        st.startAt = Date.now();
        // What they had in hand when the pin came out. Recorded here rather
        // than read at the throw, because the throw removes the grenade from
        // the inventory and a player throwing their last one has already
        // switched weapons by the time the packet is built.
        st.weap = String(nd?.[NET_WEAPON] ?? '');
        // Only a cook we were *already watching* when it began is a cook we can
        // time, and "already watching" means the tick before this one — not
        // merely having seen this player at some point in the round.
        //
        // A player cooking out of our view sends no updates at all. When they
        // walk back in, their animSeq has moved and their animType is Cook, and
        // nothing about that packet distinguishes a pin pulled just now from
        // one pulled three seconds ago behind a wall. Dating it from the moment
        // they reappeared silently drops however long they had been holding it,
        // which is the whole of the fuse that matters — and calling that exact
        // is worse than not having it, because the estimate then stops being
        // treated as an upper bound anywhere downstream.
        st.exact = watched;
      } else {
        // ANY animation that is not Cook ends the cook, and that has to be the
        // rule rather than "Anim.Throw does".
        //
        // Throwing by switching back to a gun — which is how most grenades are
        // actually thrown — runs `throwThrowable()` and `cancelAnim()` in the
        // same server tick, and cancelAnim sets animType to None and bumps the
        // sequence again. Only the last state of a tick reaches the wire, so
        // what we see is Cook -> None and the Anim.Throw in between never
        // existed as far as any packet is concerned. Watching for Throw alone
        // left the cook running forever: a ring expanding on somebody who threw
        // their grenade several seconds ago, and — quietly — no thrower and no
        // cook time for the grenade that actually appeared.
        //
        // Leaving Cook is therefore treated as the throw. The two ways that can
        // be a lie are both harmless: a cook cancelled inside cookTime never
        // produced a grenade, and a cancelAnim from somewhere else entirely
        // (a revive) did not either — and the only thing that reads `throwN`
        // needs a projectile to appear in the same handful of ticks before it
        // will name anyone.
        if (st.startN >= 0) {
          st.throwN = n;
          st.cooked = dodgeCookElapsed(st, n);
        } else if (type === ANIM_THROW) {
          // A throw we never saw the start of: they were cooking before we were
          // watching. Names them as the owner, claims no cook time.
          st.throwN = n;
          st.cooked = 0;
          st.exact = false;
        }
        st.startN = -1;
      }
    }
  }

  // ---- Watching a grenade fly --------------------------------------------
  //
  // The wire gives a projectile `pos`, `posZ` and `dir` per tick and its `type`
  // and `layer` on a full update. It does not give velocity, and it does not
  // give the fuse. Both are recovered here, once per packet, and everything the
  // blast prediction does afterwards is a function of what this holds.
  //
  //   velocity   is the tick-to-tick displacement. It is worth more than it
  //              looks: the server applies drag *only* while the projectile is
  //              resting on the floor, never in the air, so horizontal velocity
  //              is exactly constant for the whole flight and one delta measures
  //              it outright rather than sampling something that is changing.
  //
  //   velZ       is not measured at all. It is `throwPhysics.velZ - g*age`, and
  //              `age` is tracked from the tick the projectile appeared. There
  //              is no bounce in Z — posZ is clamped at the floor and velZ just
  //              stays negative — so one arc covers the whole life.
  //
  //   age        is 0 for a grenade we watched spawn, and otherwise inverted out
  //              of the arc: posZ(t) = z0 + velZ*t - g*t^2/2 solves for t in
  //              closed form, and posZ is on the wire to 10 bits over [0,5].
  //              Near the ground that dates it to under a millisecond; at the
  //              apex, where velZ passes through zero, it is worthless, which is
  //              why the descending root is taken until a second snapshot says
  //              otherwise. Descending is also the larger root, so the
  //              unresolved case reads as the older grenade — the one that goes
  //              off sooner, which is the side to be wrong on.
  //
  //   thrower    is not on the wire either. A throw leaves the hand at
  //              `player.pos + rotate({0.5,-1.0}, aim)` — 1.118u out — so the
  //              nearest player to a fresh spawn names it. That decides friend
  //              from foe, and it has to: a squadmate's frag cannot hurt us at
  //              all (Player.damage returns early on a shared teamId) while our
  //              own can hurt us in full (the same test is skipped when the
  //              source is us), so getting this backwards either walks the bot
  //              off a harmless nade or leaves it standing on our own.
  const dodgeProj = new Map();     // projectile __id -> flight record
  const DODGE_PROJ_SPAWN_TOL = 0.6;   // slack on the 1.118u hand offset
  const DODGE_PROJ_THROW_TICKS = 3;   // how stale a Cook->Throw may be and still be this grenade's

  function dodgeProjAge(z, velZ0, descending) {
    // z = z0 + velZ0*t - g*t^2/2, solved for t. The discriminant goes negative
    // only for a posZ above the arc's own apex, which is a projectile that was
    // not thrown by a player — an airdropped bomb, say — and has no age we can
    // claim to know.
    const disc = velZ0 * velZ0 - 2 * PROJ_GRAVITY * (z - PROJ_SPAWN_Z);
    if (!(disc >= 0)) return null;
    const root = Math.sqrt(disc);
    return ((descending ? velZ0 + root : velZ0 - root) / PROJ_GRAVITY);
  }

  // Water more than doubles the ground drag (5 against 2.3), which more than
  // halves the slide, so a grenade that lands in a river stops about where it
  // lands. The client's own map answers this under a readable method name — it
  // is what the projectile barn calls for the ripple effect — and it is
  // sampled per packet rather than per simulated step, so a grenade sliding out
  // of a river is a tick late noticing. Worth what it costs: at the speeds a
  // landing grenade still carries, the two drags disagree by several units.
  function dodgeProjInWater(pos, layer) {
    try {
      const map = findMapOnGame(capturedGame);
      const surf = map?.getGroundSurface?.(pos, layer);
      return surf?.type === 'water';
    } catch { return false; }
  }

  // How far a spawn at (sx, sy) is from where a player at (px, py) aiming
  // (dx, dy) could have put one.
  //
  // Not a distance to the player: the throw leaves the hand, and the hand is a
  // *known* place. `rotate({0.5,-1.0}, aim)` is 1.118u out at 63.4 degrees off
  // the aim, so the expected point is fixed by two things both on the wire, and
  // the answer is oriented rather than a circle around the body. Two players
  // shoulder to shoulder throwing at once are told apart by which way they were
  // looking, which a radius never could.
  //
  // Measured to the *segment* from the body to that point, not to the point,
  // because the server clips the spawn back along exactly that segment when a
  // wall is in the way — `intersectSegment(obj.collider, player.pos, pos)`. So
  // the set of legal spawns is the segment, and anywhere on it is a perfect
  // match rather than an error of up to a hand's length.
  function dodgeThrowSpawnDist(px, py, dx, dy, sx, sy) {
    const a = Math.atan2(dy, dx);
    const cos = Math.cos(a), sin = Math.sin(a);
    // v2.rotate({0.5, -1.0}, a)
    const hx = px + 0.5 * cos + sin;
    const hy = py + 0.5 * sin - cos;
    const ex = hx - px, ey = hy - py;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 1e-9 ? ((sx - px) * ex + (sy - py) * ey) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(px + ex * t - sx, py + ey * t - sy);
  }

  // Who threw it.
  //
  // The wire never says, but it says two things that together very nearly do.
  //
  // The server calls playAnim(Anim.Throw, ...) in the same call that creates the
  // projectile, so **the thrower is animating a throw in the very packet the
  // grenade first appears in**. Anim.Throw is played nowhere else in the game.
  // That is a hard gate and it usually leaves one candidate on its own.
  //
  // The type is the second gate. A cook records what was in hand when the pin
  // came out, so a `frag` can only have come from someone who was cooking a
  // frag — which separates the player who threw a smoke on the same tick.
  //
  // Geometry then ranks whatever is left, by where the hand was. A winner has
  // to beat the runner-up by a clear margin; a tie is left unowned rather than
  // guessed, because the three answers are genuinely different — a squadmate's
  // frag cannot touch us, our own hurts us in full, and unowned is treated as
  // hostile, which is the safe way to be wrong.
  //
  // The fallback for a grenade whose throw we did not see — we were not
  // watching that player when the packet landed — is the old rule: nearest body
  // to the spawn, which is right in the common case of one grenade at a time
  // and is why `sure` exists to say the difference.
  const DODGE_PROJ_SPAWN_FIT = 0.5;    // slack on the hand segment, in units
  const DODGE_PROJ_SPAWN_EDGE = 0.35;  // how far the winner must beat the runner-up
  // GameConfig.player.moveSpeed * throwPhysics.playerVelMult: the most of their
  // own motion a thrower can put into a grenade.
  const PROJ_VEL_CARRY = 12 * 0.6;
  // PerkProperties.amped_explosives.throwableSpeedMult.
  const PROJ_SPEED_MULT_MAX = 2;

  function dodgeProjThrower(game, x, y, layer, type, n, age, phys, out) {
    out.id = 0; out.sure = false; out.throwN = -1;
    const roster = findRosterOnGame(game) || game?.[GAME_ROSTER];
    const pool = roster?.playerPool;
    if (!pool || typeof pool[POOL_GETALL] !== 'function') return 0;
    const players = pool[POOL_GETALL]() || [];

    // How far the grenade can have travelled since it left the hand. We do not
    // see it at the spawn — the server runs one to three 100Hz physics ticks
    // between creating it and serialising the 33Hz update — so the observed
    // position is the spawn plus a tick or so of flight, and the geometry has
    // to be given room for exactly that much and no more.
    const carry = age > 0 && phys
      ? (phys.speed * PROJ_SPEED_MULT_MAX + PROJ_VEL_CARRY) * age
      : 0;
    const fit = DODGE_PROJ_SPAWN_FIT + carry;

    let best = 0, bestD = Infinity, nextD = Infinity, bestN = -1, cands = 0;
    let near = 0, nearD = PROJ_SPAWN_OFFSET + DODGE_PROJ_SPAWN_TOL + carry;

    for (const p of players) {
      if (!p || !p.active || p[PLAYER_NET]?.[NET_DEAD]) continue;
      if (!sameLayerAs(layer, p.layer)) continue;
      // Both read off the same object, netData first. The hand offset is the
      // aim applied at the body, so a position from one source and an aim from
      // another would put it somewhere neither of them means.
      const nd = p[PLAYER_NET];
      const pos = getXY(nd?.[PLAYER_POS] ?? p[PLAYER_POS] ?? p.pos);
      if (!pos) continue;
      const id = Number(p.__id ?? 0);
      if (!id) continue;

      // The fallback ranking, kept up alongside the real one so the loop is
      // walked once either way.
      const body = Math.hypot(pos.x - x, pos.y - y);
      if (body < nearD) { nearD = body; near = id; }

      const st = dodgeCook.get(id);
      if (!st || st.throwN < 0 || n - st.throwN > DODGE_PROJ_THROW_TICKS) continue;
      if (st.weap && st.weap !== type) continue;
      cands++;
      bestN = st.throwN;

      const dir = getXY(nd?.[PLAYER_DIR] ?? p[PLAYER_DIR] ?? p.dir);
      const d = dir && Math.hypot(dir.x, dir.y) > 1e-6
        ? dodgeThrowSpawnDist(pos.x, pos.y, dir.x, dir.y, x, y)
        : body;
      if (d < bestD) { nextD = bestD; bestD = d; best = id; }
      else if (d < nextD) { nextD = d; }
    }

    // One player threw a grenade of this type on this tick, so one player threw
    // this grenade. No geometry can improve on that and none is asked for — the
    // position test exists to break ties, not to second-guess the animation.
    if (cands === 1 && best) {
      out.id = best; out.sure = true; out.throwN = bestN;
      return best;
    }
    // Two at once: the hand geometry decides, and only by a clear margin.
    if (cands > 1 && best && bestD <= fit && nextD - bestD >= DODGE_PROJ_SPAWN_EDGE) {
      out.id = best; out.sure = true; out.throwN = bestN;
      return best;
    }
    out.id = near;
    return near;
  }
  const dodgeThrowerOut = { id: 0, sure: false, throwN: -1 };

  // Where and when this grenade detonates, from the state the packet just
  // delivered. Run once per packet per grenade rather than on demand: it is
  // wanted by the overlay every frame and by the planner every step, and both
  // want the same answer, so computing it here is the cheapest place it can
  // live and the only one where the two cannot disagree.
  //
  // Deliberately unclamped and unled — this is what the grenade is going to do,
  // not what the planner can see of it. dodgeAddBlasts applies its own horizon
  // and its own ping lead on top.
  function dodgeProjBoom(rec, phys, layer) {
    if (!phys) { rec.boomT = 0; rec.boomX = rec.x; rec.boomY = rec.y; return; }
    // The clock is cheap and has to stay current: it is just what is left of
    // the fuse, and it ticks down whether anything is simulated or not.
    rec.boomT = Math.max(0, phys.fuse - rec.cooked - rec.age);
    if (rec.boomSolved) return;
    // Nothing to solve from yet. Velocity takes two snapshots to measure and
    // the whole trajectory is a function of it, so until then the honest answer
    // is where the grenade is — one packet of a ring in the wrong place, rather
    // than a whole flight predicted from a velocity of zero.
    if (!rec.haveVel) { rec.boomX = rec.x; rec.boomY = rec.y; return; }
    dodgeSimBlast(rec, phys, rec.boomT, layer, dodgeSimOut);
    rec.boomX = dodgeSimOut.x;
    rec.boomY = dodgeSimOut.y;
    rec.boomSolved = true;
  }

  function snapshotProjectiles(game) {
    const n = netClock.n - 1;
    if (n < 0) return;
    const list = getProjectiles();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !p.active) continue;
      const id = Number(p.__id ?? 0);
      if (!id) continue;
      const pos = p.pos;
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      const z = Number(p.posZ);
      const phys = THROWABLE_PHYS[p.type];

      let rec = dodgeProj.get(id);
      if (!rec) {
        const velZ0 = phys ? phys.velZ : 5;
        // We never see a grenade at the height it was thrown from. The server
        // creates it at posZ 0.5 on a 100Hz physics tick and serialises the
        // world at 33Hz, so one to three ticks of flight have already happened
        // by the time the first packet carrying it arrives and posZ is 0.55 to
        // 0.65. Testing for spawn height is therefore not a test that can pass,
        // and while it was the gate here nothing downstream of it ever ran: no
        // grenade was ever attributed, no cook was ever carried onto one, and
        // every fuse read as full.
        //
        // So the arc is asked instead, and it has two answers — the same posZ
        // occurs once on the way up and once on the way down. The throw
        // animation is what picks between them: a player who threw within the
        // last few ticks means this grenade is at the start of its flight and
        // the ascending root is the age. Nobody throwing means we have picked
        // it up somewhere in the middle of a life we did not watch, and the
        // descending root is the conservative reading — the older grenade, the
        // one that goes off sooner.
        const ageUp = dodgeProjAge(z, velZ0, false);
        const thrower = dodgeProjThrower(game, pos.x, pos.y, p.layer, p.type, n,
                                         ageUp ?? 0, phys, dodgeThrowerOut);
        let age, cooked;
        if (dodgeThrowerOut.sure) {
          // The arc dates it to under a millisecond this close to the throw,
          // where velZ is still near its full 5 and the inversion is at its
          // best conditioned. The throw tick is the fallback if posZ is above
          // the arc's own apex, which means it is not a thrown grenade at all.
          age = ageUp !== null && ageUp >= 0
            ? ageUp
            : Math.max(0, (n - dodgeThrowerOut.throwN) * (netClock.slope || 30) / 1000);
        } else {
          age = dodgeProjAge(z, velZ0, true) ?? 0;
        }
        // Only a thrower we are *sure* of carries their cook. A fallback match
        // is the nearest body to the spawn, which is a good guess about who
        // threw it and no basis at all for reading their cook onto it: better
        // an assumed full fuse than somebody else's measured one.
        const ck = dodgeThrowerOut.sure && thrower ? dodgeCook.get(thrower) : null;
        cooked = ck ? ck.cooked : 0;
        rec = {
          id, n, age, thrower,
          // Whether that attribution is the throw animation naming them or the
          // fallback guessing them. Only a sure one is trusted with the cook
          // time, and only a sure one should be trusted to call a grenade
          // harmless — see dodgeAddBlasts.
          throwerSure: dodgeThrowerOut.sure,
          // Wall time of the packet this record is as of. The fuse is counted
          // forward from here rather than from "now", so a step landing between
          // packets does not read the grenade as younger than it is.
          at: Date.now(),
          water: dodgeProjInWater(pos, p.layer),
          cooked,
          // Whether that cook time is a measurement or an assumption. False
          // means "assume nobody cooked it", which is the longest fuse the
          // grenade can have and so the latest it can go off — see
          // dodgeAddBlasts for what the planner does with a fuse it does not
          // trust.
          cookExact: !!(ck && ck.exact && cooked > 0),
          // Kept for the readout: what the grenade actually is, so a diagnostic
          // does not have to go back to the pool to find out.
          type: p.type,
          x: pos.x, y: pos.y, z,
          vx: 0, vy: 0, haveVel: false,
          // Whether we know which branch of the arc it is on. A named thrower
          // settles it; anything else waits for a posZ that moves.
          resolved: dodgeThrowerOut.sure,
          // Where and when this grenade goes off: `boomT` seconds from the
          // packet this record is as of, at (boomX, boomY). A property of the
          // grenade alone — no ping lead, no planning horizon — so the overlay
          // and the planner read one answer and cannot disagree.
          //
          // Solved exactly once, on the first packet that can measure a
          // velocity, and then never again. Not an optimisation: re-running it
          // every packet is *redundant*, because simulating from a later state
          // over a correspondingly shorter fuse lands in the same place, and
          // the only thing re-running can add is the jitter of re-deriving the
          // velocity from a fresh pair of quantised positions. Frozen, the
          // blast point is a fixed spot on the ground, which is what it is.
          boomT: 0, boomX: pos.x, boomY: pos.y, boomSolved: false,
          // Whether the blast can see where we stand. Cached per packet rather
          // than frozen with the rest: the blast point holds still, but we do
          // not.
          simN: -1, simClear: false,
        };
        dodgeProj.set(id, rec);
        dodgeProjBoom(rec, phys, p.layer);
        continue;
      }

      const dn = n - rec.n;
      if (dn <= 0) continue;
      const dt = dn * (netClock.slope || 50) / 1000;
      if (dt > 0) {
        rec.vx = (pos.x - rec.x) / dt;
        rec.vy = (pos.y - rec.y) / dt;
        rec.haveVel = true;
      }
      // The ascending branch, settled by the only thing that can settle it: a
      // posZ that went up. Done once, on the first delta after the grenade was
      // picked up mid-flight.
      if (!rec.resolved) {
        rec.resolved = true;
        if (z > rec.z) {
          const velZ0 = phys ? phys.velZ : 5;
          const up = dodgeProjAge(rec.z, velZ0, false);
          if (up !== null && up >= 0) rec.age = up;
        }
      }
      rec.age += dt;
      rec.n = n;
      rec.at = Date.now();
      rec.x = pos.x; rec.y = pos.y; rec.z = z;
      rec.water = dodgeProjInWater(pos, p.layer);
      dodgeProjBoom(rec, phys, p.layer);
    }
    // A projectile that has left the pool has detonated or expired, and its
    // record must go with it: the pool hands the same object to the next
    // grenade, and a stale age would date that one from this one's throw.
    if (dodgeProj.size) {
      for (const [id, rec] of dodgeProj) {
        if (rec.n !== n) dodgeProj.delete(id);
      }
    }
    // Cook states outlive their grenades on purpose — a throw has to still be
    // readable on the tick after it happened — so they age out by tick index
    // rather than by presence. `seen` is never cleared: it is what says we have
    // watched this player's animation from before their cook began, which is
    // the whole basis for calling a cook time exact.
    if (dodgeCook.size > 32) {
      for (const [id, st] of dodgeCook) { if (n - st.lastN > 200) dodgeCook.delete(id); }
    }
  }

  // ---- Recovering the bullet type ---------------------------------------
  //
  // The barn's entries are the one place the type is thrown away. `addBullet`
  // is handed the wire bullet, which carries `bulletType`, resolves it to a def
  // and copies out only what the renderer needs — speed, distance, layer,
  // damageSelf, tracer colours. Damage never makes the trip, and neither does
  // the name it could be looked up under.
  //
  // Identifying it after the fact from what survives doesn't work: `speed` is
  // def.speed times a variance the wire also doesn't carry, and speeds collide
  // anyway — every shotgun in the game fires at 66, and buckshot, birdshot and
  // slug do 12.5, 4 and 77.
  //
  // So the type is taken on the way past, and stamped onto the entry that call
  // wrote. Which entry that is has to be worked out rather than observed: the
  // barn pools its entries and `addBullet` returns nothing. It takes the first
  // slot that is neither `alive` nor `collided`, and pushes a fresh one when
  // there isn't one — so finding that slot before the call, by the same rule,
  // and falling back to the array's new tail, names it exactly.
  //
  // Reuse can't go stale: a pooled slot is re-stamped every time it is handed
  // out, and is only ever read while `alive`. Bullets already in flight when
  // the hook goes on have no stamp and price at DODGE_DMG_REF, which lasts as
  // long as they do.
  // Rounds entering the world, counted. The planner replans when its inputs
  // change and nothing else, and a round being fired is the one input that
  // arrives mid-gap and cannot be seen by comparing two threat sets: the barn
  // pools its slots, so a round that dies and one that is born into the same
  // slot between two steps leave dodgeState.liveKey exactly as it was. This
  // rides the hook that is already in that path — see dodgeStep.
  let dodgeBulletAdds = 0;

  function hookBulletBarn(barn) {
    if (!barn || barn.__dodgeTypeHook) return barn;
    const orig = barn.addBullet;
    if (typeof orig !== 'function') return barn;
    // Marked before the attempt, not after: if assigning to a barn we can't
    // write to throws, we want to give up on it rather than retry every frame
    // for the rest of the round.
    barn.__dodgeTypeHook = true;
    try {
      // Own-property assignment shadowing the class method, so it dies with
      // the barn instead of leaking onto the next game's barn.
      barn.addBullet = function(bullet) {
        const list = this.bullets;
        let slot = null;
        if (Array.isArray(list)) {
          for (let i = 0; i < list.length; i++) {
            if (!list[i].alive && !list[i].collided) { slot = list[i]; break; }
          }
        }
        const ret = orig.apply(this, arguments);
        dodgeBulletAdds++;
        try {
          const b = slot || (Array.isArray(list) ? list[list.length - 1] : null);
          if (b) b.__dodgeType = bullet?.bulletType ?? null;
        } catch {}
        return ret;
      };
    } catch {}
    return barn;
  }

  // What a round would take off us if it landed, in HP, at the point along its
  // own path where it is going to reach us. survev's own formula, minus the
  // `damageMult` the wire doesn't carry — see BULLET_DAMAGE.
  //
  // `travelled` is distance-at-impact rather than distance-now, because falloff
  // is evaluated at the collision and the two differ by most of a round's life
  // at sniper range. Reflects halve, third, quarter — a shot that has already
  // bounced off a pan is the one case where a round we can see is worth
  // markedly less than its table entry.
  function dodgeBulletDamage(type, travelled, distance, reflectCount) {
    const def = type ? BULLET_DAMAGE[type] : null;
    if (!def) return DODGE_DMG_REF;
    let dmg = def[0];
    if (!(dmg > 0)) return 0;
    const n = Number(reflectCount);
    if (Number.isFinite(n) && n > 0) dmg /= n + 1;
    if (distance > 0) {
      const distT = Math.min(Math.max(travelled / distance, 0), 1);
      dmg *= 1 + distT * (def[1] - 1);
    }
    return dmg;
  }

  function dodgePlayerInfo(roster, id) {
    try {
      return roster?.getPlayerInfo?.(id) ?? null;
    } catch {
      return null;
    }
  }

  // Live bullets, in plan-time coordinates: position advanced to where the
  // server will have it when our input lands, velocity as a vector, and
  // `tMax` as the seconds of life it has left after truncation at the first
  // wall on its own path.
  //
  // `reach` is how far we could possibly move inside the horizon: a round that
  // cannot come within our radius plus that of where we stand is scenery, and
  // is dropped before it costs anything. That filter is now the only thing
  // deciding the size of the set — everything that survives it is kept and
  // planned against, however many that is.
  //
  // There used to be a hard cap of 48 on top, with a newcomer displacing the
  // slot furthest from mattering. It was a bound on the innermost loop in the
  // mod: threat count multiplies straight into edges x threats. Nothing else
  // replaces that bound, so a fight that puts an implausible number of rounds
  // genuinely on course for us can now cost proportionally more per frame. The
  // reachability filter is what makes that acceptable — it already rejects
  // everything flying somewhere else, which in a firefight is nearly all of it.
  function dodgeBuildThreats(game, selfId, selfInfo, roster, layer, leadS, selfR,
                             px, py, reach, horizon) {
    const out = dodgeState.threats;
    out.length = 0;
    // Rebuilt from nothing every step, so an empty barn reads as an empty set
    // rather than as the last set that was in it.
    dodgeState.liveKey = 0;
    const barn = findBulletBarn(game);
    const bullets = barn?.bullets;
    if (!Array.isArray(bullets)) return out;

    // Our live scaled body from dodgeSelfRadius, and only that. Everything
    // downstream — the reachability filter, the sweeps, the falloff's inner
    // edge — is measured from this, so it is the one number that decides what
    // counts as certainly being hit.
    const R = selfR;
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      if (!b || !b.alive) continue;
      const speed = Number(b.speed);
      if (!(speed > 0)) continue;
      const pos = b.pos, dir = b.dir, start = b.startPos;
      if (!pos || !dir || !start) continue;
      if (!Number.isFinite(pos.x) || !Number.isFinite(dir.x)) continue;

      // Our own rounds only come back at us as shrapnel or off a reflector,
      // which is exactly what the barn's own damageSelf flag already means.
      const shooter = Number(b.playerId);
      if (selfId != null && shooter === selfId && !b.damageSelf) continue;
      // A squadmate's round passes through us in every non-FF mode, so
      // dodging it would hand the keys away for nothing. Unknown shooter
      // counts as hostile, matching isHostileTo's own default.
      if (roster && shooter !== selfId &&
          !isHostileTo(selfInfo, dodgePlayerInfo(roster, shooter))) continue;
      // The game's own bullet-vs-player layer test, `sameLayer(player.layer,
      // bullet.layer) || player.layer & 2`: standing on a stairwell exposes
      // us to rounds from both layers at once, and dropping that clause would
      // make the bot blind on exactly the tile where it is most cornered.
      if (!sameLayerAs(layer, b.layer) && !(layer & 2)) continue;

      // Flares and the invisible round do no damage. Dropping them here rather
      // than letting them score as zero matters twice over: they would take a
      // threat slot from a round that can actually hurt us, and the trigger
      // reads `firstHit` regardless of what a threat is worth, so one flare on
      // course would take the keys away for the whole time it was in the air.
      const btype = b.__dodgeType ?? null;
      const bdef = btype ? BULLET_DAMAGE[btype] : null;
      if (bdef && !(bdef[0] > 0)) continue;

      const total = Number(b.distance);
      let remaining = total - Math.hypot(pos.x - start.x, pos.y - start.y);
      if (!(remaining > 0)) continue;

      const lead = Math.min(leadS * speed, remaining);
      const x = pos.x + dir.x * lead;
      const y = pos.y + dir.y * lead;
      remaining -= lead;
      if (!(remaining > 0)) continue;
      // How far it has flown by plan-time zero. Captured before the wall clip
      // below shortens `remaining` for a reason unrelated to distance flown.
      const flown = total - remaining;

      const wall = firstBulletHit(x, y, x + dir.x * remaining, y + dir.y * remaining, layer, 0);
      if (wall && wall.dist < remaining) {
        if (!(wall.dist > 0)) continue;
        remaining = wall.dist;
      }

      const wx = dir.x * speed, wy = dir.y * speed;
      const tMax = remaining / speed;
      // How soon it could reach anywhere we could be. Negative means never,
      // and past the horizon means not while this plan lasts; either way every
      // rollout would score it as a clean miss.
      const due = dodgeReachTime(x, y, wx, wy, tMax, px, py, R + reach);
      if (due < 0 || due > horizon) continue;

      // Damage is what both searches minimise. `due` is the earliest this round
      // could touch anywhere we might be, so it is the best estimate of where
      // along its own path the falloff gets evaluated — and being the earliest,
      // it is also the shortest flight and so the most damage the round can
      // still be worth. Erring high is the right side: it can only make the bot
      // take a threat more seriously than it deserves.
      const dmg = dodgeBulletDamage(btype, flown + speed * due, total, b.reflectCount);
      // What the cost function actually charges. Precomputed per threat rather
      // than per sweep because the deep search evaluates every threat on every
      // edge of a few thousand states, and this would otherwise be a division
      // in the innermost loop in the whole mod.
      const w = dmg / DODGE_DMG_REF;

      // `phantom` is false rather than absent, and the four blast fields are
      // present-and-zero rather than missing, so that a live round, the
      // hypothetical one dodgeAddPhantoms appends and the grenade
      // dodgeAddBlasts appends all share one shape — every edge of the search
      // reads this array and a second hidden class would deoptimise the
      // hottest loop in the mod.
      out.push({ x, y, wx, wy, tMax, R, due, dmg, w, type: btype, phantom: false,
                 blast: 0, tBoom: 0, rMin: 0, rMax: 0, layer: 0, clear: true, vis: -1 });
      // The slot, folded in — accepted rounds only, and in the order the barn
      // holds them, so this changes if any of them stops being a threat and not
      // if one merely moves. `i + 1` because slot 0 must not be a no-op.
      dodgeState.liveKey = (Math.imul(dodgeState.liveKey, 31) + i + 1) | 0;
    }
    return out;
  }

  // ---- The shot nobody has fired -----------------------------------------
  //
  // Everything above is reactive: a threat exists once a round does. That is
  // the whole of what the bot could see, and it is half a beat too late by
  // construction — see "What is and isn't dodgeable". The round is already in
  // the air when it becomes a cost, so at any range where flight time is under
  // the round trip, no plan beats it. What *is* knowable before the trigger is
  // pulled is the line: standing in front of a gun is a decision we make with
  // our own feet, several hundred milliseconds before the shot that punishes it.
  //
  // So each hostile pointing a gun near us contributes one more threat — a
  // round fired from where they were at the last frame we have, along the aim
  // that same frame carried, out of the gun they are holding. It travels, it is
  // clipped by walls, it is priced by BULLET_DAMAGE, and it is swept exactly
  // like a real one. It is a real cost in the loss and not a special case
  // anywhere below this function; the only thing separating it from a live
  // round is `phantom`, which keeps it out of the two hit readouts, and the
  // weight.
  //
  // DODGE.phantom is that weight, and what it means is the chance the shot is
  // actually taken. The loss is expected HP — `w * bill * DODGE_HIT_COST`, where
  // `bill` already carries the chance the round connects — so multiplying `w` by
  // a probability of firing keeps the phantom in the same currency as every
  // other term and comparable to a live round of the same gun. At 0.35 a
  // Barrett aimed down our path outweighs an mp5 round genuinely in the air,
  // which is the ordering anyone would want; at 1 the bot treats aim as fire and
  // will not stand in a line it could leave; at 0 none of this runs at all.
  //
  // Three properties worth being deliberate about:
  //
  //   The ray is frozen. The phantom is not re-aimed as the plan moves us, and
  //   must not be — an enemy modelled as tracking us perfectly makes every
  //   position equally doomed, the term goes flat, and a flat term steers
  //   nothing. Frozen, it has a gradient that points off the line, which is the
  //   entire object of the exercise.
  //
  //   It is one round, not a stream. Fire rate is not modelled, so this prices
  //   being on the line at a particular instant rather than living there. That
  //   understates a held trigger and is the conservative direction for a term
  //   that is a guess about intent.
  //
  //   It shares the reach filter with live rounds, so a phantom only exists
  //   while someone's aim already passes within our own reach of us. Pointing a
  //   gun somewhere else costs nothing, and neither does an enemy behind a wall.
  //
  // Not modelled: pellet count and spread (a shotgun contributes one pellet
  // down the centre line, at one pellet's damage), the muzzle offset
  // (`barrelLength`, ~2.6u along the aim — it matters only at ranges where
  // nothing here helps anyway), and the magazine, which is not on the wire for
  // anyone but us. An enemy who is dry, reloading or mid-switch is still
  // modelled as able to fire.
  function dodgeAddPhantoms(out, game, selfId, selfInfo, roster, layer, leadS, selfR,
                            px, py, reach, horizon) {
    const k = dodgeClamp(DODGE.phantom, 0, 1, 0);
    if (!(k > 0)) return out;
    const pool = roster && roster.playerPool;
    const players = (pool && typeof pool[POOL_GETALL] === 'function')
      ? pool[POOL_GETALL]() : null;
    if (!Array.isArray(players)) return out;

    const R = selfR;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || !p.active) continue;
      const id = Number(p.__id ?? 0);
      if (!Number.isFinite(id) || id === 0) continue;
      if (selfId != null && id === selfId) continue;
      // Dead is obvious; downed is the same rule the game plays by — a knocked
      // player cannot shoot, so their aim is not a threat and charging for it
      // would push the bot away from the one enemy it should be walking toward.
      const net = p[PLAYER_NET];
      if (net && (net[NET_DEAD] || net[NET_DOWNED])) continue;
      if (roster && !isHostileTo(selfInfo, dodgePlayerInfo(roster, id))) continue;
      // Their round would be born on their layer, so this is the same test the
      // live path makes against `b.layer`, including the stairwell clause.
      const theirLayer = Number.isFinite(p.layer) ? p.layer : 0;
      if (!sameLayerAs(layer, theirLayer) && !(layer & 2)) continue;

      // The gun decides everything else. A melee, a throwable or bare fists
      // resolves to no entry and contributes nothing, which is also how an
      // unlisted new gun behaves — it is skipped rather than guessed at, since
      // there is no instance to fall back on the way a live round has.
      const gun = getCurrentWeapon(p);
      if (!gun || !Object.prototype.hasOwnProperty.call(GUN_BULLET_SPEED, gun)) continue;
      const speed = GUN_BULLET_SPEED[gun];
      const type = GUN_BULLET_TYPE[gun];
      if (!(speed > 0) || !type) continue;
      if (!Object.prototype.hasOwnProperty.call(BULLET_RANGE, type)) continue;
      // Flares and the potato guns' invisible round, dropped for the same
      // reason the live path drops them: zero damage.
      const bdef = BULLET_DAMAGE[type];
      if (bdef && !(bdef[0] > 0)) continue;

      const pos = p[PLAYER_POS] || p[PLAYER_POS2];
      const aim = p[PLAYER_DIR];
      if (!pos || !aim) continue;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      if (!Number.isFinite(aim.x) || !Number.isFinite(aim.y)) continue;
      // The wire sends a unit vector, but this is the axis the whole threat is
      // built on and a stale or half-written one would put the ray somewhere
      // it isn't. One sqrt per enemy per frame is nothing next to being wrong.
      const alen = Math.hypot(aim.x, aim.y);
      if (!(alen > 1e-6)) continue;
      const dx = aim.x / alen, dy = aim.y / alen;

      const total = BULLET_RANGE[type];
      let remaining = total;
      // Fired at the last frame we have, so by plan-time zero — which is a
      // round trip from now, the same instant the live rounds are advanced to —
      // it has been flying for exactly that long. Same lead, same clock.
      const lead = Math.min(leadS * speed, remaining);
      const x = pos.x + dx * lead;
      const y = pos.y + dy * lead;
      remaining -= lead;
      if (!(remaining > 0)) continue;
      const flown = total - remaining;

      const wall = firstBulletHit(x, y, x + dx * remaining, y + dy * remaining, layer, 0);
      if (wall && wall.dist < remaining) {
        if (!(wall.dist > 0)) continue;
        remaining = wall.dist;
      }

      const wx = dx * speed, wy = dy * speed;
      const tMax = remaining / speed;
      const due = dodgeReachTime(x, y, wx, wy, tMax, px, py, R + reach);
      // Aimed anywhere that cannot reach anywhere we could be, inside the
      // horizon. This is what keeps a phantom from existing for every enemy on
      // screen, and with it the planner still costs nothing in the common case
      // of nobody pointing anything at us.
      if (due < 0 || due > horizon) continue;

      // Priced from the def rather than from an instance: no reflects, no
      // wire multipliers, base range as the falloff's denominator. See
      // BULLET_RANGE for why that number lives in its own table.
      const dmg = dodgeBulletDamage(type, flown + speed * due, total, 0);
      const w = k * dmg / DODGE_DMG_REF;
      out.push({ x, y, wx, wy, tMax, R, due, dmg, w, type, phantom: true,
                 blast: 0, tBoom: 0, rMin: 0, rMax: 0, layer: 0, clear: true, vis: -1 });
    }
    return out;
  }

  // ---- The grenade ------------------------------------------------------
  //
  // A round is a line and a blast is a moment. That difference decides the
  // whole shape of what follows: there is nothing to sweep, no closest approach
  // to find and no question of when contact begins, because a grenade does
  // exactly one thing to us and it does it at one instant. What has to be right
  // is *where* it is at that instant and *when* that instant is, and neither is
  // on the wire.
  //
  // So the path is simulated rather than solved. The closed form is available —
  // the airborne leg is a straight line at constant speed for
  // (velZ + sqrt(velZ^2 + 2*g*z0))/g seconds, and the ground leg's whole
  // remaining travel is exactly `speed/drag` however the tick length is
  // chosen — but it stops being available the moment the grenade touches
  // anything, and grenades are thrown at cover for a living. Stepping the
  // server's own integrator handles bounces, tables it lands on and water it
  // falls in without any of them being a special case, and it costs a few
  // hundred multiplies for a threat that appears a handful of times a match.
  //
  // Damage is then charged once, on the leg of the plan that contains the
  // detonation, from the distance between the blast and wherever that plan has
  // us standing. See dodgeDpBlast.
  //
  // Shrapnel is not modelled — see BLAST_DEFS. Neither is armour, for the same
  // reason no round in this planner is priced through armour: the loss is what
  // the game's own damage formula would take off an unarmoured body, and it is
  // that consistently.

  // The explosion's own occlusion test. Not blocksBullets: the game breaks an
  // explosion's raycast on `collidable && height > 0.5`, which is a higher bar
  // than a bullet's 0.25 and — unlike a bullet — does not let it through a
  // window. A blast reaching us through a pane of glass is survev's behaviour,
  // not an oversight here.
  const BLAST_HEIGHT = 0.5;

  function blocksBlast(o, layer) {
    return !!o && o.active && !o.dead && o.collidable &&
      o.height > BLAST_HEIGHT && !!o.collider && sameLayerAs(layer, o.layer);
  }

  function blastLineClear(x0, y0, x1, y1, layer) {
    const obstacles = getObstacles();
    const loX = Math.min(x0, x1), hiX = Math.max(x0, x1);
    const loY = Math.min(y0, y1), hiY = Math.max(y0, y1);
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!blocksBlast(o, layer)) continue;
      if (!colliderNearSegment(o.collider, loX, loY, hiX, hiY)) continue;
      if (segHitCollider(x0, y0, x1, y1, o.collider) !== null) return false;
    }
    return true;
  }

  // How much of its full damage a blast does at distance `dist`, as a fraction.
  //
  // survev's own falloff, and its one surprise: past rad.min the ramp is
  // measured from the *centre*, not from rad.min, so it does not resume at full
  // damage where the plateau ends. A frag is 125 out to 5u and about 73 just
  // past it, decaying to nothing at 12.
  //
  //   d <= rad.min   1
  //   otherwise      1 - d/rad.max
  //
  // `slack` is subtracted from the distance before any of that, which is the
  // same doubt DODGE.clearance stands for everywhere else in the loss — the
  // lead is an estimate, the plan's position is snapped to a cell, and the
  // simulated blast point carries its own error on top. Assuming we are that
  // much closer than we think can only raise the charge, which is the direction
  // to be uncertain in.
  //
  // Unlike the round sweep's falloff this one is not a model of anything: it is
  // the game's damage curve, so `f` here is a real fraction of real HP rather
  // than a probability that a hit happens at all. Both end up multiplied by the
  // same `w * DODGE_HIT_COST`, and both are expected HP when they do.
  function dodgeBlastFactor(rMin, rMax, dist, slack) {
    const d = Math.max(0, dist - slack);
    if (d <= rMin) return 1;
    if (d >= rMax) return 0;
    return 1 - d / rMax;
  }

  // Seconds per simulated tick. The server integrates at gameTps 100 and the
  // drag law is dt-dependent — `vel /= 1 + dt*drag` compounds — so matching its
  // step is what makes the slide land in the same place rather than merely
  // near it.
  const DODGE_SIM_DT = 0.01;
  const DODGE_SIM_MAX_STEPS = 400;

  const dodgeSimOut = { x: 0, y: 0 };
  const dodgeSimHit = { nx: 0, ny: 0, pen: 0 };
  const dodgeSimObs = [];

  // Port of coldet.intersectAabbCircle / intersectCircleCircle, which is what
  // the server's projectile collision calls, kept to its arithmetic so a bounce
  // here is the bounce there. `dir` in survev points from the obstacle out
  // toward the projectile, and is both the push-out direction and the surface
  // normal the reflection uses.
  function dodgeSimPen(c, x, y, r) {
    if (c.type === COLLIDER_CIRCLE) {
      if (!c.pos) return false;
      const R = c.rad + r;
      const dx = x - c.pos.x, dy = y - c.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R) return false;
      const d = Math.sqrt(d2);
      if (d > 1e-5) { dodgeSimHit.nx = dx / d; dodgeSimHit.ny = dy / d; }
      else { dodgeSimHit.nx = 1; dodgeSimHit.ny = 0; }
      dodgeSimHit.pen = R - d;
      return true;
    }
    if (!c.min || !c.max) return false;
    if (x >= c.min.x && x <= c.max.x && y >= c.min.y && y <= c.max.y) {
      const ex = (c.max.x - c.min.x) * 0.5, ey = (c.max.y - c.min.y) * 0.5;
      const px = x - (c.min.x + ex), py = y - (c.min.y + ey);
      const xp = Math.abs(px) - ex - r, yp = Math.abs(py) - ey - r;
      if (xp > yp) { dodgeSimHit.nx = px > 0 ? 1 : -1; dodgeSimHit.ny = 0; dodgeSimHit.pen = -xp; }
      else { dodgeSimHit.nx = 0; dodgeSimHit.ny = py > 0 ? 1 : -1; dodgeSimHit.pen = -yp; }
      return true;
    }
    const cx = Math.min(Math.max(x, c.min.x), c.max.x);
    const cy = Math.min(Math.max(y, c.min.y), c.max.y);
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    if (d > 1e-4) { dodgeSimHit.nx = dx / d; dodgeSimHit.ny = dy / d; }
    else { dodgeSimHit.nx = 1; dodgeSimHit.ny = 0; }
    dodgeSimHit.pen = r - d;
    return true;
  }

  // Everything the grenade could touch between here and the end of the
  // simulation, gathered once so the step loop is a flat scan. `height` is kept
  // because the test the server makes against it changes as the grenade falls:
  // an obstacle taller than the grenade's current posZ is a wall to bounce off,
  // and a shorter collidable one is a floor to land on.
  function dodgeSimObstacles(x, y, reach, layer) {
    const out = dodgeSimObs;
    out.length = 0;
    const obstacles = getObstacles();
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!o || !o.active || o.dead || !o.collider) continue;
      if (!sameLayerAs(layer, o.layer)) continue;
      if (!(o.height > 0)) continue;
      const c = o.collider;
      if (c.type === COLLIDER_AABB) {
        if (!c.min || !c.max) continue;
        if (c.max.x < x - reach || c.min.x > x + reach) continue;
        if (c.max.y < y - reach || c.min.y > y + reach) continue;
      } else {
        if (!c.pos) continue;
        if (Math.hypot(c.pos.x - x, c.pos.y - y) > reach + c.rad) continue;
      }
      out.push(o);
    }
    return out;
  }

  // Walk the server's Projectile.update forward `dur` seconds from where the
  // last packet left this grenade, and report where it ends up.
  //
  // The three things that make it the server's loop and not an approximation
  // of it:
  //
  //   Drag is applied only on the ground. `posZ <= obstacleBellowHeight` is the
  //   server's test, and it means an airborne grenade holds its speed exactly —
  //   which is also why one snapshot delta measures that speed outright.
  //
  //   There is no bounce in Z. posZ is clamped at the floor and velZ carries on
  //   downward, so a grenade lands once and stays landed.
  //
  //   A bounce reflects and loses speed by `max(1 + d.n, 0.15)`, so a graze
  //   keeps almost everything and a head-on hit keeps a sixth. Obstacles below
  //   the grenade raise the floor instead of turning it, which is how a grenade
  //   comes to rest on a table.
  // `pre` is an obstacle list the caller has already filtered, for a caller that
  // is going to run this many times over the same patch of world. Without it
  // every call rebuilds the list by walking the entire obstacle pool — which is
  // every obstacle on the map, thousands of them — and a solver sweeping a
  // hundred candidate throws pays for that a hundred times over. That was worth
  // about forty milliseconds a frame.
  function dodgeSimBlast(rec, phys, dur, layer, out, pre, dt) {
    let x = rec.x, y = rec.y, z = rec.z;
    let vx = rec.haveVel ? rec.vx : 0, vy = rec.haveVel ? rec.vy : 0;
    let vz = phys.velZ - PROJ_GRAVITY * rec.age;
    // The projectile's collision radius, which is `def.rad * 0.5` stored and
    // halved again at the collision site.
    const r = phys.rad * 0.25;
    const speed0 = Math.hypot(vx, vy);
    const reach = speed0 * dur + speed0 / PROJ_DRAG + r + 1;
    const obs = pre || dodgeSimObstacles(x, y, reach, layer);
    // `dt` coarsens the integration for a caller that is ranking candidates
    // rather than answering. The step is the whole cost of this loop — every
    // obstacle in range is tested on every one of them — and a search that runs
    // it a hundred times over cannot afford the server's own 100Hz. What a
    // coarser step costs is only the moment of landing, to within half a step;
    // the flight is a straight line at constant speed and the slide's total is
    // `v/drag` whatever the step, so neither of the two things that decide
    // where a grenade ends up is sensitive to it.
    const step = dt || DODGE_SIM_DT;
    const steps = Math.min(Math.ceil(dur / step), DODGE_SIM_MAX_STEPS);
    const h = steps > 0 ? dur / steps : 0;
    const drag = rec.water ? PROJ_DRAG_WATER : PROJ_DRAG;

    // The floor under the grenade, carried across steps exactly as the server
    // carries `obstacleBellowHeight`: it is what posZ is clamped to, and it is
    // also what "on the ground" means for the drag test, so a grenade resting
    // on a crate slows down and a grenade still in the air over one does not.
    //
    // Derived from the state we are handed rather than assumed to be zero. The
    // server keeps it across ticks and we are starting mid-flight, so a grenade
    // already sitting on a table has to be *on* the table from the first step —
    // otherwise it starts the simulation believing it is airborne, skips the
    // drag it should be under, and is dropped to the ground and put back.
    let floor = 0;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (!o.collidable || o.height > z) continue;
      if (o.height > floor && dodgeSimPen(o.collider, x, y, r)) floor = o.height;
    }

    for (let s = 0; s < steps; s++) {
      if (z <= floor) { vx /= 1 + h * drag; vy /= 1 + h * drag; }
      x += vx * h; y += vy * h;
      vz -= PROJ_GRAVITY * h;
      z = Math.min(Math.max(z + vz * h, floor), 5);

      let nextFloor = 0;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        // A bounds reject before the real one. Everything in `obs` is within
        // reach of the *path*, but on any given step the grenade is next to
        // almost none of it, and this is the innermost loop in the mod — every
        // obstacle in range, on every step, of every candidate a solver tries.
        const col = o.collider;
        if (col.type === COLLIDER_AABB) {
          if (x + r < col.min.x || x - r > col.max.x ||
              y + r < col.min.y || y - r > col.max.y) continue;
        } else {
          const ddx = x - col.pos.x, ddy = y - col.pos.y, rr = col.rad + r;
          if (ddx * ddx + ddy * ddy >= rr * rr) continue;
        }
        if (!dodgeSimPen(col, x, y, r)) continue;
        if (o.height > z) {
          if (!o.collidable) continue;
          const nx = dodgeSimHit.nx, ny = dodgeSimHit.ny;
          const push = dodgeSimHit.pen + 0.1;
          x += nx * push; y += ny * push;
          const len = Math.hypot(vx, vy);
          if (len > 1e-6) {
            const dx = vx / len, dy = vy / len;
            const dot = dx * nx + dy * ny;
            const scale = Math.max(1 + dot, 0.15) * len;
            vx = (dx - 2 * dot * nx) * scale;
            vy = (dy - 2 * dot * ny) * scale;
          }
        } else if (o.collidable && o.height > nextFloor) {
          nextFloor = o.height;
        }
      }
      floor = nextFloor;
      if (z < floor) z = floor;

      // Come to rest and the rest of the fuse changes nothing. A frag lands at
      // a second and is done sliding well before its four are up, so without
      // this every candidate throw a solver tries spends more than half its
      // steps re-confirming a grenade that has already stopped. The threshold is
      // a thousandth of a unit per second, which has `v/drag` — four
      // ten-thousandths of a unit — of travel left in it, so the exit is below
      // the resolution of the position it is exiting from and the port stays
      // exact against the server's own loop.
      if (z <= floor && vx * vx + vy * vy < 1e-6) break;
    }
    out.x = x; out.y = y;
  }

  // ---- Throwing it from here ---------------------------------------------
  //
  // Where our own cooked grenade would land if we let go this instant.
  //
  // A port of the server's throwThrowable, which is worth doing exactly rather
  // than approximately because the interesting part is the bit people get wrong
  // by feel: **throw strength is the distance to the mouse cursor**, as a
  // fraction of `throwableMaxMouseDist`, so the cursor is a throttle and not
  // just an aim. Anything past 18 units is full strength and anything nearer is
  // proportionally short. That is the whole reason to draw this — a ring on the
  // ground answers "how hard am I about to throw" in the only terms that matter.
  //
  //   throwStr = clamp(mouseDist, 0, 18) / 18 * speed
  //   spawn    = pos + rotate({0.5,-1.0}, aim), clipped to the first wall
  //   vel      = moveVel * 0.6 + aim * throwStr
  //
  // The rest is the same simulation every other grenade goes through, from a
  // state we construct instead of one the wire delivered.
  const PROJ_MAX_MOUSE_DIST = 18;   // GameConfig.player.throwableMaxMouseDist
  const PROJ_MOUSE_CLAMP = 64;      // net.Constants.MouseMaxDist
  const PROJ_AMPED_RANGE = 1.75;    // PerkProperties.amped_explosives.throwableRangeMult
  const PROJ_AMPED_SPEED = 2;       // ...throwableSpeedMult
  const PROJ_SPAWN_HEIGHT = 0.5;

  // Our own movement, as the server has it. Taken from the packet ring rather
  // than from the movement keys, because it is the velocity the server actually
  // applied and it already carries every reason it might not be 12 — water,
  // being downed, a heavy weapon — none of which the keys know about.
  const dodgeMoveVel = { x: 0, y: 0 };
  function dodgeSelfMoveVel(me) {
    dodgeMoveVel.x = 0; dodgeMoveVel.y = 0;
    if (!netClock.ready) return dodgeMoveVel;
    const tickMs = netClock.slope;
    if (!(tickMs >= NET_MIN_UPDATE_MS && tickMs <= NET_MAX_UPDATE_MS)) return dodgeMoveVel;
    const snaps = me ? netSmoothState.get(me)?.snaps : null;
    if (!snaps || snaps.length < 2) return dodgeMoveVel;
    const p2 = snaps[snaps.length - 1], p1 = snaps[snaps.length - 2];
    const dn = p2.n - p1.n;
    if (dn < 1) return dodgeMoveVel;
    const dt = (tickMs * dn) / 1000;
    const vx = (p2.x - p1.x) / dt, vy = (p2.y - p1.y) / dt;
    if (Math.hypot(vx, vy) > DODGE_SPEED_MAX) return dodgeMoveVel;
    dodgeMoveVel.x = vx; dodgeMoveVel.y = vy;
    return dodgeMoveVel;
  }

  // The throw's own spawn point: a hand's length out along the aim, clipped
  // back to the first wall on the way there, exactly as the server clips it.
  // Standing behind cover and lobbing over it is the case this exists for —
  // without the clip the grenade would be predicted to leave from inside the
  // wall we are hugging.
  const dodgeSpawnOut = { x: 0, y: 0 };

  // The obstacles that can clip a spawn, whatever the aim: the hand is 1.118u
  // out in *some* direction, so one disc around the thrower covers every
  // bearing a solver might try. Built once and swept many times.
  function dodgeSpawnObstacles(px, py, layer, out) {
    out.length = 0;
    const obstacles = getObstacles();
    const reach = PROJ_SPAWN_OFFSET + 0.5;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      // The server's own reject list for the spawn clip: anything dead, passable,
      // on another layer or shorter than the throw height is not in the way.
      if (!o || !o.active || o.dead || !o.collidable || !o.collider) continue;
      if (!sameLayerAs(layer, o.layer)) continue;
      if (!(o.height >= PROJ_SPAWN_HEIGHT)) continue;
      if (!colliderNearSegment(o.collider, px - reach, py - reach, px + reach, py + reach)) continue;
      out.push(o);
    }
    return out;
  }

  function dodgeThrowSpawn(px, py, dx, dy, layer, pre) {
    const a = Math.atan2(dy, dx);
    const hx = px + 0.5 * Math.cos(a) + Math.sin(a);
    const hy = py + 0.5 * Math.sin(a) - Math.cos(a);
    let bestT = 1;
    const obstacles = pre || dodgeSpawnObstacles(px, py, layer, dodgeSpawnScratch);
    const len = Math.hypot(hx - px, hy - py) || 1;
    for (let i = 0; i < obstacles.length; i++) {
      const d = segHitCollider(px, py, hx, hy, obstacles[i].collider);
      if (d === null) continue;
      const t = d / len;
      if (t < bestT) bestT = t;
    }
    dodgeSpawnOut.x = px + (hx - px) * bestT;
    dodgeSpawnOut.y = py + (hy - py) * bestT;
    return dodgeSpawnOut;
  }
  const dodgeSpawnScratch = [];

  // The scratch flight record the preview simulates. Reused rather than
  // allocated per frame, and shaped like the ones snapshotProjectiles builds so
  // dodgeSimBlast cannot tell the difference.
  const dodgeThrowRec = { x: 0, y: 0, z: 0, vx: 0, vy: 0, haveVel: true, age: 0, water: false };
  const dodgeThrowOut = { x: 0, y: 0 };

  // Everything about the thrower that does not change between candidate throws,
  // gathered once so a solver can sweep hundreds of aims without re-reading the
  // world for each of them.
  const dodgeThrowCtx = {
    ok: false, x: 0, y: 0, layer: 0, mvx: 0, mvy: 0,
    maxDist: PROJ_MAX_MOUSE_DIST, speed: 0, left: 0, phys: null,
    // Both obstacle sets, filtered once for the whole context. Every candidate
    // throw starts from the same body and cannot travel further than the
    // strongest one, so one disc covers all of them — which is the difference
    // between one pass over the obstacle pool and one per candidate.
    obs: [], spawnObs: [], water: false,
  };

  function dodgeThrowContext(phys, me, layer, left) {
    const c = dodgeThrowCtx;
    c.ok = false;
    const nd = me?.[PLAYER_NET];
    const pos = getXY(nd?.[PLAYER_POS] ?? me?.[PLAYER_POS] ?? me?.pos);
    if (!pos || !phys) return c;
    const amped = Array.isArray(me?.perkTypes) && me.perkTypes.includes('amped_explosives');
    const mv = dodgeSelfMoveVel(me);
    c.x = pos.x; c.y = pos.y; c.layer = layer;
    c.mvx = mv.x * 0.6; c.mvy = mv.y * 0.6;
    c.maxDist = PROJ_MAX_MOUSE_DIST * (amped ? PROJ_AMPED_RANGE : 1);
    // A pad builds toMouseLen as a fraction of its own range times
    // throwableMaxMouseDist, so 18 units is the whole of the throttle there and
    // amped_explosives' longer one simply cannot be asked for. Solving against
    // a reach we can't request would land every throw short of where it aimed.
    if (touchActive()) c.maxDist = Math.min(c.maxDist, PROJ_MAX_MOUSE_DIST);
    c.speed = phys.speed * (amped ? PROJ_AMPED_SPEED : 1);
    c.left = left; c.phys = phys;
    // Furthest anything thrown from here can get: the strongest throw's flight
    // plus the whole of its slide, plus our own motion folded in.
    const vMax = c.speed + Math.hypot(c.mvx, c.mvy);
    const reach = vMax * Math.min(left, 1.1) + vMax / PROJ_DRAG + 2;
    dodgeSimObstacles(pos.x, pos.y, reach, layer);
    c.obs = dodgeSimObs.slice();
    dodgeSpawnObstacles(pos.x, pos.y, layer, c.spawnObs);
    // Sampled once too: the spawn moves by at most a hand's length between
    // candidates, which is not far enough to leave a river.
    c.water = dodgeProjInWater(pos, layer);
    c.ok = true;
    return c;
  }

  // Where a throw aimed (dx, dy) with the cursor `mouseLen` out would put the
  // grenade at detonation. The server's arithmetic, and then the same
  // simulation every other grenade goes through.
  function dodgeThrowLand(c, dx, dy, mouseLen, out, dt) {
    const mult = Math.min(Math.max(mouseLen, 0), c.maxDist) / c.maxDist;
    const throwStr = mult * c.speed;
    const spawn = dodgeThrowSpawn(c.x, c.y, dx, dy, c.layer, c.spawnObs);
    const rec = dodgeThrowRec;
    rec.x = spawn.x; rec.y = spawn.y; rec.z = PROJ_SPAWN_HEIGHT;
    rec.vx = c.mvx + dx * throwStr;
    rec.vy = c.mvy + dy * throwStr;
    rec.age = 0;
    rec.water = c.water;
    dodgeSimBlast(rec, c.phys, c.left, c.layer, dodgeSimOut, c.obs, dt);
    out.x = dodgeSimOut.x; out.y = dodgeSimOut.y;
  }

  // The cursor as it is right now, in world units from the player: a direction
  // and a length, where the length is the throw's own throttle.
  const dodgeCursorOut = { dx: 1, dy: 0, len: 0, ok: false };
  function dodgeCursorAim(me) {
    const o = dodgeCursorOut;
    o.ok = false;
    if (touchActive()) {
      // The pad is the cursor: its bearing is the throw's direction and its
      // pull is the throttle, read back out the same way the input message
      // puts it in.
      const len = Math.hypot(touchState.aimDx, touchState.aimDy);
      if (!(len > 1e-6)) return o;
      o.dx = touchState.aimDx / len;
      o.dy = touchState.aimDy / len;
      const f = Math.min(Math.max(touchState.aimLen / touchPadRange(touchState.target), 0), 1);
      o.len = f * PROJ_MAX_MOUSE_DIST;
      o.ok = true;
      return o;
    }
    const scale = getLivePxPerWorldUnit(pageSamples[pageSamples.length - 1]);
    if (realMouse.hasMoved && scale > 0) {
      let dx = (realMouse.x - window.innerWidth / 2) / scale;
      let dy = -(realMouse.y - window.innerHeight / 2) / scale;
      const len = Math.hypot(dx, dy);
      if (len > 1e-5) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
      o.dx = dx; o.dy = dy; o.len = Math.min(len, PROJ_MOUSE_CLAMP); o.ok = true;
      return o;
    }
    // No cursor yet: fall back to the aim the wire carries, at full strength.
    const nd = me?.[PLAYER_NET];
    const aim = getXY(nd?.[PLAYER_DIR] ?? me?.[PLAYER_DIR] ?? me?.dir);
    if (!aim) return o;
    const alen = Math.hypot(aim.x, aim.y);
    if (!(alen > 1e-6)) return o;
    o.dx = aim.x / alen; o.dy = aim.y / alen; o.len = PROJ_MAX_MOUSE_DIST; o.ok = true;
    return o;
  }

  function dodgeThrowPreview(phys, me, layer, left, out) {
    // Frag aim is driving: the ring has to show the throw that is actually
    // going to happen, not the one the user's suppressed cursor points at. It
    // has already solved this frame, so the answer is there for the taking and
    // costs no second simulation.
    if (fragState.driving && fragState.haveLand) {
      out.x = fragState.landX; out.y = fragState.landY;
      return true;
    }
    const c = dodgeThrowContext(phys, me, layer, left);
    if (!c.ok) return false;
    // The live cursor rather than the aim the last packet carried: the question
    // is what happens if we let go *now*, and the cursor is ahead of the wire
    // by a round trip.
    const aim = dodgeCursorAim(me);
    if (!aim.ok) return false;
    dodgeThrowLand(c, aim.dx, aim.dy, aim.len, out);
    return true;
  }

  // ---- Solving the throw --------------------------------------------------
  //
  // Which cursor lands the grenade nearest a given point.
  //
  // Two variables — the bearing and the cursor's distance from us — and the
  // second one is the throw's strength, so this is genuinely a two-dimensional
  // aim rather than a direction with a range that takes care of itself. It is
  // solved by search rather than by inversion because the forward map is not
  // invertible in closed form the moment a wall is involved: a throw that
  // clears a crate and one that bounces off it differ by a degree and land
  // twenty units apart.
  //
  // The search is seeded analytically so it stays small. With nothing in the
  // way a standing throw covers `speed * (tAir + 1/drag)` — the flight plus the
  // whole of the slide, which telescopes to exactly `v/drag` — so the strength
  // that reaches a given distance is one division away. That seed is usually
  // the answer; the sweep around it is what copes with the bounce, the
  // thrower's own motion folded into the velocity, and a fuse too short to let
  // the grenade finish sliding.
  const FRAG_SOLVE_ANGLE = 0.28;    // radians swept either side of the bearing
  const FRAG_SOLVE_ANGLES = 7;      // samples across that sweep, per pass
  const FRAG_SOLVE_STEPS = 5;       // strength samples per pass
  const FRAG_SOLVE_PASSES = 3;      // coarse, then two refinements
  // A warm sweep already starts on the answer, so it needs neither the width
  // nor the passes.
  const FRAG_WARM_ANGLES = 5;
  const FRAG_WARM_STEPS = 5;
  const FRAG_WARM_PASSES = 2;
  // Integration step while ranking candidates, against DODGE_SIM_DT for the
  // one that wins. Ranking only has to order throws, and half a coarse step of
  // slop in the landing moment does not reorder anything; the answer that comes
  // back is then re-simulated at the server's own resolution, so what the
  // caller is handed is exact even though what got it there was not.
  const FRAG_COARSE_DT = 0.03;
  // The warm sweep, for a target we already solved against last frame. Wide
  // enough to track a strafing player across a frame and to walk out of a seed
  // the geometry has since invalidated, narrow enough that the same three
  // passes land an order of magnitude finer.
  const FRAG_SOLVE_WARM_ANGLE = 0.05;
  const FRAG_SOLVE_WARM_LEN = 0.06;
  // How near a warm solve has to land before it is trusted without a cold
  // second opinion. Well above the search's own resolution (hundredths) and
  // well below anything that would change which side of a target a grenade
  // lands on.
  const FRAG_SOLVE_WARM_OK = 0.5;
  const fragSolveOut = { dx: 1, dy: 0, len: 0, x: 0, y: 0, err: Infinity };
  const fragLandOut = { x: 0, y: 0 };
  const fragKeep = { dx: 1, dy: 0, len: 0, x: 0, y: 0, err: Infinity };

  // How far a standing throw at `throwStr` gets before the fuse runs out. The
  // closed form from the simulation's own two phases: constant speed while
  // airborne, then an exponential slide whose total is `v/drag`.
  function fragReachFor(c, throwStr) {
    const g = PROJ_GRAVITY;
    const vz = c.phys.velZ;
    const tAir = (vz + Math.sqrt(vz * vz + 2 * g * PROJ_SPAWN_HEIGHT)) / g;
    if (c.left <= tAir) return throwStr * c.left;
    const k = Math.log(1 + DODGE_SIM_DT * PROJ_DRAG) / DODGE_SIM_DT;
    return throwStr * tAir + (throwStr / k) * (1 - Math.exp(-k * (c.left - tAir)));
  }

  // `warm` is last frame's answer for the same target, when there was one.
  // Driving the cursor every frame means the previous solve is nearly this one,
  // so the sweep can open an order of magnitude narrower and still converge —
  // and the cold path is kept intact underneath it for the frame a target first
  // appears, changes, or the last solve failed to land anywhere near.
  function fragSolve(c, tx, ty, warm) {
    if (!warm) return fragSweep(c, tx, ty, null);
    const w = fragSweep(c, tx, ty, warm);
    if (w.err <= FRAG_SOLVE_WARM_OK) return w;
    // The warm sweep is narrow enough to be outrun. A target three units away
    // while we strafe past it moves the bearing further in one frame than the
    // window is wide, and a seed that cannot see the answer any more will sit
    // where it is and report a large error rather than go looking. So a warm
    // solve that did not converge is redone cold, and the better of the two
    // kept — which also covers the case where neither converges because the
    // target is simply out of reach, and the warm answer was the good one.
    fragKeep.dx = w.dx; fragKeep.dy = w.dy; fragKeep.len = w.len;
    fragKeep.x = w.x; fragKeep.y = w.y; fragKeep.err = w.err;
    const cold = fragSweep(c, tx, ty, null);
    if (fragKeep.err < cold.err) {
      cold.dx = fragKeep.dx; cold.dy = fragKeep.dy; cold.len = fragKeep.len;
      cold.x = fragKeep.x; cold.y = fragKeep.y; cold.err = fragKeep.err;
    }
    return cold;
  }

  function fragSweep(c, tx, ty, warm) {
    const out = fragSolveOut;
    out.err = Infinity;

    const dist = Math.hypot(tx - c.x, ty - c.y);
    let bearing, seedLen, halfLen, halfAng;
    if (warm) {
      bearing = warm.bearing;
      seedLen = warm.len;
      halfAng = FRAG_SOLVE_WARM_ANGLE;
      halfLen = c.maxDist * FRAG_SOLVE_WARM_LEN;
    } else {
      bearing = Math.atan2(ty - c.y, tx - c.x);
      // Invert the closed form for the seed strength, then turn it back into a
      // cursor distance — `mouseLen / maxDist` is the multiplier the server
      // scales the throw by, so the two are the same number in different units.
      const unit = Math.max(fragReachFor(c, 1), 1e-6);
      seedLen = Math.min((dist / unit) / c.speed * c.maxDist, c.maxDist);
      halfLen = c.maxDist * 0.5;
      halfAng = FRAG_SOLVE_ANGLE;
    }

    const nA = warm ? FRAG_WARM_ANGLES : FRAG_SOLVE_ANGLES;
    const nL = warm ? FRAG_WARM_STEPS : FRAG_SOLVE_STEPS;
    const passes = warm ? FRAG_WARM_PASSES : FRAG_SOLVE_PASSES;

    for (let pass = 0; pass < passes; pass++) {
      let bestA = bearing, bestL = seedLen, bestErr = Infinity;
      for (let i = 0; i < nA; i++) {
        const a = bearing + (nA === 1 ? 0 : halfAng * (2 * i / (nA - 1) - 1));
        const dx = Math.cos(a), dy = Math.sin(a);
        for (let j = 0; j < nL; j++) {
          const len = Math.min(Math.max(seedLen + halfLen *
            (2 * j / (nL - 1) - 1), 0), c.maxDist);
          dodgeThrowLand(c, dx, dy, len, fragLandOut, FRAG_COARSE_DT);
          const err = Math.hypot(fragLandOut.x - tx, fragLandOut.y - ty);
          if (err < bestErr) { bestErr = err; bestA = a; bestL = len; }
        }
      }
      bearing = bestA; seedLen = bestL;
      // Narrow around the winner. Not a bisection — the space has bounces in it
      // and is not unimodal — just a smaller net cast where the coarse one
      // found something.
      halfAng /= nA - 1;
      halfLen /= nL - 1;
    }

    // The winner, re-thrown at the server's own resolution. Everything above
    // was ranking; this is the answer, and it is the only landing point that
    // leaves this function.
    out.dx = Math.cos(bearing); out.dy = Math.sin(bearing); out.len = seedLen;
    dodgeThrowLand(c, out.dx, out.dy, seedLen, fragLandOut);
    out.x = fragLandOut.x; out.y = fragLandOut.y;
    out.err = Math.hypot(out.x - tx, out.y - ty);
    return out;
  }

  // Every grenade whose blast could reach anywhere we might stand, as one
  // threat apiece.
  //
  // The detonation time is the fuse the flight record carries, less the ping
  // lead, because plan-time zero is the moment our input reaches the server and
  // not the frame we are looking at — the same anchor every other threat is
  // placed against.
  //
  // A fuse that outlasts the horizon is not a reason to ignore the grenade. The
  // planner cannot see past its own horizon, so a frag with three seconds left
  // would be invisible until the last 0.8s of it — by which point the blast is
  // 12u across and a player covers 9.6u, and there is no escape left to plan.
  // So it detonates at the end of the horizon instead, wherever the simulation
  // has it by then, and the plan is scored against that. It is the right shape
  // of wrong: the grenade really is going to go off there, the time discount
  // already prices the far end of the horizon at a quarter of its face value,
  // and every step re-runs this with a fuse that is one tick shorter.
  function dodgeAddBlasts(out, selfId, selfInfo, roster, layer, leadS,
                          px, py, speed, horizon) {
    // Cleared before the knob is read, not after: turning the term off has to
    // leave the key empty rather than frozen at whatever the last grenade
    // hashed to, or the freshness test would keep rejecting plans over a set
    // that is no longer being built.
    dodgeState.blastKey = 0;
    const k = dodgeClamp(DODGE.blast, 0, 1, 1);
    if (!(k > 0)) return out;
    const list = getProjectiles();
    const slack = dodgeClamp(DODGE.clearance, 0.05, 1.5, 0.35);

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !p.active) continue;
      const phys = THROWABLE_PHYS[p.type];
      if (!phys || phys.impact) continue;      // no fuse to date, or none we can
      const def = BLAST_DEFS[phys.blast];
      if (!def || !(def[0] > 0)) continue;     // smoke, and anything harmless
      const rec = dodgeProj.get(Number(p.__id ?? 0));
      if (!rec) continue;                      // seen this frame but not yet on a packet

      // The blast only touches what shares its layer, exactly as the game's own
      // explosion does. A grenade one floor away is not our problem.
      if (!sameLayerAs(layer, p.layer)) continue;

      // A squadmate's grenade cannot damage us at all. Our own can, in full —
      // the game skips the friendly-fire test when the source is the victim —
      // so `thrower === selfId` is deliberately not an exclusion here, unlike
      // the bullet path where our own rounds are dropped.
      //
      // `throwerSure` gates the drop and nothing else, because the two ways of
      // being wrong are not the same size. Calling an enemy frag a squadmate's
      // and ignoring it costs 125HP; calling a squadmate's an enemy's costs a
      // few hundred milliseconds of walking somewhere we did not need to go. So
      // only the throw animation naming someone is allowed to make a grenade
      // harmless — a guess from proximity is not, and reads as hostile like any
      // other unowned grenade.
      if (rec.thrower && rec.throwerSure && rec.thrower !== selfId && roster &&
          !isHostileTo(selfInfo, dodgePlayerInfo(roster, rec.thrower))) continue;

      // Where the fuse stands at plan-time zero. A cook we measured is exact; an
      // unmeasured one reads as "nobody cooked it", which is the longest fuse
      // the grenade can have — and the horizon clamp below is what stops that
      // assumption turning into a grenade the planner ignores.
      //
      // Three clocks meet here and all three are needed. The flight record is
      // as of the last packet; our press lands one ping lead past now; and the
      // plan is scored from there. So the fuse is measured forward from the
      // packet, and the simulation is run over the whole of it.
      const sinceSnap = Math.max(0, (Date.now() - rec.at) / 1000);
      let tBoom = rec.boomT - sinceSnap - leadS;
      if (!(tBoom > 0)) tBoom = 0;

      // One place, whatever the horizon does to the clock.
      //
      // A fuse the plan cannot see the end of is still charged — at the end of
      // the plan — but it is charged *where the grenade actually goes off*, not
      // where it happens to be when the horizon runs out. That is the better of
      // the two fictions, and it used to be the worse one: a grenade sailing
      // over our heads on its way to landing twenty units away was scored as
      // detonating overhead, which is the one thing it is certainly not going
      // to do. The time is a guess the horizon forces on us; the place is not,
      // so it should not be guessed as well.
      //
      // Which also means the second simulation this used to run is gone. The
      // blast point is solved once for the whole life of the grenade — see
      // dodgeProjBoom — and only the line of sight is still per packet, because
      // our own position moves and the blast's does not.
      const bx = rec.boomX, by = rec.boomY;
      if (tBoom > horizon) tBoom = horizon - 1e-4;
      const pkt = netStats.updates;
      if (rec.simN !== pkt) {
        rec.simN = pkt;
        rec.simClear = blastLineClear(bx, by, px, py, layer);
      }

      // Nothing we could reach is inside the blast, so no plan can be touched
      // by it. The same filter the rounds get, with one difference that matters:
      // a round is solved against everywhere we could stand before the *plan*
      // ends, but a grenade only gives us until it goes off. A frag detonating
      // in 0.2s is answered from a 2.4u circle, not a 9.6u one, and using the
      // horizon there would have the bot take the keys for every grenade
      // within 22u of it — which in a building is most of them.
      const reachable = speed * Math.min(tBoom, horizon);
      if (Math.hypot(bx - px, by - py) > def[2] + reachable + slack) continue;

      const dmg = def[0];
      out.push({
        x: bx, y: by, wx: 0, wy: 0, tMax: horizon, R: 0,
        due: tBoom, dmg, w: k * dmg / DODGE_DMG_REF, type: p.type, phantom: false,
        // What separates a blast from a round, and the only branch the sweeps
        // take on it. `rMin`/`rMax` are the falloff's own two radii, and
        // `tBoom` the single instant any of it applies at.
        blast: 1, tBoom, rMin: def[1], rMax: def[2],
        // Cover. `layer` is the layer the occlusion rays are cast on, `clear`
        // is whether the blast can see where we stand right now, and `vis` is
        // the slot dodgeDpVisible memoizes per-cell answers in — assigned by
        // dodgeDpPlan, since it is the search's grid the cells belong to.
        //
        // A blast the wall already blocks is deliberately still a threat. It
        // costs nothing anywhere the wall covers, which is the point: the wall
        // is a gradient the planner can climb rather than a reason to stop
        // looking. Dropping it here — which is what this did before per-cell
        // visibility existed — meant the bot could not be pulled out of cover
        // but could not be held in it either.
        layer: p.layer, clear: rec.simClear, vis: -1,
      });
      dodgeState.blastKey = (Math.imul(dodgeState.blastKey, 31) + rec.id) | 0;
    }
    return out;
  }

  // ---- The grenade nobody has thrown -------------------------------------
  //
  // Everything above starts at the moment a projectile exists, and for a
  // grenade that is late in a way it is not for a bullet. A frag spends up to
  // four seconds in a hand before it spends any time in the air, and that is
  // the part of its life we can see coming: the pin is out, the fuse is
  // running, and the clock is on the wire as an animation.
  //
  // Not counting it does not merely lose the warning. It makes the fuse we do
  // eventually report *wrong in the dangerous direction* for the throw that
  // matters most — the one cooked to detonate on arrival. Held for three
  // seconds and thrown, that grenade goes off about where it lands, and the
  // planner meets it with under a second of fuse left on a threat it has never
  // seen before.
  //
  // So a player currently cooking contributes one blast at their own feet, at
  // the moment their fuse runs out. That is the assumption to make: if they
  // never throw it, that is exactly what happens, and if they do throw it, they
  // throw it somewhere we cannot know — towards us, which is worse, or away,
  // which is better. Their own position is the neutral reading and the only one
  // that does not require guessing at intent.
  //
  // Which is why it is priced as a phantom. Like the round nobody has fired, it
  // is a real cost in the loss and deliberately not an event in the readouts,
  // and DODGE.phantom is the probability half of the expectation — what the
  // planner thinks the chance is that this becomes a blast we are near. At 0 it
  // does not run at all, which is the same switch that turns firing lines off.
  function dodgeAddCookedNades(out, game, selfId, selfInfo, roster, layer, leadS,
                               px, py, speed, horizon) {
    const k = dodgeClamp(DODGE.blast, 0, 1, 1) * dodgeClamp(DODGE.phantom, 0, 1, 0.35);
    if (!(k > 0)) return out;
    const pool = (findRosterOnGame(game) || game?.[GAME_ROSTER])?.playerPool;
    if (!pool || typeof pool[POOL_GETALL] !== 'function') return out;
    const players = pool[POOL_GETALL]() || [];
    const n = netClock.n - 1;
    const slack = dodgeClamp(DODGE.clearance, 0.05, 1.5, 0.35);

    for (const p of players) {
      if (!p || !p.active || p[PLAYER_NET]?.[NET_DEAD]) continue;
      const id = Number(p.__id ?? 0);
      if (!id) continue;
      const st = dodgeCook.get(id);
      const phys = dodgeCookPhys(st, n);
      if (!phys) continue;
      const def = BLAST_DEFS[phys.blast];
      if (!def || !(def[0] > 0)) continue;
      if (!sameLayerAs(layer, p.layer)) continue;
      // Our own cook is not a threat to plan against: we decide when it leaves
      // our hand, and the projectile it becomes is picked up by dodgeAddBlasts
      // like anyone else's. Squadmates cannot hurt us at all.
      if (id === selfId) continue;
      if (roster && !isHostileTo(selfInfo, dodgePlayerInfo(roster, id))) continue;

      const pos = getXY(p[PLAYER_NET]?.[PLAYER_POS] ?? p[PLAYER_POS] ?? p.pos);
      if (!pos) continue;

      // The one number this term exists for. An unwatched cook is not counted
      // at all rather than counted from when we noticed — see trackCookAnims —
      // so this is either a measurement or the player is not here.
      let tBoom = phys.fuse - dodgeCookElapsed(st, n) - leadS;
      if (!(tBoom > 0)) tBoom = 0;
      if (tBoom > horizon) tBoom = horizon - 1e-4;

      const reachable = speed * Math.min(tBoom, horizon);
      if (Math.hypot(pos.x - px, pos.y - py) > def[2] + reachable + slack) continue;

      // Cover, cached per packet like the thrown grenades' is. Neither end of
      // this ray moves between packets and the sweep walks every obstacle on
      // the map, so recomputing it on every step — up to 60Hz against packets
      // arriving at 20 — was two thirds waste.
      const pkt = netStats.updates;
      if (st.losN !== pkt) {
        st.losN = pkt;
        st.los = blastLineClear(pos.x, pos.y, px, py, layer);
      }

      const dmg = def[0];
      out.push({
        x: pos.x, y: pos.y, wx: 0, wy: 0, tMax: horizon, R: 0,
        due: tBoom, dmg, w: k * dmg / DODGE_DMG_REF, type: st.weap, phantom: true,
        blast: 1, tBoom, rMin: def[1], rMax: def[2],
        layer: p.layer, clear: st.los, vis: -1,
      });
      // Folded into the same key as the thrown ones: a cook starting or ending
      // changes what the planner is solving against just as much as a grenade
      // appearing does.
      dodgeState.blastKey = (Math.imul(dodgeState.blastKey, 31) + id) | 0;
    }
    return out;
  }

  // Earliest time in [0, tMax] at which a threat starting at (x,y) and
  // travelling at (wx,wy) comes within `R` of the fixed point (px,py); -1 if it
  // never does. The same quadratic dodgeSweep solves, run against a stationary
  // us with `R` inflated by everywhere we could move to — which makes a pass
  // conservative: anything it rejects is unreachable by every plan.
  function dodgeReachTime(x, y, wx, wy, tMax, px, py, R) {
    const qx = x - px, qy = y - py;
    const c = qx * qx + qy * qy - R * R;
    if (c <= 0) return 0;
    const a = wx * wx + wy * wy;
    if (!(a > 1e-9)) return -1;
    const b = qx * wx + qy * wy;
    if (b >= 0) return -1;
    const disc = b * b - a * c;
    if (disc < 0) return -1;
    const t = (-b - Math.sqrt(disc)) / a;
    return t <= tMax ? Math.max(t, 0) : -1;
  }

  // ---- The collision primitive ------------------------------------------
  //
  // Earliest touch between a disc of radius `th.R` centred on (px,py) moving
  // at (vx,vy) and threat `th`, over the leg [t0, t0+dur] of the plan. Both
  // bodies are on constant velocities for the whole leg, so this is one
  // quadratic and no iteration:
  //     |q + u*t| = R,  q = bullet - us,  u = bullet velocity - ours
  // Writes into the caller's `hitAt` rather than returning, so a rollout's legs
  // accumulate into one answer per threat — and so a partial rollout can be
  // snapshotted and resumed, which is what lets the shared latency prefix be
  // computed once instead of once per rollout. A clean miss writes nothing:
  // near misses are not graded, so the closest approach is not worth finding.
  function dodgeSweep(i, px, py, vx, vy, th, t0, dur, hitAt) {
    // A blast is an instant, not an interval: the leg containing it either has
    // us inside the radius at that moment or it does not. `hitAt` is the
    // readout's question — when are we hit — so the bar is the game's own
    // hitbox, which for an explosion is rad.max and nothing graded.
    if (th.blast) {
      const t = th.tBoom;
      if (t < t0 || t >= t0 + dur) return;
      const dt = t - t0;
      const dx = px + vx * dt - th.x, dy = py + vy * dt - th.y;
      // `clear` rather than dodgeDpVisible: this rollout runs before the search
      // does, so the grid the per-cell answers are indexed against has not been
      // published for this plan yet. It only feeds `userHitIn`, which is a HUD
      // readout, and the single-point answer is what that readout wants anyway.
      if (th.clear && Math.hypot(dx, dy) < th.rMax && t < hitAt[i]) hitAt[i] = t;
      return;
    }
    const span = Math.min(dur, th.tMax - t0);
    if (!(span > 0)) return;
    const qx = th.x + th.wx * t0 - px;
    const qy = th.y + th.wy * t0 - py;
    const R = th.R;
    const c = qx * qx + qy * qy - R * R;
    if (c <= 0) {                       // already overlapping at the leg's start
      if (t0 < hitAt[i]) hitAt[i] = t0;
      return;
    }
    const ux = th.wx - vx;
    const uy = th.wy - vy;
    const a = ux * ux + uy * uy;
    if (!(a > 1e-9)) return;            // no relative motion, and clear: never touches
    const b = qx * ux + qy * uy;
    if (b >= 0) return;                 // separating for the whole leg
    const disc = b * b - a * c;
    if (disc < 0) return;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t >= 0 && t <= span && t0 + t < hitAt[i]) hitAt[i] = t0 + t;
  }

  // ---- Walls -------------------------------------------------------------
  //
  // Movement blockers near us, inflated by our own radius so the planner can
  // then treat itself as a point. Inflating an AABB squares off its corners,
  // which is conservative — it keeps us slightly further from a corner than
  // the game would — and erring toward clearance is the right side to err on
  // for something whose whole job is not being touched.
  function dodgeBuildWalls(x, y, reach, layer, selfR) {
    const out = dodgeState.walls;
    out.length = 0;
    const pad = selfR;
    const obstacles = getObstacles();
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      // Movement collision, not bullet collision: a window stops us and not a
      // bullet, a bush stops neither, so this is `collidable` and nothing else.
      if (!o || !o.active || o.dead || !o.collidable) continue;
      if (!sameLayerAs(layer, o.layer)) continue;
      const c = o.collider;
      if (!c) continue;
      if (c.type === COLLIDER_AABB) {
        if (!c.min || !c.max) continue;
        if (c.max.x + pad < x - reach || c.min.x - pad > x + reach) continue;
        if (c.max.y + pad < y - reach || c.min.y - pad > y + reach) continue;
        out.push({ box: true, minX: c.min.x - pad, minY: c.min.y - pad,
                   maxX: c.max.x + pad, maxY: c.max.y + pad });
      } else if (c.type === COLLIDER_CIRCLE) {
        if (!c.pos) continue;
        const r = c.rad + pad;
        if (Math.hypot(c.pos.x - x, c.pos.y - y) > reach + r) continue;
        out.push({ box: false, x: c.pos.x, y: c.pos.y, rad: r });
      }
    }
    return out;
  }

  // ---- Depenetration -----------------------------------------------------
  //
  // Walls arrive from dodgeBuildWalls already inflated by our own radius, so
  // everything here is a POINT against a solid shape and both algorithms stay
  // in their simplest form. Overlap is resolved by the minimum translation:
  // find the shortest way out and take it.
  //
  // Why push out rather than refuse the step. A refusal has to answer "does
  // this move enter the wall", which along a heading that grazes a face is a
  // question about the step size and not about the world — and answering it
  // wrong in the safe direction pins us against the wall, which is the single
  // worst place to be while a round is in the air. Resolving the overlap
  // instead makes the wall-ward component of a heading die and the tangential
  // component survive, which is sliding, and it falls straight out of the
  // geometry rather than being a case anyone has to write.
  //
  // It also gives the grid snap somewhere to land. dodgeDpPlan rounds every
  // node to a cell centre and that rounding is not obstacle-aware, so a node
  // can be quantised up to half a cell inside a wall. Under the old march that
  // was survivable but permanent — depth-relative stepping let us leave, but
  // nothing ever pulled us back out. Here the next sub-step ejects it.
  const dodgeDepenOut = { x: 0, y: 0 };

  // Circle: the normal is radial, and the exit distance is whatever is left of
  // the radius. Dead centre has no defined normal — it happens when a snap
  // lands exactly on a barrel's axis — so the caller's fallback (the reverse of
  // our heading) decides, which backs us out the way we came in.
  function dodgeDepenCircle(x, y, w, fx, fy) {
    const dx = x - w.x, dy = y - w.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= w.rad * w.rad) return false;
    const d = Math.sqrt(d2);
    if (d > 1e-9) {
      const inv = (w.rad - d + DODGE_DEPEN_EPS) / d;
      dodgeDepenOut.x = x + dx * inv;
      dodgeDepenOut.y = y + dy * inv;
    } else {
      const push = w.rad + DODGE_DEPEN_EPS;
      dodgeDepenOut.x = x + fx * push;
      dodgeDepenOut.y = y + fy * push;
    }
    return true;
  }

  // Rectangle: the four face distances are the four candidate exits, and the
  // smallest is the minimum translation. Axis-aligned throughout — `ori` is a
  // quarter-turn count, so a rotated AABB is still an AABB (see the collider
  // notes above) — which is what keeps this to four subtractions and a min.
  //
  // Corners are square rather than rounded, because dodgeBuildWalls inflates
  // the box rather than taking a true Minkowski sum. That over-inflates a
  // corner by up to (sqrt2 - 1) * selfR diagonally, keeping us slightly further
  // off it than the game would. Erring toward clearance is the right side for
  // something whose whole job is not being touched, and it is the behaviour the
  // distance march had too.
  function dodgeDepenBox(x, y, w) {
    const dl = x - w.minX;  if (dl <= 0) return false;
    const dr = w.maxX - x;  if (dr <= 0) return false;
    const db = y - w.minY;  if (db <= 0) return false;
    const dt = w.maxY - y;  if (dt <= 0) return false;
    let best = dl, ax = -1, ay = 0;
    if (dr < best) { best = dr; ax = 1;  ay = 0; }
    if (db < best) { best = db; ax = 0;  ay = -1; }
    if (dt < best) { best = dt; ax = 0;  ay = 1; }
    const push = best + DODGE_DEPEN_EPS;
    dodgeDepenOut.x = x + ax * push;
    dodgeDepenOut.y = y + ay * push;
    return true;
  }

  // Resolve every overlap at (x, y), leaving the result in dodgeDepenOut.
  // `fx, fy` is the fallback normal for the degenerate circle case and should
  // be the reverse of the heading.
  //
  // Three outcomes, because the caller has to treat the third differently:
  //
  //   CLEAR     nothing overlapped; the point is untouched.
  //   RESOLVED  overlapped, and a later pass confirmed the result is clear.
  //   STUCK     passes ran out with an overlap still live.
  //
  // STUCK is not a tuning failure and more passes will not fix it — per-shape
  // MTV can genuinely cycle. Two boxes overlapping in a narrow strip, with the
  // point inside the strip, have each shape preferring to eject along the strip
  // while the union's only real exit is across it: box A pushes right, box B
  // pushes it straight back left, forever. Detecting that and telling the
  // caller is the honest answer; dodgeSubstep then refuses the step, which
  // leaves us at the last position known to be clear.
  //
  // Keeping that invariant — every position the planner reports is outside
  // everything — is what stops the cycle being reachable in the first place.
  // Overlaps only ever arrive from one sub-step of travel or half a cell of
  // snap, so they are shallow, and shallow overlaps resolve on the first pass.
  const DODGE_DEPEN_CLEAR = 0;
  const DODGE_DEPEN_RESOLVED = 1;
  const DODGE_DEPEN_STUCK = 2;

  function dodgeDepenetrate(x, y, walls, fx, fy) {
    const n = walls.length;
    let moved = false;
    for (let pass = 0; pass < DODGE_DEPEN_PASSES; pass++) {
      let hit = false;
      for (let i = 0; i < n; i++) {
        const w = walls[i];
        if (w.box ? dodgeDepenBox(x, y, w) : dodgeDepenCircle(x, y, w, fx, fy)) {
          x = dodgeDepenOut.x; y = dodgeDepenOut.y;
          hit = true; moved = true;
        }
      }
      // A pass that finds nothing is the confirmation that we are out; without
      // one we only know the last push happened, not that it worked.
      if (!hit) {
        dodgeDepenOut.x = x; dodgeDepenOut.y = y;
        return moved ? DODGE_DEPEN_RESOLVED : DODGE_DEPEN_CLEAR;
      }
    }
    dodgeDepenOut.x = x; dodgeDepenOut.y = y;
    return DODGE_DEPEN_STUCK;
  }

  // One sub-step of travel: advance, then resolve. Refuses the step outright
  // when the overlap will not resolve, leaving us where we were.
  //
  // Every integration site goes through this — dodgeMove, dodgeAdvance and
  // dodgeDpEdge — and that is load-bearing rather than tidiness. dodgeDpEdge
  // re-walks the path that dodgeMove already measured, and the DP transition
  // uses dodgeMove's endpoint while the threat sweep uses dodgeDpEdge's
  // polyline. If the two integrations disagreed by so much as one refused
  // sub-step, the planner would be scoring a path that does not end where it
  // believes it ends.
  const dodgeStepOut = { x: 0, y: 0, bent: false };

  function dodgeSubstep(x, y, sx, sy, walls, fx, fy, out) {
    const cx = x + sx, cy = y + sy;
    const st = dodgeDepenetrate(cx, cy, walls, fx, fy);
    if (st === DODGE_DEPEN_CLEAR) {
      out.x = cx; out.y = cy; out.bent = false;
    } else if (st === DODGE_DEPEN_STUCK) {
      out.x = x; out.y = y; out.bent = true;      // refused
    } else {
      out.x = dodgeDepenOut.x; out.y = dodgeDepenOut.y; out.bent = true;
    }
  }

  // ---- Movement ----------------------------------------------------------
  //
  // Integrate one leg at DODGE_SUBSTEP_S, depenetrating after each sub-step.
  // Leaves the endpoint in `out` along with `bent` — whether any push actually
  // fired. `bent` is the whole reason this reports more than a position: an
  // unbent leg is a straight line at full speed, which lets the threat sweep
  // stay a single closed-form solve, and only a bent one has to be followed
  // segment by segment. See dodgeDpEdge.
  const dodgeMoveOut = { x: 0, y: 0, bent: false };

  function dodgeMove(x, y, dx, dy, speed, dur, walls, out) {
    out.bent = false;
    if (!(dur > 0)) { out.x = x; out.y = y; return out; }
    const still = dx === 0 && dy === 0;
    if (!walls.length) {
      out.x = x + dx * speed * dur;
      out.y = y + dy * speed * dur;
      return out;
    }
    // Standing still cannot enter anything new, so one resolve settles it —
    // and it does still need one, because the snap may have put us inside.
    if (still) {
      if (dodgeDepenetrate(x, y, walls, 0, 0) !== DODGE_DEPEN_CLEAR) {
        x = dodgeDepenOut.x; y = dodgeDepenOut.y; out.bent = true;
      }
      out.x = x; out.y = y;
      return out;
    }
    let steps = Math.ceil(dur / DODGE_SUBSTEP_S);
    if (steps > DODGE_SUBSTEP_MAX) steps = DODGE_SUBSTEP_MAX;
    const h = dur / steps;
    const sx = dx * speed * h, sy = dy * speed * h;
    for (let s = 0; s < steps; s++) {
      dodgeSubstep(x, y, sx, sy, walls, -dx, -dy, dodgeStepOut);
      x = dodgeStepOut.x; y = dodgeStepOut.y;
      if (dodgeStepOut.bent) out.bent = true;
    }
    out.x = x; out.y = y;
    return out;
  }

  // ---- Rolling a course forward ------------------------------------------
  //
  // A course is a sequence of (heading, duration) legs. Each leg is clipped at
  // the first wall and split in two — the part actually spent moving and the
  // part spent standing where it stopped — so a heading that runs out of room
  // is swept against where it really ends up rather than where it intended.
  // Being pinned costs nothing by itself; it only matters through the rounds
  // that then reach us.
  //
  // Legs are advanced through a context object rather than run as one closed
  // function, because within a frame most of the work is shared: every rollout
  // starts from the same latency prefix (see dodgeStep), so advancing a context
  // once and copying it pays for that prefix once instead of once per rollout.
  // The context carries the per-threat minima with it, so a copy resumes
  // exactly where the original left off.
  function dodgeMakeCtx() {
    return {
      x: 0, y: 0, t: 0,
      lastDir: -1,      // the heading we are on, so a caller can read it back
      hitAt: new Float64Array(DODGE_THREAT_ALLOC),
    };
  }

  const dodgeCtxPrefix = dodgeMakeCtx();  // where the latency prefix leaves us
  const dodgeCtxWork = dodgeMakeCtx();    // the rollout currently being scored

  function dodgeCtxReset(c, x, y, dirIdx, n) {
    c.x = x; c.y = y; c.t = 0;
    c.lastDir = dirIdx;
    for (let i = 0; i < n; i++) c.hitAt[i] = Infinity;
  }

  function dodgeCtxCopy(dst, src, n) {
    dst.x = src.x; dst.y = src.y; dst.t = src.t;
    dst.lastDir = src.lastDir;
    for (let i = 0; i < n; i++) dst.hitAt[i] = src.hitAt[i];
  }

  // One leg, in place, clipped at the horizon.
  function dodgeAdvance(c, dirIdx, dur, threats, speed, walls, horizon) {
    const n = threats.length;
    const d = Math.min(dur, horizon - c.t);
    if (!(d > 0)) return;
    c.lastDir = dirIdx;

    const dir = DODGE_DIRS[dirIdx];
    if (dir.x === 0 && dir.y === 0) {
      for (let i = 0; i < n; i++) {
        dodgeSweep(i, c.x, c.y, 0, 0, threats[i], c.t, d, c.hitAt);
      }
      c.t += d;
      return;
    }

    // Same adaptive split the DP edge makes, for the same reason: a leg that
    // never touches anything is a straight line and solves in closed form, and
    // only a leg that gets pushed has to be walked. `hitAt` takes a min over
    // whatever it is told, so sub-stepping needs no special billing rule here.
    dodgeMove(c.x, c.y, dir.x, dir.y, speed, d, walls, dodgeMoveOut);
    if (!dodgeMoveOut.bent) {
      const vx = dir.x * speed, vy = dir.y * speed;
      for (let i = 0; i < n; i++) {
        dodgeSweep(i, c.x, c.y, vx, vy, threats[i], c.t, d, c.hitAt);
      }
      c.x = dodgeMoveOut.x; c.y = dodgeMoveOut.y;
    } else {
      let steps = Math.ceil(d / DODGE_SUBSTEP_S);
      if (steps > DODGE_SUBSTEP_MAX) steps = DODGE_SUBSTEP_MAX;
      const h = d / steps;
      const sx = dir.x * speed * h, sy = dir.y * speed * h;
      const invH = 1 / h;
      let x = c.x, y = c.y;
      for (let s = 0; s < steps; s++) {
        dodgeSubstep(x, y, sx, sy, walls, -dir.x, -dir.y, dodgeStepOut);
        const ax = dodgeStepOut.x, ay = dodgeStepOut.y;
        const vx = (ax - x) * invH, vy = (ay - y) * invH;
        const ts = c.t + s * h;
        for (let i = 0; i < n; i++) {
          dodgeSweep(i, x, y, vx, vy, threats[i], ts, h, c.hitAt);
        }
        x = ax; y = ay;
      }
      c.x = x; c.y = y;
    }
    c.t += d;
  }

  // Carry our start state forward by the lead, un-scored: a position
  // correction, not a leg of anybody's plan.
  //
  // This has to be separate from dodgeAdvance(), and getting it wrong is
  // subtle enough to be worth the paragraph. Threats are placed where they
  // will be when our input lands — a full round trip ahead of the frame we are
  // looking at — so plan-time zero is that moment for them. Our own position is
  // a round trip *behind* it, and closing that gap by running a scored leg
  // through dodgeAdvance() advances the threats a second time along with it,
  // because their positions are a function of plan time. Every bullet is then
  // solved against us from a round trip too far away.
  //
  // At 60ms on an mp5 round that is 5 units of error and it mostly still works;
  // at 140ms it is 12, and the bot cleanly proves to itself that a round about
  // to hit us will miss. dodgebot-test/bench.js measures exactly that — at
  // 140ms the hit rate with the bot driving was indistinguishable from having
  // no bot at all, and at 60ms it was costing a factor of seven.
  //
  // So the gap is closed here instead: walls still clip it, since we really can
  // be stopped during it, but nothing is swept and no cost is charged, and plan
  // time stays at zero so the whole horizon belongs to the plan.
  function dodgeCarry(c, dirIdx, dur, speed, walls) {
    if (!(dur > 0)) return;
    const dir = DODGE_DIRS[dirIdx];
    if (dir.x === 0 && dir.y === 0) return;
    dodgeMove(c.x, c.y, dir.x, dir.y, speed, dur, walls, dodgeMoveOut);
    c.x = dodgeMoveOut.x;
    c.y = dodgeMoveOut.y;
  }

  // When a finished rollout is first hit, or Infinity if it never is. This is
  // the takeover's question and the only thing a context is rolled forward to
  // answer — the plan itself is scored edge by edge inside dodgeDpPlan. It is
  // deliberately unweighted: "when are we hit" has nothing to do with how hard,
  // and the damage weighting belongs to the loss, not to the trigger.
  function dodgeCtxFirstHit(c, threats) {
    const n = threats.length;
    let firstHit = Infinity;
    for (let i = 0; i < n; i++) {
      // A shot nobody has fired cannot be a time we get hit. It is a real cost
      // in the loss and deliberately not an event in the readouts, which exist
      // to say what the rounds actually in the air are going to do.
      if (threats[i].phantom) continue;
      const hit = c.hitAt[i];
      if (hit < firstHit) firstHit = hit;
    }
    return firstHit;
  }

  // ---- Driving the keys --------------------------------------------------

  // ---- The deep search: a shortest path over (cell, time) ---------------
  //
  // The question the fight actually poses: over the next `horizon` seconds,
  // chopped into DODGE.stepS decisions, which *sequence* of headings takes the
  // least damage? At the default 0.1s step that is eight decisions and
  // 9^8 ~ 43 million sequences, which is hopeless as a tree.
  //
  // It is not a tree. Two paths that arrive at the same place at the same time
  // are worth exactly the same from there on, so they merge, and what is left
  // is a shortest path over a graph whose nodes are (cell, layer). Time only
  // moves forward, so that graph is a DAG and its layers are already in
  // topological order — no priority queue, no Dijkstra, just a forward sweep
  // keeping the cheapest way into each cell. The reachable set at layer k is a
  // disc of radius speed*k*stepS rather than 9^k, which is the whole
  // difference: a few thousand states instead of 43 million rollouts.
  //
  // Merging is only sound if cost is additive per edge and the cost of
  // finishing depends on nothing but (cell, layer). The loss is a sum of
  // damage over the rounds that land plus a per-leg alignment term, and both
  // hold outright: neither needs to know how a state was reached, since the
  // alignment of a leg is a function of that leg's own heading. That was not
  // free when turning, standing and wall-grinding were also charged — the turn
  // penalty in particular needed the previous heading, which is history, and
  // had to be special-cased onto the first layer.
  //
  // This replaced a two-leg branch search — nine headings held for the horizon,
  // a second leg for the best few — which is kept here only as the measurement
  // that justifies the cost. dodgebot-test/bench.js, 60 trials, Barrett at
  // 214 u/s, where two legs run out of room: 8.7% hit rate -> 3.2% at 0ms,
  // 29.7% -> 22.7% at 60ms, and no worse anywhere else. Slower guns were
  // already fully dodged by both and the difference there was noise.
  const DODGE_DP_BEAM = 64;   // states kept per layer; 0 would be exact

  // The chosen opening heading and what it scored. One object, written once a
  // frame and read immediately.
  const dodgeBest = { dir: 0, cost: Infinity, firstHit: Infinity };

  // ---- Getting the whole plan back out of the search -------------------
  //
  // The search's own answer is one heading — the one to press now — and every
  // other leg behind it is overwritten as the layers swap. That was enough
  // while the plan was remade from scratch every frame. It is not enough now:
  // a plan is held and played out until something about the world changes (see
  // dodgeStep), so the legs after the first have to survive the function that
  // found them.
  //
  // What is recovered is the winning state's ancestry, not a re-simulation of
  // the heading it opens with: the two differ the moment the plan turns, which
  // is exactly when it matters, both to hold and to look at.
  //
  // Two things read the result. dodgePlan takes the headings and is load
  // bearing — it is what gets pressed. dodgePath takes the positions and is
  // display only, drawn by drawDodgePlan under the "Show plan" toggle. Neither
  // is read by the search.
  //
  // One entry per completed layer, holding the states the beam kept and the
  // state in the layer before that each was reached from. Only survivors are
  // ever expanded, so a parent recorded here is always still in the previous
  // entry — which is what makes walking the winner back to the start a lookup
  // rather than a search over the grid.
  const dodgeTrace = { layers: [], depth: 0 };

  // The course the bot is holding: one heading per decision, in plan order, and
  // everything needed to say which of them is the one to be pressing now.
  //
  // The clock this is indexed on is plan time, whose zero is "the world as the
  // server will have it when a press made at `at` lands" — a full round trip
  // ahead of the packet the plan was built from. `lead` is the size of that
  // correction when the plan was made, and it is kept because it is the thing
  // that can move underneath a held plan: see dodgePlanTime.
  //
  // The rest is the world this was planned against, kept so the next step can
  // ask whether any of it has changed rather than assume it has — see
  // dodgePlanFresh.
  const dodgePlan = {
    n: 0,                       // legs, i.e. how many decisions it holds
    dirs: new Int8Array(32),    // DODGE_DIRS index per leg, in plan order
    dt: 0,                      // seconds one leg covers
    at: 0,                      // Date.now() the plan was made at
    lead: 0,                    // the ping lead it was built with, seconds
    leg: -1,                    // the leg being pressed right now
    // What it was planned against.
    packet: -1,                 // netStats.updates
    adds: -1,                   // dodgeBulletAdds
    live: 0,                    // dodgeState.liveKey
    blasts: 0,                  // dodgeState.blastKey
    count: -1,                  // threat count, phantoms included
    userDir: -1,                // the heading the user was holding
  };

  function dodgePlanEnsure(n) {
    if (dodgePlan.dirs.length >= n) return;
    dodgePlan.dirs = new Int8Array(Math.ceil(n / 32) * 32);
  }

  // The walked-back polyline in world units, plus where we actually were when
  // it was planned. `at` is what stops a plan from a fight that has ended being
  // drawn over a quiet screen, and it is refreshed on every step that keeps the
  // plan — a plan being played out is current, not stale, and the line would
  // otherwise blink out between packets on a slow link.
  const dodgePath = {
    n: 0,
    x: new Float64Array(32),
    y: new Float64Array(32),
    at: 0,
    startX: 0,
    startY: 0,
  };

  // How long a plan is worth drawing. One step at the planner's own 16ms floor
  // plus room for a dropped frame; past that dodgeStep has stopped touching it,
  // which means the keys have gone back.
  const DODGE_PATH_STALE_MS = 120;

  function dodgePathEnsure(n) {
    if (dodgePath.x.length >= n) return;
    const cap = Math.ceil(n / 32) * 32;
    dodgePath.x = new Float64Array(cap);
    dodgePath.y = new Float64Array(cap);
  }

  // Snapshot one finished layer: the states the beam kept, the state in the
  // layer before that each was reached from, and the heading of the edge
  // between them. Called after the beam has pruned, so `len` is at most
  // DODGE_DP_BEAM and this is a few hundred bytes a layer.
  //
  // It runs unconditionally now. It used to be gated on the "Show plan" toggle,
  // which was right while the tail of a plan was only ever looked at; the tail
  // is pressed now, so the toggle gates the drawing and nothing else.
  function dodgeTraceCapture(depth, list, len, parent, dirs) {
    let e = dodgeTrace.layers[depth];
    if (!e || e.idx.length < len) {
      const cap = Math.ceil(len / 64) * 64;
      e = {
        idx: new Int32Array(cap), par: new Int32Array(cap),
        dir: new Int8Array(cap), len: 0,
      };
      dodgeTrace.layers[depth] = e;
    }
    for (let i = 0; i < len; i++) {
      const j = list[i];
      e.idx[i] = j;
      e.par[i] = parent[j];
      e.dir[i] = dirs[j];
    }
    e.len = len;
    dodgeTrace.depth = depth + 1;
  }

  // Walk the winning state back to the start and write the result out in plan
  // order: the headings into dodgePlan, which is what gets pressed, and the
  // positions into dodgePath, which is what gets drawn.
  //
  // Positions are the grid's, not the mover's: every layer snaps to `cell`, so
  // these are the points the search actually scored, and drawing the unsnapped
  // ends of the legs instead would draw a path it never considered. The
  // headings have no such caveat — they are exactly the edges the loss was
  // charged on.
  //
  // The lookup per layer is linear over at most DODGE_DP_BEAM entries, which is
  // 64 comparisons against a search that has just done several thousand edges.
  function dodgeTraceWalk(bi, ox, oy, half, w, cell) {
    const depth = dodgeTrace.depth;
    dodgePath.n = 0;
    dodgePlan.n = 0;
    if (depth <= 0) return;
    dodgePathEnsure(depth + 1);
    dodgePlanEnsure(depth);
    let idx = bi;
    for (let d = depth - 1; d >= 0; d--) {
      const e = dodgeTrace.layers[d];
      let k = -1;
      for (let i = 0; i < e.len; i++) {
        if (e.idx[i] === idx) { k = i; break; }
      }
      // Can't happen while the capture sits where it does — every state in a
      // layer was expanded from one in the entry before it — but a course that
      // silently invents a leg is worse than no course, so a broken chain drops
      // the whole plan. dodgeStep then presses the search's own opening heading
      // for this step and plans again on the next one.
      if (k < 0) { dodgePath.n = 0; dodgePlan.n = 0; return; }
      const ix = idx % w, iy = (idx / w) | 0;
      dodgePath.x[d + 1] = ox + (ix - half) * cell;
      dodgePath.y[d + 1] = oy + (iy - half) * cell;
      // e.dir[k] is the heading of the edge that reached this state, so it is
      // the heading held over leg `d` — the leg ending at the point just
      // written.
      dodgePlan.dirs[d] = e.dir[k];
      idx = e.par[k];
    }
    dodgePlan.n = depth;
    // Point 0 is where the search started, i.e. where the ping lead leaves the
    // newest packet — not where the packet put us, and not where the sprite is
    // drawn. dodgeStep records the packet position separately; drawDodgePlan
    // draws all three and what separates them.
    dodgePath.x[0] = ox;
    dodgePath.y[0] = oy;
    dodgePath.n = depth + 1;
  }

  // What disagreeing with the keys the user is holding costs, per second of
  // leg, per heading. Filled once per plan rather than per edge, because it
  // depends on nothing that varies inside the search: the held heading is fixed
  // for the frame. dodgeDpPlan multiplies each entry by the discounted length
  // of the leg being scored — see dodgeAlignScale.
  //
  //     rate = follow * norm * (1 - cos(angle between the two)) / 2
  //
  // so running with the keys is free, dead against them costs `follow` a
  // second, and the diagonals either side of the held heading cost about a
  // seventh of that — enough of a gradient that the search drifts toward the
  // user's intent when it is free to, and nowhere near enough to buy a hit.
  // Standing still sits at half, the same as running across: it is not what was
  // asked for, but it is not the opposite of it either.
  //
  // The discount reaches this term too, and it is the half of it with the
  // better excuse. The near legs are the ones that get pressed: the opening leg
  // always, the one after it only if nothing new has arrived by the time it
  // comes due, and the far end almost never — a plan is dropped the moment the
  // world it was made against moves, which at 20Hz of updates is about every
  // half a leg. Undiscounted, the planner is exactly indifferent about *when*
  // it disobeys: deviating on leg 1 and complying to the end costs the same as
  // complying until the last leg and deviating there. That spends the budget on
  // compliance that mostly never happens. Discounted, it complies now and
  // defers the deviation, toward the legs that are actually pressed.
  //
  // It sharpens the tiebreak on the right variable, too. The opening heading is
  // the one part of the course that is certain to be used, so weighting leg 1
  // more heavily separates the states by the thing being decided rather than by
  // the tail they share.
  //
  // What the discount must not do is quietly change the slider. Summed over the
  // horizon the discounted leg lengths come to (1 - exp(-H/tau)) * tau rather
  // than H, which at the defaults is 54% of it — so `norm` is the reciprocal of
  // that ratio and the total budget stays exactly `follow * H`. The discount
  // redistributes the term toward the near legs; it does not shrink it, and
  // `follow` means what it meant before there was a discount.
  //
  // A user holding nothing has no intent to agree with, so the table is left at
  // zero and the term vanishes rather than penalising every heading equally.
  //
  // That leaves the whole loss at zero whenever nothing is on course either,
  // which is now a state the bot sits in rather than a state it never reaches:
  // with no threshold to cross it plans whenever a round is in the air,
  // including the many plans where none of them is close to anything. What
  // wins a completely flat loss is decided by the tie rule and not by accident.
  // `di` is enumerated from 0, the relaxation keeps the incumbent on equal cost
  // (`c >= cost` continues), and the beam's sort is stable — so the standing
  // chain is written first into every layer, stays at index 0 of the frontier,
  // and is the first minimum the final scan sees. A user holding nothing while
  // a round flies past on the far side of a wall keeps standing still.
  const dodgeAlignPenalty = new Float64Array(DODGE_DIRS.length);

  function dodgeAlignFill(userDirIdx, window) {
    const k = dodgeClamp(DODGE.follow, 0, 5, 1);
    const u = DODGE_DIRS[userDirIdx];
    if (!(k > 0) || (u.x === 0 && u.y === 0)) {
      dodgeAlignPenalty.fill(0);
      return;
    }
    // lam * H / (1 - exp(-lam * H)), which is 1 in the limit of no discount.
    const lam = -dodgeDpTimeDecay;
    const lh = lam * window;
    const norm = lh > 1e-9 ? lh / (1 - Math.exp(-lh)) : 1;
    for (let i = 0; i < DODGE_DIRS.length; i++) {
      const d = DODGE_DIRS[i];
      dodgeAlignPenalty[i] = k * norm * (1 - (d.x * u.x + d.y * u.y)) * 0.5;
    }
  }

  // The discounted length of one leg, which is what a per-second rate has to be
  // multiplied by to become a cost:
  //
  //     integral over [t0, t0+dt] of exp(-t/tau)  =  exp(-t0/tau) * (1-g) / lam
  //
  // with g = exp(-dt/tau) fixed for the plan, so successive layers are one
  // multiply by `g` apart. A hit is an instant and samples the discount at a
  // point; alignment is a rate and integrates it. That asymmetry is the correct
  // treatment of two different kinds of cost, not an inconsistency between them.
  //
  // As lam goes to zero this goes to `dt`, which is the undiscounted leg length
  // the term used to carry directly.
  function dodgeAlignScale(dt) {
    const lam = -dodgeDpTimeDecay;
    const g = Math.exp(-lam * dt);
    return lam > 1e-9 ? (1 - g) / lam : dt;
  }

  let dodgeDpW = 0, dodgeDpEpoch = 0, dodgeDpVisit = 0;
  let dodgeDpCost = null, dodgeDpCostB = null;
  let dodgeDpFirst = null, dodgeDpFirstB = null;
  let dodgeDpHit = null, dodgeDpHitB = null;
  let dodgeDpSeen = null, dodgeDpSeenB = null;
  let dodgeDpList = null, dodgeDpListB = null;
  // Which state each state was reached from, as a grid index into the layer
  // before, and the heading of the edge that reached it. Together they are the
  // whole plan rather than its first leg: walk the parents back from the winner
  // and read the headings off, and dodgeStep has a course to hold rather than a
  // key to press once. That is what makes replanning optional — see
  // dodgeTraceWalk and dodgePlan.
  //
  // The search itself reads neither; dodgeDpFirst carries the opening heading,
  // which is all it ever needed. Both stores are unconditional: two writes on
  // the edges that improve a cell, against a table already carrying nine
  // Float32 pairs per cell, and a branch in that loop costs more than the
  // stores do.
  let dodgeDpParent = null, dodgeDpParentB = null;
  let dodgeDpDir = null, dodgeDpDirB = null;
  // Memoized leg outcome per (cell, heading): the displacement it produces and
  // whether the path bent getting there. Displacement rather than an absolute
  // position because it is small — at most speed*dt, about 1.2 units — and a
  // Float32 carries that to far more precision than it carries a world
  // coordinate a thousand units from the origin.
  let dodgeDpMoveX = null, dodgeDpMoveY = null, dodgeDpBent = null, dodgeDpStamp = null;
  let dodgeDpTouch = new Float64Array(DODGE_THREAT_ALLOC);
  // How much of a hit each threat is worth on the edge being scored: 1 inside
  // the hitbox, halving for every DODGE.clearance beyond it, 0 well outside.
  // See dodgeDpClearance.
  let dodgeDpFactor = new Float64Array(DODGE_THREAT_ALLOC);
  // The same, discounted to plan-time zero — `f * exp(-t/tau)`, the quantity the
  // loss actually charges for. Kept alongside the raw factor rather than derived
  // from it because the two answer different questions: this one decides which
  // of a split leg's two sweeps is the worse encounter, and the raw one feeds
  // the hitbox readout, which is about geometry and has no business being
  // discounted. Selecting on the raw factor would occasionally bill the cheaper
  // of the two, since a slightly closer pass later in the leg can be worth less
  // than a slightly wider one now.
  let dodgeDpBill = new Float64Array(DODGE_THREAT_ALLOC);
  // Per-leg billing mask for the sub-stepped path: 1 where the round was
  // already inside the band when the leg opened and so belongs to an earlier
  // leg. Only the bent path reads it — see dodgeDpEdge.
  let dodgeDpSkip = new Uint8Array(DODGE_THREAT_ALLOC);

  // Widen every per-threat scratch array to hold `n`. Called once a frame from
  // dodgeStep, after the threat set is built and before anything indexes by
  // threat — which is the only moment the count can change.
  //
  // Contents are not carried across: hitAt is refilled by dodgeCtxReset and the
  // dp scratch by dodgeDpEdge, both before any read, so a fresh allocation is
  // safe. Growth is in blocks of 32 and never reverses, so a fight that spikes
  // pays one allocation and the frames after it pay nothing.
  let dodgeThreatCap = DODGE_THREAT_ALLOC;

  function dodgeGrowThreats(n) {
    if (n <= dodgeThreatCap) return;
    dodgeThreatCap = Math.ceil(n / 32) * 32;
    dodgeDpTouch = new Float64Array(dodgeThreatCap);
    dodgeDpFactor = new Float64Array(dodgeThreatCap);
    dodgeDpBill = new Float64Array(dodgeThreatCap);
    dodgeDpSkip = new Uint8Array(dodgeThreatCap);
    dodgeCtxPrefix.hitAt = new Float64Array(dodgeThreatCap);
    dodgeCtxWork.hitAt = new Float64Array(dodgeThreatCap);
  }
  const dodgeDpOut = { cost: 0, hit: Infinity, x: 0, y: 0 };

  // Half-life of the hit test's falloff, set once per plan from DODGE.clearance.
  // The falloff sits entirely *outside* the hitbox:
  //
  //     d <= R   f = 1
  //     d >  R   f = (1/2)^((d - R) / clearance)
  //
  // so each `clearance` of daylight between the round and our hitbox halves
  // what the pass is billed.
  //
  // `R` is our body and nothing else — see dodgeBuildThreats — so `d <= R` is
  // the game's own hit test, and everything past it is this term's alone.
  //
  // A binary test asks whether the centre is inside the hitbox, which pretends
  // we know where the centre is. We do not: position is snapped to `Grid` at
  // every layer, the lead is an estimate, and the server's idea of where we
  // are is a round trip old — so a plan that clears a round by a hair has not
  // really cleared it. The falloff stands in for the probability that the round
  // lands anyway, and is the only thing in the loss that does.
  //
  // Exponential rather than the linear ramp it replaces, because a ramp has an
  // opinion only inside its own width: past R+band every clearance is equally
  // worth zero, and among the many plans that all clear the round the loss has
  // nothing left to say. Halving keeps paying for distance the whole way out,
  // so the planner still prefers the escape with room in it — and it decays
  // fastest exactly where the doubt is largest, just outside the body.
  //
  // One-sided, and deliberately. It can only ever *add* cost to what the binary
  // test would have charged, never remove it: a round whose closest approach is
  // inside the hitbox scores a full hit exactly as before. The symmetric band
  // this replaces also discounted marginal hits — a pass at 0.9u, comfortably
  // inside the body, was billed 0.786 of a hit — which is the wrong direction
  // to be uncertain in. Uncertainty should make the planner more careful, not
  // less.
  //
  // What it is not is the graze term this descends from, which had a hand-picked
  // sigma and — far worse — left a six-order-of-magnitude cliff at the hitbox
  // edge for a plan to shave. This loss is continuous across it, and monotone
  // the whole way out. At the defaults that is a full hit out to 1.0, half a hit
  // at 1.35, a quarter at 1.7, and zero by 3.1.
  //
  // An exponential has no end, and the sweep needs one — both to reject threats
  // cheaply and to keep the loss from noticing rounds on the far side of the
  // map. It is cut at DODGE_DP_TAIL half-lives, shifted down by its own value
  // there and renormalised, so f is still exactly 1 at the hitbox and reaches
  // exactly 0 at the cutoff instead of dropping 1/64 of a hit off a cliff —
  // which is precisely the artefact this term exists not to have.
  const DODGE_DP_TAIL = 6;
  const DODGE_DP_FLOOR = Math.pow(0.5, DODGE_DP_TAIL);
  const DODGE_DP_NORM = 1 / (1 - DODGE_DP_FLOOR);
  let dodgeDpClearance = 0.35;
  let dodgeDpDecay = -Math.LN2 / dodgeDpClearance;   // exponent per unit of clearance
  let dodgeDpPad = DODGE_DP_TAIL * dodgeDpClearance; // R + this is where f reaches 0

  function dodgeDpSetClearance(c) {
    dodgeDpClearance = c;
    dodgeDpDecay = -Math.LN2 / c;
    dodgeDpPad = DODGE_DP_TAIL * c;
  }

  // -1/tau: the exponent per second of plan time, negative so that multiplying
  // by a time and exponentiating gives the discount directly. Set once per plan
  // from DODGE.halfLife, and read by every term in the loss — see DODGE_HIT_COST
  // for what the discount is and dodgeAlignFill for how the alignment term is
  // held constant across changes to it.
  let dodgeDpTimeDecay = -Math.LN2 / 0.4;

  function dodgeDpSetHalfLife(h) {
    dodgeDpTimeDecay = -Math.LN2 / h;
  }
  const dodgeDpOrder = [];

  function dodgeDpEnsure(w) {
    if (w === dodgeDpW) return;
    const n = w * w;
    dodgeDpW = w;
    dodgeDpCost = new Float64Array(n); dodgeDpCostB = new Float64Array(n);
    dodgeDpFirst = new Int8Array(n); dodgeDpFirstB = new Int8Array(n);
    dodgeDpHit = new Float64Array(n); dodgeDpHitB = new Float64Array(n);
    dodgeDpSeen = new Int32Array(n); dodgeDpSeenB = new Int32Array(n);
    dodgeDpList = new Int32Array(n); dodgeDpListB = new Int32Array(n);
    dodgeDpParent = new Int32Array(n); dodgeDpParentB = new Int32Array(n);
    dodgeDpDir = new Int8Array(n); dodgeDpDirB = new Int8Array(n);
    dodgeDpMoveX = new Float32Array(n * 9); dodgeDpMoveY = new Float32Array(n * 9);
    dodgeDpBent = new Uint8Array(n * 9); dodgeDpStamp = new Int32Array(n * 9);
    dodgeVisStamp = new Int32Array(n * DODGE_VIS_SLOTS);
    dodgeVisVal = new Uint8Array(n * DODGE_VIS_SLOTS);
    dodgeDpEpoch = 0; dodgeDpVisit = 0;
  }

  // ---- Per-cell visibility ----------------------------------------------
  //
  // Whether a blast can see a given cell of the search grid, memoized per
  // (cell, blast) for one plan, on exactly the pattern dodgeDpMoveFor uses for
  // movement and for the same reason: the answer cannot depend on when we
  // arrive, because walls do not move within a plan, so the several states that
  // reach a cell pay for the raycast once between them.
  //
  // This is what replaces testing cover once from the blast to where we already
  // stand. That test could only ever drop a threat wholesale, which meant a
  // plan that would walk us *out* of cover into the blast was not charged for
  // it — the bot would not be pulled out of cover, but neither would it be held
  // in it. Per cell, the wall becomes a gradient the search can climb: the cost
  // is zero behind it and full in front of it, so staying put and stepping back
  // into cover are things the planner now has an opinion about.
  //
  // Cost is bounded by the frontier rather than by the grid. A blast is billed
  // on the one layer its instant falls in, so only the cells reached on that
  // layer are ever asked — at most the beam width times nine headings, and far
  // fewer in practice because the headings out of neighbouring cells land in
  // the same cells. The blockers are prefiltered per plan to those that could
  // stand between the blast and anywhere reachable, so each ray scans a handful
  // of obstacles rather than the map.
  //
  // Slots rather than a map, because the arrays have to be typed and indexed
  // without allocating: four blasts get per-cell visibility and any beyond that
  // fall back to `clear`, the single-point answer. Four simultaneous live
  // grenades close enough to matter is already an unusual frame.
  const DODGE_VIS_SLOTS = 4;
  let dodgeVisStamp = new Int32Array(0);
  let dodgeVisVal = new Uint8Array(0);
  const dodgeVisObs = [[], [], [], []];
  // The grid the cell indices are against, republished every plan. A cell index
  // and a position are the same thing only with respect to one of these.
  let dodgeDpOx = 0, dodgeDpOy = 0, dodgeDpHalf = 0, dodgeDpCell = 0.35;

  // The blockers that could stand between one blast and anywhere the plan can
  // reach: the explosion's own occlusion predicate, over the union of the blast
  // point and the grid's own box. Built once per plan per blast.
  function dodgeVisBuild(slot, bx, by, layer) {
    const out = dodgeVisObs[slot];
    out.length = 0;
    const span = dodgeDpHalf * dodgeDpCell;
    const loX = Math.min(bx, dodgeDpOx - span), hiX = Math.max(bx, dodgeDpOx + span);
    const loY = Math.min(by, dodgeDpOy - span), hiY = Math.max(by, dodgeDpOy + span);
    const obstacles = getObstacles();
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!blocksBlast(o, layer)) continue;
      if (!colliderNearSegment(o.collider, loX, loY, hiX, hiY)) continue;
      out.push(o);
    }
  }

  // Is the blast's own ray to (x, y) clear? Snapped to the cell containing that
  // point and answered for the cell centre, which is not an approximation the
  // search has to be told about: every node's position is already reconstructed
  // from its cell index, so the cell centre *is* where the planner thinks we
  // are. Anything off the grid falls back to the single-point answer.
  function dodgeDpVisible(th, x, y) {
    const slot = th.vis;
    if (slot < 0) return th.clear;
    const w = dodgeDpW;
    const ix = dodgeDpHalf + Math.round((x - dodgeDpOx) / dodgeDpCell);
    const iy = dodgeDpHalf + Math.round((y - dodgeDpOy) / dodgeDpCell);
    if (ix < 0 || iy < 0 || ix >= w || iy >= w) return th.clear;
    const key = (iy * w + ix) * DODGE_VIS_SLOTS + slot;
    if (dodgeVisStamp[key] === dodgeDpEpoch) return dodgeVisVal[key] === 1;
    const cx = dodgeDpOx + (ix - dodgeDpHalf) * dodgeDpCell;
    const cy = dodgeDpOy + (iy - dodgeDpHalf) * dodgeDpCell;
    const obs = dodgeVisObs[slot];
    let ok = true;
    const loX = Math.min(th.x, cx), hiX = Math.max(th.x, cx);
    const loY = Math.min(th.y, cy), hiY = Math.max(th.y, cy);
    for (let i = 0; i < obs.length; i++) {
      const c = obs[i].collider;
      if (!colliderNearSegment(c, loX, loY, hiX, hiY)) continue;
      if (segHitCollider(th.x, th.y, cx, cy, c) !== null) { ok = false; break; }
    }
    dodgeVisStamp[key] = dodgeDpEpoch;
    dodgeVisVal[key] = ok ? 1 : 0;
    return ok;
  }

  // dodgeSweep, but per edge instead of per rollout, graded by dodgeDpClearance,
  // and it refuses to charge for an encounter that was already underway when
  // the leg opened.
  //
  // That last rule is what keeps damage an event rather than a field. One round
  // must cost one hit, not one hit per step it spends near us, so the charge
  // lands on the leg where the round *enters* the band and every later leg that
  // opens already inside it scores nothing. `billOpen` is the exception: on the
  // first leg of a plan there is no earlier leg to have billed it, so a round
  // that starts the plan already close has to be charged here or never.
  //
  // A round crosses a body in ~20ms against a 100ms step, so an encounter opens
  // and closes inside one leg in practice.
  //
  // The closest approach is found without a square root, and usually without
  // the divide either. `ts` is the time of it, clipped to the leg, and the
  // distance there expands to
  //     |q + u*ts|^2 = |q|^2 + 2*(q.u)*ts + |u|^2*ts^2
  // out of terms already in hand. Two rejections run ahead of it and are pure
  // multiplies: a round separating from the leg's start never closes, and one
  // whose unconstrained closest approach `|q|^2 - b^2/a` still clears the band
  // never enters it anywhere on its line, which rearranges to `b*b <= a*(d02 -
  // outer2)` with no division. What is left — a round genuinely passing close —
  // pays the divide, and only what actually lands in the band pays the sqrt.
  // The exponential's cutoff makes that band DODGE_DP_TAIL half-lives wide
  // rather than one grid cell, so more pairs reach the sqrt than under the ramp
  // — where it was measured at ~0.4% of threat-edge pairs in a 48-round
  // firefight — but the two rejections ahead of it are unchanged and still take
  // the bulk.
  // A blast, billed on the one leg of the plan that contains it.
  //
  // Everything the round sweep is careful about — when contact opens, which leg
  // owns the charge, how close the closest approach was — has no meaning here.
  // A grenade goes off once. The leg containing that instant carries us to some
  // position, that position is some distance from the blast, and the distance
  // decides the damage. No other leg is charged, because on no other leg does
  // the explosion exist.
  //
  // That also makes the billing rule automatic rather than enforced: `tBoom`
  // falls inside exactly one half-open leg, so `billOpen`, dodgeDpSkip and the
  // already-inside test never come into it.
  function dodgeDpBlast(i, px, py, vx, vy, th, t0, dur) {
    const t = th.tBoom;
    if (t < t0 || t >= t0 + dur) return;
    const dt = t - t0;
    const dx = px + vx * dt - th.x;
    const dy = py + vy * dt - th.y;
    const d = Math.hypot(dx, dy);
    if (d - dodgeDpClearance >= th.rMax) return;
    // `f` is the fraction of the blast's own maximum this pass takes, so that
    // `th.w * bill` stays what it is everywhere else: expected HP over
    // DODGE_DMG_REF. th.w already carries the full-damage figure.
    const f = dodgeBlastFactor(th.rMin, th.rMax, d, dodgeDpClearance);
    if (!(f > 0)) return;
    // Asked last, because it is the only expensive thing here and the distance
    // test above rejects most of the grid before it is reached.
    if (!dodgeDpVisible(th, px + vx * dt, py + vy * dt)) return;
    const bill = f * Math.exp(dodgeDpTimeDecay * t);
    if (bill > dodgeDpBill[i]) {
      dodgeDpBill[i] = bill;
      dodgeDpFactor[i] = f;
      dodgeDpTouch[i] = t;
    }
  }

  function dodgeDpSweep(i, px, py, vx, vy, th, t0, dur, billOpen) {
    if (th.blast) return dodgeDpBlast(i, px, py, vx, vy, th, t0, dur);
    const span = Math.min(dur, th.tMax - t0);
    if (!(span > 0)) return;
    const qx = th.x + th.wx * t0 - px;
    const qy = th.y + th.wy * t0 - py;
    const outer = th.R + dodgeDpPad;
    const outer2 = outer * outer;
    const d02 = qx * qx + qy * qy;
    // Already in the band as the leg opens: whichever leg it entered on owns
    // the charge. Not so on the opening leg, which owns everything.
    const insideOpen = d02 < outer2;
    if (insideOpen && !billOpen) return;
    const ux = th.wx - vx, uy = th.wy - vy;
    const a = ux * ux + uy * uy;
    const b = qx * ux + qy * uy;
    if (!insideOpen) {
      if (b >= 0) return;                       // separating already; never closer
      if (!(a > 1e-9)) return;                  // no relative motion, and clear
      if (b * b <= a * (d02 - outer2)) return;  // the whole line stays clear of the band
    }
    // Closest approach, clipped to the leg. `a` at zero means no relative
    // motion, which leaves ts at 0 and the distance at what it already was.
    const ts = a > 1e-9 ? Math.min(Math.max(-b / a, 0), span) : 0;
    const d2 = d02 + 2 * b * ts + a * ts * ts;
    if (d2 >= outer2) return;           // never enters the band on this leg
    const dmin = Math.sqrt(d2);
    const f = dmin <= th.R
      ? 1
      : (Math.exp(dodgeDpDecay * (dmin - th.R)) - DODGE_DP_FLOOR) * DODGE_DP_NORM;
    // A leg can be swept twice — once moving, once pinned — so the worst
    // exposure in it wins, and carries its own time with it. "Worst" is the
    // discounted weight rather than the raw one, because that is what the leg
    // will be billed and the two can disagree across the length of a leg.
    const tt = t0 + ts;
    const bill = f * Math.exp(dodgeDpTimeDecay * tt);
    if (bill > dodgeDpBill[i]) {
      dodgeDpBill[i] = bill;
      dodgeDpFactor[i] = f;
      dodgeDpTouch[i] = tt;
    }
  }

  // Where heading `di` leaves us from this cell, and whether it bent. Keyed by
  // cell rather than by (cell, layer) because the answer cannot depend on when
  // we arrive — walls do not move within a plan — so the several layers that
  // can reach a cell pay for the integration once between them. The key is
  // exact rather than approximate: every node's position is reconstructed from
  // its cell index, so a cell index and a position are the same thing.
  //
  // Result goes into dodgeMoveOut, matching dodgeMove's own contract, so the
  // caller reads both hit and miss the same way.
  function dodgeDpMoveFor(idx, di, px, py, speed, dt, walls) {
    const key = idx * 9 + di;
    if (dodgeDpStamp[key] === dodgeDpEpoch) {
      dodgeMoveOut.x = px + dodgeDpMoveX[key];
      dodgeMoveOut.y = py + dodgeDpMoveY[key];
      dodgeMoveOut.bent = dodgeDpBent[key] === 1;
      return dodgeMoveOut;
    }
    const dir = DODGE_DIRS[di];
    dodgeMove(px, py, dir.x, dir.y, speed, dt, walls, dodgeMoveOut);
    dodgeDpStamp[key] = dodgeDpEpoch;
    dodgeDpMoveX[key] = dodgeMoveOut.x - px;
    dodgeDpMoveY[key] = dodgeMoveOut.y - py;
    dodgeDpBent[key] = dodgeMoveOut.bent ? 1 : 0;
    return dodgeMoveOut;
  }

  // Is this threat inside the falloff band at the instant the leg opens? The
  // billing rule needs this once per leg, and the sub-stepped path cannot ask
  // dodgeDpSweep for it — every sub-step after the first opens inside whatever
  // the one before it was inside, which would silence the charge entirely.
  function dodgeDpInBand(th, t0, px, py) {
    // A blast has no band to already be inside — it bills on the leg its own
    // instant falls in and nowhere else, so it must never be suppressed here.
    if (th.blast) return false;
    const qx = th.x + th.wx * t0 - px;
    const qy = th.y + th.wy * t0 - py;
    const outer = th.R + dodgeDpPad;
    return qx * qx + qy * qy < outer * outer;
  }

  // One leg: what it costs, the worst contact inside it, and where it ends.
  //
  // Two paths, chosen by whether depenetration fired anywhere in the leg, and
  // both exact:
  //
  //   not bent — nothing was touched, so the leg is a straight line at full
  //     speed for the whole of `dt` and one closed-form solve per threat is
  //     the entire answer. This is the overwhelming majority of edges and it
  //     costs exactly what the old distance-clipped version cost.
  //
  //   bent — the path is a polyline, so it is walked at DODGE_SUBSTEP_S and
  //     each segment solved at its own constant velocity. ~dt/0.01 times the
  //     sweep work, paid only on edges that actually touch geometry.
  //
  // `billOpen` is the layer index (see dodgeDpSweep): a round already inside
  // the band when the leg opens belongs to whichever earlier leg it entered on,
  // except on layer 0 where there is no earlier leg. That test is made ONCE
  // here, against the leg's own opening, and the sub-steps then sweep
  // unconditionally so the closest approach is found across the whole leg
  // rather than trapped in the sub-step the round happened to enter on.
  // dodgeDpSweep's own max-fold (`bill > dodgeDpBill[i]`) picks the winner.
  function dodgeDpEdge(px, py, t0, di, dt, speed, mvx, mvy, bent, threats, walls, billOpen) {
    const n = threats.length;
    let i;
    for (i = 0; i < n; i++) {
      dodgeDpFactor[i] = 0; dodgeDpBill[i] = 0; dodgeDpTouch[i] = Infinity;
    }
    let cost = 0;
    const nx = px + mvx, ny = py + mvy;
    const dir = DODGE_DIRS[di];

    if (!bent) {
      // Free flight — or standing still, where the velocity is zero and this is
      // the same solve. No wall was touched, so speed was never interrupted.
      const vx = dir.x * speed, vy = dir.y * speed;
      for (i = 0; i < n; i++) dodgeDpSweep(i, px, py, vx, vy, threats[i], t0, dt, billOpen);
    } else {
      // Which threats this leg is allowed to charge for at all.
      for (i = 0; i < n; i++) {
        dodgeDpSkip[i] = (!billOpen && dodgeDpInBand(threats[i], t0, px, py)) ? 1 : 0;
      }
      let steps = Math.ceil(dt / DODGE_SUBSTEP_S);
      if (steps > DODGE_SUBSTEP_MAX) steps = DODGE_SUBSTEP_MAX;
      const h = dt / steps;
      const sx = dir.x * speed * h, sy = dir.y * speed * h;
      const invH = 1 / h;
      let x = px, y = py;
      for (let s = 0; s < steps; s++) {
        dodgeSubstep(x, y, sx, sy, walls, -dir.x, -dir.y, dodgeStepOut);
        const ax = dodgeStepOut.x, ay = dodgeStepOut.y;
        // The segment's own velocity, push-out included — which is how a slide
        // gets its tangential speed into the solve instead of being modelled as
        // running at the wall and stopping. A refused sub-step gives zero, and
        // the sweep correctly sees us parked for its duration.
        const vx = (ax - x) * invH, vy = (ay - y) * invH;
        const ts = t0 + s * h;
        // `true` suppresses dodgeDpSweep's own already-inside bail-out; the
        // leg-level decision was made above and lives in dodgeDpSkip.
        for (i = 0; i < n; i++) {
          if (!dodgeDpSkip[i]) dodgeDpSweep(i, x, y, vx, vy, threats[i], ts, h, true);
        }
        x = ax; y = ay;
      }
    }

    let hit = Infinity;
    for (i = 0; i < n; i++) {
      const bill = dodgeDpBill[i];
      if (bill > 0) {
        // HP is the objective, and the whole of it. `w` is this round's damage
        // over DODGE_DMG_REF, priced by dodgeBulletDamage off the BULLET_DAMAGE
        // table — so a path that eats an mp5 round to stay out of an awc's line
        // is cheaper than one that does the reverse, which under a flat hit
        // count it never could be. Summed over edges, this is expected HP lost:
        // `f` is the chance of losing it and the discount already folded into
        // `bill` is the chance the plan is still about the world it was written
        // for by the time it would be lost.
        //
        // The discount samples at the closest approach rather than at the moment
        // the hitbox is crossed, and deliberately: the crossing does not exist
        // for a graze and appears discontinuously as one becomes a hit, which
        // would put back a cliff in the term the falloff exists to smooth. The
        // two differ by less than the time a round takes to cross a body — ~20ms
        // against a half-life of hundreds — so nothing measurable rides on it.
        const th = threats[i];
        cost += th.w * bill * DODGE_HIT_COST;
        // For the readout only, undiscounted, and a binary question: is this a
        // hit. `f > 0.5` sits at `dmin < R + 0.98 * clearance` — near enough one
        // clearance outside the body rather than on it, so the readout calls a
        // near miss a hit and errs pessimistic. `f >= 1` would be the game's own
        // hitbox exactly, since `f` is set to literal 1 there and is strictly
        // below it anywhere outside; nothing but the HUD reads this, and the
        // takeover test is dodgeCtxFirstHit, which is separate and exact.
        const f = dodgeDpFactor[i], tt = dodgeDpTouch[i];
        // Phantoms are excluded here for the same reason as in
        // dodgeCtxFirstHit: `planHitIn` answers "when does a round that exists
        // reach us", and a guess about someone's trigger finger is not that.
        if (f > 0.5 && tt < hit && !th.phantom) hit = tt;
      }
    }
    dodgeDpOut.cost = cost; dodgeDpOut.hit = hit; dodgeDpOut.x = nx; dodgeDpOut.y = ny;
    return dodgeDpOut;
  }

  function dodgeDpPlan(threats, speed, walls, horizon, userDirIdx) {
    const prefix = dodgeCtxPrefix;
    const best = dodgeBest;
    // Dropped up here, ahead of every path out of this function: whether the
    // search finds a course, declines to run, or loses the chain walking one
    // back, nothing that survives is older than this call. An empty plan is not
    // a failure state — it is dodgeStep being told to press the opening heading
    // and come back next step.
    dodgePath.n = 0;
    dodgePlan.n = 0;
    dodgeTrace.depth = 0;
    const window = horizon - prefix.t;
    const curDir = prefix.lastDir >= 0 ? prefix.lastDir : 0;

    best.dir = curDir;
    best.cost = Infinity;
    best.firstHit = Infinity;
    if (!(window > 1e-3)) return best;

    let dt = dodgeClamp(DODGE.stepS, 0.03, 0.3, 0.1);
    const steps = Math.max(1, Math.round(window / dt));
    dt = window / steps;
    // The leg length the plan will be indexed by while it is held. Stamped
    // before the search rather than after it so the two can never disagree
    // about how long a decision lasts.
    dodgePlan.dt = dt;
    const cell = dodgeClamp(DODGE.cell, 0.05, 0.5, 0.35);
    dodgeDpSetClearance(dodgeClamp(DODGE.clearance, 0.05, 1.5, 0.35));
    dodgeDpSetHalfLife(dodgeClamp(DODGE.halfLife, 0.1, 5, 0.4));
    dodgeAlignFill(userDirIdx, window);
    // The discounted length of one leg. Every layer is the same `dt` long, so
    // successive layers differ by one multiply — see dodgeAlignScale.
    let alignS = dodgeAlignScale(dt);
    const alignStep = Math.exp(dodgeDpTimeDecay * dt);

    // Half-width: everywhere the body can reach, plus the drift snapping can
    // add, plus a cell of slack — anything landing outside is unreachable and
    // dropping it is free. Rounded up to a multiple of 8 because `speed` is a
    // measurement that drifts every frame, and a width tracking it exactly
    // would reallocate a quarter-megabyte of grid at 60Hz.
    let half = Math.ceil((speed * window + steps * cell + 2 * cell) / cell);
    half = (Math.ceil(half / 8) | 0) * 8;
    const w = 2 * half + 1;
    dodgeDpEnsure(w);
    // The stamps are counters compared against, never cleared, so they only
    // have to outlive one plan — but they do have to stay inside an Int32.
    if (dodgeDpEpoch > 2e9 || dodgeDpVisit > 2e9) {
      dodgeDpStamp.fill(0); dodgeDpSeen.fill(0); dodgeDpSeenB.fill(0);
      // The visibility memo is stamped with the epoch too, so it has to be
      // cleared with it: the counter restarts at 1, and a cell last written on
      // plan 1 and never since would otherwise read as current.
      dodgeVisStamp.fill(0);
      dodgeDpEpoch = 0; dodgeDpVisit = 0;
    }
    dodgeDpEpoch++;

    const ox = prefix.x, oy = prefix.y;
    // Published so dodgeDpVisible can turn a position into a cell. The epoch
    // bumped just above is what invalidates the last plan's answers, which it
    // has to: the grid's origin, width and cell size all move between plans, so
    // a cached cell index means nothing across one.
    dodgeDpOx = ox; dodgeDpOy = oy; dodgeDpHalf = half; dodgeDpCell = cell;
    for (let i = 0, slot = 0; i < threats.length; i++) {
      const th = threats[i];
      if (!th.blast) continue;
      th.vis = slot < DODGE_VIS_SLOTS ? slot : -1;
      if (th.vis >= 0) dodgeVisBuild(th.vis, th.x, th.y, th.layer);
      slot++;
    }
    const start = half * w + half;
    let curLen = 1, q, layer;

    dodgeDpList[0] = start;
    dodgeDpSeen[start] = ++dodgeDpVisit;
    dodgeDpCost[start] = 0;
    dodgeDpFirst[start] = -1;
    dodgeDpHit[start] = Infinity;
    // No parent for the start: dodgeTraceWalk stops at layer 0 and writes the
    // origin itself as the first point.

    for (layer = 0; layer < steps; layer++) {
      const t0 = layer * dt;
      const visitNext = ++dodgeDpVisit;
      let nextLen = 0;

      for (q = 0; q < curLen; q++) {
        const idx = dodgeDpList[q];
        const base = dodgeDpCost[idx];
        const ix = idx % w, iy = (idx / w) | 0;
        const px = ox + (ix - half) * cell, py = oy + (iy - half) * cell;
        const f0 = dodgeDpFirst[idx], h0 = dodgeDpHit[idx];

        for (let di = 0; di < DODGE_DIRS.length; di++) {
          const mv = dodgeDpMoveFor(idx, di, px, py, speed, dt, walls);
          const e = dodgeDpEdge(px, py, t0, di, dt, speed, mv.x - px, mv.y - py,
                                mv.bent, threats, walls, layer === 0);
          const c = base + e.cost + dodgeAlignPenalty[di] * alignS;

          const jx = half + Math.round((e.x - ox) / cell);
          const jy = half + Math.round((e.y - oy) / cell);
          if (jx < 0 || jy < 0 || jx >= w || jy >= w) continue;
          const j = jy * w + jx;

          const fresh = dodgeDpSeenB[j] !== visitNext;
          if (!fresh && c >= dodgeDpCostB[j]) continue;
          if (fresh) { dodgeDpSeenB[j] = visitNext; dodgeDpListB[nextLen++] = j; }
          dodgeDpCostB[j] = c;
          dodgeDpFirstB[j] = layer === 0 ? di : f0;
          dodgeDpHitB[j] = h0 < e.hit ? h0 : e.hit;
          dodgeDpParentB[j] = idx;
          dodgeDpDirB[j] = di;
        }
      }

      alignS *= alignStep;

      let t;
      t = dodgeDpCost; dodgeDpCost = dodgeDpCostB; dodgeDpCostB = t;
      t = dodgeDpFirst; dodgeDpFirst = dodgeDpFirstB; dodgeDpFirstB = t;
      t = dodgeDpHit; dodgeDpHit = dodgeDpHitB; dodgeDpHitB = t;
      t = dodgeDpSeen; dodgeDpSeen = dodgeDpSeenB; dodgeDpSeenB = t;
      t = dodgeDpList; dodgeDpList = dodgeDpListB; dodgeDpListB = t;
      t = dodgeDpParent; dodgeDpParent = dodgeDpParentB; dodgeDpParentB = t;
      t = dodgeDpDir; dodgeDpDir = dodgeDpDirB; dodgeDpDirB = t;
      curLen = nextLen;
      if (!curLen) break;

      // The beam is what bounds a frame. A firefight puts several times as many
      // rounds in the air as a duel and every one of them is swept on every
      // edge, so the exact search is the thing whose cost is not under our
      // control — the frontier is. 64 measured within noise of the exact
      // search on the bench (3.4% against 3.2%) for a quarter of the time.
      if (DODGE_DP_BEAM && curLen > DODGE_DP_BEAM) {
        dodgeDpOrder.length = 0;
        for (q = 0; q < curLen; q++) dodgeDpOrder.push(dodgeDpList[q]);
        const costs = dodgeDpCost;
        dodgeDpOrder.sort((a, b) => costs[a] - costs[b]);
        for (q = 0; q < DODGE_DP_BEAM; q++) dodgeDpList[q] = dodgeDpOrder[q];
        curLen = DODGE_DP_BEAM;
      }

      // After the prune, so what is kept is exactly what the next layer can be
      // reached from.
      dodgeTraceCapture(layer, dodgeDpList, curLen, dodgeDpParent, dodgeDpDir);
    }

    let bi = -1;
    for (q = 0; q < curLen; q++) {
      const e2 = dodgeDpList[q];
      if (dodgeDpCost[e2] < best.cost) { best.cost = dodgeDpCost[e2]; bi = e2; }
    }
    if (bi >= 0) {
      best.dir = dodgeDpFirst[bi] >= 0 ? dodgeDpFirst[bi] : curDir;
      best.firstHit = dodgeDpHit[bi];
      dodgeTraceWalk(bi, ox, oy, half, w, cell);
    }
    return best;
  }

  function dodgeDirIndex(dx, dy) {
    if (!dx && !dy) return 0;
    for (let i = 1; i < DODGE_DIRS.length; i++) {
      const d = DODGE_DIRS[i];
      if (Math.sign(d.x) === Math.sign(dx) && Math.sign(d.y) === Math.sign(dy)) return i;
    }
    return 0;
  }

  // The heading the user is actually asking for, read past our own synthetic
  // layer. This has to go through realBindDown or the trigger would see the
  // bot's own held keys and latch itself on forever.
  function dodgeUserDirIdx(binds) {
    if (touchActive()) {
      // Their pad, recorded before we replaced it, snapped to the eight
      // headings the planner searches. Snapped by bearing rather than through
      // dodgeDirIndex, whose sign test reads a hair off due east as a diagonal
      // — and an analog stick is almost always a hair off something.
      if (!touchState.moveTouched) return 0;
      const dx = touchState.userMoveDx;
      const dy = touchState.userMoveDy;
      if (!(Math.hypot(dx, dy) > 1e-6)) return 0;
      // DODGE_DIRS runs E, NE, N, ... from index 1, which is exactly the
      // octants of atan2 counterclockwise from due east.
      return 1 + (((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8);
    }
    const left = realBindDown(binds, DODGE_INPUT_LEFT) || dodgeArrowDown.get(37);
    const right = realBindDown(binds, DODGE_INPUT_RIGHT) || dodgeArrowDown.get(39);
    const up = realBindDown(binds, DODGE_INPUT_UP) || dodgeArrowDown.get(38);
    const down = realBindDown(binds, DODGE_INPUT_DOWN) || dodgeArrowDown.get(40);
    return dodgeDirIndex((right ? 1 : 0) - (left ? 1 : 0), (up ? 1 : 0) - (down ? 1 : 0));
  }

  function dodgeApply(binds, dirIdx) {
    const d = DODGE_DIRS[dirIdx];
    if (touchActive()) {
      // The pads never reach the bind layer: on a touch device the movement
      // half of the message is one analog vector off the left pad, so driving
      // it means replacing that reading rather than holding four keys.
      // Suppressing the user comes free — the reading being replaced is theirs.
      touchDriveMove(d.x, d.y);
      return;
    }
    setInputHeld(binds, DODGE_INPUT_RIGHT, d.x > 0);
    setInputHeld(binds, DODGE_INPUT_LEFT, d.x < 0);
    setInputHeld(binds, DODGE_INPUT_UP, d.y > 0);
    setInputHeld(binds, DODGE_INPUT_DOWN, d.y < 0);
    // Whatever we aren't holding, the user doesn't get to hold either —
    // otherwise their W and our S cancel and the dodge goes nowhere.
    for (const inp of DODGE_MOVE_INPUTS) setInputSuppressed(inp, !heldInputs.has(inp));
    suppressArrowMovement = true;
  }

  function dodgeRelease() {
    touchReleaseMove();
    for (const inp of DODGE_MOVE_INPUTS) {
      heldInputs.delete(inp);
      setInputSuppressed(inp, false);
    }
    suppressArrowMovement = false;
    dodgeState.engaged = false;
    dodgeState.dirIdx = 0;
    dodgeState.userHitIn = Infinity;
    dodgeState.planHitIn = Infinity;
    dodgePath.n = 0;
    // The course goes with the keys. Handing them back and keeping a plan
    // around would let a stale one be picked up again by the next step that
    // happened to match it — and every path into here is one where the plan is
    // wrong: the toggle went off, we died, the round ended, or the step threw.
    dodgePlan.n = 0;
    dodgePlan.leg = -1;
    dodgePlan.packet = -1;
  }

  // Our real speed, measured rather than assumed. GameConfig says 12, but
  // water, being downed and a heavy weapon all scale it, and a planner that
  // believes in 12 while the player wades at 9 plans escapes it cannot make.
  //
  // Driven by the packet clock, not by requestAnimationFrame. Position is a
  // step function: it changes once per server update and holds. Polling it on
  // a render frame samples that step at a rate with no relation to the rate it
  // steps at, so the delta and the interval it is divided by come from
  // different packets' worth of time — at 60Hz that read 20 u/s for a player
  // moving 12, and at 144Hz it never cleared the frame-time floor at all and
  // the estimate stayed on its seed forever. One packet's movement over one
  // packet's duration is the speed, with nothing left to alias.
  //
  // The interval is pseudotime — the fitted tick length, `netClock.slope` —
  // and not the wall-clock gap between the two arrivals. Jitter is exactly
  // what the fit exists to remove, and a max estimator has no defence against
  // it: an early packet is a short gap is an inflated sample, and the max then
  // holds that sample for the whole window. Against the fitted clock an early
  // arrival is not a fast player, which is the truth of it.
  //
  // The deltas come from the snapshot ring snapshotPlayers already fills for
  // every player, so this inherits its guards for free — a pooled Player
  // recycled onto a new entity, or a ring straddling a gap, has already had
  // its history cleared and cannot be read here as one tick of movement.
  //
  // Only packets where we were plainly moving teach it anything; a standing
  // player would otherwise drag the estimate to zero.
  //
  // The estimate is the MAX of the last DODGE_SPEED_WINDOW moving deltas, not
  // their average. Individual deltas only ever under-report: a tick spent
  // grinding along a wall, or one where a key went down partway through,
  // covers less ground than the surface actually allows, and on this clock
  // nothing makes one cover more. Averaging folds that floor-noise into the
  // number; the max reads through it. The cost is that a genuine slowdown —
  // stepping into water — takes a full window to show, about half a second.
  function dodgeTrackSpeed(game) {
    const st = dodgeState;
    // Before the fit is up there is no tick length to divide by, and a slope
    // outside the plausible update range means it is fitting noise.
    if (!netClock.ready) return;
    const tickMs = netClock.slope;
    if (!(tickMs >= NET_MIN_UPDATE_MS && tickMs <= NET_MAX_UPDATE_MS)) return;

    const me = findLocalPlayerOnGame(game);
    const snaps = me ? netSmoothState.get(me)?.snaps : null;
    if (!snaps || snaps.length < 2) return;
    const p2 = snaps[snaps.length - 1];
    const p1 = snaps[snaps.length - 2];
    const dn = p2.n - p1.n;
    if (dn < 1) return;
    // pseudotimeOf(p2.n) - pseudotimeOf(p1.n), with the centroid terms both
    // sides share cancelled off: the fitted tick length times the ticks
    // between them. `dn` is normally 1 — it is larger only where the ring kept
    // a pair across ticks that produced no snapshot, and the span is still
    // right for those.
    const dt = (tickMs * dn) / 1000;
    const v = Math.hypot(p2.x - p1.x, p2.y - p1.y) / dt;
    if (v < DODGE_SPEED_MIN || v > DODGE_SPEED_MAX) return;
    st.speedRing[st.speedRingIdx] = v;
    st.speedRingIdx = (st.speedRingIdx + 1) % DODGE_SPEED_WINDOW;
    st.speedSamples++;
    // Rescanned rather than tracked incrementally: the window is 10 wide, and
    // a running max still has to rescan whenever the entry holding it is the
    // one being overwritten.
    const n = Math.min(st.speedSamples, DODGE_SPEED_WINDOW);
    let max = 0;
    for (let i = 0; i < n; i++) if (st.speedRing[i] > max) max = st.speedRing[i];
    st.speed = max;
  }

  // A new round renumbers the packets and swaps the camera, so every sample in
  // the ring was taken against a clock that no longer exists — and against a
  // surface and a loadout that no longer do either. Back to the seed.
  function dodgeResetSpeed() {
    dodgeState.speedRing.fill(0);
    dodgeState.speedRingIdx = 0;
    dodgeState.speedSamples = 0;
    dodgeState.speed = DODGE_SPEED_FALLBACK;
  }

  // ---- Holding a plan, and knowing when to drop it ---------------------
  //
  // The search is deterministic in its inputs. Run it twice against the same
  // world and it returns the same course, so a second run is worth exactly what
  // the world has changed by since the first — and between two server updates
  // the world has changed by nothing the plan did not already model. Rounds
  // move on the client, but they move in straight lines at constant speed,
  // which is precisely how the plan advanced them; re-reading their positions
  // 16ms later just re-derives the state the plan is already holding.
  //
  // So the bot plans on new information and plays the answer out in between.
  // What counts as new information is every input the search reads:
  //
  //   the packet counter   our position, everyone else's, their aim, their
  //                        weapon, the layer, the walls, the measured speed —
  //                        all of it arrives together, so one comparison covers
  //                        the lot (netStats.updates, bumped by the camera
  //                        interp setter, which fires once per update packet)
  //   a round fired        dodgeBulletAdds, off the addBullet hook
  //   a round gone         dodgeState.liveKey, the identity of the live set
  //   the keys             the user's own heading, which is the whole of the
  //                        alignment term and so of what they are asking for
  //   the knobs            anything in the MOD tab the loss reads
  //   the lead             but only past DODGE_LEAD_SLACK_CELLS — see below
  //
  // The user's heading is in that list rather than folded into the packet
  // clock because it is the one input that is theirs and not the server's.
  // Waiting a packet to notice it would put up to a full update of lag on the
  // steering, which is the opposite of what "Follow input" is for.
  //
  // What this is not is a way to commit to a course. A plan is dropped the
  // instant anything it was made against moves, which at 20Hz of updates is
  // about every 50ms, and every leg after the first is still thrown away far
  // more often than it is pressed. It is the same bot, deciding at the rate
  // the information arrives instead of at the rate the monitor refreshes.
  const DODGE_PLAN_KNOBS = ['horizon', 'clearance', 'leadK', 'halfLife',
                            'follow', 'phantom', 'blast', 'stepS', 'cell'];
  const dodgePlanKnobs = new Float64Array(DODGE_PLAN_KNOBS.length);

  // Tests and latches in one pass, so it must be called exactly once per step.
  // A non-finite knob reads as 0 rather than as NaN, which would never compare
  // equal to itself and would quietly put the planner back on every frame.
  function dodgeKnobsChanged() {
    let changed = false;
    for (let i = 0; i < DODGE_PLAN_KNOBS.length; i++) {
      const v = Number(DODGE[DODGE_PLAN_KNOBS[i]]);
      const n = Number.isFinite(v) ? v : 0;
      if (dodgePlanKnobs[i] !== n) { dodgePlanKnobs[i] = n; changed = true; }
    }
    return changed;
  }

  // Where a press made now lands in the plan's own time.
  //
  // Plan time is not wall time offset by a constant: its zero is the moment a
  // press reaches the server, so it is anchored to the far end of the ping
  // lead. A press made `d` seconds after the plan lands `d` seconds later in
  // plan time only while the lead is what it was — and if the link has moved,
  // the press arrives that much earlier or later relative to the world the plan
  // described, which is exactly `prefixS - dodgePlan.lead`.
  //
  // The correction is right for the threats too, and for free. Plan time is one
  // clock for the whole scored world: at plan time `t` the rounds are where the
  // search put them at `t`, because that is how they were swept. So indexing
  // the course at the true `t` reads the leg that was scored against the rounds
  // as they will actually be — a slower link does not just delay our press, it
  // delays it into a world the plan already has an opinion about.
  //
  // It only holds while the plan lasts. A lead that moves far enough to slide
  // the plan's own start off the cell it was rounded to is a different start
  // state, not a different index into this one, and dodgePlanMatches drops the
  // plan instead.
  function dodgePlanTime(now, prefixS) {
    return (now - dodgePlan.at) / 1000 + (prefixS - dodgePlan.lead);
  }

  // Which leg to be pressing, or -1 if the plan has nothing left to say.
  //
  // A negative plan time means the link sped up and our press now lands before
  // the plan's own zero. The opening leg is the answer: it is the heading the
  // plan commits to at its start, and the alternative — pressing nothing —
  // would spend the gap standing still, which the search never scored.
  function dodgePlanLeg(now, prefixS) {
    if (dodgePlan.n <= 0 || !(dodgePlan.dt > 0)) return -1;
    const t = dodgePlanTime(now, prefixS);
    const leg = t <= 0 ? 0 : Math.floor(t / dodgePlan.dt);
    return leg < dodgePlan.n ? leg : -1;
  }

  // Is the standing plan still about the world in front of us?
  function dodgePlanMatches(packet, threats, userDir, prefixS, speed) {
    // No packet clock — the netcode hook never found the camera's interp field
    // — and nothing here can tell a new update from an old one. Every step
    // plans, which is what the bot did before it could hold a course at all.
    if (packet < 0) return false;
    if (dodgePlan.packet !== packet) return false;
    if (dodgePlan.adds !== dodgeBulletAdds) return false;
    if (dodgePlan.live !== dodgeState.liveKey) return false;
    if (dodgePlan.blasts !== dodgeState.blastKey) return false;
    // Phantoms carry no identity of their own, so the count stands in for one.
    // They are packet data — position, aim, weapon — so the counter above has
    // already caught every way one can appear or go; this is belt and braces
    // over the reach filter, which is the one thing about a phantom that can
    // turn over without an update, since it is measured against our own
    // position and our own position is packet data too.
    if (dodgePlan.count !== threats.length) return false;
    if (dodgePlan.userDir !== userDir) return false;
    // The lead, as the distance it slides the plan's start rather than as a
    // time: anything under a cell is what the search rounded away regardless,
    // and dodgePlanTime absorbs it exactly. Past that the plan starts somewhere
    // it wasn't scored from.
    const cell = dodgeClamp(DODGE.cell, 0.05, 0.5, 0.35);
    return Math.abs(prefixS - dodgePlan.lead) * speed <=
      DODGE_LEAD_SLACK_CELLS * cell;
  }

  function dodgeStep() {
    // Movement is read with isBindDown, but a rising edge in setInputHeld
    // also arms isBindPressed for a frame and nothing else would take it
    // back down — and a stale one would sit in front of our own suppression.
    for (const inp of DODGE_MOVE_INPUTS) framePressInputs.delete(inp);

    const game = capturedGame;
    const binds = game?.[GAME_BINDS];
    const me = findLocalPlayerOnGame(game);
    const pos = me ? getXY(me[PLAYER_POS] ?? me.pos) : null;
    const alive = !!pos && !me[PLAYER_NET]?.[NET_DEAD];
    const now = Date.now();

    // Sampled whether or not the bot is on: this is what the debug HUD reads,
    // and a radius sampled only while dodging would be a stale number from the
    // last firefight every time anyone looked at it. Speed is not measured
    // here at all any more — it rides the packet clock, in dodgeTrackSpeed.
    if (alive) dodgeState.selfR = dodgeSelfRadius(me);

    if (!DODGE.enabled || !binds || !alive) {
      if (dodgeState.engaged) dodgeRelease();
      return;
    }
    if (now - dodgeState.lastStepAt < DODGE_PLAN_MS) return;
    dodgeState.lastStepAt = now;
    // Once per step, because it latches what it reads.
    const knobsChanged = dodgeKnobsChanged();

    const layer = Number.isFinite(me.layer) ? me.layer : 0;
    const selfId = Number(me.__id ?? me.playerId ?? 0) || null;
    const roster = findRosterOnGame(game) || game?.[GAME_ROSTER];
    const selfInfo = roster && selfId != null ? dodgePlayerInfo(roster, selfId) : null;

    const ping = smoothedPingMs();
    const leadS = Math.max(0, (Number.isFinite(ping) ? ping : 0) / 1000) *
      dodgeClamp(DODGE.leadK, 0, 2, 1);
    const horizon = dodgeClamp(DODGE.horizon, 0.2, 2, 0.8);
    // Hoisted above the threat build because both are read by the freshness
    // test as well as by the search: the lead is what plan time is anchored to,
    // and the user's heading is an input to the loss in its own right. Their
    // arguments are at the two sites that use them — the prefix carry below,
    // and dodgePlanMatches.
    const prefixS = Math.min(leadS, horizon * 0.5);
    const userDir = dodgeUserDirIdx(binds);
    // The server update this step is looking at, or -1 if the packet clock
    // never came up. See dodgePlanMatches.
    const packet = netStats.hookedCamera ? netStats.updates : -1;

    const speed = dodgeState.speed;
    const reach = speed * horizon;
    // One radius, used for both jobs: obstacles are inflated by it so the
    // planner can be a point, and rounds are tested against it. It is our body
    // as the server collides it and nothing else — the doubt that used to be
    // padded onto it here is now DODGE.clearance, graded, further down.
    // Sampled at the top of the frame, alongside the speed.
    const selfR = dodgeState.selfR;
    const threats = dodgeBuildThreats(game, selfId, selfInfo, roster, layer, leadS, selfR,
      pos.x, pos.y, reach, horizon);
    // Then the rounds nobody has fired: one per hostile whose aim already
    // passes near us. Appended to the same list, and indistinguishable to
    // everything downstream — see dodgeAddPhantoms.
    dodgeAddPhantoms(threats, game, selfId, selfInfo, roster, layer, leadS, selfR,
      pos.x, pos.y, reach, horizon);
    // Then the grenades, which are neither: a blast is not in the air and not a
    // guess about anyone's intentions, it is a clock that has already been
    // started. Appended to the same list and carrying the same fields, with
    // `blast` the one flag the sweeps branch on. See dodgeAddBlasts.
    dodgeAddBlasts(threats, selfId, selfInfo, roster, layer, leadS,
      pos.x, pos.y, speed, horizon);
    // And the grenades still in a hand, whose fuse is already running and whose
    // clock is on the wire. See dodgeAddCookedNades.
    dodgeAddCookedNades(threats, game, selfId, selfInfo, roster, layer, leadS,
      pos.x, pos.y, speed, horizon);
    // The overwhelmingly common case, and the one that has to cost nothing:
    // nothing that could reach us — no round in the air and, with the firing
    // lines term on, nobody's aim passing near us either — so the keys are the
    // user's. This is not a takeover threshold; it is the planner having
    // nothing to plan against, in which case its answer would be the user's own
    // heading anyway. See the section header.
    //
    // Phantoms make this fire less often, and that is the cost of the term
    // rather than a side effect of it: being aimed at is a thing the planner
    // now has an opinion about, so it plans while it is true. What keeps that
    // from meaning "always" is dodgeAddPhantoms' own reach filter — a gun
    // pointed anywhere that cannot reach anywhere we could be inside the
    // horizon contributes nothing at all.
    if (!threats.length) {
      if (dodgeState.engaged) dodgeRelease();
      return;
    }

    // Nothing the last plan was made against has moved, and the plan still has
    // a leg for the moment our press will land in. Press it. This is the common
    // case by a wide margin — updates arrive at ~20Hz and steps run at up to
    // 60Hz, so two steps in three answer here, and the search does not run.
    //
    // Everything above this line still runs on every step, and has to: the
    // threat set is what says whether the keys are still ours to hold, and it
    // is also half of the freshness test. What is skipped is the search, which
    // is two orders of magnitude more of the frame than the rest of it.
    const leg = dodgeState.engaged && !knobsChanged &&
      dodgePlanMatches(packet, threats, userDir, prefixS, speed)
      ? dodgePlanLeg(now, prefixS) : -1;
    if (leg >= 0) {
      dodgeState.dirIdx = dodgePlan.dirs[leg];
      dodgeState.leadS = prefixS;
      dodgePlan.leg = leg;
      // The plan is current, not stale — it is being pressed. Without this the
      // drawn line ages out between packets on a slow link.
      dodgePath.at = now;
      dodgeApply(binds, dodgeState.dirIdx);
      return;
    }

    dodgeGrowThreats(threats.length);

    const walls = dodgeBuildWalls(pos.x, pos.y, reach + selfR, layer, selfR);

    // The plan's own start state has to be led, not just the threats'. Whatever
    // we choose this frame is not acted on until it reaches the server, and
    // until then we keep going the way we are already going — so the rollout
    // starts from where that leaves us, not from where we are. Capped at half
    // the horizon so a bad link cannot move the start of the plan further than
    // the plan is long. It is a position correction and nothing else: see
    // dodgeCarry for why running it as a scored leg is a bug and not a
    // shortcut.
    //
    // The current heading is ours while engaged and the user's otherwise, and
    // either way it seeds the context's lastDir, which is what dodgeDpPlan
    // falls back to when no state survives the search.
    dodgeState.leadS = prefixS;
    const curDir = dodgeState.engaged ? dodgeState.dirIdx : userDir;
    dodgeCtxReset(dodgeCtxPrefix, pos.x, pos.y, curDir, threats.length);
    dodgeCarry(dodgeCtxPrefix, curDir, prefixS, speed, walls);

    // Does the course the user is on get hit, and when? This used to be the
    // takeover's question and the only thing that could engage the bot; it
    // decides nothing now and is kept purely for the HUD, where it is the one
    // number that says whether the bot is earning its keep — read it against
    // `planHitIn` for what the plan does about it. One rollout of nine legs
    // against the several thousand edges of the search below, so it is not
    // what a frame costs.
    dodgeCtxCopy(dodgeCtxWork, dodgeCtxPrefix, threats.length);
    dodgeAdvance(dodgeCtxWork, userDir, horizon, threats, speed, walls, horizon);
    dodgeState.userHitIn = dodgeCtxFirstHit(dodgeCtxWork, threats);

    const planAt = performance.now();
    const plan = dodgeDpPlan(threats, speed, walls, horizon, userDir);
    dodgeState.planMs = performance.now() - planAt;
    dodgeState.engaged = true;
    // The opening heading, taken off the walked-back course where there is one
    // so that what is pressed now and what is held next step cannot come from
    // two different readings of the same search. They agree by construction —
    // dodgeDpFirst is the layer-0 heading of the winner's own chain, and so is
    // dirs[0] — and reading one of them twice is how it stays that way.
    const open = dodgePlan.n > 0 ? dodgePlan.dirs[0] : plan.dir;
    dodgeState.dirIdx = open;
    dodgeState.planHitIn = plan.firstHit;
    dodgeState.planCost = plan.cost;
    // What this plan is about, so the next step can ask whether any of it still
    // is. `at` and `lead` are the two halves of its clock — see dodgePlanTime.
    dodgePlan.at = now;
    dodgePlan.lead = prefixS;
    dodgePlan.leg = 0;
    dodgePlan.packet = packet;
    dodgePlan.adds = dodgeBulletAdds;
    dodgePlan.live = dodgeState.liveKey;
    dodgePlan.blasts = dodgeState.blastKey;
    dodgePlan.count = threats.length;
    dodgePlan.userDir = userDir;
    // Where the newest packet put us, as against dodgePath[0], which is where
    // the lead prefix leaves us. Stamped here rather than in the search because
    // the search is handed the prefix and never sees this. Not the position the
    // sprite is drawn at either — that is the playout, further back again; see
    // drawDodgePlan for the three of them.
    dodgePath.startX = pos.x;
    dodgePath.startY = pos.y;
    dodgePath.at = now;
    dodgeApply(binds, open);
  }

  // ---- Frag aim -----------------------------------------------------------
  //
  // While a grenade is cooking in our hand, the cursor is driven every frame to
  // the throw that would land nearest the target — so releasing at any instant
  // throws it there, and the user's job is reduced to deciding *when*.
  //
  // Driving continuously rather than fixing the aim on release turns out to be
  // both simpler and better. Simpler because there is nothing to defer: the
  // game builds one input message a frame from whatever the cursor currently
  // is, so if the cursor has been right on every frame then it is right on the
  // frame the release happens to land in, and no part of the release has to be
  // intercepted or held back. Better because the throw is no longer a single
  // solved instant that may already be stale by the time the packet goes out —
  // it is re-solved against where the target is now, sixty times a second,
  // until the moment it is let go.
  //
  // The user's real mouse is suppressed while this is driving, exactly as it is
  // while the gun aimbot's key is held, but it is still *recorded* — target
  // selection reads it, so moving the (invisible) cursor still chooses who to
  // throw at. That division is deliberate: this answers "how hard, and in what
  // direction", which is the part a human is bad at, and never "who".
  const fragState = {
    driving: false,
    x: 0, y: 0,               // the synthetic cursor, in screen pixels
    targetId: null,
    err: 0,
    // The solved landing point, so the overlay ring can show where the grenade
    // is actually going rather than where the suppressed cursor points.
    landX: 0, landY: 0, haveLand: false,
    // Last frame's answer, used to warm-start the next solve.
    bearing: NaN, len: NaN,
  };

  function fragActive() { return fragState.driving; }

  // Hand the cursor back. Replays the user's real position once so the game's
  // aim snaps to where their mouse actually is rather than holding the last
  // thing we sent.
  function fragRelease() {
    if (!fragState.driving) return;
    fragState.driving = false;
    fragState.targetId = null;
    fragState.haveLand = false;
    fragState.bearing = NaN; fragState.len = NaN;
    touchReleaseAim('frag');
    if (touchActive()) return;
    if (!realMouse.hasMoved) return;
    fragDispatch(Math.round(realMouse.x), Math.round(realMouse.y));
  }

  function fragDispatch(x, y) {
    const target = document.querySelector('canvas') || document.body;
    if (!target) return;
    try {
      target.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
      }));
    } catch {}
  }

  function fragTick() {
    if (!FRAGBOT.enabled) { fragRelease(); return; }

    const game = capturedGame;
    const me = findLocalPlayerOnGame(game);
    const selfId = Number(me?.__id ?? 0) || null;
    if (!me || !selfId) { fragRelease(); return; }

    // Cooking, with a fuse on it. This is the whole gate — the cook state is
    // exactly "the pin is out and it has not left our hand", and it ends by
    // itself the moment the throw goes out. Impact throwables are excluded by
    // dodgeCookPhys and should be: their whole flight is the aim, and there is
    // no detonation point to solve for.
    const nTick = netClock.n - 1;
    const st = dodgeCook.get(selfId);
    const phys = dodgeCookPhys(st, nTick);
    if (!phys) { fragRelease(); return; }

    const sample = pageSamples[pageSamples.length - 1];
    const player = sample ? liveSelf(sample) : null;
    if (!player || !sample.enemies?.length) { fragRelease(); return; }
    const [enemy] = pickTarget(player, sample.enemies, Date.now());
    if (!enemy) { fragRelease(); return; }

    const left = Math.max(0, phys.fuse - dodgeCookElapsed(st, nTick));
    if (!(left > 0.05)) { fragRelease(); return; }   // already going off

    // Where they will be when it detonates. Their position is a one-way trip
    // old and a release now lands a one-way trip from now, which is the round
    // trip; the fuse burns on top of that. Read off the same recovered clock
    // the aim helper leads with, so a strafing target is led and a standing one
    // is not.
    const tNow = performance.now();
    const leadMs = (smoothedPingMs() ?? 0) + left * 1000;
    const pair = clockPairAt(enemy.id, tNow);
    const at = pair ? pairAt(pair, tNow + leadMs) : {
      x: enemy.x + (enemy.xv ?? 0) * (leadMs / 1000),
      y: enemy.y + (enemy.yv ?? 0) * (leadMs / 1000),
    };

    const layer = Number.isFinite(me.layer) ? me.layer : 0;
    const c = dodgeThrowContext(phys, me, layer, left);
    if (!c.ok) { fragRelease(); return; }

    // Warm start from last frame. Solving sixty times a second against a target
    // that moves smoothly means the previous answer is nearly this one, so the
    // sweep can open much narrower — but only while it is the same target and
    // the last solve actually converged, or a stale seed would anchor the
    // search somewhere it should have left.
    const warm = fragState.driving && fragState.targetId === enemy.id &&
      Number.isFinite(fragState.bearing) ? fragState : null;
    const sol = fragSolve(c, at.x, at.y, warm);

    // A pad carries the throw as a bearing and a pull, so there is no screen
    // point to put it at and no scale needed to get there. A mouse needs both,
    // and a scale of zero means the camera isn't readable yet.
    const touch = touchActive();
    const scale = touch ? 1 : getLivePxPerWorldUnit(sample);
    if (!(scale > 0)) { fragRelease(); return; }

    if (!touch) {
      fragState.x = Math.round(window.innerWidth / 2 + sol.dx * sol.len * scale);
      fragState.y = Math.round(window.innerHeight / 2 - sol.dy * sol.len * scale);
    }
    fragState.targetId = enemy.id;
    fragState.err = sol.err;
    fragState.landX = sol.x; fragState.landY = sol.y; fragState.haveLand = true;
    fragState.bearing = Math.atan2(sol.dy, sol.dx);
    fragState.len = sol.len;
    fragState.driving = true;
    // The solved cursor distance goes out as the pad's own pull. It is the
    // whole of the throw's strength, and on a pad it is the only way to say it.
    if (touch) touchDriveAim('frag', sol.dx, sol.dy, sol.len);
    else fragDispatch(fragState.x, fragState.y);
  }

  function fragFrameTick() {
    try { fragTick(); } catch { try { fragRelease(); } catch {} }
    requestAnimationFrame(fragFrameTick);
  }
  requestAnimationFrame(fragFrameTick);

  window.__frag = () => ({
    enabled: !!FRAGBOT.enabled,
    // Driving means the cursor is ours this frame: we are cooking, there is a
    // target, and a throw at it has been solved.
    driving: fragState.driving,
    targetId: fragState.targetId,
    // How far the solved throw misses the extrapolated target by, in units. A
    // few hundredths is the search resolution; several units means a wall.
    missBy: Number(fragState.err.toFixed(2)),
  });

  function dodgeFrameTick() {
    try {
      dodgeStep();
    } catch {
      // Never leave the movement keys taken away because of our own bug.
      try { dodgeRelease(); } catch {}
    }
    requestAnimationFrame(dodgeFrameTick);
  }
  requestAnimationFrame(dodgeFrameTick);

  // Console handle, matching __bulletGeom / __wallDiag.
  window.__dodge = () => ({
    enabled: !!DODGE.enabled,
    engaged: dodgeState.engaged,
    heading: ['stand', 'E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][dodgeState.dirIdx],
    speed: Number(dodgeState.speed.toFixed(2)),
    // Our hitbox as the game tests it. 1 means either scale is 1 or the field
    // could not be read; `scaled` says which.
    radius: Number(dodgeState.selfR.toFixed(3)),
    scaled: !!NET_SCALE,
    // The falloff's half-life: a round clearing the body by this much is
    // billed half a hit, by twice this a quarter, and so on.
    clearance: Number(dodgeClamp(DODGE.clearance, 0.05, 1.5, 0.35).toFixed(3)),
    pingMs: smoothedPingMs(),
    // Everything the planner is solving against, and the split. `threats` is
    // the total; `live` is rounds genuinely in the air and `phantoms` is
    // hostiles whose aim currently passes close enough to be charged for — one
    // per enemy, never more. See dodgeAddPhantoms.
    threats: dodgeState.threats.length,
    live: dodgeState.threats.filter((t) => !t.phantom && !t.blast).length,
    phantoms: dodgeState.threats.filter((t) => t.phantom && !t.blast).length,
    // Grenades whose blast is being planned against, and the worst of them in
    // HP at the centre — 125 for a frag, before the falloff and before the
    // distance any plan puts between us and it. `blastIn` is how long the
    // soonest of them has left, in seconds of plan time; it reads exactly
    // `horizon` for a fuse the planner could not see the end of, which is the
    // clamp in dodgeAddBlasts and not a measurement.
    blasts: dodgeState.threats.filter((t) => t.blast && !t.phantom).length,
    // Grenades still in a hand with the fuse already running, priced as
    // phantoms — see dodgeAddCookedNades. Counted apart from `blasts` because
    // one is a thing that exists and the other is a thing somebody is holding.
    cooking: dodgeState.threats.filter((t) => t.blast && t.phantom).length,
    worstBlast: Number(dodgeState.threats.reduce(
      (m, t) => (t.blast ? Math.max(m, t.dmg) : m), 0).toFixed(1)),
    blastIn: dodgeState.threats.reduce(
      (m, t) => (t.blast && !t.phantom ? Math.min(m, t.tBoom) : m), Infinity),
    // Every cook we are currently watching: who, what, and how long it has been
    // burning. This is the readout that says whether the fix for cooks is
    // working — a cook that never appears here is one the animation watch
    // missed, and its grenade will arrive with a fuse read as full.
    cooks: (() => {
      const nn = netClock.n - 1;
      const out = [];
      for (const [id, st] of dodgeCook) {
        if (!dodgeCookPhys(st, nn)) continue;
        out.push({ id, weap: st.weap, held: Number(dodgeCookElapsed(st, nn).toFixed(2)),
                   exact: st.exact });
      }
      return out;
    })(),
    // Grenades in the air whose cook we actually timed, against how many are
    // being tracked at all. A `cookTimed` under `tracked` is not a fault — most
    // throws are not cooked, and an untimed one is assumed uncooked — but a
    // ratio that is always zero means the anim watch is not seeing throws.
    tracked: dodgeProj.size,
    cookTimed: (() => { let k = 0; for (const r of dodgeProj.values()) if (r.cookExact) k++; return k; })(),
    // Grenades whose thrower the throw animation named outright, against those
    // attributed by falling back to the nearest body. Only a named one can make
    // a grenade harmless, so an `owned` well under `tracked` in a squad means
    // the bot is dodging its own team's grenades — see dodgeProjThrower.
    owned: (() => { let k = 0; for (const r of dodgeProj.values()) if (r.throwerSure) k++; return k; })(),
    // Every grenade in the air: type, who threw it, how sure of that, and how
    // long the fuse has left. The one readout that says whether attribution is
    // working at all.
    nades: [...dodgeProj.values()].map((r) => ({
      type: r.type,
      thrower: r.thrower || null,
      sure: r.throwerSure,
      cooked: r.cookExact ? Number(r.cooked.toFixed(2)) : null,
      fuse: Number(Math.max(0, r.boomT - (Date.now() - r.at) / 1000).toFixed(2)),
    })),
    // Worst round in the air, in HP, and how many of the *live* ones we could
    // actually name. A `typed` well under `live` means the addBullet hook went
    // on mid-flight or survev has shipped a bullet BULLET_DAMAGE doesn't list —
    // either way those rounds are priced at DODGE_DMG_REF. Phantoms are always
    // named (they are priced from the gun, or they do not exist) and so are
    // counted in neither, or they would hide exactly that failure.
    worstDmg: Number(dodgeState.threats.reduce(
      (m, t) => (t.phantom || t.blast ? m : Math.max(m, t.dmg)), 0).toFixed(1)),
    typed: dodgeState.threats.filter((t) => !t.phantom && !t.blast && !!BULLET_DAMAGE[t.type]).length,
    // What the worst line currently aimed at us would take off if it were
    // fired, before DODGE.phantom's discount. 0 with nothing pointed our way.
    worstAimed: Number(dodgeState.threats.reduce(
      (m, t) => (t.phantom && !t.blast ? Math.max(m, t.dmg) : m), 0).toFixed(1)),
    walls: dodgeState.walls.length,
    leadMs: Math.round(dodgeState.leadS * 1000),
    userHitIn: dodgeState.userHitIn,
    planHitIn: dodgeState.planHitIn,
    planMs: Number(dodgeState.planMs.toFixed(2)),
    // The course being held and where in it we are. `planLeg` climbing off 0
    // is the plan being played out — it means the press about to land falls
    // past the first decision, i.e. more than one step of plan time has gone by
    // without the world producing anything new. `planAgeMs` is wall time since
    // the search ran, and at a healthy 20Hz of updates it sits under 50.
    planLeg: dodgePlan.leg,
    planLegs: dodgePlan.n,
    planAgeMs: dodgePlan.n > 0 ? Math.round(Date.now() - dodgePlan.at) : 0,
    // Points in the drawn plan, one per layer plus the start. 0 whenever
    // "Show plan" is off — nothing walks the search back otherwise.
    pathPts: dodgePath.n,
    barnFound: !!findBulletBarn(capturedGame),
  });

  // ---------------------------------------------------------------------
  // Debug HUD: hold Tab for the two numbers the dodge planner infers rather
  // than reads.
  //
  // Both are guesses, and both are guesses the rest of the bot is built on top
  // of, which is the whole reason they are worth a panel. GameConfig says the
  // player moves at 12 and collides at radius 1; neither is what happens.
  // Speed is whatever the current surface, weapon and stance leave of it, so
  // it is measured off our own per-packet position deltas, on the recovered
  // tick clock (dodgeTrackSpeed). Radius is
  // `scale * cfg.player.radius` off the wire, so it is 1 only until someone
  // is scaled (dodgeSelfRadius). If either drifts from what the eye says,
  // every distance the planner solves is wrong by the same factor and there
  // is otherwise nothing to see.
  //
  // Tab and not a bound key: keyCode 9 appears in survev's bind table only as a
  // name it can print, never as a default bind, so nothing is being taken from
  // the game. Held rather than toggled so it cannot be left on by accident.
  // `preventDefault` is not optional — Tab's default is to walk focus off the
  // canvas, which would silently eat the movement keys.
  // ---------------------------------------------------------------------
  const DEBUG_HUD_KEY = 9;   // Tab
  const debugHud = { el: null, speed: null, radius: null, held: false, raf: 0 };

  function ensureDebugHudEl() {
    if (debugHud.el && debugHud.el.isConnected) return debugHud.el;
    const parent = document.body || document.documentElement;
    if (!parent) return null;
    const el = debugHud.el || document.createElement('div');
    if (!debugHud.el) {
      el.style.cssText = [
        'position:fixed', 'top:50%', 'left:12px', 'transform:translateY(-50%)',
        'padding:8px 10px', 'border-radius:4px',
        'background:rgba(0,0,0,0.55)',
        'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
        'color:#fff', 'text-shadow:0 1px 2px rgba(0,0,0,0.9)',
        // Same z-index as the enemy overlay, and equally untouchable: this
        // sits over the canvas the game reads clicks from.
        'pointer-events:none', 'user-select:none', 'white-space:pre',
        'z-index:2147483647', 'display:none',
      ].join(';');
      const mk = (label) => {
        const row = document.createElement('div');
        const val = document.createElement('span');
        row.textContent = label;
        row.appendChild(val);
        el.appendChild(row);
        return val;
      };
      debugHud.speed = mk('speed   ');
      debugHud.radius = mk('radius  ');
      debugHud.el = el;
    }
    if (!el.isConnected) parent.appendChild(el);
    return el;
  }

  // One frame of the panel. Reads dodgeState rather than the game because
  // dodgeStep already samples both every frame, bot or no bot — see the
  // measurement block at the top of it.
  function debugHudFrame() {
    if (!debugHud.held) { debugHud.raf = 0; return; }
    const el = ensureDebugHudEl();
    if (el) {
      const live = !!findLocalPlayerOnGame(capturedGame);
      // Until a packet delta has actually landed in the ring, `speed` is still
      // the GameConfig figure it was seeded with, and saying so is the point
      // of the panel.
      const measured = live && dodgeState.speedSamples > 0;
      debugHud.speed.textContent = measured
        ? `${dodgeState.speed.toFixed(2)} u/s`
        : `${DODGE_SPEED_FALLBACK.toFixed(2)} u/s (default)`;
      debugHud.radius.textContent = !live
        ? '—'
        : NET_SCALE
          ? `${dodgeState.selfR.toFixed(3)} u`
          : `${dodgeState.selfR.toFixed(3)} u (unscaled)`;
      el.style.display = 'block';
    }
    debugHud.raf = requestAnimationFrame(debugHudFrame);
  }

  function debugHudHide() {
    debugHud.held = false;
    if (debugHud.raf) { cancelAnimationFrame(debugHud.raf); debugHud.raf = 0; }
    if (debugHud.el) debugHud.el.style.display = 'none';
  }

  window.addEventListener('keydown', (e) => {
    // Never while a bind is being captured or the caret is in one of our own
    // fields — Tab is how you leave a form, and stealing it there would trap
    // the user in the settings pane.
    if (e.keyCode !== DEBUG_HUD_KEY || bindCapture || typingInElgField()) return;
    e.preventDefault();
    if (debugHud.held) return;          // key repeat
    debugHud.held = true;
    if (!debugHud.raf) debugHud.raf = requestAnimationFrame(debugHudFrame);
  }, true);

  window.addEventListener('keyup', (e) => {
    if (e.keyCode === DEBUG_HUD_KEY) debugHudHide();
  }, true);

  // Alt-Tab and clicking away both take the window's focus with the key still
  // down, and no keyup is ever coming for it.
  window.addEventListener('blur', debugHudHide);

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
  //   The render extrapolates rather than freezing — a render time past the
  //   newest snapshot continues along the same line, for up to
  //   NET_MAX_EXTRAP_MS past it — but it is taken half a tick behind the clock
  //   rather than at `t_now`, so most
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
  // How far past the newest snapshot the position lerp may be extended. Inside
  // this the render keeps coasting along the last segment, which is what covers
  // an ordinary stall; past it the position freezes rather than sliding off on
  // a velocity the server stopped confirming a fifth of a second ago.
  const NET_MAX_EXTRAP_MS = 200;

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
  // The render extrapolates, so a stall is coasted through rather than frozen
  // — bounded at NET_MAX_EXTRAP_MS past the newest snapshot, so a stall that
  // is really a disconnect stops rather than sliding away — and it is taken at
  // `t_now - renderLag * tick` rather than at
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
    dodgeResetSpeed();
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

  // ---- TEMP DEBUG: per-packet self displacement ----------------------------
  // Logs how far our own position moved between consecutive server updates.
  // Reads the pair snapshotPlayers just pushed, so the delta is netData pos
  // (the server's authoritative position), never the interpolated render pos.
  // Off by default; turn it on at runtime with
  // `window.__SURVEV_LOG_DISP__ = true`. Remove this block and its call in the
  // camera setter when done.
  window.__SURVEV_LOG_DISP__ = false;
  // Standing still gives a delta of exactly 0 — position is quantized on the
  // wire, so a still player re-sends the identical value and the difference is
  // bit-for-bit zero. The threshold is here for the case that isn't: a delta
  // of one quantum from a rounding boundary, which is not movement. Well under
  // one tick of the slowest real motion (~0.15u for a downed crawl at 50ms),
  // so nothing you actually did gets swallowed.
  const DISP_LOG_MIN_U = 0.01;
  function debugLogSelfDisplacement(game) {
    if (!window.__SURVEV_LOG_DISP__) return;
    const me = findLocalPlayerOnGame(game);
    const snaps = me ? netSmoothState.get(me)?.snaps : null;
    if (!snaps || snaps.length < 2) return;
    const p2 = snaps[snaps.length - 1];
    const p1 = snaps[snaps.length - 2];
    const dn = p2.n - p1.n;
    if (dn < 1) return;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);
    if (dist < DISP_LOG_MIN_U) return;
    // Speed is only meaningful once the clock fit is up; before that report
    // the displacement alone rather than dividing by a slope that is noise.
    const tickMs = netClock.ready ? netClock.slope : NaN;
    const speed = Number.isFinite(tickMs) ? dist / ((tickMs * dn) / 1000) : NaN;
    console.log(
      `[${SOURCE}] disp n=${p2.n}${dn > 1 ? ` (+${dn} ticks)` : ''} ` +
      `d=(${dx.toFixed(3)}, ${dy.toFixed(3)}) |d|=${dist.toFixed(3)}u ` +
      `raw=${netStats.rawMs.toFixed(1)}ms ` +
      `tick=${Number.isFinite(tickMs) ? tickMs.toFixed(1) + 'ms' : 'n/a'} ` +
      `v=${Number.isFinite(speed) ? speed.toFixed(2) + 'u/s' : 'n/a'} ` +
      `pos=(${p2.x.toFixed(2)}, ${p2.y.toFixed(2)})`
    );
  }
  // ---- end TEMP DEBUG ------------------------------------------------------

  // ---- TEMP DEBUG: per-packet server update interval -----------------------
  // Collects the gap between consecutive server update packets and prints the
  // batch every 3 seconds as one line — the dts alone, in arrival order. The
  // gap is the game's own `(now - lastUpdateTime)` measurement, i.e. exactly
  // what survev divides its lerp by. Off by default; turn it on at runtime
  // with `window.__SURVEV_LOG_TICK__ = true`. Remove this block and its call
  // in the camera setter when done.
  window.__SURVEV_LOG_TICK__ = false;
  const TICK_LOG_BATCH_MS = 3000;
  const tickLog = { dts: [], since: 0 };
  function debugLogUpdateInterval() {
    if (!window.__SURVEV_LOG_TICK__) return;
    const raw = netStats.rawMs;
    if (!Number.isFinite(raw)) return;
    const now = performance.now();
    // First packet after a toggle or a fresh camera starts the window here
    // rather than at 0, so the opening batch is a real 3s and not everything
    // since page load.
    if (!tickLog.since) tickLog.since = now;
    tickLog.dts.push(raw);
    if (now - tickLog.since < TICK_LOG_BATCH_MS) return;
    console.log(`[${SOURCE}] ${tickLog.dts.map((d) => d.toFixed(1)).join(' ')}`);
    tickLog.dts.length = 0;
    // Advance from the deadline, not from `now`: the flush happens on a packet
    // arrival, which is up to a tick late, and resetting to `now` would let
    // that lateness accumulate and stretch the batches past 3s.
    tickLog.since += TICK_LOG_BATCH_MS;
    // Unless we were away long enough to miss whole windows (tab blur, round
    // change), in which case skip forward instead of flushing empty batches.
    if (now - tickLog.since >= TICK_LOG_BATCH_MS) tickLog.since = now;
  }
  // ---- end TEMP DEBUG ------------------------------------------------------

  // Position on the recovered clock. Given the last two snapshots p1@t1 and
  // p2@t2 in pseudotime, render at
  //     p1 * (t_now - t2)/(t1 - t2) + p2 * (t1 - t_now)/(t1 - t2)
  // which is the standard two-point lerp written over (t1 - t2); the weights
  // sum to 1 for any t_now. The upper end is left open by NET_MAX_EXTRAP_MS
  // rather than at the newest snapshot, so t_now past t2 keeps extrapolating
  // along the same line — that is what carries an ordinary stall — but the
  // render time is clipped to max(t1, t2) + NET_MAX_EXTRAP_MS, so a stall long
  // enough to be a disconnect or a tab-blur parks the player at the end of
  // that coast instead of running off the map. The lower end stays open: t_now
  // before t1 runs the same segment backwards, which is continuous.
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
    // Clip the render time to a fixed budget past the newer of the two
    // snapshots. Written over max(t1, t2) rather than t2 so it still holds if
    // the pair is ever handed over in the other order.
    const limit = Math.max(t1, t2) + NET_MAX_EXTRAP_MS;
    const t = nowMs > limit ? limit : nowMs;
    const w1 = (t - t2) / d;
    const w2 = (t1 - t) / d;
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
            // Before the snapshot work, so a throw in there still leaves the
            // interval log running.
            debugLogUpdateInterval();
            snapshotPlayers(game);
            // Before the projectiles, because a grenade appearing this tick is
            // dated by the throw animation of the tick before it — and after
            // clockOnPacket, because both measure in ticks and convert with the
            // slope it has just refit.
            trackCookAnims(game);
            snapshotProjectiles(game);
            // Strictly after both: it reads the pair snapshotPlayers has just
            // pushed, against the tick length clockOnPacket has just refit.
            dodgeTrackSpeed(game);
            debugLogSelfDisplacement(game);
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

  // ---- Bullets on the render clock --------------------------------------
  //
  // Everything drawn should represent the same instant, and by default it does
  // not. Players render at `renderNowMs()` — the recovered clock, held
  // `renderLag` ticks back — while bullets are a pure client-side simulation
  // that the barn advances by frame dt, so they are drawn at
  // `performance.now()`. Every tracer on screen is therefore half a tick ahead
  // of every body on screen. At 20Hz that is 25ms, which a Barrett round
  // spends 5.4 units of travel on — five player radii, and the difference
  // between a round that looks like it missed and one that looks like it hit.
  //
  // This is survev's own inconsistency rather than one the smoothing
  // introduces: stock survev lerps players a whole tick behind the newest
  // snapshot while running bullets in real time, so the gap there is larger.
  // Part A narrows it. This closes it.
  //
  // The correction is one substitution in the barn's render pass and nothing
  // else. `pos` is left exactly as the barn computed it, because the barn's
  // own update integrates it, tests the segment it swept against obstacles and
  // players for the tracer-stop and the whiz sound, and the dodge bot reads it
  // to build its threat list — every one of which wants the true simulated
  // position and none of which is a render. Only the value the sprite
  // transform is handed gets moved, by walking each round back along its own
  // direction by the same lag the player render is held at, and it is put back
  // before the frame ends. The barn recomputes the tracer's length from
  // `pos - startPos` in that same pass, so a round drawn earlier in its flight
  // gets the shorter trail it had then for free.
  //
  // The one thing this cannot do is un-draw a round that had not been fired
  // yet at render time. Walking back is clamped at the muzzle instead, so a
  // new bullet sits at its start point for up to half a tick and then sets
  // off — which is what the shot looked like from the server's side anyway.
  //
  // The impact is the mirror image of that, and it is where a fixed offset
  // stops being the same clock. When a round hits something the barn snaps
  // `pos` onto the contact point, clears `alive` and holds it there while
  // `scale` retracts the streak into that point over ~167ms. A dead round is
  // no longer where it was a lag ago — it *stopped* — so subtracting the same
  // distance for the whole fade draws it at no instant at all, collapsing the
  // trail 5.4 units short of the rock it visibly just hit (a Barrett at 214
  // u/s over half a 20Hz tick) with the spark stranded out at the surface for
  // ten frames.
  //
  // Reading the clock literally fixes it. The shift is `speed * (the part of
  // the lag the round was still in the air for)`, which is the whole lag while
  // it flies and then runs down to nothing over the lag after it dies — so the
  // tracer covers its last stretch, arrives at the contact point about a frame
  // and a half after the spark does, and rests there for the remainder of the
  // fade. It needs the time of death, which is stamped in the loop below,
  // because `pos` alone no longer says when the round got there.
  //
  // This rides the master Smoothing switch rather than a toggle of its own:
  // the whole point of the clock is that one instant is drawn, and a smoothed
  // world with bullets left at `t_now` is the incoherent half-state. It does
  // cost half a tick of warning on incoming fire, which is the price of the
  // tracer and the body agreeing about when they are; the dodge bot is
  // unaffected either way, since it reads the barn's true positions and never
  // looks at a sprite.
  const netBulletShift = { idx: [], x: [], y: [] };
  let netBarnRenderKey = null;
  let netBarnHooked = null;

  // The barn's render pass, by shape. survev leaves `onMapLoad`, `addBullet`
  // and `createBulletHit` readable and mangles the other two; of those, the
  // update takes eight arguments and the render takes one. So the render is
  // the only arity-1 method on the prototype that is not `onMapLoad`. If a
  // future bundle makes that ambiguous this returns null and the whole feature
  // turns itself off, which is the right failure: a wrong guess here would
  // wrap the update and quietly corrupt the simulation.
  function findBarnRenderKey(barn) {
    const proto = Object.getPrototypeOf(barn);
    if (!proto || proto === Object.prototype) return null;
    let found = null;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name === 'onMapLoad') continue;
      let fn;
      try { fn = proto[name]; } catch { continue; }
      if (typeof fn !== 'function' || fn.length !== 1) continue;
      if (found) return null;   // ambiguous: refuse rather than guess
      found = name;
    }
    return found;
  }

  // How far behind `performance.now()` the render is taken. Not just
  // `renderNowMs()`: this is the time renderOnClock *actually resolves a
  // player at*, which is that held back further by the extrapolation clip. Two
  // terms, in order:
  //
  //   the playout delay, `slope * renderLag`, capped at NET_MAX_UPDATE_MS so a
  //   runaway fit cannot ask for an absurd walk-back; then
  //
  //   the clip. renderOnClock refuses to carry a player more than
  //   NET_MAX_EXTRAP_MS past its newest snapshot, so once a stall runs long
  //   the bodies stop at the end of that coast. Applying the same ceiling here
  //   makes the lag grow at exactly the rate real time does, which holds the
  //   tracers still beside them — without it they fly on through a frozen
  //   world, which is the one place the two clocks used to part. The growth is
  //   deliberately left unbounded: it is self-limiting, since a round in the
  //   air is drawn frozen and one that has already landed fades out on its own
  //   ~167ms regardless, and the muzzle clamp below bounds the walk-back in
  //   any case.
  //
  // `netClock.n - 1` is the index snapshotPlayers last recorded at, so its
  // pseudotime is the newest snapshot every player still in the pool holds —
  // the same `max(t1, t2)` renderOnClock clips against.
  //
  // Zero until the clock fit is usable, so a fresh round draws stock until
  // there is a slope to trust.
  function netRenderLagS() {
    if (!NETCODE.enabled || !netClock.ready) return 0;
    const now = performance.now();
    const playout = netClock.slope * NETCODE.renderLag;
    if (!Number.isFinite(playout) || playout < 0) return 0;
    let t = now - Math.min(playout, NET_MAX_UPDATE_MS);
    const limit = pseudotimeOf(netClock.n - 1) + NET_MAX_EXTRAP_MS;
    if (Number.isFinite(limit) && t > limit) t = limit;
    const ms = now - t;
    return ms > 0 ? ms / 1000 : 0;
  }

  // Wrapped on the prototype rather than the instance: a new round builds a
  // fresh barn but reuses the class, so this installs once and survives. The
  // Smoothing toggle is read per call — through netRenderLagS, which returns 0
  // with it off — so turning it off restores stock drawing live rather than
  // leaving a dead wrapper behind.
  function installBulletRenderHook(game) {
    const barn = findBulletBarn(game);
    if (!barn) return;
    const proto = Object.getPrototypeOf(barn);
    if (!proto || netBarnHooked === proto) return;
    const key = netBarnRenderKey || findBarnRenderKey(barn);
    if (!key) { netBarnHooked = proto; return; }   // give up once, not per frame
    const orig = proto[key];
    if (typeof orig !== 'function') { netBarnHooked = proto; return; }
    netBarnRenderKey = key;
    proto[key] = function (camera) {
      const lag = netRenderLagS();
      const list = this && this.bullets;
      if (!lag || !Array.isArray(list)) return orig.call(this, camera);
      const save = netBulletShift;
      const now = performance.now();
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (!b) continue;
        // Stamp the moment a round stops, so the walk-back below knows how
        // much of the lag it was still flying for. Clearing it on both of the
        // other two states is enough to keep one life's death time out of the
        // next: the barn only ever refills a slot that is inactive, and only
        // from a message handler, which cannot interleave with the frame's
        // synchronous update-then-render — so every entry passes through a
        // render of ours in the inactive state before it is reused.
        if (b.alive) {
          b.__netDied = 0;
        } else if (b.collided) {
          // Late by at most one frame's dt, since the barn's update ran
          // earlier in this same frame — sub-frame against half a tick of lag.
          if (!b.__netDied) b.__netDied = now;
        } else {
          b.__netDied = 0;
          continue;                    // inactive pool entry
        }
        const p = b.pos, d = b.dir, s = b.startPos;
        if (!p || !d || !s || !(b.speed > 0)) continue;
        // How much of the lag this round spent in the air. The whole of it
        // while it is still flying; for a dead one, only what is left since it
        // stopped — which runs out exactly `lag` after impact and sets it down
        // on the point it hit, where the spark and the decal already are.
        const flight = b.__netDied ? lag - (now - b.__netDied) / 1000 : lag;
        if (!(flight > 0)) continue;
        const flown = Math.hypot(p.x - s.x, p.y - s.y);
        const back = Math.min(b.speed * flight, flown);
        if (!(back > 0)) continue;
        save.idx[n] = i; save.x[n] = p.x; save.y[n] = p.y; n++;
        p.x -= d.x * back;
        p.y -= d.y * back;
      }
      try {
        return orig.call(this, camera);
      } finally {
        // Unconditionally, including if the render threw: leaving a bullet
        // displaced would feed a wrong position straight back into the barn's
        // next integration step and into the dodge bot's threat list.
        for (let k = 0; k < n; k++) {
          const b = list[save.idx[k]];
          if (b && b.pos) { b.pos.x = save.x[k]; b.pos.y = save.y[k]; }
        }
      }
    };
    netBarnHooked = proto;
  }

  // Called from the sample loop: keep the camera hook attached to the live
  // Game and make sure every Player in the pool is smoothed. Both guards are
  // cheap no-ops once installed.
  function netcodeTick(game) {
    if (!game) return;
    try {
      const camera = installCameraInterpHook(game);
      installBulletRenderHook(game);
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
  // Debug render: replace the world's art with its collision geometry.
  //
  // The game's scene graph is a flat list of stage children (client/src/
  // game.ts init()): `map.display.ground` holds the terrain, drawn once into
  // a Graphics in WORLD coordinates and then positioned/scaled to screen
  // every frame; `renderer.layers[0..3]` and `renderer.ground` hold every
  // sprite — obstacles, buildings, ceilings, players, loot, bullets — each
  // positioned in screen pixels by its own render(). The UI above them (gas
  // ring, minimap, indicators) is a separate set of stage children.
  //
  // So the whole world is switched off by setting `renderable = false` on
  // those six containers, and nothing else on the page changes: the HUD is
  // DOM, and the minimap is a texture baked by renderMap() from a Graphics of
  // its own, not from `display.ground`. `renderable` rather than `visible`
  // because the renderer rewrites `visible` on the layers every frame off the
  // layer-transition alphas (Renderer.update) and would fight us for it;
  // `renderable` it never touches, and PIXI checks it before descending, so a
  // false there skips the container and its children whole.
  //
  // Our own geometry goes in as three children of `map.display.ground`. That
  // parent is the one thing on the stage already carrying the world->screen
  // transform, so drawing in world units under it needs no camera read of our
  // own and cannot drift a frame behind the game's: whatever transform the
  // renderer resolves for the terrain is the one our shapes get, on the same
  // pass. It also sits at stage index 0, under everything — which is where a
  // replacement world belongs. We paint an opaque sheet over the terrain
  // rather than clearing it, so switching back off is just a `renderable`
  // flip with the game's own geometry still intact underneath.
  // ---------------------------------------------------------------------

  // Ground is flat white, so the two things drawn on it need to read against
  // white and against each other. Water keeps the map's own colour — the ask
  // is a hitbox view of the *objects*, and water is terrain you can swim in,
  // not something with a collider.
  const DEBUG_GROUND_COLOR = 0xffffff;
  const DEBUG_OBSTACLE_COLOR = 0x1a1a1a;
  const DEBUG_PLAYER_COLOR = 0xff2a2a;
  // Fallback biome water, for a mapDef we can't read colours off. survev's
  // main-biome value.
  const DEBUG_WATER_FALLBACK = 0x3282ab;
  // The grid, taken from the one renderTerrain already draws: GameConfig.map
  // .gridSize spacing, black at 0.15. The width is the game's own
  // `2 / camera.ppu` with survev's hardcoded ppu of 16 substituted in — our
  // Graphics hangs off `map.display.ground`, so it inherits the same
  // world->screen scale and a line 0.125 units wide lands on the same 2 * zoom
  // pixels the game's grid does.
  const DEBUG_GRID_SIZE = 16;
  const DEBUG_GRID_COLOR = 0x000000;
  const DEBUG_GRID_ALPHA = 0.15;
  const DEBUG_GRID_WIDTH = 2 / 16;

  // The Renderer class (`yr`) declares its layer bookkeeping under real
  // readable names, so this survives a re-mangle the way looksLikeRoster and
  // looksLikeObstacle do.
  function looksLikeRenderer(v) {
    try {
      return !!v && typeof v === 'object' &&
        Array.isArray(v.layers) && 'ground' in v &&
        'layerMask' in v && 'layerMaskActive' in v && 'underground' in v;
    } catch {
      return false;
    }
  }

  let cachedRendererKey = null;

  function findRendererOnGame(game) {
    if (!game || typeof game !== 'object') return null;
    try {
      if (cachedRendererKey) {
        const r = game[cachedRendererKey];
        if (looksLikeRenderer(r)) return r;
        cachedRendererKey = null;
      }
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        const v = game[names[i]];
        if (looksLikeRenderer(v)) {
          cachedRendererKey = names[i];
          return v;
        }
      }
    } catch {}
    return null;
  }

  const debugRender = {
    terrainGfx: null,    // ground + water, baked once per map
    obstacleGfx: null,   // obstacle colliders, rebuilt when they change
    playerGfx: null,     // player circles, rebuilt every frame
    host: null,          // the map.display.ground we hung them off
    terrainKey: null,    // identity of the terrain we baked from
    obstacleSig: null,   // signature of the collider set we last drew
    hiddenIn: null,      // the renderer we switched off, so we can switch it back
    attachFailed: false,
  };

  // A sibling Graphics of `like`, built from its own constructor so we never
  // need a handle on PIXI itself.
  function makeGraphicsLike(like) {
    try {
      const Ctor = like && like.constructor;
      if (typeof Ctor !== 'function') return null;
      const g = new Ctor();
      // Same treatment the game gives every stage child it adds.
      g.interactiveChildren = false;
      return g;
    } catch {
      return null;
    }
  }

  // survev's own polygon trace (client/src/map.ts), reproduced so our terrain
  // outlines are built exactly the way the ones we're covering were.
  function traceDebugPoly(g, points) {
    const first = points[0];
    g.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    g.closePath();
  }

  function biomeColor(v, fallback) {
    return Number.isFinite(v) ? v : fallback;
  }

  // Ground and water, in world units, in the same order renderTerrain lays
  // them down: one white sheet over the whole map and its margin, then the
  // ocean as the play area minus the shore polygon, then each river's water
  // polygon, then the grid over the lot. Everything renderTerrain draws in
  // between — beach, grass, ground patches, riverbanks — is ground, and ground
  // is white; the grid is the one piece of it kept, because a flat sheet with
  // nothing on it gives no sense of scale or of how far anything has moved.
  function bakeDebugTerrain(map, g) {
    const t = map.terrain;
    const w = map.width;
    const h = map.height;
    const colors = (map.mapDef && map.mapDef.biome && map.mapDef.biome.colors) || {};
    const water = biomeColor(colors.water, DEBUG_WATER_FALLBACK);
    const lake = biomeColor(colors.lakeWater, water);

    g.clear();
    g.beginFill(DEBUG_GROUND_COLOR);
    g.drawRect(-120, -120, w + 240, h + 240);
    g.endFill();

    // The ocean is a hole shape, not a border: the shore polygon is concave
    // and hand-jittered, so the water is whatever the play area has left over
    // once it is cut out. Same construction the game uses.
    if (t && t.shore && t.shore.length && typeof g.beginHole === 'function') {
      g.beginFill(water);
      g.moveTo(0, 0);
      g.lineTo(0, h);
      g.lineTo(w, h);
      g.lineTo(w, 0);
      g.beginHole();
      traceDebugPoly(g, t.shore);
      g.endHole();
      g.closePath();
      g.endFill();
    }

    const rivers = (t && t.rivers) || [];
    for (let i = 0; i < rivers.length; i++) {
      const r = rivers[i];
      if (!r || !r.waterPoly || !r.waterPoly.length) continue;
      g.beginFill(r.looped ? lake : water);
      traceDebugPoly(g, r.waterPoly);
      g.endFill();
    }

    // Last, and over the water as well as the ground — same order and same
    // extent as renderTerrain, which rules the play area rather than the
    // margin. Reset to a zero-width line afterwards so anything added to this
    // bake later doesn't silently inherit a stroke.
    g.lineStyle(DEBUG_GRID_WIDTH, DEBUG_GRID_COLOR, DEBUG_GRID_ALPHA);
    for (let x = 0; x <= w; x += DEBUG_GRID_SIZE) {
      g.moveTo(x, 0);
      g.lineTo(x, h);
    }
    for (let y = 0; y <= h; y += DEBUG_GRID_SIZE) {
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    g.lineStyle(0);
  }

  // A cheap fingerprint of the drawn collider set: obstacle count, ids, and
  // the collider numbers themselves quantized to 1/64 of a unit. That covers
  // everything that can change a shape on screen — an obstacle entering or
  // leaving the pool, one being destroyed, a door swinging its collider onto
  // a new orientation — without allocating, so the expensive part (clearing
  // and re-tessellating a few hundred shapes) only runs on frames where the
  // geometry actually moved. Players are excluded deliberately: they move
  // every frame, so gating them would never pay off, and they live in a
  // Graphics of their own for that reason.
  function debugObstacleSignature(obstacles) {
    let sig = obstacles.length | 0;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!o || !o.active || o.dead || !o.collidable) continue;
      const c = o.collider;
      if (!c) continue;
      sig = (sig * 31 + (o.__id | 0)) | 0;
      if (c.type === COLLIDER_AABB) {
        if (!c.min || !c.max) continue;
        sig = (sig * 31 + Math.round(c.min.x * 64)) | 0;
        sig = (sig * 31 + Math.round(c.min.y * 64)) | 0;
        sig = (sig * 31 + Math.round(c.max.x * 64)) | 0;
        sig = (sig * 31 + Math.round(c.max.y * 64)) | 0;
      } else {
        if (!c.pos) continue;
        sig = (sig * 31 + Math.round(c.pos.x * 64)) | 0;
        sig = (sig * 31 + Math.round(c.pos.y * 64)) | 0;
        sig = (sig * 31 + Math.round(c.rad * 64)) | 0;
      }
    }
    return sig;
  }

  // Every collider currently in the world, as the flat filled shape it
  // actually is. `collidable` is the line between "this is an object" and
  // "this is scenery": a bush carries a collider and doesn't stop you, and a
  // destroyed crate keeps its collider object but stops colliding, so both
  // are dropped. No stroke — a border would draw outside the hitbox and make
  // it read as larger than it is, which is the one thing this view exists to
  // get right.
  function drawDebugObstacles(g, obstacles) {
    g.clear();
    g.beginFill(DEBUG_OBSTACLE_COLOR);
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!o || !o.active || o.dead || !o.collidable) continue;
      const c = o.collider;
      if (!c) continue;
      if (c.type === COLLIDER_AABB) {
        if (!c.min || !c.max) continue;
        g.drawRect(c.min.x, c.min.y, c.max.x - c.min.x, c.max.y - c.min.y);
      } else if (c.type === COLLIDER_CIRCLE) {
        if (!c.pos || !(c.rad > 0)) continue;
        g.drawCircle(c.pos.x, c.pos.y, c.rad);
      }
    }
    g.endFill();
  }

  // Players are all one colour — no teammate/enemy split, no downed shade.
  // The circle is GameConfig.player.radius, i.e. the collision circle the
  // server resolves movement against.
  //
  // It is drawn at `posAlt`, not `pos`. `pos` is where the last packet said
  // the player was; `posAlt` is the render-interpolated position the game
  // lerps toward it each frame, and it is what the body sprite's own
  // pointToScreen is fed — so reading it is what puts the circle exactly where
  // the (now hidden) sprite was. It is also the field the netcode smoothing
  // installs its accessor on, so the position follows the Smoothing toggle and
  // its knobs live, the same playback the sprite would have been drawn with.
  // `pos` is only the fallback for a player the game has not interpolated yet.
  function drawDebugPlayers(g) {
    g.clear();
    const roster = capturedGame ? findRosterOnGame(capturedGame) : null;
    const pool = roster && roster.playerPool;
    const players = (pool && typeof pool[POOL_GETALL] === 'function')
      ? pool[POOL_GETALL]() : null;
    if (!Array.isArray(players)) return;
    g.beginFill(DEBUG_PLAYER_COLOR);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || !p.active) continue;
      const net = p[PLAYER_NET];
      if (net && net[NET_DEAD]) continue;
      const pos = p[PLAYER_POS2] || p[PLAYER_POS];
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      g.drawCircle(pos.x, pos.y, PLAYER_RADIUS);
    }
    g.endFill();
  }

  // Attach (or re-attach) our Graphics under the live map's terrain
  // container, in draw order: ground and water, then obstacles, then players.
  // The map is rebuilt per round and `display.ground` is destroyed with it,
  // taking our children along, so identity is re-checked every frame rather
  // than assumed.
  function ensureDebugGfx(map) {
    const host = map && map.display && map.display.ground;
    // `children` goes null when PIXI destroys a container, and the map's is
    // destroyed at the end of every round — without this the addChild below
    // would throw once per frame until the next map arrives.
    if (!host || host.destroyed || !Array.isArray(host.children)) return false;
    const st = debugRender;
    if (st.host === host && st.terrainGfx && st.obstacleGfx && st.playerGfx &&
        st.terrainGfx.parent === host && st.obstacleGfx.parent === host &&
        st.playerGfx.parent === host) {
      return true;
    }
    const terrainGfx = makeGraphicsLike(host);
    const obstacleGfx = makeGraphicsLike(host);
    const playerGfx = makeGraphicsLike(host);
    if (!terrainGfx || !obstacleGfx || !playerGfx) {
      st.attachFailed = true;
      return false;
    }
    try {
      host.addChild(terrainGfx);
      host.addChild(obstacleGfx);
      host.addChild(playerGfx);
    } catch {
      st.attachFailed = true;
      return false;
    }
    st.terrainGfx = terrainGfx;
    st.obstacleGfx = obstacleGfx;
    st.playerGfx = playerGfx;
    st.host = host;
    st.terrainKey = null;
    st.obstacleSig = null;
    st.attachFailed = false;
    return true;
  }

  function setWorldRenderable(renderer, on) {
    if (!renderer) return;
    try {
      if (renderer.ground) renderer.ground.renderable = on;
      const layers = renderer.layers || [];
      for (let i = 0; i < layers.length; i++) {
        if (layers[i]) layers[i].renderable = on;
      }
    } catch {}
  }

  // Put the game's own rendering back and drop our geometry. Called both when
  // the toggle goes off and when the pieces we were holding have gone stale,
  // so a round change can't strand a hidden layer.
  function teardownDebugRender() {
    const st = debugRender;
    if (st.hiddenIn) {
      setWorldRenderable(st.hiddenIn, true);
      st.hiddenIn = null;
    }
    for (const g of [st.terrainGfx, st.obstacleGfx, st.playerGfx]) {
      if (!g) continue;
      try {
        if (g.parent) g.parent.removeChild(g);
        g.destroy();
      } catch {}
    }
    st.terrainGfx = null;
    st.obstacleGfx = null;
    st.playerGfx = null;
    st.host = null;
    st.terrainKey = null;
    st.obstacleSig = null;
  }

  // One frame of the debug view. Cheap and self-restoring when off: the only
  // work an idle tick does is the enabled check plus, once, the teardown.
  function debugRenderTick() {
    const st = debugRender;
    if (DEBUG_RENDER.enabled !== 1) {
      if (st.hiddenIn || st.terrainGfx) teardownDebugRender();
      return;
    }
    const game = capturedGame;
    const map = game ? findMapOnGame(game) : null;
    if (!map || !map.mapLoaded) {
      if (st.hiddenIn || st.terrainGfx) teardownDebugRender();
      return;
    }
    if (!ensureDebugGfx(map)) return;

    if (st.terrainKey !== map.terrain) {
      bakeDebugTerrain(map, st.terrainGfx);
      st.terrainKey = map.terrain;
    }
    const obstacles = getObstacles();
    const sig = debugObstacleSignature(obstacles);
    if (sig !== st.obstacleSig) {
      drawDebugObstacles(st.obstacleGfx, obstacles);
      st.obstacleSig = sig;
    }
    drawDebugPlayers(st.playerGfx);

    // Hide the art last, and only once we have something to show in its
    // place: a frame with both the world and our geometry up is a frame of
    // clutter, a frame with neither is a black screen.
    const renderer = findRendererOnGame(game);
    if (renderer !== st.hiddenIn) {
      setWorldRenderable(st.hiddenIn, true);
      st.hiddenIn = renderer || null;
    }
    setWorldRenderable(renderer, false);
  }

  // `mapFound: false` in a match means findMapOnGame lost the map shape;
  // `rendererFound: false` means the layer containers are still on screen and
  // the hitboxes are drawing underneath them.
  window.__debugRenderDiag = () => {
    const game = capturedGame;
    const map = game ? findMapOnGame(game) : null;
    return {
      enabled: DEBUG_RENDER.enabled === 1,
      mapFound: !!map,
      mapLoaded: !!(map && map.mapLoaded),
      rendererFound: !!(game && findRendererOnGame(game)),
      attached: !!(debugRender.terrainGfx && debugRender.terrainGfx.parent),
      obstacleSig: debugRender.obstacleSig,
      attachFailed: debugRender.attachFailed,
      worldHidden: !!debugRender.hiddenIn,
      terrainBaked: !!debugRender.terrainKey,
      rivers: map && map.terrain && map.terrain.rivers ? map.terrain.rivers.length : null,
    };
  };

  // ---------------------------------------------------------------------
  // ESP render: stop anything that isn't part of the collision set from
  // covering what is — building roofs come off entirely, and bushes, the
  // rubble a destroyed obstacle leaves behind and smoke are faded down to
  // where whatever they sit over stays readable through them.
  //
  // A house's inside is already being rendered. Its floor, its walls, the loot
  // and the players in it are all drawn on the same layer as the world
  // outside, and the roof is only a sprite laid over the top of them at
  // `zOrd = 750 - zIdx`. `Building.imgs` holds both halves of that art in one
  // array with each entry tagged `isCeiling`, so switching the ceiling ones
  // off leaves the building standing and reveals what was under it, without
  // touching the building's geometry, its layer or its zoom regions.
  //
  // `renderable = false` per sprite, for the same reason the debug view uses
  // it on the layer containers: the game rewrites both fields we might
  // otherwise use on every update — `positionSprite` sets a ceiling img's
  // `alpha` from `ceiling.fadeAlpha`, and a `removeOnDamaged` img gets a
  // `visible` — so anything written there is gone within a frame. `renderable`
  // it never touches, and PIXI checks it before drawing the sprite.
  //
  // Obstacles are sorted by that same rule, but faded rather than switched
  // off. `collidable` is the game's own line between an object and scenery — a
  // bush carries a collider and doesn't stop you — and a dead obstacle keeps
  // its collider object but stops colliding, so both are art in front of
  // nothing. That line is the one `__bulletGeom` and the aim path already work
  // from, which is what makes the view honest: what is left drawn solid is
  // what a bullet and a body can actually hit.
  //
  // A tree is on the other side of it — it is collidable, it stops a bullet,
  // and removing it would make the view lie about cover. But its leaves are
  // drawn on top of whoever stands under them, which is exactly what this is
  // here to stop, so canopy art is faded too, to the same ESP_ALPHA. Both
  // sides of the line end up at one depth on purpose: the fade says "you can
  // see through this", and the geometry underneath — solid or not — is what
  // the ESP overlay and the aim path are for. See ESP_ALPHA below for which
  // art counts as canopy and how it is recognized.
  //
  // Smoke is the same problem out of a different barn. A grenade cloud is not
  // an obstacle at all — it stops nothing and it is drawn over everything
  // beneath it — so it is faded to that same ESP_ALPHA, and the two read at
  // one depth instead of a tree seen through smoke reading as two. Only the
  // mechanism differs: the barn assigns `sprite.alpha` on every frame it
  // draws, so the number is caught rather than written. See capArt below.
  //
  // A display switch and nothing else: nothing reads geometry from it, and it
  // is deliberately independent of the ESP overlay's master toggle even
  // though it sits in that section — it puts nothing on the overlay canvas,
  // so gating it behind the canvas would only be surprising.
  //
  // What it cannot open up is a bunker. Underground art lives on
  // `renderer.layers[2]`, which the renderer masks down to the stairwell
  // openings the whole time the local player is aboveground, so there is no
  // roof to hide — those sprites are being clipped away, not covered up.
  // ---------------------------------------------------------------------

  // A Building, by the readable fields its class declares. `ceiling` and
  // `surfaces` together are unique to it: a Structure carries `layers`,
  // `stairs` and `mask` instead, and an Obstacle has none of the four.
  function looksLikeBuilding(v) {
    try {
      return !!v && typeof v === 'object' &&
        'ceiling' in v && 'ceilingDead' in v && 'surfaces' in v && Array.isArray(v.imgs);
    } catch {
      return false;
    }
  }

  let cachedBuildingPoolKey = null;

  // Same shape, and the same caveat, as findObstaclePool: the pool is under a
  // mangled name, so it is identified by what its entries are, which needs at
  // least one live building. Until there is one this returns null and the
  // roofs stay up for a tick.
  function findBuildingPool(map) {
    if (!map || typeof map !== 'object') return null;
    const isBuildingPool = (v) => {
      if (!v || typeof v !== 'object' || typeof v[POOL_GETALL] !== 'function') return false;
      const all = v[POOL_GETALL]();
      if (!Array.isArray(all) || !all.length) return false;
      return looksLikeBuilding(all[0]);
    };
    try {
      if (cachedBuildingPoolKey) {
        const p = map[cachedBuildingPoolKey];
        if (isBuildingPool(p)) return p;
        cachedBuildingPoolKey = null;
      }
      const names = Object.getOwnPropertyNames(map);
      for (let i = 0; i < names.length; i++) {
        if (isBuildingPool(map[names[i]])) {
          cachedBuildingPoolKey = names[i];
          return map[names[i]];
        }
      }
    } catch {}
    return null;
  }

  function getBuildings() {
    const map = findMapOnGame(capturedGame);
    if (!map) return [];
    const pool = findBuildingPool(map);
    if (!pool) return [];
    const all = pool[POOL_GETALL]();
    return Array.isArray(all) ? all : [];
  }

  // A smoke particle, by the readable fields its class declares. Survev leaves
  // these unmangled the way it leaves `pos` and `sprite` unmangled elsewhere,
  // and the radTarget/fadeTicker/rotVel trio is carried by nothing else.
  function looksLikeSmokeParticle(v) {
    try {
      return !!v && typeof v === 'object' &&
        'radTarget' in v && 'fadeTicker' in v && 'rotVel' in v &&
        'interior' in v && 'sprite' in v;
    } catch {
      return false;
    }
  }

  function isSmokeParticleArray(v) {
    return Array.isArray(v) && v.length > 0 && looksLikeSmokeParticle(v[0]);
  }

  let cachedSmokeBarnKey = null;
  let cachedSmokeArrayKey = null;

  // The smoke barn hangs off the Game rather than the map, and holds its
  // particles in a plain array beside its entity pool — both under mangled
  // names, so the pair is found by what the array's entries are. Like the
  // obstacle and building pools that needs one live entry, which here means
  // one smoke that has been thrown this round; until then the barn is
  // unidentified and this returns empty rather than wrong. The array is the
  // barn's own recycling pool and is never rebuilt, so once the two keys are
  // cached the per-frame cost is two property reads.
  function findSmokeParticles() {
    const game = capturedGame;
    if (!game || typeof game !== 'object') return [];
    try {
      if (cachedSmokeBarnKey && cachedSmokeArrayKey) {
        const barn = game[cachedSmokeBarnKey];
        const arr = barn && typeof barn === 'object' && barn[cachedSmokeArrayKey];
        if (isSmokeParticleArray(arr)) return arr;
        cachedSmokeBarnKey = null;
        cachedSmokeArrayKey = null;
      }
      const names = Object.getOwnPropertyNames(game);
      for (let i = 0; i < names.length; i++) {
        const barn = game[names[i]];
        // Arrays are skipped rather than descended into: the barn is a class
        // instance, and the Game keeps `pings` and `updateIntervals` beside it
        // — both one entry per server update and both unbounded over a match,
        // so listing their indices every frame is the one way this scan could
        // cost anything.
        if (!barn || typeof barn !== 'object' || Array.isArray(barn)) continue;
        const keys = Object.getOwnPropertyNames(barn);
        for (let j = 0; j < keys.length; j++) {
          if (isSmokeParticleArray(barn[keys[j]])) {
            cachedSmokeBarnKey = names[i];
            cachedSmokeArrayKey = keys[j];
            return barn[keys[j]];
          }
        }
      }
    } catch {}
    return [];
  }

  // A tree is collidable, so it stays — but its leaves are drawn on top of
  // whoever is standing under them, which is the one thing this view exists to
  // stop. So canopy art is faded rather than removed: the tree still reads as
  // a tree, and the player under it reads as a player. A bush, a dead
  // obstacle's rubble and a smoke cloud are faded to the same number rather
  // than each getting a depth of its own, so everything this view leaves in
  // front of a body is in front of it by the same amount — what is solid
  // reads solid, and everything you can walk or shoot through reads as one
  // kind of thing.
  const ESP_ALPHA = 0.3;
  // Which art counts as a canopy, by the game's own rule rather than by a list
  // of type names that would rot on the next content patch. `sprite.zOrd` is
  // the obstacle def's `img.zIdx`, and Obstacle.render treats >= 50 as "this
  // draws above the player" — it lifts exactly those onto the player's layer
  // and pushes them past their z-order. Tree canopies sit at 200 and 801;
  // tables, pipes and statue tops share the rule and get the same treatment,
  // for the same reason.
  const CANOPY_ZORD = 50;

  // One property we are holding on a set of sprites. `live` is what is held
  // right now, `next` collects the frame being built, and `restore` hands one
  // sprite back. `commit` releases anything the new frame didn't re-claim and
  // then swaps the two buffers, so the released set becomes the next frame's
  // scratch — which is what restores a sprite when its obstacle changes state,
  // when a pool entry is recycled into a different object, when the toggle
  // goes off and when the round ends, and it keeps a per-frame pass over a few
  // hundred sprites free of garbage.
  function makeArtTracker(restore) {
    return {
      live: new Set(),
      next: new Set(),
      commit() {
        for (const sprite of this.live) {
          if (!this.next.has(sprite)) restore(sprite);
        }
        this.live.clear();
        const empty = this.live;
        this.live = this.next;
        this.next = empty;
      },
      releaseAll() {
        for (const sprite of this.live) restore(sprite);
        this.live.clear();
        this.next.clear();
      },
    };
  }

  function showArt(sprite) {
    try { sprite.renderable = true; } catch {}
  }

  // Back to whatever the game last assigned. Every sprite carries its own
  // `imgAlpha` — the def's alpha, which the obstacle copies into `alpha` on
  // the rare frames it swaps a texture — so the value to hand back is on the
  // sprite itself and needs no bookkeeping of ours.
  function unfadeArt(sprite) {
    try {
      sprite.alpha = Number.isFinite(sprite.imgAlpha) ? sprite.imgAlpha : 1;
    } catch {}
  }

  // Smoke's alpha, unlike a canopy's, is rewritten every frame — the barn sets
  // `alpha = clamp(1 - fadeTicker / fadeDuration) * 0.9` in the same tick that
  // renders the particle — so there is no point in a frame where a value we
  // write is the one that gets drawn. The write is intercepted instead of
  // repeated: an own accessor keeps the game's number in `raw` and hands back
  // the lower of it and ESP_ALPHA. The barn goes on assigning exactly as it
  // did, and a puff's own fade-out still plays, because those values are under
  // the cap and pass straight through — what is capped is how solid the cloud
  // gets, not how it dies.
  //
  // `alpha` on a PIXI DisplayObject is a plain instance field, so this
  // replaces an own data property, and handing it back is deleting the
  // accessor and assigning the game's last number in its place.
  const cappedAlpha = new WeakMap();

  function capArt(sprite, into) {
    if (!sprite) return;
    if (!cappedAlpha.has(sprite)) {
      const rec = { raw: Number.isFinite(sprite.alpha) ? sprite.alpha : 1 };
      try {
        Object.defineProperty(sprite, 'alpha', {
          configurable: true,
          enumerable: true,
          get() { return rec.raw < ESP_ALPHA ? rec.raw : ESP_ALPHA; },
          set(v) { rec.raw = v; },
        });
      } catch { return; }
      cappedAlpha.set(sprite, rec);
    }
    into.add(sprite);
  }

  function uncapArt(sprite) {
    const rec = cappedAlpha.get(sprite);
    cappedAlpha.delete(sprite);
    try {
      delete sprite.alpha;
      sprite.alpha = rec && Number.isFinite(rec.raw) ? rec.raw : 1;
    } catch {}
  }

  const espArt = {
    hidden: makeArtTracker(showArt),
    faded: makeArtTracker(unfadeArt),
    capped: makeArtTracker(uncapArt),
  };

  function hideArt(sprite, into) {
    if (!sprite) return;
    try { sprite.renderable = false; } catch { return; }
    into.add(sprite);
  }

  function fadeArt(sprite, into) {
    if (!sprite) return;
    try { sprite.alpha = ESP_ALPHA; } catch { return; }
    into.add(sprite);
  }

  // Hand every sprite back. Called when the toggle goes off and whenever the
  // world we were reading disappears, so a round change can't strand an
  // invisible roof, or a faded canopy, on a sprite the next map recycles.
  function restoreHiddenArt() {
    espArt.hidden.releaseAll();
    espArt.faded.releaseAll();
    espArt.capped.releaseAll();
  }

  // One frame of the ESP view. Idle cost when off is the enabled
  // check plus, once, the restore.
  function espTick() {
    const st = espArt;
    const holding = st.hidden.live.size || st.faded.live.size || st.capped.live.size;
    if (ESP.esp !== 1) {
      if (holding) restoreHiddenArt();
      return;
    }
    const map = findMapOnGame(capturedGame);
    if (!map || !map.mapLoaded) {
      if (holding) restoreHiddenArt();
      return;
    }

    const hide = st.hidden.next;
    const fade = st.faded.next;
    const cap = st.capped.next;

    const buildings = getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (!b || !b.active || !Array.isArray(b.imgs)) continue;
      for (let j = 0; j < b.imgs.length; j++) {
        const img = b.imgs[j];
        if (img && img.isCeiling) hideArt(img.sprite, hide);
      }
    }

    const obstacles = getObstacles();
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!o || !o.active) continue;
      if (!o.collidable || o.dead) {
        // Faded, not removed: a bush is still cover from being seen even
        // though it stops nothing, and rubble still says an obstacle was
        // there. At ESP_ALPHA it reads as the same kind of pass-through art a
        // canopy does, and anything drawn under it stays legible.
        fadeArt(o.sprite, fade);
        // A door's frame is a second sprite the obstacle positions alongside
        // its own, so a dead door that faded only the first would leave its
        // casing standing solid around nothing.
        if (o.isDoor && o.door) fadeArt(o.door.casingSprite, fade);
        continue;
      }
      // Collidable, so it stays on screen — but if the game draws it over the
      // player, it gets faded to show what is underneath.
      const sprite = o.sprite;
      if (sprite && sprite.zOrd >= CANOPY_ZORD) fadeArt(sprite, fade);
    }

    // Smoke sits in none of the pools above and is in no collision set, but it
    // is drawn over whoever is inside it, so it gets the canopy treatment.
    // Inactive particles are the barn's free list — already invisible, and
    // capping one would only be handed back on the frame it is reused.
    const smoke = findSmokeParticles();
    for (let i = 0; i < smoke.length; i++) {
      const p = smoke[i];
      if (p && p.active) capArt(p.sprite, cap);
    }

    st.hidden.commit();
    st.faded.commit();
    st.capped.commit();
  }

  // `buildings: 0` in a live match means findBuildingPool hasn't identified the
  // pool — the roofs are still up and `mangled.js` may need re-deriving if it
  // stays that way once a match is running.
  window.__espDiag = () => {
    const map = findMapOnGame(capturedGame);
    // Counted before `poolKey` is read: getBuildings is what resolves the key,
    // and with the toggle off nothing else ever has.
    const live = getBuildings().filter((b) => b && b.active).length;
    return {
      enabled: ESP.esp === 1,
      mapFound: !!map,
      mapLoaded: !!(map && map.mapLoaded),
      poolKey: cachedBuildingPoolKey,
      buildings: live,
      hiddenSprites: espArt.hidden.live.size,
      fadedSprites: espArt.faded.live.size,
      cappedSprites: espArt.capped.live.size,
      smokeBarnKey: cachedSmokeBarnKey,
      smokeParticles: findSmokeParticles().length,
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

  // Weight half-life of the RTT average, in samples. This is the clock
  // regression's own EWMA (see clockOnPacket) in its one-variable form: decay
  // the accumulated weight, fold the new sample in at weight 1, move the mean
  // by the share it takes. `1/(1 - lam)` is the effective sample count, so a
  // half-life of 8 carries about the twelve samples the median used to hold —
  // the same horizon, with no window edge for a sample to drop off.
  const PING_HALF_LIFE = 8;
  const PING_GOOD_MS = 60;
  const PING_OK_MS = 120;

  const pingState = {
    el: null,
    dot: null,
    text: null,
    sw: 0,               // Σ w, the decayed sample weight
    mean: 0,             // weighted mean RTT, ms
    sourceArray: null,   // identity of the game's array, to spot replacement
    consumed: 0,         // how much of it we've already folded in
    lastText: null,      // last string written, so an unchanged tick writes nothing
    lastDot: null,
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
      foldPing(v);
    }
    pingState.consumed = arr.length;
  }

  // Fold one RTT sample into the average, by the same decayed-moment update
  // clockOnPacket runs on the regression: the accumulated weight decays by
  // `lam`, the sample lands at weight 1, and the mean moves by `1/sw` of the
  // residual. Seeding is exact rather than a ramp from zero — the first sample
  // gets sw = 1 and takes the mean whole, exactly as the clock's first arrival
  // takes `mt`.
  function foldPing(ms) {
    const lam = Math.pow(0.5, 1 / PING_HALF_LIFE);
    const sw = lam * pingState.sw + 1;
    pingState.mean += (ms - pingState.mean) / sw;
    pingState.sw = sw;
  }

  // The averaged RTT, or null before the first acked input.
  //
  // This was a median over the last twelve samples, which is strictly better
  // at ignoring a lone retransmit or GC pause: an outlier that a median throws
  // away entirely moves this by its distance over the effective sample count,
  // so a 500ms spike on a 40ms link shows as a ~40ms bump that then decays.
  // The mean is what the clock uses and what everything reading this wants —
  // the aim lead and the dodge bot's threat advance are both linear in it — so
  // the two now agree on how the link is being averaged rather than each
  // having its own answer.
  function smoothedPingMs() {
    return pingState.sw ? pingState.mean : null;
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
    // Fresh nodes carry none of the old ones' content, so the write cache in
    // updatePingUI has to be dropped with them or the rebuilt readout would
    // stay blank until the string happened to change.
    pingState.lastText = null;
    pingState.lastDot = null;
    return el;
  }

  // Rebuilt on every tick of the sample loop rather than on a redraw timer, so
  // the readout is never older than the last measurement. There is no cost to
  // that and nothing to flicker, because both halves of the line only move
  // when a packet lands: the mean is flat between RTT samples, and the slope
  // and residual are flat between arrivals. What that buys over a timer is
  // that the change lands on the tick the packet did, instead of up to a
  // quarter-second later.
  //
  // Both writes are guarded on the value actually differing. Assigning the
  // same string to `textContent` still replaces the text node and dirties
  // layout, and at 50Hz on a line that changes at 20Hz most of those writes
  // would be for an identical string.
  function updatePingUI(game, now) {
    // Harvest before the enabled check: the aim path leads by this RTT (see
    // reactionTarget), so hiding the readout must not also stop measuring it.
    harvestPings(game);
    if (!PING_UI.enabled) {
      if (pingState.el) pingState.el.style.display = 'none';
      return;
    }

    const el = ensurePingEl();
    if (!el) return;
    const ms = smoothedPingMs();
    pingState.currentMs = ms;

    // Clock readout beside the ping: the fitted tick period (slope of the
    // pseudotime model, ms per packet) and the RMS arrival-vs-pseudotime
    // residual, i.e. how much jitter the fit is absorbing. Both blank until
    // the clock has converged.
    const jitter = clockJitterMs();
    const clockTxt = netClock.ready
      ? ` · ${netClock.slope.toFixed(2)} ms/tick${jitter == null ? '' : ` · ±${jitter.toFixed(1)} ms`}`
      : '';

    // `ms == null` is in a match with no acked input yet — say so rather than
    // showing a stale or invented number.
    const txt = ms == null ? `– ms${clockTxt}` : `${Math.round(ms)} ms${clockTxt}`;
    const dot = ms == null ? '#7f8c8d'
      : ms < PING_GOOD_MS ? '#2ecc71' : ms < PING_OK_MS ? '#f1c40f' : '#e74c3c';

    el.style.display = 'flex';
    if (txt !== pingState.lastText) {
      pingState.text.textContent = txt;
      pingState.lastText = txt;
    }
    if (dot !== pingState.lastDot) {
      pingState.dot.style.background = dot;
      pingState.lastDot = dot;
    }
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
    const aim = userAim(player);
    const now = Date.now();
    let best = null;
    let bestScore = Infinity;
    for (const e of enemies) {
      if (!isEngageable(e, now)) continue;
      if (isSpoofedEnemy(e.id, pageSamples)) continue;
      if (!canInteract(player.layer, e.layer)) continue;
      const p = livePos(e.id, e);
      const s = userAimScore(aim, player, p);
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

  // ---------------------------------------------------------------------
  // The dodge plan, drawn.
  //
  // The line is the polyline dodgeTraceWalk recovered from the search — the
  // legs behind the heading the bot is actually pressing, at the grid
  // positions the loss was evaluated at. It is drawn from the same world ->
  // screen projection as everything else on this canvas, and from the
  // planner's own coordinates rather than from the screen centre, so where the
  // plan starts and where the camera says we are are allowed to disagree.
  //
  // They do disagree, and there are three positions in it, not two:
  //
  //   playout   stateOnClock at renderNowMs(), held NETCODE.renderLag ticks
  //             behind the clock so the lerp interpolates between snapshots it
  //             has. This is the camera centre, i.e. your sprite.
  //   packet    me[PLAYER_POS], the newest thing the server has said. Half a
  //             tick to a tick ahead of the playout while moving — 0.3 to 0.6
  //             units at full speed — and what dodgeStep plans from.
  //   carried   packet + dodgeCarry(prefixS), the ping lead: where the heading
  //             now held will have taken us by the time this frame's key press
  //             reaches the server. dodgePath[0], where the search starts.
  //
  // Both gaps are drawn, and drawn differently, because they are owed to
  // different things. The playout leg is the renderer being behind and is
  // nothing the planner did; the lead leg is a correction the planner applies
  // on purpose, and it goes to zero with the Ping lead knob. Merging them into
  // one stub off the sprite — which is what this drew first — makes the
  // renderer's lag look like part of the bot's lead, and at any normal ping
  // the two are the same size.
  //
  // Nothing here can affect a plan. It reads a snapshot the frame already made
  // and draws it.
  // ---------------------------------------------------------------------
  const DODGE_PATH_RGB = '255, 176, 0';

  function dodgePlanVisible() {
    return !!DODGE.path && dodgePath.n > 1 &&
      (Date.now() - dodgePath.at) <= DODGE_PATH_STALE_MS;
  }

  // ---- Grenade rings ----------------------------------------------------
  //
  // Every grenade in the air, drawn as the blast it is going to make: two rings
  // at the *detonation* point rather than around the sprite, because for
  // anything still moving those are not the same place and the one that matters
  // is where it will be when the fuse runs out. A leader line joins the two
  // when they differ, so a grenade mid-flight reads as "it is here, it goes off
  // there" rather than as a ring that has drifted off its object.
  //
  // The rings are the game's own two radii. Inside the inner one the blast does
  // its full damage flat; between them it ramps to nothing at the outer one.
  // That ramp is measured from the centre rather than from the inner ring, so
  // the step across the inner ring is real and worth being able to see: a frag
  // is 125 just inside it and 73 just outside.
  //
  // The fuse is over the grenade, in seconds. A `~` in front of it means the
  // cook was not measured — nobody was watched pulling the pin, so the number
  // is the longest the fuse can be and the grenade may go off sooner. See
  // dodgeProjBoom for where both numbers come from; nothing here computes
  // anything, it reads the same per-packet record the planner is scored
  // against.
  const DODGE_RING_RGB = '255, 60, 48';

  // Something to actually draw, not merely something tracked. `dodgeCook` keeps
  // an entry per player we have watched and is only trimmed at 32, so asking it
  // for a non-zero size answered "yes" for the whole round — which held the
  // overlay canvas open and ran the draw path on every frame of a match with no
  // grenade anywhere in it.
  function dodgeRingsVisible() {
    if (!DODGE.rings) return false;
    if (dodgeProj.size > 0) return true;
    const n = netClock.n - 1;
    for (const st of dodgeCook.values()) if (dodgeCookPhys(st, n)) return true;
    return false;
  }

  function drawGrenadeRings(ctx) {
    const sample = pageSamples[pageSamples.length - 1];
    const player = sample && sample.self;
    if (!player) return;
    const pi = stateOnClock(player.id, renderNowMs())
      || interpPos('__self__', player.x, player.y);
    const scale = getLivePxPerWorldUnit(sample);
    if (!(scale > 0)) return;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const px = (wx) => cx + (wx - pi.x) * scale;
    const py = (wy) => cy - (wy - pi.y) * scale;
    const now = Date.now();
    const me = findLocalPlayerOnGame(capturedGame);
    const layer = Number.isFinite(me?.layer) ? me.layer : 0;
    // Who we are, so a grenade that cannot hurt us can be left off the screen.
    // Read through the same isHostileTo the planner, the sampler and the name
    // tags use, so the four cannot disagree about who is on our side.
    const selfId = Number(me?.__id ?? 0) || null;
    const roster = findRosterOnGame(capturedGame) || capturedGame?.[GAME_ROSTER];
    const selfInfo = roster && selfId != null ? dodgePlayerInfo(roster, selfId) : null;
    const friendly = (id) => !!roster && !!id && id !== selfId &&
      !isHostileTo(selfInfo, dodgePlayerInfo(roster, id));

    // The live sprites, so a grenade is drawn where the renderer has it rather
    // than where the last packet left it — the rings are a world annotation and
    // have to sit on the object they annotate.
    const list = getProjectiles();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !p.active || !p.pos) continue;
      // An explosion only touches what shares its layer, so a grenade a floor
      // away is drawing a circle we cannot be inside. Same test the threat
      // build makes, for the same reason.
      if (!sameLayerAs(layer, p.layer)) continue;
      const phys = THROWABLE_PHYS[p.type];
      if (!phys || phys.impact) continue;
      const def = BLAST_DEFS[phys.blast];
      if (!def || !(def[0] > 0)) continue;
      const rec = dodgeProj.get(Number(p.__id ?? 0));
      if (!rec) continue;
      // A squadmate's grenade cannot touch us, so it is ink over the fight for
      // nothing. Only a thrower the throw animation *named* is allowed to hide
      // one: a guess from proximity is not enough to take a 12u circle off the
      // screen, the same asymmetry that decides whether the planner may drop it.
      // Our own is still drawn — it hurts us in full.
      if (rec.throwerSure && friendly(rec.thrower)) continue;

      // Counted from the packet the record is as of, so the disc grows smoothly
      // between updates instead of stepping at 20Hz.
      const left = Math.max(0, rec.boomT - (now - rec.at) / 1000);
      drawBlastRing(ctx, px(rec.boomX), py(rec.boomY), px(p.pos.x), py(p.pos.y),
                    def, scale, left, phys.fuse, false);
    }

    // The grenades still in a hand. Drawn from the same cook states the planner
    // prices, at the holder's feet and with a dashed outline to say the place is
    // a guess in a way a thrown grenade's is not — they can still throw it, and
    // where it goes then is not knowable from anything on the wire. The fuse,
    // though, is exactly as real as a thrown one's, and it is the thing worth
    // seeing: somebody three quarters through a frag is about to produce a blast
    // nobody gets to plan against.
    const nTick = netClock.n - 1;
    const pool = (findRosterOnGame(capturedGame) || capturedGame?.[GAME_ROSTER])?.playerPool;
    const players = pool && typeof pool[POOL_GETALL] === 'function' ? pool[POOL_GETALL]() : [];
    for (const p of players) {
      if (!p || !p.active || p[PLAYER_NET]?.[NET_DEAD]) continue;
      const pid = Number(p.__id ?? 0);
      // A squadmate cooking a frag is not a thing that can happen to us, so it
      // is ink for nothing. Our own is the opposite: knowing *that* we are
      // cooking is not the same as knowing how much of the fuse is left, and
      // that is the number the whole ring exists to show. It is also the fuse
      // we can still do something about.
      //
      // This is display parting company with the loss on purpose. The planner
      // does not price our own cook — we decide when it leaves our hand, so it
      // is not a threat to plan around — but the overlay draws it, because the
      // countdown is for the player and the loss is not.
      if (friendly(pid)) continue;
      const st = dodgeCook.get(pid);
      const phys = dodgeCookPhys(st, nTick);
      if (!phys) continue;
      const def = BLAST_DEFS[phys.blast];
      if (!def || !(def[0] > 0)) continue;
      if (!sameLayerAs(layer, p.layer)) continue;
      const pos = getXY(p[PLAYER_NET]?.[PLAYER_POS] ?? p[PLAYER_POS] ?? p.pos);
      if (!pos) continue;
      const left = Math.max(0, phys.fuse - dodgeCookElapsed(st, nTick));
      const sx = px(pos.x), sy = py(pos.y);

      // Our own cook is the one we can say something better about than "it goes
      // off where you are standing". We know the cursor, and on this server the
      // cursor *is* the throw strength — so the whole throw can be simulated and
      // the ring put where the grenade would actually end up if we let go now.
      // For anyone else the cursor is not on the wire and their feet remain the
      // only honest answer.
      if (pid === selfId && dodgeThrowPreview(phys, p, layer, left, dodgeThrowOut)) {
        drawBlastRing(ctx, px(dodgeThrowOut.x), py(dodgeThrowOut.y), sx, sy,
                      def, scale, left, phys.fuse, true);
      } else {
        drawBlastRing(ctx, sx, sy, sx, sy, def, scale, left, phys.fuse, true);
      }
    }

  }

  // One grenade's worth of ink: the damage radius outlined at (bx, by) where it
  // goes off, a disc inside it growing to meet that outline as the fuse burns,
  // and a leader back to (gx, gy) where the grenade is now. `held` dashes the
  // outline, which is how a grenade still in a hand is told from one already
  // committed to a place.
  function drawBlastRing(ctx, bx, by, gx, gy, def, scale, left, fuse, held) {
    const outer = def[2] * scale;

    // How much of the fuse is gone, as a fraction of the whole of it. Measured
    // against the throwable's own fuse rather than against when we first saw
    // it, so a grenade cooked for three seconds arrives three quarters full
    // instead of starting from empty and lying about how long there is.
    const burnt = fuse > 0 ? Math.min(Math.max(1 - left / fuse, 0), 1) : 1;

    // The damage radius, outlined. Fixed and faint: it is a fact about the
    // grenade and not about the clock, so it must not compete with the thing
    // that is moving. Dashed while the grenade is still in a hand, where the
    // centre is a guess about somebody who has not committed to it yet.
    ctx.setLineDash(held ? [5, 5] : []);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = `rgba(${DODGE_RING_RGB}, 0.55)`;
    ctx.beginPath();
    ctx.arc(bx, by, outer, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // And the clock, as a disc growing out to meet that outline. This is the
    // whole of the countdown: full circle means now. It reads at a glance and
    // without being looked at directly, which a number in the corner of a
    // firefight does not, and it is in the units that actually matter — the
    // ground the blast is about to cover — rather than in seconds the reader
    // then has to convert into distance themselves.
    if (burnt > 0.005) {
      ctx.fillStyle = `rgba(${DODGE_RING_RGB}, 0.26)`;
      ctx.beginPath();
      ctx.arc(bx, by, outer * burnt, 0, Math.PI * 2);
      ctx.fill();
    }

    // Where it is now, against where it goes off. Only drawn once the two are
    // far enough apart to be telling us something.
    if (Math.hypot(gx - bx, gy - by) > 6) {
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${DODGE_RING_RGB}, 0.6)`;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(${DODGE_RING_RGB}, 0.8)`;
      ctx.beginPath();
      ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }


  function drawDodgePlan(ctx) {
    const sample = pageSamples[pageSamples.length - 1];
    const player = sample && sample.self;
    if (!player) return;
    // The camera's own centre, on the render clock — the same position the ESP
    // rings are measured from, so the plan lands in the world rather than
    // relative to a second idea of where we are.
    const pi = stateOnClock(player.id, renderNowMs())
      || interpPos('__self__', player.x, player.y);
    const scale = getLivePxPerWorldUnit(sample);
    if (!(scale > 0)) return;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const px = (wx) => cx + (wx - pi.x) * scale;
    const py = (wy) => cy - (wy - pi.y) * scale;

    const n = dodgePath.n;
    const xs = dodgePath.x, ys = dodgePath.y;

    ctx.lineJoin = 'round';

    // Playout -> packet. Dotted and faint: this is the distance the renderer is
    // behind the newest update, so it is a statement about the screen and not
    // about the plan. Butt caps so the dots stay dots. The near end is the
    // camera centre by construction — pi is what the projection is built on —
    // but it is written through px/py anyway, because it is a world position
    // that happens to land there and not a screen constant.
    ctx.lineCap = 'butt';
    ctx.setLineDash([1.5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${DODGE_PATH_RGB}, 0.3)`;
    ctx.beginPath();
    ctx.moveTo(px(pi.x), py(pi.y));
    ctx.lineTo(px(dodgePath.startX), py(dodgePath.startY));
    ctx.stroke();

    ctx.lineCap = 'round';

    // Packet -> carried, the ping lead. Dashed because it is not a decision —
    // it is the distance the heading already held carries us while the press is
    // in flight, and the search is handed its far end as a fait accompli. At
    // Ping lead 0 this collapses and the plan starts on the packet.
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${DODGE_PATH_RGB}, 0.45)`;
    ctx.beginPath();
    ctx.moveTo(px(dodgePath.startX), py(dodgePath.startY));
    ctx.lineTo(px(xs[0]), py(ys[0]));
    ctx.stroke();
    ctx.setLineDash([]);

    // The handover, marked: everything nearer than this dot is latency, and
    // everything past it is the search. Without it the two dash patterns are
    // the only thing saying where one ends and the other begins, which is not
    // much to go on at a glance in the middle of a fight.
    ctx.fillStyle = `rgba(${DODGE_PATH_RGB}, 0.55)`;
    ctx.beginPath();
    ctx.arc(px(dodgePath.startX), py(dodgePath.startY), 2, 0, Math.PI * 2);
    ctx.fill();

    // A dark casing under the whole line first. The map runs from sand to dark
    // water and a single stroke is legible over about half of it.
    ctx.beginPath();
    ctx.moveTo(px(xs[0]), py(ys[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(px(xs[i]), py(ys[i]));
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.stroke();

    // Then the line, in two parts, split at the leg being pressed. The plan is
    // held between packets rather than remade every frame — see dodgeStep — so
    // it is worth being able to see it being spent: everything behind the split
    // is a decision already sent, and everything ahead is what is left to hold
    // if nothing new arrives. On a healthy link the split sits at the first or
    // second dot and never travels far before the plan is replaced.
    const done = Math.max(0, Math.min(dodgePlan.leg, n - 1));
    if (done > 0) {
      ctx.beginPath();
      ctx.moveTo(px(xs[0]), py(ys[0]));
      for (let i = 1; i <= done; i++) ctx.lineTo(px(xs[i]), py(ys[i]));
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(${DODGE_PATH_RGB}, 0.35)`;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(px(xs[done]), py(ys[done]));
    for (let i = done + 1; i < n; i++) ctx.lineTo(px(xs[i]), py(ys[i]));
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(${DODGE_PATH_RGB}, 0.9)`;
    ctx.stroke();

    // One dot per decision, so the step length is visible: the plan is a
    // sequence of DODGE.stepS-long commitments, not a curve, and how far apart
    // these sit is how coarse it is. Faded on the ones already spent, to the
    // same value as the leg they open.
    for (let i = 0; i < n - 1; i++) {
      ctx.fillStyle = `rgba(${DODGE_PATH_RGB}, ${i < done ? 0.35 : 0.9})`;
      ctx.beginPath();
      ctx.arc(px(xs[i]), py(ys[i]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // The far end, at the horizon. Hollow, because it is where the plan stops
    // being scored rather than anywhere it intends to arrive — the leg that
    // gets pressed is the first one, and the rest exist to judge it.
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${DODGE_PATH_RGB}, 0.9)`;
    ctx.beginPath();
    ctx.arc(px(xs[n - 1]), py(ys[n - 1]), 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  function overlayFrame() {
    // Ahead of the ESP gate below: both of these are their own toggle and have
    // to keep working (and keep the world's art switched off) with the ESP
    // overlay itself off.
    try { debugRenderTick(); } catch {}
    try { espTick(); } catch {}

    if (!ensureOverlayCanvas()) {
      requestAnimationFrame(overlayFrame);
      return;
    }
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // ESP off: keep the loop (and the canvas) alive but draw nothing, so
    // flipping the toggle back on resumes on the very next frame. Sampling,
    // aim and netcode are untouched — this is a display switch only.
    //
    // The dodge plan and the grenade rings are their own toggles on the same
    // canvas, and one of the things they are for is watching the bot with
    // nothing else drawn over the screen — so each holds the canvas open on its
    // own, and no switch can blank another's drawing.
    const showPlan = dodgePlanVisible();
    const showRings = dodgeRingsVisible();
    overlayCanvas.style.display = (ESP.enabled || showPlan || showRings) ? 'block' : 'none';
    if (!ESP.enabled && !showPlan && !showRings) {
      requestAnimationFrame(overlayFrame);
      return;
    }

    const sample = pageSamples[pageSamples.length - 1];
    if (ESP.enabled && sample && sample.self && sample.enemies && sample.enemies.length) {
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

    // Under the plan, over the ESP: a 12u circle is a big shape and the plan is
    // a thin line, so the line has to win where they cross.
    if (showRings) {
      try { drawGrenadeRings(ctx); } catch {}
    }

    // Last, so it sits over the rings rather than under them.
    if (showPlan) {
      try { drawDodgePlan(ctx); } catch {}
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
    pingMs: smoothedPingMs(),
    // Effective sample count behind that mean, i.e. 1/(1 - lam) once the
    // weight has settled — the analogue of the old buffer length.
    pingWeight: Number(pingState.sw.toFixed(2)),
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
    const pingMs = smoothedPingMs();
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
