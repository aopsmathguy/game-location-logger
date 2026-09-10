// Offline test harness for the movement-speed model in inject.js.
//
//     node speed_sim.js
//
// `dodgeComputeSpeed` is a port of `Player.recalculateSpeed` from the survev
// server, and a port is a thing that is either exactly right or quietly wrong.
// Nothing in the game tells you which. The speed is never transmitted, so
// there is no field to check the answer against; a model that is 2 u/s fast
// looks like a bot that occasionally mistimes a dodge, which looks like every
// other reason a bot occasionally mistimes a dodge.
//
// The failure modes that matter are all orderings and precedences rather than
// arithmetic:
//
//   - the halving is applied to the accumulated total, last. Move it up one
//     term — before haste, say — and a hasted player firing reads 10.4
//     instead of 8.4, and only while both are true.
//   - `field_medic` adds its +1 *after* the halving it exempts you from, so
//     it is worth +1 and not +2.
//   - `tree_climbing` does not cancel the water penalty, it replaces it with
//     a bonus: +2, not 0, a 5 u/s swing from the naive reading.
//   - the base cases are exclusive and ordered. A downed player being revived
//     is 2, not 4, and not 4 - something.
//   - the clamp floor is 1, and it is reachable: downed and firing is 2 * 0.5.
//
// So this drives the shipped functions, pulled verbatim out of inject.js,
// against a second transcription of the server's own function written from
// `server/src/game/objects/player.ts` — and sweeps every combination of the
// states that feed it. The two implementations share no code. When they
// disagree, one of them has drifted from the server, and the sweep names the
// exact state it happened in.

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

function grabConst(name) {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
  if (!m) throw new Error(`could not find const ${name} in inject.js`);
  return Number(m[1]);
}

function grabBlock(name, close) {
  const start = src.indexOf(`\n  const ${name} = `);
  if (start < 0) throw new Error(`could not find const ${name} in inject.js`);
  const end = src.indexOf(`\n  ${close}\n`, start);
  if (end < 0) throw new Error(`could not find the end of const ${name}`);
  return src.slice(start, end + close.length + 4);
}

// ---- The shipped model --------------------------------------------------
//
// Everything it reaches outside itself is a mangled field name, so the stand-in
// is just the readable name. The shipped code never sees a literal — it goes
// through these the same way it goes through mangled.js in the browser.

const elg = eval(`(function () {
  const PLAYER_NET = 'netData';
  const PLAYER_LOC = 'localData';
  const PLAYER_ACT = 'action';
  const NET_WEAPON = 'activeWeapon';
  const NET_DOWNED = 'downed';
  const NET_ANIM = 'animType';
  const NET_ACTION = 'actionType';
  const NET_FROZEN = 'frozen';
  const NET_HASTE = 'hasteType';
  const NET_PERKS = 'perks';
  const LOC_BOOST = 'boost';
  const LOC_CURIDX = 'curWeapIdx';
  const LOC_SLOTS = 'weapons';
  const ANIM_MELEE = ${grabConst('ANIM_MELEE')};
  const ANIM_COOK = ${grabConst('ANIM_COOK')};
  const ACTION_USEITEM = ${grabConst('ACTION_USEITEM')};
  const ACTION_REVIVE = ${grabConst('ACTION_REVIVE')};
  const HASTE_NONE = ${grabConst('HASTE_NONE')};
  ${grabBlock('SPEED_CFG', '};')}
  const SPEED_SHOT_HALVING = ${grabConst('SPEED_SHOT_HALVING')};
  ${grabBlock('WEAPON_EQUIP_SPEED', '};')}
  ${grabBlock('WEAPON_ATTACK_SPEED', '};')}
  ${grabBlock('WEAPON_FIRE_DELAY', '};')}
  // Only the four fields the speed model touches. The real one carries the
  // planner's whole world.
  const dodgeState = { speed: 0, speedWhy: '', shotUntil: 0, shotWeapon: '' };
  ${extract('getCurrentWeapon')}
  ${extract('speedTerm')}
  ${extract('dodgeHasPerk')}
  ${extract('dodgeIsOnWater')}
  ${extract('dodgeNoteOwnShot')}
  ${extract('dodgeComputeSpeed')}
  return { dodgeComputeSpeed, dodgeNoteOwnShot, dodgeState,
           SPEED_CFG, WEAPON_FIRE_DELAY, WEAPON_EQUIP_SPEED, WEAPON_ATTACK_SPEED };
})()`);

// ---- The server, transcribed --------------------------------------------
//
// `Player.recalculateSpeed`, in the server's own terms and its own order,
// written from the source rather than from the port. The one thing not
// transcribed is the final `if (!moving) speed = 0` in the caller, which the
// port deliberately omits — see the comment on dodgeComputeSpeed.

