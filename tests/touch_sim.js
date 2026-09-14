// Offline test harness for the mobile/touch input path in inject.js.
//
//     node touch_sim.js
//
// A touch device builds its input message from two virtual pads instead of
// from a mouse and four keys, and every cheat in inject.js that touches input
// has to be re-pointed at them. That re-pointing is easy to get wrong in ways
// no amount of looking at a phone will show you:
//
//   - the throw throttle is an *inverse*. The message carries
//     `clamp(toAimLen / padPosRange, 0, 1) * throwableMaxMouseDist`, so putting
//     a solved cursor distance on the wire means solving that back for
//     `toAimLen`. Get the direction of the division wrong and every grenade
//     still flies — just never as far as it was aimed, and only at long range,
//     which reads as "the solver is a bit off" rather than as a bug.
//   - the aim pad can be taken away from you. If the returned reading says the
//     pad is untouched, the caller hands the aim to the *movement* stick's
//     bearing a few lines later, and a driven bearing silently becomes
//     whichever way the player is walking.
//   - standing still is not a direction. The movement half of the message is
//     gated on `moveDetected`, not on the vector, and a zero vector goes
//     through `normalizeSafe(v, (1,0))` — so "hold this position" written as
//     (0,0) walks due east at full speed.
//
// So this pulls the touch layer verbatim out of inject.js and drives it
// through a port of the bundle's own pads and input build, transcribed from
// the deobfuscated client (`js_dump/Dzch6shQ_formatted.js`: class `Sr` at
// ~13340 for the pads, and the `if (k.touch)` branch at ~15859 for the
// message). The harness cannot drift from the shipped code, because the half
// under test *is* the shipped code.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'core', 'inject.js'), 'utf8');

function extract(name) {
  const start = src.indexOf(`\n  function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}() in inject.js`);
  const end = src.indexOf('\n  }\n', start);
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  return src.slice(start, end + 4);
}

// The raw right-hand side of a `const NAME = ...;`, for the ones that are an
// expression rather than a literal.
function grabExpr(name) {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
  if (!m) throw new Error(`could not find const ${name} in inject.js`);
  return m[1];
}

function grabConst(name) {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
  if (!m) throw new Error(`could not find const ${name} in inject.js`);
  return Number(m[1]);
}

// A single-line `const NAME = ...;` or `let NAME = ...;`, taken whole. Pass the
// keyword with the name for a `let`.
function grabLine(name) {
  const decl = name.startsWith('let ') ? name : `const ${name}`;
  const m = new RegExp(`\n  ${decl} = .*;\n`).exec(src);
  if (!m) throw new Error(`could not find ${decl} in inject.js`);
  return m[0];
}

// A multi-line `const NAME = {...};` or `const NAME = [...];`, taken whole.
function grabBlock(name, close) {
  const start = src.indexOf(`\n  const ${name} = `);
  if (start < 0) throw new Error(`could not find const ${name} in inject.js`);
  const end = src.indexOf(`\n  ${close}\n`, start);
  if (end < 0) throw new Error(`could not find the end of const ${name}`);
  return src.slice(start, end + close.length + 4);
}

const PROJ_MAX_MOUSE_DIST = grabConst('PROJ_MAX_MOUSE_DIST');
const PROJ_MOUSE_CLAMP = grabConst('PROJ_MOUSE_CLAMP');
const TOUCH_STALE_MS = grabConst('TOUCH_STALE_MS');
const AUTO_SWAP_INPUT_FIRE = grabConst('AUTO_SWAP_INPUT_FIRE');
const AUTO_SWAP_INPUT_EQUIP_OTHER = grabConst('AUTO_SWAP_INPUT_EQUIP_OTHER');

// ---- The shipped touch layer -------------------------------------------
//
// Everything it reaches outside itself is stubbed to the scenario: the game
// ref and the bind object it reads the user's trigger through, and the four
// desktop-cursor globals `userAim` falls back to when the pads are cold.

const env = {
  capturedGame: null,
  binds: null,
  realMouse: { x: 0, y: 0, hasMoved: false },
  scale: 20,            // pixels per world unit
  obstacles: [],
};

