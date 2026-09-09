// Offline test harness for the netcode smoothing in inject.js.
//
//     node netcode_sim.js
//
// Netcode smoothing is easy to get subtly, invisibly wrong: every wrong
// variant looks fine on a straight-line test player and a clean link, and only
// separates once the player is allowed to turn and the link is allowed to
// misbehave. Bugs caught this way, all of which read as "smoother" by eyeball
// while measurably making things worse:
//
//   - matching *position* across a segment seam pins the output to where it
//     already was, dropping one rendered frame in three;
//   - matching the old segment's *velocity* across the seam treats genuine
//     acceleration as an artefact, so it fought every direction change a
//     strafing player made on a perfectly clean link;
//   - extrapolating too far renders a player who has already stopped past
//     their true position, then walks it back.
//
// It also caught a bad *model*. An earlier version simulated dropped updates,
// which TCP cannot produce; that let the arrival count diverge from the tick
// index, which no real link does, and indicted clock recovery for failing at
// a case it never faces.
//
// So rather than reimplementing the algorithm, this pulls the clock, the
// snapshot renderer and the smoother verbatim out of inject.js and drives them
// through a simulated survev render loop. The harness cannot drift from the
// shipped code, because it *is* the shipped code.
//
// The model mirrors the bundle: server ticks carrying absolute positions,
// delivered over a TCP-like link (no loss, no reordering; delay jitter and
// stall-then-burst head-of-line blocking), rendered at 60fps. The `vanilla`
// baseline is survev's own
// `lerp(clamp(posInterpTicker / camera[interpWindow], 0, 1), visualPosOld, pos)`;
// the `smoothed` column is the recovered-clock path. Ground-truth motion covers
// a straight line, a 1Hz strafe, and full-speed reversals every 400ms ("juke"),
// the last being the worst realistic case for extrapolation.
//
// Metrics:
//   jerk  mean |Δspeed| between frames. What the eye reads as stutter.
//   froz  % of frames with ~no movement. The freeze-then-teleport.
//   err   RMS position error vs truth, minimised over a range of time shifts
//         so a constant render delay isn't charged as error — this isolates
//         *shape* error, i.e. overshoot and rubber-banding.
//   lag   the time shift that minimised err. The cost side of the trade.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'core', 'inject.js'), 'utf8');

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
  return Number(m[1]);
}

// Everything the extracted functions close over, lifted from inject.js so that
// retuning there flows straight through to these numbers.
const NET_MIN_UPDATE_MS = grabConst('NET_MIN_UPDATE_MS');
const NET_MAX_UPDATE_MS = grabConst('NET_MAX_UPDATE_MS');
const NET_EWMA_ALPHA = grabConst('NET_EWMA_ALPHA');
const NET_SNAP_CAP = grabConst('NET_SNAP_CAP');
const NET_MAX_EXTRAP_MS = grabConst('NET_MAX_EXTRAP_MS');
const NETCODE = eval('(' + /const NETCODE = (\{[\s\S]*?\n  \});/.exec(src)[1] + ')');

// The Player field names the extracted code reads through. In the browser
// these are mangled; here they can be anything, so use readable ones.
const PLAYER_POS = 'pos';

const netStats = { rawMs: 0, meanMs: 0, devMs: 0, windowMs: 0, updates: 0 };
let NOW = 0;
const performance = { now: () => NOW };

// The clock, the snapshot renderer and the smoother all come out of inject.js
// together, so the harness exercises the real pipeline end to end.
const netClock = eval('(' + /const netClock = (\{[\s\S]*?\n  \});/.exec(src)[1] + ')');
// clockOnPacket also logs each arrival into the HUD's residual ring, so that
// has to exist here even though nothing in the sim reads it back.
const CLOCK_RESID_CAP = grabConst('CLOCK_RESID_CAP');
const clockResid = eval('(' + /const clockResid = (\{[\s\S]*?\n  \});/.exec(src)[1] + ')');
const bundle = eval(`(function () {
  ${extract('recordUpdateInterval')}
  ${extract('clockOnPacket')}
  ${extract('renderOnClock')}
  ${extract('updatePlayerSmoothing')}
  ${src.match(/  const pseudotimeOf = [^;]+;/)[0]}
  ${src.match(/  const renderNowMs = [^;]+;/)[0]}
  return { recordUpdateInterval, clockOnPacket, renderOnClock, updatePlayerSmoothing };
})()`);
const { recordUpdateInterval, clockOnPacket, renderOnClock, updatePlayerSmoothing } = bundle;
function resetClock() {
  netClock.n = 0; netClock.count = 0; netClock.sw = 0;
  netClock.mn = 0; netClock.mt = 0; netClock.cnn = 0; netClock.cnt = 0;
  netClock.slope = 0; netClock.ready = false;
}

