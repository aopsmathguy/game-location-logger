// Offline test harness for the zoom-out path in inject.js.
//
//     node zoom_sim.js
//
// Zooming out is one divided number, and every way of getting it wrong looks
// plausible until it is on screen:
//
//   - the game recomputes the camera scale from the scope radius on every
//     single frame and lerps toward it, so a divisor written onto `m_zoom`
//     lasts exactly one frame, and a divisor *read out of* m_zoom lands
//     inside that lerp's feedback loop — the game reads our divided value
//     back, lerps it toward the undivided target, and the pair settles at a
//     scale that is neither (at 60fps, about a twentieth of the one asked
//     for). So the divisor goes on the two methods that consume m_zoom, and
//     the zoom state machine is not touched at all.
//   - `m_ppu` is the tempting knob, being a hardcoded 16 that nothing writes,
//     but it is not the whole scale: sprite sizes go through
//     `scaleToScreen(x) = x * m_zoom` with the callers dividing by m_ppu
//     themselves, so scaling m_ppu shrinks the world and grows everything
//     standing in it. That is why this checks the sprite scale and the world
//     transform move together, and not just that the view got wider.
//   - the methods carry mangled names, so both are identified rather than
//     pinned — and *when* an identification can fire matters as much as
//     whether it is correct. This file previously hooked m_targetZoom,
//     identified by being numerically equal to m_zoom, which is true only of
//     a lerp that has finished converging; a scope change, a resize or a
//     respawn restarts that lerp, so in a real match the test often never
//     fired and the view stayed stock. Hence `mid-lerp` below: every
//     identification here has to land on a frame where the camera is still
//     moving.
//
// So this pulls the camera and zoom blocks verbatim out of inject.js and
// drives them through a port of the bundle's own Camera and camera update,
// transcribed from the deobfuscated client (`js_dump/rv39I73V_formatted.js`:
// class `ht` at ~3451, and the zoom block of `update()` at ~15843). The
// harness cannot drift from the shipped code, because the half under test
// *is* the shipped code.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'core', 'inject.js'), 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error(`marker not found: ${startMark}`);
  return src.slice(a, b);
}

// Everything from looksLikeCamera through readCameraPxPerUnit, then the whole
// zoom block. Taken out of the file, not retyped.
const cameraCode = slice('  function looksLikeCamera(obj)',
                         '  // Pixels per world unit, by whatever source is available.');
const zoomCode = slice('  const ZOOM = {', '  window.__zoomDiag');

// The module-level state those two blocks close over. The mangled interp
// names are the ones the current mangled.js carries; they only ever act as
// exclusions here.
const M = new Function(`
  const CAM_INTERP_W = 'LhhGRR';
  const CAM_INTERP_ON = 'AaG';
  let cachedCameraKey = null, cachedCameraScaleFn = null,
      cachedCameraPpuKey = null, cachedCameraZoomKey = null,
      cameraScaleProbedAt = 0;
  const CAMERA_PROBE_RETRY_MS = 500;
  let capturedGame = null;
  ${cameraCode}
  ${zoomCode}
  return { findCameraSpriteScaleName, readCameraPxPerUnit, findCameraOnGame,
           zoomTick, ZOOM,
           setGame: (g) => { capturedGame = g; },
           hook: () => zoomHook,
           keys: () => ({ zoom: cachedCameraZoomKey, ppu: cachedCameraPpuKey,
                          scaleFn: cachedCameraScaleFn }) };
`)();

// ---- The bundle's Camera, member for member -------------------------------
const v2 = { create: (x, y) => ({ x, y }) };
const lerp = (t, a, b) => a + t * (b - a);

class Camera {
  Swy = v2.create(0, 0);
  bQybS = 16;        // m_ppu
  ueYRQD = 1.5;      // m_zoom
  MBeBTQ = 1.5;      // m_targetZoom
  uQTrAG = 1920;     // m_screenWidth
  wmJk = 1080;       // m_screenHeight
  kiJM = true;       // m_shakeEnabled
  QbaAjR = 0;        // m_shakeStr
  AaG = true;        // m_interpEnabled
  ocRy = false;      // m_localRotation
  LhhGRR = 0.1;      // m_interpWindow, a packet gap in seconds
  bmKiGy() { return this.bQybS * this.ueYRQD; }            // pixelsPerUnit
  FNPGun(e) { return e * this.ueYRQD; }                    // scaleToScreen
  aNZJ(e) { return e * this.bmKiGy(); }                    // pixels
  LGamHd(e) {                                              // pointToScreen
    return { x: this.uQTrAG * 0.5 + (e.x - this.Swy.x) * this.bmKiGy(),
             y: this.wmJk * 0.5 - (e.y - this.Swy.y) * this.bmKiGy() };
  }
  ToT() { this.QbaAjR = 0; }
}

// The zoom half of the bundle's game.update(dt).
function gameUpdate(cam, dt, zoomRadius, zoomFast = false) {
  const i = Math.min(cam.uQTrAG, cam.wmJk);
  const a = Math.max(cam.uQTrAG, cam.wmJk);
  const o = Math.max((16 / 9) * i, a);
  cam.MBeBTQ = (o * 0.5) / (zoomRadius * cam.bQybS);
  const s = zoomFast ? 3 : 2;
  const c = zoomFast ? 3 : 1.4;
  const l = cam.MBeBTQ > cam.ueYRQD ? s : c;
  cam.ueYRQD = lerp(dt * l, cam.ueYRQD, cam.MBeBTQ);
}

// The lerp only converges asymptotically, so "settled" is a few seconds of
// frames rather than one.
const settle = (cam, radius, frames = 3000) => {
  for (let i = 0; i < frames; i++) gameUpdate(cam, 1 / 60, radius);
};
const close = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-9;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
}