const elg = eval(`(function () {
  const PROJ_MAX_MOUSE_DIST = ${PROJ_MAX_MOUSE_DIST};
  const GAME_BINDS = 'binds';
  const AUTO_SWAP_INPUT_FIRE = ${AUTO_SWAP_INPUT_FIRE};
  const window = { innerWidth: 800, innerHeight: 600 };
  const pageSamples = [];
  const realMouse = env.realMouse;
  const getLivePxPerWorldUnit = () => env.scale;
  const dodgeArrowDown = new Map();
  const dodgeDirIndex = () => 0;
  const realBindDown = (binds, input) => !!(binds && binds.realDown(input));
  let capturedGame = null;
  ${grabBlock('touchState', '};')}
  ${grabLine('touchAimOut')}
  ${grabLine('touchMoveOut')}
  ${grabLine('userAimOut')}
  const DODGE_K = ${grabExpr('DODGE_K')};
  ${grabBlock('DODGE_DIRS', '];')}
  let cachedTouchKey = null;
  ${extract('angleDelta')}
  ${extract('looksLikeTouchInput')}
  ${extract('findTouchOnGame')}
  ${extract('ensureTouchHook')}
  ${extract('touchActive')}
  ${extract('touchPadRange')}
  ${extract('touchAimOverride')}
  ${extract('touchWriteAimDir')}
  ${extract('touchMoveOverride')}
  ${extract('touchDriveAim')}
  ${extract('touchReleaseAim')}
  ${extract('touchDriveMove')}
  ${extract('touchReleaseMove')}
  const PLAYER_NET = 'netData';
  const NET_WEAPON = 'activeWeapon';
  const PLAYER_LOC = 'localData';
  const LOC_SLOTS = 'weapons';
  const LOC_CURIDX = 'curWeapIdx';
  const AIMBOT = { enabled: 1 };
  const AUTOSHOOT = { enabled: 1 };
  ${grabBlock('GUN_FIRE_DELAY', '};')}
  ${extract('getCurrentWeapon')}
  // Target selection, cone and all. The sample ring is the scenario's, and the
  // filters pickTarget runs ahead of scoring are reduced to "alive": they are
  // tested where they live, and nothing here is about them.
  const isEngageable = (e) => !!e && !e.dead;
  const isSpoofedEnemy = () => false;
  const canInteract = () => true;
  const livePos = (id, e) => e;
  const liveSelf = (s) => s.self;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  ${grabBlock('TOUCH_CONE', '};')}
  ${grabLine('let touchConeHeldAt')}
  ${grabBlock('aimState', '};')}
  ${grabLine('AIM_COVER_STALE_MS')}
  ${extract('touchConeAdmits')}
  ${extract('pickTarget')}
  ${extract('aimCoverOnly')}
  ${extract('touchConeTarget')}
  // The cover sweep, over the scenario's obstacles.
  const getObstacles = () => env.obstacles;
  const COLLIDER_CIRCLE = ${grabConst('COLLIDER_CIRCLE')};
  const COLLIDER_AABB = ${grabConst('COLLIDER_AABB')};
  const BULLET_HEIGHT = ${grabConst('BULLET_HEIGHT')};
  ${extract('sameLayerAs')}
  ${extract('blocksBullets')}
  ${extract('segHitCircle')}
  ${extract('segHitAabb')}
  ${extract('segHitCollider')}
  ${extract('colliderNearSegment')}
  ${extract('blockedOnlyByDestructibles')}
  ${extract('touchShotSuppressed')}
  ${extract('userFireDown')}
  ${extract('userAim')}
  ${extract('userAimScore')}
  ${extract('dodgeUserDirIdx')}
  const AUTO_SWAP = { enabled: 1 };
  const ensureBindHook = () => {};
  const requestAnimationFrame = () => 0;
  let swapsQueued = 0;
  const autoSwapOnFirePressed = () => { swapsQueued++; };
  ${grabLine('let autoSwapFireWasDown').replace('let ', 'let ')}
  ${extract('autoSwapFrameTick')}
  return {
    autoSwapFrameTick,
    setAimbotEnabled: (v) => { AIMBOT.enabled = v; },
    setAutoshootEnabled: (v) => { AUTOSHOOT.enabled = v; },
    swaps: () => swapsQueued,
    resetSwaps: () => { swapsQueued = 0; autoSwapFireWasDown = false; },
    setAutoSwapEnabled: (v) => { AUTO_SWAP.enabled = v; },
    touchState, DODGE_DIRS, TOUCH_CONE, aimState, AIM_COVER_STALE_MS,
    ensureTouchHook, touchActive, touchDriveAim, touchReleaseAim,
    touchDriveMove, touchReleaseMove, userFireDown,
    userAim, userAimScore, dodgeUserDirIdx, pickTarget,
    blockedOnlyByDestructibles,
    setGame: (g) => { capturedGame = g; },
    // The scene: our own sample and who is on the field around us.
    setField: (self, enemies) => {
      pageSamples.length = 0;
      if (self) pageSamples.push({ self, enemies });
    },
    // Forget the cone's hold, or backdate it by ms as if that long had passed.
    resetCone: () => { touchConeHeldAt = -Infinity; },
    ageCone: (ms) => { touchConeHeldAt -= ms; },
  };
})()`);

// ---- The bundle's own pads and input build ------------------------------
//
// Transcribed from the deobfuscated client. Names are the readable ones; the
// arithmetic is the bundle's, character for character.

const PAD_DEAD = 2;              // `br`
const EPS = 1e-5;                // `xr`
const THROWABLE_MAX_MOUSE_DIST = 18;   // GameConfig.player.throwableMaxMouseDist
const MOUSE_MAX_DIST = 64;             // net.Constants.MouseMaxDist

const vlen = (v) => Math.hypot(v.x, v.y);
const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const vdiv = (v, s) => ({ x: v.x / s, y: v.y / s });
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const normalizeSafe = (v, fb) => {
  if (!v) return { x: fb.x, y: fb.y };
  const l = vlen(v);
  return l > EPS ? { x: v.x / l, y: v.y / l } : { x: fb.x, y: fb.y };
};

class TouchInput {
  constructor() {
    this.aimMovement = { toAimDir: { x: 1, y: 0 }, toAimLen: 0 };
    this.analogMovement = { toMoveDir: { x: 1, y: 0 }, toMoveLen: 0 };
    this.padPosBase = 48;
    this.padScaleBase = 1;
    this.padPosRange = 48;
    this.movePadDetectMult = 1;
    this.shotPadDetectMult = 1.075;
    this.turnDirCooldown = 0.5;
    this.turnDirTicker = 0;
    this.moveDetected = false;
    this.shotDetected = false;
    this.shotDetectedOld = false;
    this.touchingAim = false;
    this.leftLockedPadCenter = { x: 120, y: 480 };
    this.rightLockedPadCenter = { x: 680, y: 480 };
    this.moveStyle = 'locked';
    this.aimStyle = 'locked';
    this.touches = [];   // { pos, posDown, isDead }
  }

  isLeftSideTouch(x, camera) { return x < camera.width * 0.5; }