const Action = { None: 0, Reload: 1, ReloadAlt: 2, UseItem: 3, Revive: 4 };
const Anim = { None: 0, Melee: 1, Cook: 2, Throw: 3 };
const HasteType = { None: 0, Windwalk: 1, Takedown: 2, Inspire: 3 };

// GameObjectDefs, for the weapons the sweep uses. Transcribed independently
// from the definitions bundle so that a wrong number in inject.js's tables is
// a failure here and not a shared assumption. `attack: undefined` is the
// distinction the server makes with `speed.attack !== undefined` — the melee
// defs declare `speed: { equip: 1 }` and nothing else.
const DEFS = {
  fists:       { type: 'melee', equip: 1,    attack: undefined },
  knuckles:    { type: 'melee', equip: 1,    attack: 0,  },
  mp5:         { type: 'gun',   equip: 0,    attack: 0,    fireDelay: 0.09 },
  m249:        { type: 'gun',   equip: 0,    attack: -4,   fireDelay: 0.08 },
  barrett:     { type: 'gun',   equip: -1,   attack: -4,   fireDelay: 0.925 },
  scout_elite: { type: 'gun',   equip: 0,    attack: 5,    fireDelay: 1 },
  potato_lmg:  { type: 'gun',   equip: -1.5, attack: -6,   fireDelay: 0.07 },
  m870:        { type: 'gun',   equip: 0,    attack: 0,    fireDelay: 0.9 },
};

function serverSpeed(p) {
  let speed;
  if (p.actionType === Action.Revive) {
    if (p.actionTargetId && !(p.downed && p.perks.includes('self_revive'))) {
      speed = 4 + 2;                       // downedMoveSpeed + 2
    } else {
      speed = 2;                           // downedRezMoveSpeed
    }
  } else if (p.downed) {
    speed = 4;                             // downedMoveSpeed
  } else {
    speed = 12;                            // moveSpeed
  }

  const def = DEFS[p.activeWeapon];
  if (!p.meleeAttacking) {
    let equipSpeed = def.equip;
    if (p.perks.includes('small_arms') && def.type === 'gun') equipSpeed = 1;
    speed += equipSpeed;
  }
  if (p.shotSlowdown && def.attack !== undefined) speed += def.attack;
  if (p.onWater) speed -= p.perks.includes('tree_climbing') ? -2 : 3;
  if (p.boost >= 50) speed += 1.85;
  if (p.animType === Anim.Cook) speed -= 3;
  if (p.hasteType !== HasteType.None) speed += 4.8;
  if (p.frozen) speed -= 3;

  const hasFieldMedic = p.perks.includes('field_medic');
  if (p.shotSlowdown || (!hasFieldMedic && p.actionType === Action.UseItem)) {
    speed *= 0.5;
  }
  if (hasFieldMedic && p.actionType === Action.UseItem) speed += 1;

  return Math.min(10000, Math.max(1, speed));
}

// ---- Driving the shipped model ------------------------------------------
//
// One player state, expressed twice: as the flat record the transcription
// takes, and as the object graph the client actually holds.

function shippedSpeed(p) {
  const me = {
    netData: {
      activeWeapon: p.activeWeapon,
      downed: p.downed,
      animType: p.animType,
      actionType: p.actionType,
      frozen: p.frozen,
      hasteType: p.hasteType,
      perks: p.perks.map((type) => ({ type })),
    },
    localData: { boost: p.boost, curWeapIdx: 0, weapons: [] },
    action: { targetId: p.actionTargetId },
    // The client fills this every frame from the ground it is drawing us on.
    surface: { type: p.onWater ? 'water' : 'grass' },
  };
  // The shot timer is wall-clock rather than a flag, so it is set far enough
  // ahead that nothing in a test tick can expire it. Its own timing is tested
  // separately, below.
  elg.dodgeState.shotUntil = p.shotSlowdown ? performance.now() + 60000 : 0;
  elg.dodgeState.shotWeapon = p.shotSlowdown ? p.activeWeapon : '';
  return elg.dodgeComputeSpeed(me);
}

// ---- Checks -------------------------------------------------------------

const results = [];
let checks = 0;
let failures = 0;

function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  results.push({ name, pass, detail });
}

function near(a, b) { return Math.abs(a - b) < 1e-9; }