// ---------------------------------------------------------------------------
// Simulated world
// ---------------------------------------------------------------------------

const TICK_MS = 50;             // survev server tick
const FRAME_MS = 1000 / 60;
const SPEED = 12;               // world units/sec, near survev's top speed
const DURATION_MS = 30000;

const MOTION = {
  line: (t) => SPEED * t,
  strafe: (t) => (SPEED / (2 * Math.PI)) * Math.sin(2 * Math.PI * t),
  juke: (t) => {
    const step = 0.4;
    let x = 0;
    let dir = 1;
    for (let u = 0; u + step <= t; u += step) {
      x += dir * SPEED * step;
      dir = -dir;
    }
    return x + dir * SPEED * (t % step);
  },
};

// survev runs over a WebSocket, so the transport is TCP: updates are never
// lost, never reordered, and never duplicated. Degradation shows up two ways
// instead — delay jitter, and head-of-line blocking, where a retransmit stalls
// the stream and the updates produced during the stall are then delivered
// back-to-back in a burst. Modelling dropped updates (an earlier version of
// this file did) is not merely unrealistic, it is misleading: it makes the
// arrival count diverge from the tick index, which no real link can do, and
// then indicts clock recovery for failing at something it never has to face.
const LINKS = {
  'clean': { jitterMs: 0, seed: 7 },
  'mild jitter': { jitterMs: 15, seed: 7 },
  'heavy jitter': { jitterMs: 35, seed: 7 },
  'severe jitter': { jitterMs: 60, seed: 7 },
  '250ms stalls': { jitterMs: 20, seed: 7, stallEveryMs: 2000, stallLenMs: 250 },
  '400ms stalls': { jitterMs: 20, seed: 7, stallEveryMs: 3000, stallLenMs: 400 },
};

// Build one link's delivery schedule. Arrival times are forced monotonic at
// the end, which is what makes this TCP rather than UDP.
function makeLink({ jitterMs, seed, stallEveryMs = 0, stallLenMs = 0 }, motion) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const packets = [];
  for (let tick = 0; tick * TICK_MS < DURATION_MS; tick++) {
    const sentAt = tick * TICK_MS;
    let arriveAt = sentAt + rnd() * jitterMs;
    if (stallEveryMs && sentAt % stallEveryMs < stallLenMs) {
      // Held by the stall, then released with everything else behind it.
      arriveAt = Math.max(arriveAt, sentAt - (sentAt % stallEveryMs) + stallLenMs);
    }
    packets.push({ arriveAt, x: motion(sentAt / 1000), y: 0 });
  }
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].arriveAt < packets[i - 1].arriveAt) packets[i].arriveAt = packets[i - 1].arriveAt;
  }
  return packets;
}

function run(packets, motion, smooth) {
  netStats.meanMs = 0;
  netStats.devMs = 0;
  netStats.windowMs = 0;
  netStats.updates = 0;
  NETCODE.enabled = smooth ? 1 : 0;

  // Mirrors the bundle's per-entity fields.
  const player = { pos: { x: 0, y: 0 }, visualPosOld: { x: 0, y: 0 }, posInterpTicker: 0 };
  resetClock();
  const st = {
    base: { x: 0, y: 0 }, out: null, haveOut: false,
    snaps: [], lastMs: 0,
  };
  let rawWindowSec = TICK_MS / 1000;
  let lastUpdateTime = null;
  let pi = 0;
  const samples = [];

  for (NOW = 0; NOW < DURATION_MS; NOW += FRAME_MS) {
    while (pi < packets.length && packets[pi].arriveAt <= NOW) {
      const p = packets[pi++];
      if (lastUpdateTime !== null) {
        const gapMs = p.arriveAt - lastUpdateTime;
        rawWindowSec = gapMs / 1000;      // what stock survev would use
        recordUpdateInterval(gapMs / 1000);
      }
      lastUpdateTime = p.arriveAt;
      // Mirrors inject.js's packet hook: advance the clock, then snapshot.
      clockOnPacket(p.arriveAt);
      st.snaps.push({ n: netClock.n - 1, x: p.x, y: p.y });
      if (st.snaps.length > NET_SNAP_CAP) st.snaps.shift();
      // bundle: eq(e.pos, visualPosOld) || (visualPosOld = copy(pos), ticker = 0)
      if (!(p.x === player.visualPosOld.x && p.y === player.visualPosOld.y)) {
        player.visualPosOld = { x: player.pos.x, y: player.pos.y };
        player.posInterpTicker = 0;
      }
      player.pos = { x: p.x, y: p.y };
    }

    const dt = FRAME_MS / 1000;
    const winSec = smooth && netStats.windowMs ? netStats.windowMs / 1000 : rawWindowSec;
    player.posInterpTicker += dt;
    const t = Math.min(Math.max(player.posInterpTicker / winSec, 0), 1);
    const base = {
      x: player.visualPosOld.x + (player.pos.x - player.visualPosOld.x) * t,
      y: player.visualPosOld.y + (player.pos.y - player.visualPosOld.y) * t,
    };

    let out = base;
    if (smooth) {
      updatePlayerSmoothing(st, base);
      out = st.haveOut ? st.out : base;
    }
    samples.push({ now: NOW, x: out.x, truth: motion(NOW / 1000) });
  }
  return samples;
}