  getMovement(camera) {
    this.moveDetected = false;
    for (const t of this.touches) {
      if (t.isDead || !this.isLeftSideTouch(t.posDown.x, camera)) continue;
      const center = this.moveStyle === 'anywhere' ? t.posDown : this.leftLockedPadCenter;
      const a = vsub(t.pos, center);
      const s = vlen(a);
      if (s > PAD_DEAD) {
        const e = (s - PAD_DEAD) / (this.padPosRange / this.movePadDetectMult - PAD_DEAD);
        const i = e > EPS ? vdiv(a, e) : this.analogMovement.toMoveDir;
        this.analogMovement = { toMoveDir: { x: i.x, y: i.y * -1 }, toMoveLen: e };
        this.moveDetected = true;
      }
      break;
    }
    return this.analogMovement;
  }

  getAim(isThrowable, camera) {
    let touched = false;
    for (const t of this.touches) {
      if (t.isDead || this.isLeftSideTouch(t.posDown.x, camera)) continue;
      const center = this.aimStyle === 'anywhere' ? t.posDown : this.rightLockedPadCenter;
      const d = vsub(t.pos, center);
      const s = vlen(d);
      if (s > PAD_DEAD) {
        const a = s > EPS ? vdiv(d, s) : this.aimMovement.toAimDir;
        this.aimMovement = { toAimDir: { x: a.x, y: a.y * -1 }, toAimLen: s };
      } else this.aimMovement.toAimLen = 0;
      touched = true;
      break;
    }
    this.shotDetectedOld = this.shotDetected;
    this.shotDetected =
      this.aimMovement.toAimLen > this.padPosRange / this.shotPadDetectMult && touched;
    this.touchingAim = touched;
    if (isThrowable && this.shotDetectedOld && touched) this.shotDetected = true;
    return { aimMovement: this.aimMovement, touched };
  }

  getTouchMovement(camera) { return this.getMovement(camera); }
  getAimMovement(player, camera) { return this.getAim(!!player.throwableEquipped, camera); }
  setAimDir(d) { this.aimMovement.toAimDir = { x: d.x, y: d.y }; }
}

// The bind layer, with inject.js's own synthetic-input hook over it so a test
// can tell the user's trigger from autoshoot's.
function makeBinds() {
  const userDown = new Set();
  const synthetic = new Set();
  return {
    userDown, synthetic,
    realDown: (input) => userDown.has(input),
    isBindDown: (input) => synthetic.has(input) || userDown.has(input),
    isBindPressed: (input) => synthetic.has(input) || userDown.has(input),
  };
}

const camera = { width: 800, height: 600 };

// The `if (device.touch)` half of the bundle's input build, verbatim.
function buildInputMsg(touch, binds, player, dt) {
  const msg = {};
  const move = touch.getTouchMovement(camera);
  const aim = touch.getAimMovement(player, camera);
  let dir = { x: aim.aimMovement.toAimDir.x, y: aim.aimMovement.toAimDir.y };
  touch.turnDirTicker -= dt;
  if (touch.moveDetected && !aim.touched) {
    const md = normalizeSafe(move.toMoveDir, { x: 1, y: 0 });
    const pick = touch.turnDirTicker < 0 ? md : aim.aimMovement.toAimDir;
    touch.setAimDir(pick);
    dir = pick;
  }
  if (aim.touched) touch.turnDirTicker = touch.turnDirCooldown;
  if (touch.moveDetected) {
    msg.touchMoveDir = normalizeSafe(move.toMoveDir, { x: 1, y: 0 });
    msg.touchMoveLen = Math.round(clamp(move.toMoveLen, 0, 1) * 255);
  } else msg.touchMoveLen = 0;
  msg.touchMoveActive = true;
  msg.toMouseLen = clamp(aim.aimMovement.toAimLen / touch.padPosRange, 0, 1)
    * THROWABLE_MAX_MOUSE_DIST;
  msg.toMouseDir = dir;

  msg.touchMoveDir = normalizeSafe(msg.touchMoveDir, { x: 1, y: 0 });
  msg.touchMoveLen = clamp(msg.touchMoveLen, 0, 255);
  msg.toMouseDir = normalizeSafe(msg.toMouseDir, { x: 1, y: 0 });
  msg.toMouseLen = clamp(msg.toMouseLen, 0, MOUSE_MAX_DIST);
  msg.shootStart = binds.isBindPressed(AUTO_SWAP_INPUT_FIRE) || touch.shotDetected;
  msg.shootHold = binds.isBindDown(AUTO_SWAP_INPUT_FIRE) || touch.shotDetected;
  // The equip-input loop that follows in the same build, outside the touch
  // branch. Only the three auto-quickswap presses are listed; the other
  // thirteen behave identically and nothing here presses them.
  msg.inputs = [13 /* EquipMelee */, 19 /* EquipLastWeap */, 20 /* EquipOtherGun */]
    .filter((i) => binds.isBindPressed(i));
  return msg;
}

// What the server does with the movement half.
const MOVE_SPEED = 12;
function serverVelocity(msg) {
  if (!msg.touchMoveActive || !msg.touchMoveLen) return { x: 0, y: 0 };
  const d = normalizeSafe(msg.touchMoveDir, { x: 1, y: 0 });
  const s = (msg.touchMoveLen / 255) * MOVE_SPEED;
  return { x: d.x * s, y: d.y * s };
}

// ---- Scenario plumbing --------------------------------------------------

// Put a finger on a pad. `bearing` is screen-space from the pad's centre and
// `pull` is in pixels, so a pull past padPosRange/1.075 is a shot.
function finger(center, bearing, pull) {
  const pos = {
    x: center.x + Math.cos(bearing) * pull,
    y: center.y - Math.sin(bearing) * pull,
  };
  return { pos, posDown: pos, isDead: false };
}

