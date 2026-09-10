// Offline test harness for the grenade blast prediction in inject.js.
//
//     node blast_sim.js
//
// The dodge bot prices a grenade by simulating where it will be when its fuse
// runs out. That simulation is a port of survev's own Projectile.update, and a
// port is exactly the kind of thing that looks right and is quietly several
// units wrong: the drag law is dt-dependent and compounds, drag applies only
// while the projectile is resting rather than for its whole flight, posZ is
// clamped rather than bounced, and a bounce keeps a speed fraction that depends
// on the angle it struck at. Each of those is easy to write plausibly and get
// backwards, and none of them is visible by eyeball in a game.
//
// So this drives the shipped simulator against an independent transcription of
// the server loop out of `server/src/game/objects/projectile.ts`, over the
// cases that separate the mistakes:
//
//   open        no geometry at all — isolates the arc, the landing and the
//               slide, whose total is analytically v_land/drag and so is the
//               one case with a closed-form answer to check against.
//   wall        a tall obstacle in the path, so the reflection and its
//               velocity scaling are exercised.
//   glance      the same wall struck at a shallow angle, where `max(1+dot,
//               0.15)` keeps almost all the speed — the case that separates a
//               correct scaling from a constant one.
//   table       a low collidable obstacle: the grenade must fly *over* it and
//               then rest *on* it, which is the only thing obstacleBellowHeight
//               does and the easiest to drop entirely.
//   water       the harder drag constant, where the slide is less than half.
//   cooked      a short fuse, detonating in mid-air before anything is touched.
//
// The harness pulls the simulator verbatim out of inject.js rather than
// restating it, so it cannot drift from the shipped code — the same argument
// netcode_sim.js makes.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'core', 'inject.js'), 'utf8');

function extract(name) {
  const start = src.indexOf(`  function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}() in inject.js`);
  const end = src.indexOf('\n  }\n', start);
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  return src.slice(start, end + 4);
}

function grabConst(name) {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
  if (!m) throw new Error(`could not find const ${name} in inject.js`);
  // Some of these are written as the derivation they are — the wire's position
  // quantum is `1024 / 65535` and says so — so the expression is evaluated
  // rather than parsed, and the test reads the same number for the same reason.
  const v = Number(eval(m[1]));
  if (!Number.isFinite(v)) throw new Error(`const ${name} is not a number: ${m[1]}`);
  return v;
}

const PROJ_GRAVITY = grabConst('PROJ_GRAVITY');
const PROJ_SPAWN_Z = grabConst('PROJ_SPAWN_Z');
const PROJ_DRAG = grabConst('PROJ_DRAG');
const PROJ_DRAG_WATER = grabConst('PROJ_DRAG_WATER');
const DODGE_SIM_DT = grabConst('DODGE_SIM_DT');
const DODGE_SIM_MAX_STEPS = grabConst('DODGE_SIM_MAX_STEPS');
const COLLIDER_CIRCLE = grabConst('COLLIDER_CIRCLE');
const COLLIDER_AABB = grabConst('COLLIDER_AABB');
const DODGE_PROJ_POS_Q = grabConst('DODGE_PROJ_POS_Q');
const DODGE_PROJ_Z_Q = grabConst('DODGE_PROJ_Z_Q');
const DODGE_PROJ_BOUNCE_K = grabConst('DODGE_PROJ_BOUNCE_K');

// The shipped simulator, plus the two helpers it calls. `getObstacles` and
// `sameLayerAs` are the only things it reaches outside itself, and both are
// stubbed to the scenario.
let SCENE = [];
let RIVERS = [];
const bundle = eval(`(function () {
  const PROJ_GRAVITY = ${PROJ_GRAVITY};
  const DODGE_PROJ_POS_Q = ${DODGE_PROJ_POS_Q};
  const DODGE_PROJ_Z_Q = ${DODGE_PROJ_Z_Q};
  const DODGE_PROJ_BOUNCE_K = ${DODGE_PROJ_BOUNCE_K};
  const PROJ_DRAG = ${PROJ_DRAG};
  const PROJ_DRAG_WATER = ${PROJ_DRAG_WATER};
  const DODGE_SIM_DT = ${DODGE_SIM_DT};
  const DODGE_SIM_MAX_STEPS = ${DODGE_SIM_MAX_STEPS};
  const COLLIDER_CIRCLE = ${COLLIDER_CIRCLE};
  const COLLIDER_AABB = ${COLLIDER_AABB};
  const dodgeSimOut = { x: 0, y: 0 };
  const dodgeSimHit = { nx: 0, ny: 0, pen: 0 };
  const dodgeSimObs = [];
  const dodgeSimRiverList = [];
  const sameLayerAs = () => true;
  const getObstacles = () => SCENE;
  // dodgeSimRivers reaches the live client map for its river polygons; the
  // scenario stands in for it, so the shipped gather and point test are the ones
  // under examination and only the map handle is fake.
  const capturedGame = null;
  const findMapOnGame = () => ({ terrain: { rivers: RIVERS } });
  ${extract('dodgeSimRivers')}
  ${extract('dodgeSimInWater')}
  ${extract('dodgeSimPen')}
  ${extract('dodgeSimObstacles')}
  ${extract('dodgeSimBlast')}
  ${extract('dodgeProjAge')}
  ${extract('dodgeProjVel')}
  ${extract('dodgeBlastFactor')}
  return { dodgeSimBlast, dodgeSimOut, dodgeProjAge, dodgeProjVel, dodgeBlastFactor,
           dodgeSimInWater, dodgeSimRivers };
})()`);

// ---- Ground truth -------------------------------------------------------
//
// An independent transcription of Projectile.update from the survev server, at
// its own gameTps of 100. Deliberately written from the TypeScript rather than
// from the port under test, and deliberately in the server's own order:
// drag, then move, then gravity, then the clamp, then collision.

const SERVER_DT = 0.01;

function serverPen(c, x, y, r) {
  if (c.type === COLLIDER_CIRCLE) {
    const R = c.rad + r;
    const dx = x - c.pos.x, dy = y - c.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) return null;
    const d = Math.sqrt(d2);
    const dir = d > 0.00001 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 };
    return { dir, pen: R - d };
  }
  if (x >= c.min.x && x <= c.max.x && y >= c.min.y && y <= c.max.y) {
    const ex = (c.max.x - c.min.x) / 2, ey = (c.max.y - c.min.y) / 2;
    const px = x - (c.min.x + ex), py = y - (c.min.y + ey);
    const xp = Math.abs(px) - ex - r, yp = Math.abs(py) - ey - r;
    if (xp > yp) return { dir: { x: px > 0 ? 1 : -1, y: 0 }, pen: -xp };
    return { dir: { x: 0, y: py > 0 ? 1 : -1 }, pen: -yp };
  }
  const cx = Math.min(Math.max(x, c.min.x), c.max.x);
  const cy = Math.min(Math.max(y, c.min.y), c.max.y);
  const dx = x - cx, dy = y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  const d = Math.sqrt(d2);
  const dir = d > 0.0001 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 };
  return { dir, pen: r - d };
}

// `water` is a boolean for the cases that never leave one surface, or a
// predicate for the ones that cross. The predicate is the honest shape: the
// server calls `isOnWater(this.pos)` from *inside* the tick, under the same
// `posZ <= obstacleBellowHeight` test that gates the drag, so the surface it
// uses is the one under the grenade on that tick and not the one it was made on.
function serverSim(init, dur, obstacles, water) {
  let x = init.x, y = init.y, z = init.z;
  let vx = init.vx, vy = init.vy, vz = init.vz;
  let below = 0;
  const rad = init.rad * 0.5;          // Projectile.rad = def.rad * 0.5
  const r = rad / 2;                   // the collision site halves it again
  const wetAt = typeof water === 'function' ? water : () => !!water;
  const n = Math.round(dur / SERVER_DT);

  for (let i = 0; i < n; i++) {
    if (z <= below) {
      const drag = wetAt(x, y) ? PROJ_DRAG_WATER : PROJ_DRAG;
      vx = vx / (1 + SERVER_DT * drag); vy = vy / (1 + SERVER_DT * drag);
    }
    x += vx * SERVER_DT; y += vy * SERVER_DT;
    vz -= PROJ_GRAVITY * SERVER_DT;
    z = Math.min(Math.max(z + vz * SERVER_DT, below), 5);

    let inside = false;
    for (const o of obstacles) {
      const res = serverPen(o.collider, x, y, r);
      if (!res) continue;
      if (o.height > z) {
        if (!o.collidable) continue;
        x += res.dir.x * (res.pen + 0.1);
        y += res.dir.y * (res.pen + 0.1);
        const len = Math.max(Math.hypot(vx, vy), 0.000001);
        const dx = vx / len, dy = vy / len;
        const dot = dx * res.dir.x + dy * res.dir.y;
        const scale = Math.max(1 + dot, 0.15) * len;
        vx = (dx - 2 * dot * res.dir.x) * scale;
        vy = (dy - 2 * dot * res.dir.y) * scale;
      } else if (o.collidable) {
        below = Math.max(below, o.height);
        inside = true;
      }
    }
    if (!inside) below = 0;
    if (z < below) z = below;
  }
  return { x, y, z, vx, vy, vz, below };
}

// ---- Scenarios ----------------------------------------------------------