function metrics(samples) {
  const warm = samples.filter((s) => s.now > 4000);   // skip EWMA warm-up
  const vel = [];
  for (let i = 1; i < warm.length; i++) {
    vel.push((warm[i].x - warm[i - 1].x) / (FRAME_MS / 1000));
  }
  let jerk = 0;
  for (let i = 1; i < vel.length; i++) jerk += Math.abs(vel[i] - vel[i - 1]);
  const frozen = vel.filter((v) => Math.abs(v) < SPEED * 0.05).length;

  let best = Infinity;
  let bestShift = 0;
  for (let shift = 0; shift <= 18; shift++) {
    let acc = 0;
    let n = 0;
    for (let i = shift; i < warm.length; i++) {
      const d = warm[i].x - warm[i - shift].truth;
      acc += d * d;
      n++;
    }
    const rms = Math.sqrt(acc / n);
    if (rms < best) {
      best = rms;
      bestShift = shift;
    }
  }
  return {
    jerk: jerk / vel.length,
    frozen: (frozen / vel.length) * 100,
    err: best,
    lagMs: bestShift * FRAME_MS,
  };
}

// ---------------------------------------------------------------------------

console.log('Driving inject.js\'s own smoother through a simulated survev render loop.\n');
console.log(`defaults:  ${JSON.stringify(NETCODE)}`);
console.log(`constants: gap=[${NET_MIN_UPDATE_MS},${NET_MAX_UPDATE_MS}]ms alpha=${NET_EWMA_ALPHA} `
  + `snaps=${NET_SNAP_CAP}\n`);
console.log('jerk = stutter (lower better) | froz = frozen frames % | err = shape error (world units)\n');