function newScene() {
  const touch = new TouchInput();
  const binds = makeBinds();
  const game = { touch, binds };
  elg.touchState.target = null;
  elg.touchState.driveAim = false;
  elg.touchState.owner = null;
  elg.touchState.driveLen = -1;
  elg.touchReleaseMove();
  elg.setField(null);
  elg.resetCone();
  elg.aimState.coverId = null;
  elg.setGame(game);
  env.binds = binds;
  elg.ensureTouchHook(game);
  return { touch, binds, game };
}

// One rendered frame: the hook installer runs, then the game builds a message.
function frame(scene, player = {}, dt = 1 / 60) {
  return buildInputMsg(scene.touch, scene.binds, player, dt);
}

// ---- Assertions ---------------------------------------------------------

let failures = 0;
let checks = 0;
const results = [];

function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  results.push({ name, pass, detail: detail || '' });
}

function near(a, b, tol) { return Math.abs(a - b) <= tol; }
function bearingOf(v) { return Math.atan2(v.y, v.x); }
function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

// ---- 1. A driven bearing reaches the wire -------------------------------

{
  const scene = newScene();
  // The user's thumb is pulled hard due south-west; the aim we drive has
  // nothing to do with it.
  scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, -2.4, 47)];
  let worst = 0;
  for (let i = 0; i < 16; i++) {
    const want = -Math.PI + (i * Math.PI * 2) / 16;
    elg.touchDriveAim('aim', Math.cos(want), Math.sin(want));
    const msg = frame(scene);
    worst = Math.max(worst, angDiff(bearingOf(msg.toMouseDir), want));
  }
  ok('gun aim: every driven bearing reaches toMouseDir', worst < 1e-9,
     `worst error ${worst.toExponential(1)} rad over 16 bearings`);
}

// ---- 2. The throw throttle round-trips ----------------------------------

{
  const scene = newScene();
  scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, 0.3, 47)];
  let worst = 0;
  for (let i = 0; i <= 36; i++) {
    const want = (i / 36) * PROJ_MAX_MOUSE_DIST;
    elg.touchDriveAim('frag', 1, 0, want);
    const msg = frame(scene, { throwableEquipped: true });
    worst = Math.max(worst, Math.abs(msg.toMouseLen - want));
  }
  ok('frag: a solved cursor distance round-trips through the pad', worst < 1e-9,
     `worst error ${worst.toExponential(1)}u over 0..${PROJ_MAX_MOUSE_DIST}u`);

  // Past the pad's ceiling the message saturates, which is why the solver is
  // capped to the same 18 on a touch device.
  elg.touchDriveAim('frag', 1, 0, 31.5);
  const over = frame(scene, { throwableEquipped: true });
  ok('frag: a throw past the pad ceiling saturates rather than wrapping',
     near(over.toMouseLen, PROJ_MAX_MOUSE_DIST, 1e-9),
     `asked 31.5u, wire carried ${over.toMouseLen.toFixed(3)}u`);

  // The pad also scales: a phone in the smaller layout has a shorter throw of
  // the thumb for the same throw of the grenade.
  scene.touch.padScaleBase = 0.8;
  scene.touch.padPosRange = 48 * 0.8;
  elg.touchDriveAim('frag', 1, 0, 9);
  const small = frame(scene, { throwableEquipped: true });
  ok('frag: the round trip follows padPosRange when the pad is rescaled',
     near(small.toMouseLen, 9, 1e-9),
     `asked 9u at padPosRange ${scene.touch.padPosRange}, wire carried ${small.toMouseLen.toFixed(3)}u`);
}

// ---- 3. A driven frame keeps the pad ------------------------------------
//
// The bundle hands the aim to the movement stick's bearing when the aim pad
// reads untouched and the turn cooldown has run out. That is the case a driven
// bearing has to survive.

{
  const scene = newScene();
  scene.touch.touches = [finger(scene.touch.leftLockedPadCenter, Math.PI, 40)];  // walking west
  scene.touch.turnDirTicker = -1;   // cooldown already expired

  const undriven = frame(scene);
  ok('control: an untouched aim pad follows the movement bearing',
     angDiff(bearingOf(undriven.toMouseDir), Math.PI) < 1e-6,
     `aim went to ${(bearingOf(undriven.toMouseDir) * 180 / Math.PI).toFixed(1)}°, walking west`);

  scene.touch.turnDirTicker = -1;
  elg.touchDriveAim('aim', 0, 1);   // due north
  const driven = frame(scene);
  ok('gun aim: a driven bearing is not stolen by the movement stick',
     angDiff(bearingOf(driven.toMouseDir), Math.PI / 2) < 1e-9,
     `aim held ${(bearingOf(driven.toMouseDir) * 180 / Math.PI).toFixed(1)}° while walking west`);
}

// ---- 4. Releasing hands the aim back ------------------------------------

{
  const scene = newScene();
  const userBearing = -0.9;
  scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, userBearing, 30)];
  frame(scene);                                  // record the user's own pad
  elg.touchDriveAim('aim', 0, 1);
  frame(scene);                                  // drive it somewhere else
  elg.touchReleaseAim('aim');
  // Lift the finger, so nothing recomputes the pad: the restore is the only
  // thing that can put the aim back.
  scene.touch.touches = [];
  const after = frame(scene);
  ok('release: the aim goes back to the user\'s own thumb',
     angDiff(bearingOf(after.toMouseDir), userBearing) < 1e-9,
     `restored to ${(bearingOf(after.toMouseDir) * 180 / Math.PI).toFixed(1)}°, thumb at ${(userBearing * 180 / Math.PI).toFixed(1)}°`);

  // ...and only for the owner. Frag must not be able to hand back a pad the
  // gun aim is holding, or a cook that ends mid-burst drops the crosshair.
  elg.touchDriveAim('aim', 0, 1);
  elg.touchReleaseAim('frag');
  ok('release: one driver cannot hand back another\'s pad',
     elg.touchState.driveAim === true && elg.touchState.owner === 'aim',
     'frag released while aim was driving');
  elg.touchReleaseAim('aim');
}