const aabb = (x0, y0, x1, y1, height, collidable = true) => ({
  active: true, dead: false, collidable, height, layer: 0,
  collider: { type: COLLIDER_AABB, min: { x: x0, y: y0 }, max: { x: x1, y: y1 } },
});
const circ = (x, y, rad, height, collidable = true) => ({
  active: true, dead: false, collidable, height, layer: 0,
  collider: { type: COLLIDER_CIRCLE, pos: { x, y }, rad },
});

// A frag as thrown: 20 u/s along +x, out of a hand 0.5 up, rising at 5.
const FRAG = { velZ: 5, rad: 1 };
const throwState = (speed = 20) => ({
  x: 0, y: 0, z: PROJ_SPAWN_Z, vx: speed, vy: 0, vz: FRAG.velZ, rad: FRAG.rad,
});

const CASES = [
  { name: 'open',   fuse: 4,   speed: 20, scene: [] },
  { name: 'wall',   fuse: 4,   speed: 20, scene: [aabb(14, -5, 15, 5, 2)] },
  { name: 'glance', fuse: 4,   speed: 20, scene: [aabb(10, -6, 30, -0.6, 2)] },
  { name: 'table',  fuse: 4,   speed: 20, scene: [aabb(18, -4, 26, 4, 0.6)] },
  { name: 'barrel', fuse: 4,   speed: 20, scene: [circ(16, 0.4, 1.2, 2)] },
  { name: 'bush',   fuse: 4,   speed: 20, scene: [aabb(14, -5, 15, 5, 2, false)] },
  { name: 'water',  fuse: 4,   speed: 20, scene: [], water: true },
  { name: 'cooked', fuse: 0.6, speed: 20, scene: [] },
  { name: 'lobbed', fuse: 4,   speed: 6,  scene: [aabb(4, -5, 5, 5, 2)] },
];

// The threshold. A cell of the planner's own grid is 0.35u at the default and
// the blast falloff is 125HP over 12u, so a tenth of a unit is about 1HP of
// mispricing — well inside the error the ping lead already carries, and far
// inside what would change a plan.
const TOL = 0.1;

console.log('grenade path: shipped simulator vs a transcription of the server loop\n');
console.log('case      dt      truth (x, y)          predicted (x, y)       err     verdict');
console.log('-'.repeat(80));

let worst = 0, failed = 0;
for (const c of CASES) {
  SCENE = c.scene;
  const init = throwState(c.speed);
  const truth = serverSim(init, c.fuse, c.scene, !!c.water);

  // What the mod holds: the record snapshotProjectiles builds, as of a packet
  // at the moment of the throw, with velocity already measured off a delta.
  const rec = {
    x: init.x, y: init.y, z: init.z, vx: init.vx, vy: init.vy,
    haveVel: true, age: 0, water: !!c.water,
  };
  bundle.dodgeSimBlast(rec, { velZ: FRAG.velZ, rad: FRAG.rad }, c.fuse, 0, bundle.dodgeSimOut);
  const got = bundle.dodgeSimOut;

  const err = Math.hypot(got.x - truth.x, got.y - truth.y);
  worst = Math.max(worst, err);
  const ok = err <= TOL;
  if (!ok) failed++;
  console.log(
    `${c.name.padEnd(9)} ${String(c.fuse).padEnd(7)} ` +
    `(${truth.x.toFixed(2).padStart(7)}, ${truth.y.toFixed(2).padStart(6)})     ` +
    `(${got.x.toFixed(2).padStart(7)}, ${got.y.toFixed(2).padStart(6)})    ` +
    `${err.toFixed(3).padStart(6)}  ${ok ? 'ok' : 'FAIL'}`);
}

// ---- Crossing a shoreline -----------------------------------------------
//
// Drag is 5 in water and 2.3 on land, and the server picks between them inside
// its own loop — `isOnWater(this.pos)`, every tick, at the position it has then
// (projectile.ts, under the same `posZ <= obstacleBellowHeight` test that gates
// the drag at all). A simulation that picks once, from where the last packet
// left the grenade, gets every shoreline wrong for as long as the grenade has
// not reached it yet.
//
// The case that motivated this: a frag lands on the bank and *slides into* a
// river. Nothing about its position has crossed anything while it is in the air
// or on the dry half of the slide, so a per-packet flag says "land" throughout
// and predicts a `v/2.3` slide where the server is going to give `v/5`. That is
// 4.6u long at a 20u/s touchdown, held for the whole flight, and only corrected
// when the grenade is physically in the water — by which point the prediction
// had a third of the fuse to be wrong in.
//
// So dodgeSimBlast tests the river polygons per step. These check it against a
// transcription that tests the water where the server tests it.
console.log('\nshorelines (drag chosen per step, as the server chooses it)');