// The full sweep. Every state that feeds the formula, crossed with every
// other, against a weapon set chosen to exercise each shape of def: no
// modifier at all, an attack penalty, both modifiers at once, a positive
// attack modifier, a melee with no `attack` key, and the slowest gun in the
// game.
{
  const weapons = Object.keys(DEFS);
  const perkSets = [
    [], ['small_arms'], ['field_medic'], ['tree_climbing'],
    ['self_revive'], ['field_medic', 'small_arms'],
  ];
  let cases = 0;
  let worst = null;

  for (const activeWeapon of weapons) {
    for (const perks of perkSets) {
      for (const downed of [false, true]) {
        for (const actionType of [Action.None, Action.UseItem, Action.Revive]) {
          for (const actionTargetId of [0, 77]) {
            for (const animType of [Anim.None, Anim.Melee, Anim.Cook]) {
              for (const onWater of [false, true]) {
                for (const boost of [0, 49, 50, 100]) {
                  for (const hasteType of [HasteType.None, HasteType.Inspire]) {
                    for (const frozen of [false, true]) {
                      for (const shotSlowdown of [false, true]) {
                        const p = {
                          activeWeapon, perks, downed, actionType, actionTargetId,
                          animType, onWater, boost, hasteType, frozen, shotSlowdown,
                          // The one input the port infers rather than reads:
                          // the server's melee-swing queue is not on the wire,
                          // and Anim.Melee is what stands in for it.
                          meleeAttacking: animType === Anim.Melee,
                        };
                        cases++;
                        const want = serverSpeed(p);
                        const got = shippedSpeed(p);
                        if (!near(want, got) && !worst) {
                          worst = { p, want, got };
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  ok('sweep: every state agrees with the server transcription',
     worst === null,
     worst
       ? `${JSON.stringify(worst.p)} -> server ${worst.want}, port ${worst.got}`
       : `${cases.toLocaleString()} states, no disagreement`);
}

// The cases worth naming, because each one is a specific way to get the
// ordering wrong. Values computed by hand from the server source.
{
  const base = {
    activeWeapon: 'mp5', perks: [], downed: false, actionType: Action.None,
    actionTargetId: 0, animType: Anim.None, onWater: false, boost: 0,
    hasteType: HasteType.None, frozen: false, shotSlowdown: false,
    meleeAttacking: false,
  };
  const at = (over) => shippedSpeed({ ...base, ...over });

  ok('plain: nothing happening is the GameConfig figure',
     near(at({}), 12), '12 u/s');

  ok('water: wading is 9, not 12',
     near(at({ onWater: true }), 9), '12 - 3');

  ok('water: tree_climbing makes it 14, not 12',
     near(at({ onWater: true, perks: ['tree_climbing'] }), 14),
     'the penalty is replaced by a +2 bonus, not cancelled');

  ok('firing: an M249 is a third of the advertised speed',
     near(at({ activeWeapon: 'm249', shotSlowdown: true }), 4),
     '(12 - 4) / 2 = 4 u/s, for 80ms after every round');

  ok('firing: an ordinary gun is halved with no attack term',
     near(at({ shotSlowdown: true }), 6), '12 / 2');

  ok('firing: scout_elite is the one gun that speeds you up',
     near(at({ activeWeapon: 'scout_elite', shotSlowdown: true }), 8.5),
     '(12 + 5) / 2, still slower than standing');

  ok('healing: using an item halves you',
     near(at({ actionType: Action.UseItem }), 6), '12 / 2');

  ok('healing: field_medic adds after the halving it exempts you from',
     near(at({ actionType: Action.UseItem, perks: ['field_medic'] }), 13),
     '12 + 1, not (12 + 1) / 2 and not 12 / 2 + 1');

  ok('haste: the bonus lands before the halving',
     near(at({ hasteType: HasteType.Inspire, shotSlowdown: true }), 8.4),
     '(12 + 4.8) / 2 — moving it after would read 10.4');

  ok('adren: the step is at 50, not at any boost at all',
     near(at({ boost: 49 }), 12) && near(at({ boost: 50 }), 13.85),
     '49 -> 12.00, 50 -> 13.85');

  ok('downed: crawling is 4',
     near(at({ downed: true }), 4), 'downedMoveSpeed');

  ok('downed: being revived is 2, and the base cases are exclusive',
     near(at({ downed: true, actionType: Action.Revive }), 2),
     'downedRezMoveSpeed, not downedMoveSpeed adjusted');

  ok('reviving: holding the syringe is 6',
     near(at({ actionType: Action.Revive, actionTargetId: 77 }), 6),
     'downedMoveSpeed + 2');

  ok('reviving: self_revive makes you the patient, not the medic',
     near(at({ downed: true, actionType: Action.Revive, actionTargetId: 77,
               perks: ['self_revive'] }), 2),
     'a target of our own does not promote us to 6');

  ok('clamp: the floor is 1 and it is reachable',
     near(at({ downed: true, activeWeapon: 'm249', shotSlowdown: true }), 1),
     'downed 4 - 4 = 0, halved, clamped up to 1');

  ok('perks: small_arms overrides the gun\'s own equip modifier',
     near(at({ activeWeapon: 'potato_lmg', perks: ['small_arms'] }), 13),
     '12 + 1 rather than 12 - 1.5');

  ok('perks: small_arms does not touch a melee',
     near(at({ activeWeapon: 'knuckles', perks: ['small_arms'] }), 13),
     'the knuckles\' own +1, which happens to agree');

  ok('melee: a swing costs the equip bonus',
     near(at({ activeWeapon: 'fists', animType: Anim.Melee }), 12)
       && near(at({ activeWeapon: 'fists' }), 13),
     'fists are 13 idle, 12 mid-swing');

  ok('stacking: everything at once composes in the server\'s order',
     near(at({ activeWeapon: 'barrett', onWater: true, boost: 100,
               hasteType: HasteType.Inspire, frozen: true, shotSlowdown: true }),
          3.825),
     '(12 - 1 - 4 - 3 + 1.85 + 4.8 - 3) / 2 = 3.825');
}

// The shot timer is the one input reconstructed locally rather than read, so
// its own behaviour — how long it runs, and what cancels it — is not covered
// by the sweep above, which only ever sets it to "on" or "off".
{
  const me = {
    netData: { activeWeapon: 'm249', downed: false, animType: 0, actionType: 0,
               frozen: false, hasteType: 0, perks: [] },
    localData: { boost: 0, curWeapIdx: 0, weapons: [] },
    action: { targetId: 0 },
    surface: { type: 'grass' },
  };

  elg.dodgeState.shotUntil = 0;
  elg.dodgeState.shotWeapon = '';
  elg.dodgeNoteOwnShot('m249');
  const left = (elg.dodgeState.shotUntil - performance.now()) / 1000;
  ok('shot timer: a round starts it at the gun\'s fireDelay',
     Math.abs(left - 0.08) < 0.02 && near(elg.dodgeComputeSpeed(me), 4),
     `${left.toFixed(3)}s left, reading 4.00 u/s`);

  // The server zeroes shotSlowdownTimer when the weapon changes, so a switch
  // out of a fired gun must not leave us planning at half speed.
  me.netData.activeWeapon = 'mp5';
  ok('shot timer: switching weapons cancels it',
     near(elg.dodgeComputeSpeed(me), 12),
     'back to 12 immediately, not after the M249\'s 80ms');

  // And an expired timer stops applying without anything having to clear it.
  me.netData.activeWeapon = 'm249';
  elg.dodgeNoteOwnShot('m249');
  elg.dodgeState.shotUntil = performance.now() - 1;
  ok('shot timer: it expires on its own',
     near(elg.dodgeComputeSpeed(me), 12), 'reads 12 once the delay is past');

  ok('shot timer: a weapon with no fireDelay never starts one',
     (() => {
       elg.dodgeState.shotUntil = 0;
       elg.dodgeState.shotWeapon = '';
       elg.dodgeNoteOwnShot('fists');
       return elg.dodgeState.shotUntil === 0;
     })(),
     'melees and throwables do not set the server\'s timer either');
}

// The tables are lifted out of the definitions bundle by hand, which is the
// step with nothing checking it. These are the entries the sweep's own
// reference table declares independently.
{
  let bad = null;
  for (const [name, def] of Object.entries(DEFS)) {
    const equip = elg.WEAPON_EQUIP_SPEED[name] ?? 0;
    const attack = elg.WEAPON_ATTACK_SPEED[name] ?? 0;
    const delay = elg.WEAPON_FIRE_DELAY[name];
    if (!near(equip, def.equip)) bad = `${name} equip ${equip} vs ${def.equip}`;
    else if (!near(attack, def.attack ?? 0)) bad = `${name} attack ${attack} vs ${def.attack}`;
    else if (def.type === 'gun' && !near(delay, def.fireDelay)) bad = `${name} fireDelay ${delay} vs ${def.fireDelay}`;
    else if (def.type !== 'gun' && delay !== undefined) bad = `${name} is a melee with a fireDelay`;
    if (bad) break;
  }
  ok('tables: the shipped weapon numbers match the defs',
     bad === null, bad || `${Object.keys(DEFS).length} defs cross-checked`);
}

// ---- Report -------------------------------------------------------------

console.log('Checking inject.js\'s speed model against a transcription of the server\'s.\n');
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(width)}${r.detail ? '   ' + r.detail : ''}`);
}
console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