// ---- 5. The trigger is the user's, not ours -----------------------------

{
  const scene = newScene();
  const range = scene.touch.padPosRange / scene.touch.shotPadDetectMult;

  scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, 0.4, range - 3)];
  frame(scene);
  ok('trigger: a partial pull aims without firing',
     scene.touch.shotDetected === false && elg.userFireDown() === false,
     `pulled ${(range - 3).toFixed(1)}px of ${range.toFixed(1)}px`);

  scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, 0.4, range + 3)];
  frame(scene);
  ok('trigger: a full pull is the activation',
     scene.touch.shotDetected === true && elg.userFireDown() === true,
     `pulled ${(range + 3).toFixed(1)}px of ${range.toFixed(1)}px`);

  // Autoshoot presses Fire through the bind hook. That must not read back as
  // the user holding the trigger, or the aim helper latches on forever.
  scene.touch.touches = [];
  frame(scene);
  scene.binds.synthetic.add(AUTO_SWAP_INPUT_FIRE);
  const msg = frame(scene);
  ok('trigger: autoshoot\'s own press does not latch the activation',
     elg.userFireDown() === false && msg.shootHold === true,
     'synthetic Fire reached the wire without reading back as the user');
  scene.binds.synthetic.delete(AUTO_SWAP_INPUT_FIRE);

  // A real bind still counts — a paired controller or keyboard goes through it.
  scene.binds.userDown.add(AUTO_SWAP_INPUT_FIRE);
  frame(scene);
  ok('trigger: a real Fire bind still activates', elg.userFireDown() === true,
     'a paired controller counts as the trigger');
}

// ---- 6. The pull is an activation, not a trigger ------------------------
//
// A pad has one gesture where a desktop has two fingers, so leaving the pull
// wired to the trigger as well as to the activation means the gun fires
// whenever the user is aiming — into walls, at nobody, and straight through
// the slow-gun swap cycle, which depends on every shot being one autoshoot
// took a magazine reading before.

const GUN = { netData: { activeWeapon: 'mosin' } };        // slow, single-shot
const MELEE = { netData: { activeWeapon: 'machete' } };
const NADE = { netData: { activeWeapon: 'frag' }, throwableEquipped: true };

// Somewhere `bearing` radians from us and `range` units out.
const onBearing = (bearing, range, extra) =>
  ({ id: 1, x: Math.cos(bearing) * range, y: Math.sin(bearing) * range, ...extra });
const ME = { x: 0, y: 0, layer: 0 };

{
  const scene = newScene();
  const range = scene.touch.padPosRange / scene.touch.shotPadDetectMult;
  const hold = () => {
    scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, 0.4, range + 5)];
  };
  // Everything in this section is an engagement: someone is standing where
  // the thumb points. With nobody there the pull is the user's — section 7.
  elg.setField(ME, [onBearing(0.4, 20)]);

  hold();
  const msg = frame(scene, GUN);
  ok('activation: holding the pad out does not fire the gun by itself',
     msg.shootStart === false && msg.shootHold === false,
     'shotDetected is recorded, then taken off the message');
  ok('activation: ...but it is still the activation',
     elg.userFireDown() === true && scene.touch.shotDetected === false,
     'the aim helper engages off a trigger the game never sees');

  // Autoshoot is now the only thing that can fire, which is the whole point.
  scene.binds.synthetic.add(AUTO_SWAP_INPUT_FIRE);
  const shot = frame(scene, GUN);
  ok('activation: autoshoot still fires through the same message',
     shot.shootStart === true && shot.shootHold === true, '');
  scene.binds.synthetic.delete(AUTO_SWAP_INPUT_FIRE);

  // The bug this fixes: a held pad trigger rides the same message as the swap,
  // so the swapped-to gun's shot is spent before autoshoot ever reads its
  // magazine, and a pair of slow guns trades places once and then stops.
  scene.binds.synthetic.add(AUTO_SWAP_INPUT_EQUIP_OTHER);
  const swap = frame(scene, GUN);
  ok('activation: the tick that carries a swap carries no shot',
     swap.inputs.includes(AUTO_SWAP_INPUT_EQUIP_OTHER) && swap.shootHold === false,
     'the swapped-to gun is not fired before autoshoot has read its magazine');
  scene.binds.synthetic.delete(AUTO_SWAP_INPUT_EQUIP_OTHER);

  // Either switch hands the trigger straight back: with one off nothing else
  // is going to fire, and the user would be left unarmed.
  elg.setAutoshootEnabled(0);
  ok('activation: turning autoshoot off hands the trigger back',
     frame(scene, GUN).shootHold === true, '');
  elg.setAutoshootEnabled(1);

  elg.setAimbotEnabled(0);
  ok('activation: turning the aimbot off hands the trigger back',
     frame(scene, GUN).shootHold === true, '');
  elg.setAimbotEnabled(1);

  // A melee is not autoshoot's to swing.
  ok('activation: a melee still swings on the user\'s own pull',
     frame(scene, MELEE).shootHold === true, '');
}

// ---- 7. ...but only when there is someone to shoot -----------------------
//
// Taking the trigger unconditionally left no gesture that meant "fire at that
// crate". So it is autoshoot's only while an enemy is inside the aim cone;
// point away from everyone and the pull is an ordinary shot again.