console.log('\nzoom\n');

const cam = new Camera();
const game = { pTCE: cam, roster: { players: [] } };
M.setGame(game);
ok('the camera is still recognized', M.findCameraOnGame(game) === cam,
   'looksLikeCamera, with m_ppu untouched');

// One frame in, the camera is mid-lerp and nothing has settled — which is the
// state a match spends most of its time in, and the one the old identification
// could not work in.
gameUpdate(cam, 1 / 60, 28);
ok('m_zoom is identified by the doubling test, mid-lerp',
   !!M.readCameraPxPerUnit(cam) && M.keys().zoom === 'ueYRQD',
   `zoom=${M.keys().zoom} ppu=${M.keys().ppu} pixelsPerUnit=${M.keys().scaleFn}`);
ok('scaleToScreen is identified by f(1) === m_zoom, mid-lerp',
   M.findCameraSpriteScaleName(cam) === 'FNPGun',
   `${M.findCameraSpriteScaleName(cam)}, not aNZJ (m_ppu times bigger)`);

for (const k of [1.25, 1.5, 2]) {
  const c = new Camera();
  M.setGame({ pTCE: c });
  settle(c, 28);
  const before = { px: c.bmKiGy(), sprite: c.FNPGun(1), corner: c.LGamHd(v2.create(10, 10)) };
  M.ZOOM.factor = k;
  M.zoomTick();
  ok(`factor ${k}: it hooks on the first tick`, !!M.hook(),
     `${M.hook() ? M.hook().scaleName + ' + ' + M.hook().spriteName : 'not hooked'}`);
  ok(`factor ${k}: the world renders ${k}x smaller`, close(before.px / c.bmKiGy(), k),
     `${before.px.toFixed(3)} -> ${c.bmKiGy().toFixed(3)} px/unit`);
  ok(`factor ${k}: sprites shrink by the same factor`,
     close(before.sprite / c.FNPGun(1), k),
     `scaleToScreen(1) ${before.sprite.toFixed(4)} -> ${c.FNPGun(1).toFixed(4)}`);
  // pointToScreen is a prototype method calling this.pixelsPerUnit(), so the
  // instance override has to reach it — the ground and layer transforms are
  // built out of exactly this call.
  const corner = c.LGamHd(v2.create(10, 10));
  ok(`factor ${k}: pointToScreen follows through the shadowed method`,
     close((before.corner.x - c.uQTrAG / 2) / (corner.x - c.uQTrAG / 2), k),
     `(10,10) at x=${before.corner.x.toFixed(1)} -> ${corner.x.toFixed(1)}`);
  ok(`factor ${k}: the game's own zoom state is untouched`,
     close(c.ueYRQD, c.MBeBTQ) && close(c.ueYRQD * c.bQybS, before.px),
     `m_zoom ${c.ueYRQD.toFixed(4)} still converged on m_targetZoom, at the stock scale`);
  ok(`factor ${k}: our own px/unit reader sees the divided scale`,
     close(M.readCameraPxPerUnit(c), before.px / k),
     `${M.readCameraPxPerUnit(c).toFixed(3)} px/unit, so the overlay stays glued`);

  M.ZOOM.factor = 1;
  M.zoomTick();
  ok(`factor ${k}: back at 1 the methods are handed back`,
     close(c.bmKiGy(), before.px) && close(c.FNPGun(1), before.sprite) &&
     Object.getOwnPropertyDescriptor(c, 'bmKiGy') === undefined &&
     Object.getOwnPropertyDescriptor(c, 'FNPGun') === undefined,
     'the prototype\'s own show through again');
}

// The scale is rebuilt from the scope radius every frame, so a scope change is
// where a one-shot write would come undone — and where the lerp is running.
const scoped = new Camera();
M.setGame({ pTCE: scoped });
settle(scoped, 28);
M.ZOOM.factor = 2;
M.zoomTick();
const stock8x = new Camera();
settle(stock8x, 28);                                 // same starting scale
for (let i = 0; i < 90; i++) {                       // 1.5s into an 8x scope
  gameUpdate(scoped, 1 / 60, 68);
  gameUpdate(stock8x, 1 / 60, 68);
}
ok('a scope change keeps the divisor, mid-lerp',
   close(stock8x.bmKiGy() / scoped.bmKiGy(), 2),
   `8x: ${stock8x.bmKiGy().toFixed(3)} -> ${scoped.bmKiGy().toFixed(3)} px/unit`);
settle(scoped, 68);
settle(stock8x, 68);
ok('and still holds it once the lerp lands', close(stock8x.bmKiGy() / scoped.bmKiGy(), 2),
   `8x: ${stock8x.bmKiGy().toFixed(3)} -> ${scoped.bmKiGy().toFixed(3)} px/unit`);

// A new round is a new camera object, handed to us mid-lerp.
const next = new Camera();
M.setGame({ pTCE: next });
gameUpdate(next, 1 / 60, 28);
M.zoomTick();
settle(next, 28);
const stock1x = new Camera();
settle(stock1x, 28);
ok('a new round re-hooks the new camera on the first tick',
   M.hook() && M.hook().camera === next && close(stock1x.bmKiGy() / next.bmKiGy(), 2),
   `${next.bmKiGy().toFixed(3)} px/unit`);
ok('the camera it left behind is as we found it',
   Object.getOwnPropertyDescriptor(scoped, 'bmKiGy') === undefined &&
   close(scoped.bmKiGy(), stock8x.bmKiGy()), 'stock methods, stock scale');

console.log(`\n${pass}/${pass + fail} checks passed.\n`);
process.exit(fail ? 1 : 0);