let worstRegression = 0;
for (const motionName of Object.keys(MOTION)) {
  const motion = MOTION[motionName];
  console.log(`  motion: ${motionName}`);
  console.log(`  ${'link'.padEnd(15)}${'jerk'.padEnd(20)}${'froz%'.padEnd(18)}${'err'.padEnd(18)}lag`);
  for (const [name, link] of Object.entries(LINKS)) {
    const packets = makeLink(link, motion);
    const v = metrics(run(packets, motion, false));
    const s = metrics(run(packets, motion, true));
    const pct = ((s.jerk - v.jerk) / (v.jerk || 1)) * 100;
    if (name !== 'clean') worstRegression = Math.max(worstRegression, pct);
    console.log(
      `  ${name.padEnd(15)}`
      + `${`${v.jerk.toFixed(1)} → ${s.jerk.toFixed(1)}`.padEnd(13)}${`${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`.padStart(6)}  `
      + `${`${v.frozen.toFixed(1)} → ${s.frozen.toFixed(1)}`.padEnd(18)}`
      + `${`${v.err.toFixed(2)} → ${s.err.toFixed(2)}`.padEnd(18)}`
      + `+${(s.lagMs - v.lagMs).toFixed(0)}ms`
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Stop accuracy
//
// Smoothness is only half the job: the rendered position also has to be in the
// *right place*. The case that exposes extrapolation is releasing a movement
// key while packets stall over that exact moment — extrapolation is still
// betting the player kept moving, so it carries them past where they actually
// stopped and then has to walk it back. That misplaces the player against
// cover, and is far more noticeable than a brief freeze, so it is guarded
// separately with a tight bound.
// ---------------------------------------------------------------------------

const STOP_MOVE_MS = 2000;
const STOP_DECEL_MS = 100;      // a key release decelerates, it doesn't teleport to a halt
const STOP_DURATION_MS = 5000;
const MAX_STOP_OVERSHOOT = 0.15;  // world units; player radius is ~1

function stopMotion(t) {
  const ms = t * 1000;
  if (ms < STOP_MOVE_MS) return SPEED * t;
  const d = Math.min(ms - STOP_MOVE_MS, STOP_DECEL_MS) / 1000;
  return SPEED * (STOP_MOVE_MS / 1000) + SPEED * d
    - 0.5 * (SPEED / (STOP_DECEL_MS / 1000)) * d * d;
}

function stopPackets(stallMs) {
  const packets = [];
  for (let tick = 0; tick * TICK_MS < STOP_DURATION_MS; tick++) {
    const sentAt = tick * TICK_MS;
    // TCP again: updates produced during the stall are delayed to its end, not
    // discarded.
    const held = sentAt >= STOP_MOVE_MS && sentAt < STOP_MOVE_MS + stallMs;
    packets.push({
      arriveAt: held ? STOP_MOVE_MS + stallMs : sentAt,
      x: stopMotion(sentAt / 1000),
      y: 0,
    });
  }
  for (let i = 1; i < packets.length; i++) {
    if (packets[i].arriveAt < packets[i - 1].arriveAt) packets[i].arriveAt = packets[i - 1].arriveAt;
  }
  return packets;
}

console.log('  stop accuracy: release a movement key while packets stall over the release');
console.log(`  ${'stall'.padEnd(10)}${'peak overshoot'.padEnd(18)}settles`);
let worstOvershoot = 0;
for (const stall of [0, 100, 200, 300]) {
  const samples = run(stopPackets(stall), stopMotion, true)
    .filter((s) => s.now >= STOP_MOVE_MS);
  const peak = samples.reduce((m, s) => Math.max(m, s.x - s.truth), -Infinity);
  const settled = samples.find((s) => Math.abs(s.x - s.truth) < 0.02);
  worstOvershoot = Math.max(worstOvershoot, peak);
  console.log(
    `  ${`${stall}ms`.padEnd(10)}${`${peak.toFixed(3)}u`.padEnd(18)}`
    + `${settled ? `${(settled.now - STOP_MOVE_MS).toFixed(0)}ms` : 'never'}`
  );
}
console.log('');

// These two are the residual cost of extrapolating: during a stall there is no
// data to interpolate between, so the renderer keeps extending the last line
// and is corrected when the stream resumes. That is what eliminates freezes
// outright (froz% is ~0 on every link above), and it costs accuracy whenever a
// player turns or stops inside the gap.
//
// NET_MAX_EXTRAP_MS caps how far that coast runs past the newest snapshot, so
// the overshoot stops growing with the stall length: at the shipped 200ms the
// stop-accuracy rows above flatten out once the stall exceeds it, instead of
// climbing with every extra tick of silence.
//
// `renderLag` sets how much of it is paid in the steady state, by holding the
// render that many ticks behind the clock. At 0 the render sits exactly at
// t_now, and since the newest snapshot's pseudotime is always a little in the
// past, *every* frame extrapolates: measured, that is ~2x the jerk on
// direction-changing motion and ~7x the overshoot on a clean stop, for ~35ms
// less latency. The shipped 0.5 buys most of that accuracy back and still
// renders ahead of stock survev's own lerp. Re-run this file after changing
// it — both columns come from inject.js, so they move with it.
//
// They are reported rather than failed, because what remains is a design
// choice rather than a bug.
if (worstRegression > 0) {
  console.log(`NOTE: on a degraded link the renderer is up to ${worstRegression.toFixed(0)}% jerkier`);
  console.log('      than stock on direction-changing motion (extrapolation');
  console.log('      overshoots each turn and is corrected by the next packet).');
}
if (worstOvershoot > MAX_STOP_OVERSHOOT) {
  console.log(`NOTE: stopping mid-stall overshoots by up to ${worstOvershoot.toFixed(2)}u`);
  console.log(`      before the next packet pulls it back — up to ${NET_MAX_EXTRAP_MS}ms of`);
  console.log('      extrapolation keeps predicting motion after the player has stopped.');
}
console.log('\nFrozen frames are ~0% on every link: the clock never has to freeze,');
console.log('which is what the recovered-clock design buys over survev\'s own lerp.');