{
  const scene = newScene();
  const range = scene.touch.padPosRange / scene.touch.shotPadDetectMult;
  const THUMB = 0.4;
  const deg = (d) => d * Math.PI / 180;
  // A frame with the thumb pulled all the way out at THUMB and one enemy at
  // `offDeg` degrees off it (or nobody), holding a gun.
  const pullAt = (offDeg, extra) => {
    elg.setField(ME, offDeg == null ? [] : [onBearing(THUMB + deg(offDeg), 20, extra)]);
    scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, THUMB, range + 5)];
    return frame(scene, GUN);
  };
  const { enterDeg, exitDeg, holdMs } = elg.TOUCH_CONE;

  ok('scenery: with nobody on the field the pull fires the gun',
     pullAt(null).shootHold === true && elg.userFireDown() === true,
     'shot reaches the wire, and it is still the activation');

  elg.resetCone();
  ok('scenery: an enemy well outside the cone does not take the trigger',
     pullAt(enterDeg + 30).shootHold === true,
     `enemy ${enterDeg + 30}° off the thumb`);

  elg.resetCone();
  ok('cone: an enemy inside it does',
     pullAt(enterDeg - 5).shootHold === false,
     `enemy ${enterDeg - 5}° off the thumb`);

  // The same enemy drifting out past the entry width, but not the exit one,
  // stays engaged — the thumb sweeping over the edge must not flip the trigger
  // between the user and autoshoot every frame.
  ok('cone: once engaged, it holds out to the wider exit width',
     pullAt((enterDeg + exitDeg) / 2).shootHold === false,
     `${(enterDeg + exitDeg) / 2}° off, between ${enterDeg}° and ${exitDeg}°`);
  ok('cone: ...and lets go past it',
     pullAt(exitDeg + 5).shootHold === true,
     `${exitDeg + 5}° off`);

  // Picked up cold, that in-between angle is outside.
  elg.resetCone();
  ok('cone: the wider width is not where an engagement starts',
     pullAt((enterDeg + exitDeg) / 2).shootHold === true,
     `${(enterDeg + exitDeg) / 2}° off with no engagement in the last ${holdMs}ms`);

  // ...and the hold runs out.
  pullAt(enterDeg - 5);
  elg.ageCone(holdMs + 10);
  ok('cone: the hold expires after holdMs without anyone inside',
     pullAt((enterDeg + exitDeg) / 2).shootHold === true,
     `${holdMs + 10}ms since the last engagement`);

  // The aim and the trigger ask the same question, so they cannot disagree.
  elg.resetCone();
  elg.setField(ME, [onBearing(THUMB + deg(enterDeg + 30), 20)]);
  ok('cone: the aim helper picks nobody outside it either',
     elg.pickTarget(ME, [onBearing(THUMB + deg(enterDeg + 30), 20)], Date.now())[0] === null, '');

  // A throwable is still the cook, cone or no cone.
  elg.resetCone();
  elg.setField(ME, []);
  scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, THUMB, range + 5)];
  frame(scene, NADE);
  ok('scenery: a grenade still cooks with nobody around',
     scene.touch.shotDetected === true, '');
  scene.touch.touches = [];
  frame(scene, NADE);
}

// ---- 8. An enemy behind a crate hands the trigger back -------------------
//
// The aim helper declines a blocked target, so nothing is going to fire at
// them — and the crate in the way is exactly what the user wants to shoot.

{
  const scene = newScene();
  const range = scene.touch.padPosRange / scene.touch.shotPadDetectMult;
  const pull = () => {
    scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, 0.4, range + 5)];
    return frame(scene, GUN);
  };
  elg.setField(ME, [onBearing(0.4, 20)]);

  ok('cover: with no verdict from the aim loop the trigger stays autoshoot\'s',
     pull().shootHold === false, 'the first frame of a pull, before the aim loop has run');

  elg.aimState.coverId = 1;
  elg.aimState.coverAt = performance.now();
  ok('cover: destructible cover in the way hands it back',
     pull().shootHold === true, '');

  elg.aimState.coverAt = performance.now() - (elg.AIM_COVER_STALE_MS + 10);
  ok('cover: a stale verdict is not read',
     pull().shootHold === false, `${elg.AIM_COVER_STALE_MS + 10}ms old`);

  elg.aimState.coverId = 2;
  elg.aimState.coverAt = performance.now();
  ok('cover: a verdict about somebody else is not read',
     pull().shootHold === false, 'cover verdict for id 2, cone target id 1');
  elg.aimState.coverId = null;

  // The sweep. A box collider from (x0,y0) to (x1,y1).
  const box = (x0, y0, x1, y1, destructible) => ({
    active: true, dead: false, collidable: true, isWindow: false, height: 1,
    layer: 0, destructible,
    collider: { type: 1, min: { x: x0, y: y0 }, max: { x: x1, y: y1 } },
  });
  const crate = box(9, -1, 11, 1, true);
  const wall = box(14, -3, 15, 3, false);
  const sweep = () => elg.blockedOnlyByDestructibles(0, 0, 20, 0, 0, 1);

  env.obstacles = [];
  ok('cover sweep: a clear line is not "blocked by cover"', sweep() === false, '');
  env.obstacles = [crate];
  ok('cover sweep: a crate alone is', sweep() === true, '');
  env.obstacles = [crate, wall];
  ok('cover sweep: a crate in front of a wall is still a wall', sweep() === false, '');
  env.obstacles = [wall, crate];
  ok('cover sweep: ...in either pool order', sweep() === false, '');
  env.obstacles = [{ ...crate, dead: true }, wall];
  ok('cover sweep: a broken crate in front of a wall is just the wall', sweep() === false, '');
  env.obstacles = [];
}