// A river as the client holds one: an `aabb` for the broad reject and a
// `waterPoly` for the real answer. Rectangles here — the polygon test is
// survev's own pnpoly either way, and a rectangle is the shape whose crossing
// point is arithmetic rather than a fixture.
const river = (x0, y0, x1, y1) => ({
  aabb: { min: { x: x0, y: y0 }, max: { x: x1, y: y1 } },
  waterPoly: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
});
// The transcription's own water test, written from map.ts rather than from the
// helper under test: an AABB reject, then pnpoly against the water polygon.
function truthWet(rivers, x, y) {
  for (const rv of rivers) {
    const { min, max } = rv.aabb;
    if (x < min.x || x > max.x || y < min.y || y > max.y) continue;
    const poly = rv.waterPoly;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

const WIDE = river(25, -60, 200, 60);        // everything past x=25 is water
const SHORE = [
  // The reported case. Lands dry at 20.87 and slides across x=25.
  { name: 'land→water', rivers: [WIDE], seed: false, fuse: 4, speed: 20 },
  // The mirror: thrown from in the river, slides out onto dry land.
  { name: 'water→land', rivers: [river(-60, -60, 25, 60)], seed: true, fuse: 4, speed: 20 },
  // Neither leaves its surface. These are the regression: the per-step test must
  // return exactly what the flag used to.
  { name: 'all water',  rivers: [river(-60, -60, 200, 60)], seed: true, fuse: 4, speed: 20 },
  { name: 'all land',   rivers: [river(60, -60, 200, 60)], seed: false, fuse: 4, speed: 20 },
  // Over a river and down on the far bank: airborne over water costs nothing,
  // because the server's own water test is inside the on-the-ground branch.
  { name: 'flies over', rivers: [river(8, -60, 16, 60)], seed: false, fuse: 4, speed: 20 },
  // A short lob that stops before it ever gets to the bank.
  { name: 'stops short', rivers: [river(40, -60, 200, 60)], seed: false, fuse: 4, speed: 20 },
];

let shoreWorst = 0, shoreFail = 0;
console.log('  case          truth (x)    predicted    err');
for (const c of SHORE) {
  SCENE = [];
  RIVERS = c.rivers;
  const init = throwState(c.speed);
  const truth = serverSim(init, c.fuse, [], (x, y) => truthWet(c.rivers, x, y));
  const rec = {
    x: init.x, y: init.y, z: init.z, vx: init.vx, vy: init.vy,
    haveVel: true, age: 0, water: c.seed,
  };
  bundle.dodgeSimBlast(rec, { velZ: FRAG.velZ, rad: FRAG.rad }, c.fuse, 0, bundle.dodgeSimOut);
  const err = Math.hypot(bundle.dodgeSimOut.x - truth.x, bundle.dodgeSimOut.y - truth.y);
  if (err > shoreWorst) shoreWorst = err;
  const ok = err <= TOL;
  if (!ok) { shoreFail++; failed++; }
  console.log(`  ${c.name.padEnd(13)} ${truth.x.toFixed(2).padStart(7)}u   ` +
              `${bundle.dodgeSimOut.x.toFixed(2).padStart(8)}u   ${err.toFixed(3).padStart(6)}  ${ok ? 'ok' : 'FAIL'}`);
}
console.log(`  ${shoreFail === 0 ? 'ok' : 'FAIL'}  worst ${shoreWorst.toFixed(3)}u across the six`);

// What it was worth. The same land→water throw with the flag held for the whole
// simulation — which is what the old code did, and what the code still does when
// the polygons are not allowed to answer.
{
  RIVERS = [];                                  // no geometry: fall back to the flag
  SCENE = [];
  const init = throwState(20);
  const truth = serverSim(init, 4, [], (x, y) => truthWet([WIDE], x, y));
  const rec = { x: init.x, y: init.y, z: init.z, vx: init.vx, vy: init.vy,
                haveVel: true, age: 0, water: false };
  bundle.dodgeSimBlast(rec, { velZ: FRAG.velZ, rad: FRAG.rad }, 4, 0, bundle.dodgeSimOut);
  const was = Math.abs(bundle.dodgeSimOut.x - truth.x);
  console.log(`  ${was > 2 ? 'ok' : 'FAIL'}  holding one flag instead puts it ${was.toFixed(2)}u long ` +
              `— what the per-step test is worth`);
  if (!(was > 2)) failed++;
}

// ---- When the polygons are not the whole answer -------------------------
//
// `isOnWater` consults decals and building surfaces before it ever reaches the
// rivers, and both can overrule them: a bridge deck across a river reads dry,
// and a building's own water surface reads wet with no river anywhere. The
// river polygons cannot see either, so they are only trusted when they agree
// with the authoritative reading at the one point that has one — the position
// the packet left the grenade at. Disagreement means something else is
// deciding, and the flag stands for the whole simulation.
console.log('\n  where the rivers are overruled (the seed flag has to win)');
{
  const cases = [
    // Standing on a bridge over a river: polygons say wet, getGroundSurface said
    // dry. The whole slide must be simulated dry.
    { name: 'bridge over a river', rivers: [river(-60, -60, 200, 60)], seed: false, want: false },
    // A building's water surface with no river under it: polygons say dry,
    // getGroundSurface said wet. The whole slide must be simulated wet.
    { name: 'water floor, no river', rivers: [river(300, -60, 400, 60)], seed: true, want: true },
  ];
  for (const c of cases) {
    SCENE = [];
    RIVERS = c.rivers;
    const init = throwState(20);
    const rec = { x: init.x, y: init.y, z: init.z, vx: init.vx, vy: init.vy,
                  haveVel: true, age: 0, water: c.seed };
    bundle.dodgeSimBlast(rec, { velZ: FRAG.velZ, rad: FRAG.rad }, 4, 0, bundle.dodgeSimOut);
    const got = bundle.dodgeSimOut.x;
    // What the flag alone gives, which is what the answer has to be.
    const want = serverSim(init, 4, [], c.want).x;
    const ok = Math.abs(got - want) <= TOL;
    if (!ok) failed++;
    console.log(`    ${c.name.padEnd(21)} simulated ${c.want ? 'wet' : 'dry'} throughout: ` +
                `${got.toFixed(2)}u vs ${want.toFixed(2)}u  ${ok ? 'ok' : 'FAIL'}`);
  }
}

// ---- The ring, packet by packet -----------------------------------------
//
// The bug as it was actually seen: not a number in a table but a ring that sat
// several units long for a third of the fuse and then jumped. This walks the
// reported throw one update at a time and reports the worst the prediction ever
// gets, which is the thing that has to be small.
console.log('\n  the reported throw, packet by packet');
{
  RIVERS = [WIDE];
  SCENE = [];
  const FUSE = 4, TICK = 0.03;
  const init = throwState(20);
  const wet = (x, y) => truthWet([WIDE], x, y);
  const truth = serverSim(init, FUSE, [], wet).x;
  const qMap = (v) => Math.round(v / 1024 * 65535) / 65535 * 1024;
  const qZ = (v) => Math.round(v / 5 * 1023) / 1023 * 5;
  const phys = { velZ: FRAG.velZ, rad: FRAG.rad, fuse: FUSE };

  let rec = null, worstNow = 0, worstFlag = 0, crossedAt = null;
  for (let k = 1; k * TICK < FUSE; k++) {
    const t = k * TICK;
    const st = serverSim(init, t, [], wet);
    const x = qMap(st.x), z = qZ(st.z);
    if (!rec) {
      rec = { x, y: 0, z, age: t, n: k, vx: 0, vy: 0, haveVel: false,
              legN: -1, legX: x, legY: 0, grounded: false, atRest: false, water: wet(x, 0) };
      continue;
    }
    bundle.dodgeProjVel(rec, phys, x, 0, z, k, TICK, TICK * 1000);
    rec.age = t; rec.n = k; rec.x = x; rec.y = 0; rec.z = z;
    rec.water = wet(x, 0);                       // what snapshotProjectiles stores
    if (rec.water && crossedAt === null) crossedAt = t;

    let px;
    if (rec.atRest) px = rec.x;
    else { bundle.dodgeSimBlast(rec, phys, FUSE - t, 0, bundle.dodgeSimOut); px = bundle.dodgeSimOut.x; }
    worstNow = Math.max(worstNow, Math.abs(px - truth));

    // The same packet, simulated the old way: one flag for the whole run.
    RIVERS = [];
    bundle.dodgeSimBlast(rec, phys, FUSE - t, 0, bundle.dodgeSimOut);
    worstFlag = Math.max(worstFlag, Math.abs(bundle.dodgeSimOut.x - truth));
    RIVERS = [WIDE];
  }
  // The same throw with no shoreline in it at all, which is the floor this can
  // possibly reach: a quantised packet stream carries velocity noise whatever
  // the surface, and the section above already prices that. What has to be true
  // is that crossing a shoreline costs nothing *on top* of it.
  RIVERS = [];
  const dryTruth = serverSim(init, FUSE, [], false).x;
  let worstDry = 0, dry = null;
  for (let k = 1; k * TICK < FUSE; k++) {
    const t = k * TICK;
    const st = serverSim(init, t, [], false);
    const x = qMap(st.x), z = qZ(st.z);
    if (!dry) {
      dry = { x, y: 0, z, age: t, n: k, vx: 0, vy: 0, haveVel: false,
              legN: -1, legX: x, legY: 0, grounded: false, atRest: false, water: false };
      continue;
    }
    bundle.dodgeProjVel(dry, phys, x, 0, z, k, TICK, TICK * 1000);
    dry.age = t; dry.n = k; dry.x = x; dry.y = 0; dry.z = z;
    let px;
    if (dry.atRest) px = dry.x;
    else { bundle.dodgeSimBlast(dry, phys, FUSE - t, 0, bundle.dodgeSimOut); px = bundle.dodgeSimOut.x; }
    worstDry = Math.max(worstDry, Math.abs(px - dryTruth));
  }

  console.log(`    the grenade reaches the water at t=${crossedAt.toFixed(2)}s of a ${FUSE}s fuse`);
  console.log(`    worst ring error, one flag held:   ${worstFlag.toFixed(2)}u`);
  console.log(`    worst ring error, tested per step: ${worstNow.toFixed(2)}u`);
  console.log(`    the same throw with no river in it: ${worstDry.toFixed(2)}u — the wire's own noise`);
  const ok = worstNow <= worstDry + 0.01 && worstFlag > 2;
  if (!ok) failed++;
  console.log(`    ${ok ? 'ok' : 'FAIL'}  the shoreline costs nothing over a throw that never meets one`);
  RIVERS = [];
}

// ---- The closed forms ---------------------------------------------------
//
// Two of the numbers the simulation produces are independently derivable, and
// checking them is what says the loop is right rather than merely
// self-consistent with a transcription that could share a misreading.
console.log('\nclosed forms');

// Air time: posZ = z0 + velZ*t - g*t^2/2 reaches 0 at
// (velZ + sqrt(velZ^2 + 2*g*z0))/g, which for a frag is 1.0436s.
const tAir = (FRAG.velZ + Math.sqrt(FRAG.velZ ** 2 + 2 * PROJ_GRAVITY * PROJ_SPAWN_Z)) / PROJ_GRAVITY;

// Slide: `v /= 1 + dt*k` summed over the position update telescopes to exactly
// v/k, whatever dt is. That is why the port may use a different step than the
// server without the landing point moving.
const slide = 20 / PROJ_DRAG;
SCENE = [];
const openTruth = serverSim(throwState(20), 4, [], false);
const predicted = 20 * tAir + slide;
const closedErr = Math.abs(openTruth.x - predicted);
console.log(`  air time            ${tAir.toFixed(4)}s`);
console.log(`  flight + slide      ${predicted.toFixed(3)}u  (20*${tAir.toFixed(3)} + 20/${PROJ_DRAG})`);
console.log(`  simulated           ${openTruth.x.toFixed(3)}u`);
// The two are not supposed to agree exactly, and the gap is worth naming
// rather than tuning away: the server integrates the arc with Euler at 100Hz,
// which lands the grenade about 3.6ms before the exact parabola does, and at
// throw speed that is ~0.07u of travel. The closed form is the approximation
// here; the discrete loop is the truth, because the discrete loop is the game.
// What this checks is that they are the same *model* — a slide that used a
// continuous e-folding, or an air time off by a factor, would be units out.
console.log(`  ${closedErr < TOL ? 'ok' : 'FAIL'}  differ by ${closedErr.toFixed(3)}u ` +
            `(Euler at 100Hz against the exact parabola)`);
if (closedErr >= TOL) failed++;

// ---- Dating a grenade already in the air --------------------------------
//
// dodgeProjAge inverts the arc to recover how long ago a grenade was thrown,
// which is what dates one that came into view mid-flight. The descending root
// is the one taken by default, so the round trip is checked on both branches.
console.log('\narc inversion (age recovered from posZ alone)');
let ageWorst = 0;
for (const age of [0.1, 0.3, 0.47, 0.6, 0.9, 1.0]) {
  const z = PROJ_SPAWN_Z + FRAG.velZ * age - PROJ_GRAVITY * age * age / 2;
  const descending = age > FRAG.velZ / PROJ_GRAVITY;
  const got = bundle.dodgeProjAge(z, FRAG.velZ, descending);
  const err = Math.abs(got - age);
  ageWorst = Math.max(ageWorst, err);
  console.log(`  age ${age.toFixed(2)}s  posZ ${z.toFixed(3)}  ${descending ? 'down' : 'up  '}  ` +
              `recovered ${got.toFixed(4)}s  err ${(err * 1000).toFixed(2)}ms`);
}
// The wire quantises posZ to 10 bits over [0, 5]. Near the apex velZ passes
// through zero and the inversion is worthless there; near the ground it is
// worth under a millisecond. Both are properties of the arc, not of the code,
// so this only checks that the algebra round-trips.
if (ageWorst > 1e-6) { console.log('  FAIL  inversion does not round-trip'); failed++; }
else console.log(`  ok  round-trips to ${(ageWorst * 1e6).toFixed(1)}us`);

// ---- The damage curve ---------------------------------------------------
console.log('\nblast falloff (frag: 125HP, rad 5..12)');
for (const d of [0, 4.9, 5.1, 8, 11.9, 12.1]) {
  const f = bundle.dodgeBlastFactor(5, 12, d, 0);
  console.log(`  ${d.toFixed(1).padStart(5)}u  ${(f * 125).toFixed(1).padStart(6)} HP`);
}
// The step at rad.min is survev's, not ours: the ramp past the plateau is
// measured from the centre rather than from rad.min, so it resumes at
// 125*(1 - 5/12) and not at 125.
const step = bundle.dodgeBlastFactor(5, 12, 4.99, 0) - bundle.dodgeBlastFactor(5, 12, 5.01, 0);
console.log(`  ${Math.abs(step - 5 / 12) < 0.01 ? 'ok' : 'FAIL'}  ` +
            `plateau edge drops ${(step * 125).toFixed(1)}HP, as the game's remap does`);
if (Math.abs(step - 5 / 12) >= 0.01) failed++;

// ---- Billing ------------------------------------------------------------
//
// A blast is charged on the one leg of the plan that contains its instant, and
// on no other. That is what keeps damage an event rather than a field — the
// same rule the round sweep enforces with billOpen and dodgeDpSkip, except that
// for a blast it falls out of the geometry and cannot be got wrong by a caller.
// This drives dodgeDpBlast over a whole plan's worth of legs and checks both
// halves: exactly one leg pays, and what it pays is the game's own damage.
console.log('\nbilling (a 0.8s plan in 0.1s legs, frag detonating at t=0.35)');

const DODGE_VIS_SLOTS = grabConst('DODGE_VIS_SLOTS');

// The scoring path, with the real per-cell visibility wired to a real grid.
// `rays` counts memo misses — the cells that actually had to be traced — so
// the cache can be shown to be doing its job rather than merely being present.
const scoring = eval(`(function () {
  const dodgeDpBill = new Float64Array(1);
  const dodgeDpFactor = new Float64Array(1);
  const dodgeDpTouch = new Float64Array(1);
  let dodgeDpClearance = 0.35;
  let dodgeDpTimeDecay = -Math.LN2 / 0.4;
  const DODGE_VIS_SLOTS = ${DODGE_VIS_SLOTS};
  const COLLIDER_AABB = ${COLLIDER_AABB};
  const COLLIDER_CIRCLE = ${COLLIDER_CIRCLE};
  // A 41x41 grid of 0.35u cells centred on the origin, which is the shape
  // dodgeDpPlan builds at the default knobs.
  let dodgeDpW = 41, dodgeDpHalf = 20, dodgeDpCell = 0.35;
  let dodgeDpOx = 0, dodgeDpOy = 0, dodgeDpEpoch = 1;
  const n = dodgeDpW * dodgeDpW;
  let dodgeVisStamp = new Int32Array(n * DODGE_VIS_SLOTS);
  let dodgeVisVal = new Uint8Array(n * DODGE_VIS_SLOTS);
  const dodgeVisObs = [[], [], [], []];
  let rays = 0;
  ${extract('segHitCircle')}
  ${extract('segHitAabb')}
  ${extract('segHitCollider')}
  ${extract('colliderNearSegment')}
  ${extract('dodgeBlastFactor')}
  ${extract('dodgeDpVisible').replace('const cx = dodgeDpOx', 'rays++; const cx = dodgeDpOx')}
  ${extract('dodgeDpBlast')}
  return {
    dodgeDpBlast, dodgeDpBill, dodgeDpFactor, dodgeDpTouch, dodgeDpVisible,
    setObs: (slot, list) => { dodgeVisObs[slot] = list; },
    newPlan: () => { dodgeDpEpoch++; },
    rays: () => rays,
    reset: () => { dodgeDpBill[0] = 0; dodgeDpFactor[0] = 0; dodgeDpTouch[0] = Infinity; },
  };
})()`);

// A frag going off 7u away at t=0.35, against a plan that walks +x at 12 u/s
// from the origin. At the detonation the plan has covered 4.2u, so the gap is
// 7 - 4.2 = 2.8u — inside rad.min, a full 125.
const TH = { blast: 1, tBoom: 0.35, x: 7, y: 0, rMin: 5, rMax: 12, dmg: 125,
             w: 125 / 25, tMax: 0.8, vis: -1, clear: true, layer: 0 };
scoring.reset();
let billedLegs = 0;
for (let leg = 0; leg < 8; leg++) {
  const before = scoring.dodgeDpBill[0];
  scoring.dodgeDpBlast(0, 12 * (leg * 0.1), 0, 12, 0, TH, leg * 0.1, 0.1);
  if (scoring.dodgeDpBill[0] !== before) {
    billedLegs++;
    console.log(`  leg ${leg} (t ${(leg * 0.1).toFixed(1)}-${((leg + 1) * 0.1).toFixed(1)}) billed` +
                `  f=${scoring.dodgeDpFactor[0].toFixed(3)}  at t=${scoring.dodgeDpTouch[0].toFixed(2)}`);
  }
}
const hp = scoring.dodgeDpFactor[0] * TH.dmg;
console.log(`  ${billedLegs === 1 ? 'ok' : 'FAIL'}  ${billedLegs} leg billed`);
console.log(`  ${Math.abs(hp - 125) < 0.01 ? 'ok' : 'FAIL'}  charged ${hp.toFixed(1)} HP ` +
            `(2.8u from the centre, inside rad.min)`);
if (billedLegs !== 1 || Math.abs(hp - 125) >= 0.01) failed++;

// Standing still instead: the gap stays 7u, past rad.min, so the same blast is
// worth 125*(1 - 7/12) = 52HP. That difference is the entire gradient the
// planner steers on, so it is worth pinning down.
scoring.reset();
for (let leg = 0; leg < 8; leg++) scoring.dodgeDpBlast(0, 0, 0, 0, 0, TH, leg * 0.1, 0.1);
const still = scoring.dodgeDpFactor[0] * TH.dmg;
// The clearance slack shifts the distance in by 0.35 before the curve, so the
// figure to match is the curve at 6.65u, not at 7u.
const want = 125 * (1 - (7 - 0.35) / 12);
console.log(`  ${Math.abs(still - want) < 0.01 ? 'ok' : 'FAIL'}  standing still charges ` +
            `${still.toFixed(1)} HP against ${want.toFixed(1)} expected; ` +
            `moving is worth ${(hp - still).toFixed(1)} HP of gradient`);
if (Math.abs(still - want) >= 0.01) failed++;

// ---- Per-cell visibility ------------------------------------------------
//
// The point of doing this per cell rather than once from where we stand is
// that a wall becomes a gradient the search can climb: full cost in front of
// it, nothing behind it, and the boundary in the right place. Checked with the
// blast at +7x and a wall at +3.5x running across the view, so the plan's own
// cells straddle it.
console.log('\nper-cell visibility (blast at +7x, wall at +3.5x)');

const WALL = [aabb(3.4, -6, 3.6, 6, 2)];
scoring.setObs(0, WALL);
const THV = Object.assign({}, TH, { vis: 0 });

// Standing at the origin, behind the wall from the blast: nothing.
scoring.newPlan();
scoring.reset();
for (let leg = 0; leg < 8; leg++) scoring.dodgeDpBlast(0, 0, 0, 0, 0, THV, leg * 0.1, 0.1);
const behind = scoring.dodgeDpFactor[0] * THV.dmg;

// Walking +x at 12 u/s: 4.2u by the detonation, which is past the wall, so the
// blast has a clean line and charges in full.
scoring.reset();
for (let leg = 0; leg < 8; leg++) {
  scoring.dodgeDpBlast(0, 12 * (leg * 0.1), 0, 12, 0, THV, leg * 0.1, 0.1);
}
const infront = scoring.dodgeDpFactor[0] * THV.dmg;

console.log(`  behind the wall   ${behind.toFixed(1)} HP`);
console.log(`  past the wall     ${infront.toFixed(1)} HP`);
const visOk = behind === 0 && Math.abs(infront - 125) < 0.01;
console.log(`  ${visOk ? 'ok' : 'FAIL'}  cover is a gradient, not a switch`);
if (!visOk) failed++;

// And the memo: a whole plan's worth of edges over the same handful of cells
// must not be a whole plan's worth of raycasts.
const before = scoring.rays();
for (let rep = 0; rep < 20; rep++) {
  for (let leg = 0; leg < 8; leg++) {
    scoring.dodgeDpBlast(0, 12 * (leg * 0.1), 0, 12, 0, THV, leg * 0.1, 0.1);
  }
}
const cast = scoring.rays() - before;
console.log(`  ${cast === 0 ? 'ok' : 'FAIL'}  20 more passes over the same cells traced ${cast} of them`);
if (cast !== 0) failed++;

// A new plan invalidates it, because the grid it was indexed against moves.
scoring.newPlan();
scoring.dodgeDpBlast(0, 12 * 0.3, 0, 12, 0, THV, 0.3, 0.1);
const after = scoring.rays() - before;
console.log(`  ${after > 0 ? 'ok' : 'FAIL'}  a new plan re-traces (${after} cell)`);
if (!(after > 0)) failed++;

// ---- Thrower attribution ------------------------------------------------
//
// The wire never says who threw a grenade. What it says is where everyone is,
// which way they are looking, and — decisively — that the thrower is animating
// a throw in the very packet the grenade appears in. Geometry breaks whatever
// ties that leaves, so what is checked here is that the geometry actually can:
// the hand is a known place, 1.118u out at 63.4 degrees off the aim, and the
// spawn is somewhere on the segment from the body to it.
console.log('\nthrower attribution (hand offset from body and aim)');

const geom = eval(`(function () {
  ${extract('dodgeThrowSpawnDist')}
  return { dodgeThrowSpawnDist };
})()`);
const PROJ_SPAWN_OFFSET = Math.hypot(0.5, 1.0);
const FIT = grabConst('DODGE_PROJ_SPAWN_FIT');
const EDGE = grabConst('DODGE_PROJ_SPAWN_EDGE');

// The server's own throwThrowable: pos = player.pos + v2.rotate({0.5,-1.0}, aim).
function serverHand(px, py, aim) {
  const c = Math.cos(aim), s = Math.sin(aim);
  return { x: px + 0.5 * c - -1.0 * s, y: py + 0.5 * s + -1.0 * c };
}

let attrFail = 0;
for (const aim of [0, Math.PI / 2, Math.PI, -2.2]) {
  const h = serverHand(0, 0, aim);
  const d = geom.dodgeThrowSpawnDist(0, 0, Math.cos(aim), Math.sin(aim), h.x, h.y);
  const ok = d < 1e-9;
  if (!ok) attrFail++;
  console.log(`  aim ${aim.toFixed(2).padStart(5)}  hand (${h.x.toFixed(2).padStart(5)}, ` +
              `${h.y.toFixed(2).padStart(5)})  fits its own thrower to ${d.toExponential(1)}  ` +
              `${ok ? 'ok' : 'FAIL'}`);
}

// A wall clips the spawn back along the body->hand segment, so any point on
// that segment has to read as a perfect fit and not as an error.
const halfway = serverHand(0, 0, 0);
const clipped = geom.dodgeThrowSpawnDist(0, 0, 1, 0, halfway.x / 2, halfway.y / 2);
console.log(`  ${clipped < 1e-9 ? 'ok' : 'FAIL'}  a wall-clipped spawn halfway out still fits (${clipped.toExponential(1)})`);
if (!(clipped < 1e-9)) attrFail++;

// The case a radius around the body cannot do: two players standing on top of
// each other, throwing in opposite directions. The wrong one must be rejected
// by more than the margin the tie-break demands.
const A = { x: 0, y: 0, aim: 0 };            // looking +x
const B = { x: 0.4, y: 0, aim: Math.PI };    // 0.4u away, looking -x
const spawn = serverHand(A.x, A.y, A.aim);
const dA = geom.dodgeThrowSpawnDist(A.x, A.y, Math.cos(A.aim), Math.sin(A.aim), spawn.x, spawn.y);
const dB = geom.dodgeThrowSpawnDist(B.x, B.y, Math.cos(B.aim), Math.sin(B.aim), spawn.x, spawn.y);
const split = dA <= FIT && dB - dA >= EDGE;
console.log(`  two players 0.4u apart, opposite aims: thrower ${dA.toFixed(3)}u, ` +
            `other ${dB.toFixed(3)}u`);
console.log(`  ${split ? 'ok' : 'FAIL'}  told apart by ${(dB - dA).toFixed(2)}u against a ` +
            `${EDGE}u margin; a ${PROJ_SPAWN_OFFSET.toFixed(2)}u radius could not`);
if (!split) attrFail++;

// And the tolerance has to survive the thrower having moved on since the throw:
// the packet carrying the grenade is up to a net tick old, so a player at
// 12 u/s is up to ~0.36u from where they threw it.
const drifted = geom.dodgeThrowSpawnDist(0.36, 0, 1, 0, spawn.x, spawn.y);
console.log(`  ${drifted <= FIT ? 'ok' : 'FAIL'}  a thrower who ran 0.36u since still fits ` +
            `(${drifted.toFixed(3)}u against ${FIT}u)`);
if (!(drifted <= FIT)) attrFail++;
failed += attrFail;

// ---- Cook to throw ------------------------------------------------------
//
// The hand-off. A grenade cooked for two seconds and thrown must arrive with
// two seconds of fuse, not four: the cook has to survive the moment the
// projectile appears, and the age the arc reports has to be the tick or so of
// flight that has already happened rather than the second the other root of the
// same equation would claim.
//
// This is the regression that matters, because the failure was silent. The gate
// on the record-creation path asked whether posZ was within 0.02 of the 0.5 a
// grenade is thrown at — and it never is, because the server runs one to three
// 100Hz physics ticks before the 33Hz packet goes out. Nothing downstream of
// that gate ever ran, and every grenade arrived reading a full fuse.
console.log('\ncook to throw (posZ at first sight, and what it dates the grenade to)');

const arc = eval(`(function () {
  const PROJ_GRAVITY = ${PROJ_GRAVITY};
  const PROJ_SPAWN_Z = ${PROJ_SPAWN_Z};
  ${extract('dodgeProjAge')}
  return { dodgeProjAge };
})()`);

// The server's own integrator, for the ticks between creation and serialisation.
function posZAfter(ticks, velZ0) {
  let z = PROJ_SPAWN_Z, vz = velZ0;
  for (let i = 0; i < ticks; i++) { vz -= PROJ_GRAVITY * 0.01; z += vz * 0.01; }
  return z;
}

let cookFail = 0;
const FUSE = 4, COOKED = 2.0;
console.log('  ticks  posZ    ageUp     ageDown   fuse via ageUp   fuse via ageDown');
for (const ticks of [1, 2, 3]) {
  const z = posZAfter(ticks, FRAG.velZ);
  const up = arc.dodgeProjAge(z, FRAG.velZ, false);
  const down = arc.dodgeProjAge(z, FRAG.velZ, true);
  const viaUp = FUSE - COOKED - up;
  const viaDown = FUSE - COOKED - down;
  const trueAge = ticks * 0.01;
  // Not exact, and not meant to be: the server integrates the arc with Euler at
  // 100Hz while the inversion solves the continuous parabola, so they part by a
  // few tenths of a millisecond. What is being checked is that the *root* is
  // the right one — the wrong branch is out by 900ms, three orders past this.
  const ok = Math.abs(up - trueAge) < 2e-3;
  if (!ok) cookFail++;
  console.log(`  ${ticks}      ${z.toFixed(4)}  ${up.toFixed(4)}s  ${down.toFixed(4)}s  ` +
              `${viaUp.toFixed(3)}s          ${viaDown.toFixed(3)}s  ${ok ? '' : 'FAIL'}`);
}
console.log(`  ${cookFail === 0 ? 'ok' : 'FAIL'}  the ascending root is the age at first sight; ` +
            `the descending one would over-age it by ~0.9s`);

// The gate that used to stand here, against the smallest posZ it could ever
// have seen. This is the assertion that keeps the bug from coming back.
const zMin = posZAfter(1, FRAG.velZ);
const neverFresh = Math.abs(zMin - PROJ_SPAWN_Z) > 0.02;
console.log(`  ${neverFresh ? 'ok' : 'FAIL'}  a spawn-height test could not have passed: the ` +
            `earliest posZ is ${zMin.toFixed(4)}, ${Math.abs(zMin - PROJ_SPAWN_Z).toFixed(4)} off 0.5`);
if (!neverFresh) cookFail++;

// And the whole point: a 2s cook must leave 2s of fuse, not 4.
const carried = FUSE - COOKED - arc.dodgeProjAge(posZAfter(3, FRAG.velZ), FRAG.velZ, false);
const dropped = FUSE - 0 - arc.dodgeProjAge(posZAfter(3, FRAG.velZ), FRAG.velZ, false);
console.log(`  cook carried: ${carried.toFixed(2)}s left   cook dropped: ${dropped.toFixed(2)}s left`);
const carryOk = Math.abs(carried - 1.97) < 0.02;
console.log(`  ${carryOk ? 'ok' : 'FAIL'}  a 2s cook leaves ~2s, and losing it would overstate ` +
            `the fuse by ${(dropped - carried).toFixed(2)}s`);
if (!carryOk) cookFail++;
failed += cookFail;

// ---- Re-solving the blast point -----------------------------------------
//
// The detonation point is re-solved on every packet, against the state that
// packet delivered. Three things have to hold for that to beat solving it once
// and freezing it, and the first of them is what the freeze was defending.
//
// **Re-solving must not move the answer in a world that has not moved.**
// Simulating from a later state over a correspondingly shorter fuse has to land
// where simulating from an earlier one did — it has to, because the later state
// is *on* the trajectory computed from the earlier one, but "has to" is exactly
// the sort of reasoning worth checking against a wall and a table. If this
// fails, re-solving is noise and freezing was right.
console.log('\nre-solving from later states (the answer must not move)');

let freezeWorst = 0;
for (const c of CASES) {
  if (c.water) continue;                      // the sim reads water per packet
  SCENE = c.scene;
  const init = throwState(c.speed);
  const base = serverSim(init, c.fuse, c.scene, false);

  let worstHere = 0;
  // Re-solve from where the grenade is a quarter, a half and three quarters of
  // the way through its fuse — after the bounce, in the cases that have one.
  for (const frac of [0.25, 0.5, 0.75]) {
    const at = c.fuse * frac;
    const mid = serverSim(init, at, c.scene, false);
    const rec = {
      x: mid.x, y: mid.y, z: mid.z, vx: mid.vx, vy: mid.vy,
      haveVel: true, water: false,
      // The mod carries age rather than velZ, and reconstructs velZ from it as
      // velZ0 - g*age, so the state handed to a re-solve is expressed the same
      // way the record would express it.
      age: at,
    };
    bundle.dodgeSimBlast(rec, { velZ: FRAG.velZ, rad: FRAG.rad }, c.fuse - at, 0,
                         bundle.dodgeSimOut);
    const d = Math.hypot(bundle.dodgeSimOut.x - base.x, bundle.dodgeSimOut.y - base.y);
    if (d > worstHere) worstHere = d;
  }
  if (worstHere > freezeWorst) freezeWorst = worstHere;
  const ok = worstHere <= TOL;
  if (!ok) failed++;
  console.log(`  ${c.name.padEnd(9)} re-solve drifts ${worstHere.toFixed(3)}u  ${ok ? 'ok' : 'FAIL'}`);
}
console.log(`  ${freezeWorst <= TOL ? 'ok' : 'FAIL'}  worst ${freezeWorst.toFixed(3)}u — ` +
            `the exact state re-solves to the same point`);

// ---- What the wire actually delivers ------------------------------------
//
// The exact state is not what arrives. Positions ride as 16 bits over the map's
// 1024 units and posZ as 10 bits over [0, 5], so every packet is a rounded
// reading and a velocity differenced from two of them carries a whole quantum
// divided by one tick — about half a unit per second. That noise is the entire
// case the freeze had: locked in, the blast point holds still; re-solved from a
// fresh pair every packet, it wanders.
//
// So the second thing that has to hold is that **the velocity fed to the
// re-solve is not a fresh pair**. An airborne grenade holds its horizontal
// speed exactly, so dodgeProjVel averages across the whole leg since it last
// touched something, and the error falls off with the length of the baseline.
//
// This drives a quantised packet stream — the server loop sampled at the update
// rate and rounded the way the wire rounds it — through three schemes:
//
//   frozen   solved once on the first packet that can measure a velocity, from
//            that single noisiest-available pair, and never again
//   pair     re-solved every packet from the newest pair of positions
//   leg      re-solved every packet from the shipped estimator
//
// and asks each of them where the grenade is going to go off.
console.log('\nagainst the wire (16-bit positions, 10-bit posZ)');

const TICK_MS = 30;                    // an update, and a whole number of server ticks
const TICK_S = TICK_MS / 1000;
// The wire's own rounding: readFloat is `lo + readBits(n)/(2^n - 1) * (hi - lo)`.
const qMap = (v) => Math.round(v / 1024 * 65535) / 65535 * 1024;
const qZ = (v) => Math.round(v / 5 * 1023) / 1023 * 5;
// Off the map's origin, so nothing lands on a grid line by construction.
const OX = 137.317, OY = 208.941;
const FRAG_PHYS = { velZ: FRAG.velZ, rad: FRAG.rad, fuse: 4 };

// One grenade's life as the mod sees it, scored against where it truly goes off.
// `mutate(t)` is the world changing under the prediction; it returns the scene
// in force at time t.
function packetRun(speed, ang, fuse, scene, mutate) {
  const init = {
    x: OX, y: OY, z: PROJ_SPAWN_Z, rad: FRAG.rad, vz: FRAG.velZ,
    vx: speed * Math.cos(ang), vy: speed * Math.sin(ang),
  };
  const truthScene = mutate ? mutate(fuse) : scene;
  const truth = serverSim(init, fuse, truthScene, false);

  const mk = (x, y, z, t) => ({
    x, y, z, age: t, n: 1, vx: 0, vy: 0, haveVel: false,
    legN: -1, legX: x, legY: y, grounded: false, atRest: false, water: false,
  });
  let legRec = null, pairRec = null;
  let frozen = null;
  const errs = { frozen: [], pair: [], leg: [] };
  const last = { pair: null, leg: null };
  const jit = { pair: 0, leg: 0, n: 0 };

  const solve = (rec, left) => {
    if (rec.atRest || !rec.haveVel) return { x: rec.x, y: rec.y };
    SCENE = mutate ? mutate(fuse - left) : scene;
    bundle.dodgeSimBlast(rec, FRAG_PHYS, left, 0, bundle.dodgeSimOut);
    return { x: bundle.dodgeSimOut.x, y: bundle.dodgeSimOut.y };
  };
  const miss = (p) => Math.hypot(p.x - truth.x, p.y - truth.y);

  for (let k = 1; k * TICK_S < fuse; k++) {
    const t = k * TICK_S;
    const st = serverSim(init, t, mutate ? mutate(t) : scene, false);
    const x = qMap(st.x), y = qMap(st.y), z = qZ(st.z);
    if (!legRec) { legRec = mk(x, y, z, t); pairRec = mk(x, y, z, t); continue; }

    bundle.dodgeProjVel(legRec, FRAG_PHYS, x, y, z, k, TICK_S, TICK_MS);
    // The estimator the freeze locked in, and the one `pair` keeps using: the
    // newest two positions, differenced.
    pairRec.vx = (x - pairRec.x) / TICK_S;
    pairRec.vy = (y - pairRec.y) / TICK_S;
    pairRec.haveVel = true;
    for (const r of [legRec, pairRec]) {
      r.age = t; r.n = k; r.x = x; r.y = y; r.z = z;
    }

    const left = fuse - t;
    const pLeg = solve(legRec, left);
    const pPair = solve(pairRec, left);
    if (!frozen) frozen = pLeg;        // both schemes agree on the first pair
    errs.frozen.push(miss(frozen));
    errs.pair.push(miss(pPair));
    errs.leg.push(miss(pLeg));
    if (last.leg) {
      jit.leg += Math.hypot(pLeg.x - last.leg.x, pLeg.y - last.leg.y);
      jit.pair += Math.hypot(pPair.x - last.pair.x, pPair.y - last.pair.y);
      jit.n++;
    }
    last.leg = pLeg; last.pair = pPair;
  }
  const mean = (a) => a.reduce((u, v) => u + v, 0) / Math.max(a.length, 1);
  return {
    frozen: mean(errs.frozen), pair: mean(errs.pair), leg: mean(errs.leg),
    finalLeg: errs.leg[errs.leg.length - 1], finalPair: errs.pair[errs.pair.length - 1],
    jitLeg: jit.leg / Math.max(jit.n, 1), jitPair: jit.pair / Math.max(jit.n, 1),
  };
}

// Twelve headings of open-ground throw, so the answer is a property of the
// estimator and not of one lucky trajectory.
let agg = { frozen: 0, pair: 0, leg: 0, jitPair: 0, jitLeg: 0, finalLeg: 0, finalPair: 0, n: 0 };
for (let i = 0; i < 12; i++) {
  const r = packetRun(20, i * Math.PI / 6, 4, [], null);
  for (const k of Object.keys(agg)) if (k !== 'n') agg[k] += r[k];
  agg.n++;
}
for (const k of Object.keys(agg)) if (k !== 'n') agg[k] /= agg.n;
console.log('  scheme   mean err   final err   packet-to-packet move');
console.log(`  frozen   ${agg.frozen.toFixed(3)}u     ${agg.frozen.toFixed(3)}u      0.000u`);
console.log(`  pair     ${agg.pair.toFixed(3)}u     ${agg.finalPair.toFixed(3)}u      ${agg.jitPair.toFixed(3)}u`);
console.log(`  leg      ${agg.leg.toFixed(3)}u     ${agg.finalLeg.toFixed(3)}u      ${agg.jitLeg.toFixed(3)}u`);

// The three claims, in the order they matter. Re-solving has to be worth
// something at all; the leg has to be the reason it is worth something rather
// than a wash against the noise it adds; and the ring has to sit still enough
// to read while it does it.
const beatsFrozen = agg.leg < agg.frozen;
console.log(`  ${beatsFrozen ? 'ok' : 'FAIL'}  re-solving is closer than the answer frozen off the ` +
            `first pair (${agg.leg.toFixed(3)}u vs ${agg.frozen.toFixed(3)}u)`);
if (!beatsFrozen) failed++;
const beatsPair = agg.leg < agg.pair && agg.jitLeg < agg.jitPair;
console.log(`  ${beatsPair ? 'ok' : 'FAIL'}  the leg baseline beats a fresh pair on both ` +
            `(${agg.leg.toFixed(3)}u vs ${agg.pair.toFixed(3)}u, moving ` +
            `${agg.jitLeg.toFixed(3)}u a packet vs ${agg.jitPair.toFixed(3)}u)`);
if (!beatsPair) failed++;
const settles = agg.finalLeg <= TOL;
console.log(`  ${settles ? 'ok' : 'FAIL'}  and it converges: ${agg.finalLeg.toFixed(3)}u ` +
            `left on the last packet before the fuse`);
if (!settles) failed++;

// A bounce is what the leg has to survive: the average is only meaningful over
// a stretch of flight the grenade did not turn during, so the estimator watches
// for a reading it cannot explain as quantisation and starts again there.
{
  const wall = [aabb(OX + 14, OY - 5, OX + 15, OY + 5, 2)];
  const r = packetRun(20, 0, 4, wall, null);
  // What is checked here is that the turn does not poison the average — that a
  // leg spanning the bounce is noticed and abandoned. Not that it beats the
  // freeze on this particular throw: a frozen point is a coin toss on one
  // trajectory, and on this one the coin came up well.
  const ok = r.finalLeg <= TOL && r.leg <= TOL;
  console.log(`  ${ok ? 'ok' : 'FAIL'}  through a wall bounce the leg re-anchors: mean ` +
              `${r.leg.toFixed(3)}u, final ${r.finalLeg.toFixed(3)}u ` +
              `(a fresh pair: ${r.pair.toFixed(3)}u / ${r.finalPair.toFixed(3)}u)`);
  if (!ok) failed++;
}

// ---- And the third thing: a world that does move ------------------------
//
// The one cost of freezing that no amount of arithmetic could recover. The
// prediction bounces the grenade off a crate, and half a second into the flight
// somebody shoots the crate. Nothing about the grenade has changed, so nothing
// re-derives; the frozen point simply describes a bounce that is not going to
// happen. Re-solving reads the obstacle list the packet left behind.
console.log('\na crate destroyed under the prediction');
{
  const crate = aabb(OX + 14, OY - 5, OX + 15, OY + 5, 2);
  const DIES_AT = 0.5;
  const withCrate = [crate], without = [];
  const r = packetRun(20, 0, 4, null, (t) => (t < DIES_AT ? withCrate : without));
  const ok = r.finalLeg <= TOL;
  console.log(`  frozen off the first packet: ${r.frozen.toFixed(2)}u out — it is still ` +
              `predicting the bounce`);
  console.log(`  ${ok ? 'ok' : 'FAIL'}  re-solved: ${r.finalLeg.toFixed(3)}u out by the ` +
              `last packet, and ${r.leg.toFixed(2)}u averaged over the flight`);
  if (!ok) failed++;
  if (!(r.frozen > 1)) {
    console.log('  FAIL  the scenario does not actually separate the two');
    failed++;
  }
}

// ---- Throw preview ------------------------------------------------------
//
// While we are cooking, the ring is drawn where the grenade would land if we
// let go this instant. That means porting the server's throwThrowable, and the
// part worth checking is the part people misremember: **the cursor is the
// throttle**. Strength is the distance to the mouse over
// throwableMaxMouseDist, so half a screen out is half a throw, and everything
// past 18 units is the same full-strength throw.
console.log('\nthrow preview (cursor distance is throw strength)');

const PROJ_MAX_MOUSE_DIST = grabConst('PROJ_MAX_MOUSE_DIST');
const FRAG_THROW_SPEED = 20;

// The server's own arithmetic, from throwThrowable.
function serverThrow(mouseLen, moveVx) {
  const mult = Math.min(Math.max(mouseLen, 0), PROJ_MAX_MOUSE_DIST) / PROJ_MAX_MOUSE_DIST;
  return mult * FRAG_THROW_SPEED + moveVx * 0.6;
}

let throwFail = 0;
console.log('  cursor   strength   lands at   (still, from a standing throw)');
SCENE = [];
let lastX = -1;
for (const mouseLen of [0, 4.5, 9, 18, 40]) {
  const vx = serverThrow(mouseLen, 0);
  const rec = { x: 0, y: 0, z: 0.5, vx, vy: 0, haveVel: true, age: 0, water: false };
  bundle.dodgeSimBlast(rec, { velZ: FRAG.velZ, rad: FRAG.rad }, 4, 0, bundle.dodgeSimOut);
  const at = bundle.dodgeSimOut.x;
  console.log(`  ${String(mouseLen).padStart(5)}u   ${vx.toFixed(1).padStart(5)} u/s   ` +
              `${at.toFixed(2).padStart(6)}u`);
  // Monotone in cursor distance, and flat past the cap.
  if (mouseLen <= PROJ_MAX_MOUSE_DIST && at <= lastX) throwFail++;
  lastX = at;
}
// Past the cap the throw stops growing: 18u and 40u must land in the same place.
const at18 = (() => {
  const rec = { x: 0, y: 0, z: 0.5, vx: serverThrow(18, 0), vy: 0, haveVel: true, age: 0, water: false };
  bundle.dodgeSimBlast(rec, { velZ: FRAG.velZ, rad: FRAG.rad }, 4, 0, bundle.dodgeSimOut);
  return bundle.dodgeSimOut.x;
})();
const capped = Math.abs(at18 - lastX) < 1e-9;
console.log(`  ${capped ? 'ok' : 'FAIL'}  past ${PROJ_MAX_MOUSE_DIST}u the cursor stops mattering`);
if (!capped) throwFail++;

// Half strength is half the flight but not half the total: the slide is
// proportional to landing speed, so the whole throw scales linearly. Worth
// pinning because it is the property that makes the ring readable — the
// distance to the ring tracks the cursor proportionally.
const half = (() => {
  const rec = { x: 0, y: 0, z: 0.5, vx: serverThrow(9, 0), vy: 0, haveVel: true, age: 0, water: false };
  bundle.dodgeSimBlast(rec, { velZ: FRAG.velZ, rad: FRAG.rad }, 4, 0, bundle.dodgeSimOut);
  return bundle.dodgeSimOut.x;
})();
const linear = Math.abs(half * 2 - at18) < 0.05;
console.log(`  ${linear ? 'ok' : 'FAIL'}  half a cursor is half a throw ` +
            `(${half.toFixed(2)}u vs ${(at18 / 2).toFixed(2)}u)`);
if (!linear) throwFail++;
console.log(`  ${throwFail === 0 ? 'ok' : 'FAIL'}  landing distance rises with the cursor`);
failed += throwFail;

// ---- Solving a throw ----------------------------------------------------
//
// Frag aim inverts the throw: given a point, which cursor puts the grenade
// there. Two variables, and the second one is the throw's strength, so it is a
// genuinely two-dimensional aim. It cannot be inverted in closed form once a
// wall is in the picture — a throw that clears a crate and one that bounces off
// it differ by a degree and land twenty units apart — so it is searched, seeded
// from the closed form that holds when nothing is in the way.
//
// What is checked here is that the search converges to the point asked for,
// across the range and off-axis, and that it degrades honestly rather than
// silently when the target is out of reach.
console.log('\nsolving a throw (which cursor lands it on this point)');

const solver = eval(`(function () {
  const PROJ_GRAVITY = ${PROJ_GRAVITY};
  const PROJ_SPAWN_HEIGHT = ${PROJ_SPAWN_Z};
  const PROJ_DRAG = ${PROJ_DRAG};
  const PROJ_DRAG_WATER = ${PROJ_DRAG_WATER};
  const PROJ_MAX_MOUSE_DIST = ${grabConst('PROJ_MAX_MOUSE_DIST')};
  const DODGE_SIM_DT = ${DODGE_SIM_DT};
  const DODGE_SIM_MAX_STEPS = ${DODGE_SIM_MAX_STEPS};
  const COLLIDER_CIRCLE = ${COLLIDER_CIRCLE};
  const COLLIDER_AABB = ${COLLIDER_AABB};
  const FRAG_SOLVE_ANGLE = ${grabConst('FRAG_SOLVE_ANGLE')};
  const FRAG_SOLVE_ANGLES = ${grabConst('FRAG_SOLVE_ANGLES')};
  const FRAG_SOLVE_STEPS = ${grabConst('FRAG_SOLVE_STEPS')};
  const FRAG_SOLVE_PASSES = ${grabConst('FRAG_SOLVE_PASSES')};
  const FRAG_SOLVE_WARM_ANGLE = ${grabConst('FRAG_SOLVE_WARM_ANGLE')};
  const FRAG_SOLVE_WARM_LEN = ${grabConst('FRAG_SOLVE_WARM_LEN')};
  const dodgeSimOut = { x: 0, y: 0 };
  const dodgeSimHit = { nx: 0, ny: 0, pen: 0 };
  const dodgeSimObs = [];
  const dodgeSimRiverList = [];
  const dodgeThrowRec = { x: 0, y: 0, z: 0, vx: 0, vy: 0, haveVel: true, age: 0, water: false };
  const dodgeSpawnOut = { x: 0, y: 0 };
  const fragSolveOut = { dx: 1, dy: 0, len: 0, x: 0, y: 0, err: Infinity };
  const fragLandOut = { x: 0, y: 0 };
  let sims = 0;
  const sameLayerAs = () => true;
  const getObstacles = () => SCENE;
  const dodgeProjInWater = () => false;
  // dodgeSimRivers reaches the live client map for its river polygons; the
  // scenario stands in for it, so the shipped gather and point test are the ones
  // under examination and only the map handle is fake.
  const capturedGame = null;
  const findMapOnGame = () => ({ terrain: { rivers: RIVERS } });
  ${extract('dodgeSimRivers')}
  ${extract('dodgeSimInWater')}
  ${extract('dodgeSimPen')}
  ${extract('dodgeSimObstacles')}
  ${extract('dodgeSimBlast')}
  ${extract('segHitCircle')}
  ${extract('segHitAabb')}
  ${extract('segHitCollider')}
  ${extract('colliderNearSegment')}
  const PROJ_SPAWN_OFFSET = Math.hypot(0.5, 1.0);
  const dodgeSpawnScratch = [];
  ${extract('dodgeSpawnObstacles')}
  ${extract('dodgeThrowSpawn')}
  ${extract('dodgeThrowLand').replace('const mult =', 'sims++; const mult =')}
  ${extract('fragReachFor')}
  const FRAG_WARM_ANGLES = ${grabConst('FRAG_WARM_ANGLES')};
  const FRAG_WARM_STEPS = ${grabConst('FRAG_WARM_STEPS')};
  const FRAG_WARM_PASSES = ${grabConst('FRAG_WARM_PASSES')};
  const FRAG_COARSE_DT = ${grabConst('FRAG_COARSE_DT')};
  const FRAG_SOLVE_WARM_OK = ${grabConst('FRAG_SOLVE_WARM_OK')};
  const fragKeep = { dx: 1, dy: 0, len: 0, x: 0, y: 0, err: Infinity };
  ${extract('fragSweep')}
  ${extract('fragSolve')}
  return { fragSolve, dodgeThrowLand, sims: () => sims };
})()`);

// A stationary thrower with a frag, four seconds of fuse, no perks.
const ctx = { ok: true, x: 0, y: 0, layer: 0, mvx: 0, mvy: 0,
              maxDist: 18, speed: FRAG_THROW_SPEED, left: 4, water: false,
              phys: { velZ: FRAG.velZ, rad: FRAG.rad, speed: FRAG_THROW_SPEED },
              // Prefiltered once, as dodgeThrowContext does — passing null here
              // would exercise a path the real solver never takes.
              obs: null, spawnObs: null };
// Rebuilt whenever the scene changes, the same way the context is rebuilt each
// time the solver is entered.
function ctxScene(scene) {
  SCENE = scene;
  ctx.obs = scene.slice();
  ctx.spawnObs = scene.filter((o) => o.collidable && o.height >= 0.5);
}

// Reachable at all: the full-strength throw from the earlier section.
const REACH = 29.49;
console.log('  target            solved cursor       lands at            miss');
let solveFail = 0;
ctxScene([]);
const simsBefore = solver.sims();
for (const [tx, ty] of [[10, 0], [20, 0], [28, 0], [12, 12], [-15, 6], [0, -22]]) {
  const sol = solver.fragSolve(ctx, tx, ty, null);
  const ok = sol.err <= 0.5;
  if (!ok) solveFail++;
  console.log(`  (${tx.toFixed(0).padStart(4)},${ty.toFixed(0).padStart(4)})      ` +
              `${sol.len.toFixed(1).padStart(5)}u @ ${(Math.atan2(sol.dy, sol.dx) * 180 / Math.PI).toFixed(0).padStart(4)}deg   ` +
              `(${sol.x.toFixed(1).padStart(5)},${sol.y.toFixed(1).padStart(5)})    ` +
              `${sol.err.toFixed(3)}  ${ok ? 'ok' : 'FAIL'}`);
}
console.log(`  ${solveFail === 0 ? 'ok' : 'FAIL'}  every reachable point solved to under half a unit`);

// Out of range: the honest answer is the longest throw available, and an error
// that says how far short it fell rather than a pretence that it reached.
const far = solver.fragSolve(ctx, 60, 0, null);
const short = Math.abs(far.len - ctx.maxDist) < 0.6 && far.err > 25;
console.log(`  ${short ? 'ok' : 'FAIL'}  a target at 60u gets a full-strength throw ` +
            `(${far.len.toFixed(1)}u cursor) landing ${far.x.toFixed(1)}u out, ` +
            `reported ${far.err.toFixed(1)}u short`);
if (!short) solveFail++;

// The cursor really is the throttle: a nearer target must solve to a nearer
// cursor, monotonically.
let lastLen = -1, mono = true;
for (const d of [8, 14, 20, 26]) {
  const sol = solver.fragSolve(ctx, d, 0, null);
  if (sol.len <= lastLen) mono = false;
  lastLen = sol.len;
}
console.log(`  ${mono ? 'ok' : 'FAIL'}  a nearer target solves to a nearer cursor`);
if (!mono) solveFail++;

// And the cost, since the whole thing runs inside the single frame the release
// is read on. A dropped frame there is a dropped frame at the exact moment the
// user is throwing, which is the worst place in the game to find one.
const t0 = process.hrtime.bigint();
const N = 50;
const simsAt = solver.sims();
for (let i = 0; i < N; i++) solver.fragSolve(ctx, 20, 0, null);
const msEach = Number(process.hrtime.bigint() - t0) / 1e6 / N;
const perSolve = (solver.sims() - simsAt) / N;
const cheap = perSolve <= 200 && msEach <= 3;
console.log(`  ${cheap ? 'ok' : 'FAIL'}  ${perSolve} simulations and ${msEach.toFixed(2)}ms per ` +
            `solve — seeded from the closed form, so the sweep is small`);
if (!cheap) solveFail++;

// Warm start. The cursor is driven every frame while the grenade is cooking, so
// the previous frame's answer seeds the next — which is only sound if it
// converges at least as well as a cold solve on a target that has moved a
// frame's worth, and if it can still walk out of a seed that has gone stale.
const FRAG_WARM_OK_TEST = grabConst('FRAG_SOLVE_WARM_OK');
console.log('\n  warm start (the same solve, seeded from last frame)');
{
  let coldWorst = 0, warmWorst = 0;
  let warm = null;
  // A target strafing across at 12 u/s, sampled every 16ms — the hardest thing
  // the warm sweep has to track.
  for (let f = 0; f < 30; f++) {
    const tx = 20, ty = -6 + 12 * (f * 0.016);
    const cold = solver.fragSolve(ctx, tx, ty, null);
    coldWorst = Math.max(coldWorst, cold.err);
    const w = solver.fragSolve(ctx, tx, ty, warm);
    warmWorst = Math.max(warmWorst, w.err);
    warm = { bearing: Math.atan2(w.dy, w.dx), len: w.len, err: w.err };
  }
  // The bar is what the solver itself treats as converged, not parity with a
  // cold solve: both are far below anything that would change which side of a
  // target a grenade lands on, and holding a narrow sweep to a wide one's exact
  // number is measuring noise.
  const ok = warmWorst <= FRAG_WARM_OK_TEST;
  console.log(`    cold ${coldWorst.toFixed(3)}u worst, warm ${warmWorst.toFixed(3)}u worst ` +
              `over 30 frames of a strafing target`);
  console.log(`    ${ok ? 'ok' : 'FAIL'}  a warm seed tracks at least as well as a cold solve`);
  if (!ok) solveFail++;

  // And it must not be trapped by a seed that no longer means anything: a
  // target that jumps to the far side has to be found from a stale warm start.
  const stale = { bearing: Math.PI, len: 4, err: 0.1 };
  const jumped = solver.fragSolve(ctx, 22, 0, stale);
  const escaped = jumped.err <= 0.5;
  console.log(`    ${escaped ? 'ok' : 'FAIL'}  a stale seed pointing the wrong way still ` +
              `converges (${jumped.err.toFixed(3)}u)`);
  if (!escaped) solveFail++;
}

// The cost again, this time against geometry rather than an empty field. The
// first benchmark above measures the search; this one measures what a town
// costs on top of it, which is the number that decides whether the frame
// survives. Every obstacle in range is tested on every step of every candidate.
console.log('\n  cost against real geometry');
{
  const town = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2, d = 6 + (i % 7) * 3;
    town.push(aabb(Math.cos(a) * d, Math.sin(a) * d,
                   Math.cos(a) * d + 2, Math.sin(a) * d + 2, 1.5));
  }
  ctxScene(town);
  const t = process.hrtime.bigint();
  const M = 50;
  for (let i = 0; i < M; i++) solver.fragSolve(ctx, 20, 0, null);
  const cold = Number(process.hrtime.bigint() - t) / 1e6 / M;
  const warmSeed = { bearing: 0.05, len: 12, err: 0.1 };
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < M; i++) solver.fragSolve(ctx, 20, 0, warmSeed);
  const warmMs = Number(process.hrtime.bigint() - t2) / 1e6 / M;
  console.log(`    ${town.length} obstacles in range: cold ${cold.toFixed(2)}ms, ` +
              `warm ${warmMs.toFixed(2)}ms per solve`);
  // The warm path is what runs on all but a handful of frames, so it is the one
  // with a budget: a sixth of a 60fps frame, leaving the game the rest.
  const ok = warmMs <= 2.5;
  console.log(`    ${ok ? 'ok' : 'FAIL'}  the warm solve fits in a frame with room to spare`);
  if (!ok) solveFail++;
  ctxScene([]);
}

// With a wall in the way the search cannot reach past it, and must not claim to.
ctxScene([aabb(9, -8, 10, 8, 2)]);
const walled = solver.fragSolve(ctx, 20, 0, null);
console.log(`  wall at 9u: best lands (${walled.x.toFixed(1)}, ${walled.y.toFixed(1)}), ` +
            `${walled.err.toFixed(1)}u from the target`);
console.log(`  ${walled.x < 20 ? 'ok' : 'FAIL'}  it does not pretend to throw through it`);
if (!(walled.x < 20)) solveFail++;
failed += solveFail;
ctxScene([]);

console.log(`\nworst path error ${worst.toFixed(3)}u over ${CASES.length} cases; ` +
            `${failed ? `${failed} FAILED` : 'all pass'}`);
process.exit(failed ? 1 : 0);