// ---- 9. A cooking grenade keeps its trigger -----------------------------
//
// For a throwable `shotDetected` is not a trigger at all — it *is* the cook,
// held up by a stickiness rule for as long as a finger is down. Dropping it
// would throw the grenade on the spot.

{
  const scene = newScene();
  const range = scene.touch.padPosRange / scene.touch.shotPadDetectMult;
  const at = (px) => {
    scene.touch.touches = px == null ? []
      : [finger(scene.touch.rightLockedPadCenter, 0.4, px)];
    return frame(scene, NADE);
  };

  at(range + 5);
  ok('cook: pulling past the threshold starts the cook',
     scene.touch.shotDetected === true, '');

  // Frag aim drives the pull down to whatever the solved throw needs. That must
  // not read back as letting go: the stickiness is computed from the real
  // touch, and the toAimLen we write is discarded by the next real read.
  elg.touchDriveAim('frag', 1, 0, 3);
  const lobbing = at(range + 5);
  ok('cook: a solver-driven short throw does not end the cook',
     scene.touch.shotDetected === true && near(lobbing.toMouseLen, 3, 1e-9),
     `wire carried a ${lobbing.toMouseLen.toFixed(1)}u throw with the cook still up`);

  // Easing the thumb back mid-cook is also not letting go.
  ok('cook: easing the thumb back mid-cook does not end it',
     at(range - 20).shootHold === true && scene.touch.shotDetected === true,
     `pulled ${(range - 20).toFixed(1)}px, well under the ${range.toFixed(1)}px threshold`);

  // Lifting it is.
  at(null);
  ok('cook: lifting the thumb throws', scene.touch.shotDetected === false, '');
  elg.touchReleaseAim('frag');
}

// ---- 10. Auto-quickswap's fire edge --------------------------------------
//
// The swap itself already reaches the wire on a pad: the loop that copies
// pressed equip inputs onto the message runs outside the touch branch, off the
// same isBindPressed the synthetic layer wraps. The *edge* that starts it is
// the half that had to be re-pointed — on a pad the user's trigger is not the
// Fire bind, so reading the bind alone left the whole feature inert.

{
  const scene = newScene();
  const range = scene.touch.padPosRange / scene.touch.shotPadDetectMult;
  // One rendered frame with the thumb at `px` out on the aim pad, or off it.
  const pull = (px) => {
    scene.touch.touches = px == null ? []
      : [finger(scene.touch.rightLockedPadCenter, 0.4, px)];
    frame(scene);
    elg.autoSwapFrameTick();
  };

  elg.resetSwaps();
  pull(null);
  pull(range + 5);
  ok('auto-quickswap: a pad pull is a trigger pull', elg.swaps() === 1,
     `${elg.swaps()} queued off one pull past the shot threshold`);

  // Holding it out is one trigger pull, not one per frame — the same edge a
  // held mouse button gives.
  for (let i = 0; i < 10; i++) pull(range + 5);
  ok('auto-quickswap: holding the pad out stays one trigger pull',
     elg.swaps() === 1, `${elg.swaps()} after 10 more held frames`);

  pull(range - 5);   // eased back below the threshold
  pull(range + 5);   // and pulled again
  ok('auto-quickswap: easing off and pulling again is a second',
     elg.swaps() === 2, `${elg.swaps()} after the second pull`);

  // Autoshoot's own presses must not read as the user reaching for the
  // trigger, or every burst it fires queues a swap of its own on top of the
  // one autoshoot already queues itself.
  elg.resetSwaps();
  pull(null);
  scene.binds.synthetic.add(AUTO_SWAP_INPUT_FIRE);
  for (let i = 0; i < 10; i++) pull(null);
  ok('auto-quickswap: autoshoot\'s own presses are not a trigger pull',
     elg.swaps() === 0, `${elg.swaps()} off 10 synthetic presses`);
  scene.binds.synthetic.delete(AUTO_SWAP_INPUT_FIRE);

  // The toggle gates the action but not the edge tracking, so switching it on
  // mid-pull doesn't fire off a pull that started before the toggle flipped.
  elg.resetSwaps();
  elg.setAutoSwapEnabled(0);
  pull(null);
  pull(range + 5);
  elg.setAutoSwapEnabled(1);
  pull(range + 5);
  ok('auto-quickswap: enabling mid-pull does not fire off the old pull',
     elg.swaps() === 0, `${elg.swaps()} queued`);
  pull(range - 5);
  pull(range + 5);
  ok('auto-quickswap: the next fresh pull does', elg.swaps() === 1,
     `${elg.swaps()} queued`);
}

// ---- 11. Dodge movement drives all eight headings ------------------------

{
  const scene = newScene();
  // The user is walking hard east; the bot is going to override that.
  scene.touch.touches = [finger(scene.touch.leftLockedPadCenter, 0, 46)];

  let worst = 0;
  let slowest = Infinity;
  for (let i = 1; i < elg.DODGE_DIRS.length; i++) {
    const d = elg.DODGE_DIRS[i];
    elg.touchDriveMove(d.x, d.y);
    const v = serverVelocity(frame(scene));
    worst = Math.max(worst, angDiff(bearingOf(v), bearingOf(d)));
    slowest = Math.min(slowest, vlen(v));
  }
  ok('dodge: all eight headings reach the server as movement', worst < 1e-9,
     `worst error ${worst.toExponential(1)} rad, slowest ${slowest.toFixed(2)}u/s of ${MOVE_SPEED}`);
  ok('dodge: a driven heading moves at full speed', near(slowest, MOVE_SPEED, 0.05),
     `slowest of the eight was ${slowest.toFixed(3)}u/s`);

  // The zero heading is "hold this position", and it is the one the naive
  // encoding turns into a full-speed sprint due east.
  elg.touchDriveMove(0, 0);
  const still = serverVelocity(frame(scene));
  ok('dodge: standing still stands still', vlen(still) === 0,
     `velocity ${vlen(still).toFixed(3)}u/s with the user\'s thumb held east`);

  // Handing the pads back returns the user's own course.
  elg.touchReleaseMove();
  const back = serverVelocity(frame(scene));
  ok('dodge: releasing returns the user\'s own course',
     angDiff(bearingOf(back), 0) < 1e-6 && vlen(back) > 1,
     `walking ${(bearingOf(back) * 180 / Math.PI).toFixed(1)}° at ${vlen(back).toFixed(2)}u/s`);
}

// ---- 12. The bot reads the user's heading, not its own -------------------

{
  const scene = newScene();
  // DODGE_DIRS runs E, NE, N, NW, W, SW, S, SE from index 1.
  let wrong = 0;
  for (let i = 1; i < elg.DODGE_DIRS.length; i++) {
    const bearing = ((i - 1) * Math.PI) / 4;
    // Off-axis by a fifth of an octant, which is what a thumb actually does
    // and what a sign test would misread as the next heading over.
    scene.touch.touches = [finger(scene.touch.leftLockedPadCenter, bearing + 0.15, 40)];
    frame(scene);
    if (elg.dodgeUserDirIdx(scene.binds) !== i) wrong++;
  }
  ok('dodge: an analog thumb snaps to the right one of eight headings', wrong === 0,
     `${8 - wrong}/8 headings read correctly with a 8.6° wobble on each`);

  // With no thumb on the pad the user is asking for nothing.
  scene.touch.touches = [];
  frame(scene);
  ok('dodge: no thumb on the pad reads as no heading',
     elg.dodgeUserDirIdx(scene.binds) === 0, '');

  // And while the bot drives the opposite way, the user's own heading is still
  // what comes back — the trigger would latch on itself otherwise.
  scene.touch.touches = [finger(scene.touch.leftLockedPadCenter, 0, 40)];  // east
  elg.touchDriveMove(-1, 0);                                               // bot goes west
  frame(scene);
  ok('dodge: the bot\'s own course does not read back as the user\'s',
     elg.dodgeUserDirIdx(scene.binds) === 1,
     'user read as east while the bot drove west');
  elg.touchReleaseMove();
}

// ---- 13. Target selection without a cursor -------------------------------

{
  const scene = newScene();
  const player = { x: 0, y: 0 };
  // Thumb pointing due north on the aim pad.
  scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, Math.PI / 2, 40)];
  frame(scene);

  const aim = elg.userAim(player);
  ok('targeting: a pad gives a bearing, not a point', aim.angular === true, '');
  ok('targeting: the bearing is the thumb\'s',
     angDiff(aim.theta, Math.PI / 2) < 1e-9,
     `read ${(aim.theta * 180 / Math.PI).toFixed(1)}°`);

  // Far away but dead on the bearing beats close but off it. A cursor-distance
  // score would pick the near one and shoot the wrong player all game.
  const onBearing = { x: 0, y: 60 };
  const offBearing = { x: 9, y: 4 };
  ok('targeting: on the bearing beats near the feet',
     elg.userAimScore(aim, player, onBearing) < elg.userAimScore(aim, player, offBearing),
     `60u away on the line scored ${elg.userAimScore(aim, player, onBearing).toFixed(4)} vs ${elg.userAimScore(aim, player, offBearing).toFixed(4)} for 10u off it`);

  // Two on the same bearing: the near one wins, which is what the tie-break is
  // there for.
  ok('targeting: two on one bearing break the tie by range',
     elg.userAimScore(aim, { x: 0, y: 0 }, { x: 0, y: 10 }) <
     elg.userAimScore(aim, { x: 0, y: 0 }, { x: 0, y: 40 }), '');

  // ...but the tie-break must never outrank the bearing itself.
  ok('targeting: range never outranks the bearing',
     elg.userAimScore(aim, player, { x: 0, y: 400 }) <
     elg.userAimScore(aim, player, { x: 1, y: 1 }), '');
}

// ---- 14. A desktop is untouched -----------------------------------------

{
  const scene = newScene();
  scene.touch.touches = [finger(scene.touch.rightLockedPadCenter, Math.PI / 2, 40)];
  frame(scene);
  ok('device: a pad that is being read reads as touch mode',
     elg.touchActive() === true, '');

  // Let the reading go stale, as it does the moment the game stops building
  // input from the pads at all.
  elg.touchState.lastSeenAt = performance.now() - (TOUCH_STALE_MS + 50);
  ok('device: a stale pad reading is not a touch device',
     elg.touchActive() === false, `after ${TOUCH_STALE_MS}ms without a read`);

  // And with no pads in the picture, "where is the user pointing" is the mouse
  // again, scored as a world point.
  env.realMouse.x = 400 + 3 * env.scale;   // 3u right of centre
  env.realMouse.y = 300 - 4 * env.scale;   // 4u up
  env.realMouse.hasMoved = true;
  const aim = elg.userAim({ x: 10, y: 10 });
  ok('device: the desktop path still reads the cursor as a world point',
     aim.angular === false && near(aim.x, 13, 1e-9) && near(aim.y, 14, 1e-9),
     `cursor resolved to (${aim.x.toFixed(2)}, ${aim.y.toFixed(2)}) from player (10, 10)`);
}

// ---- Report -------------------------------------------------------------

console.log('Driving inject.js\'s own touch layer through a port of the bundle\'s pads.\n');
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(width)}${r.detail ? '   ' + r.detail : ''}`);
}
console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
