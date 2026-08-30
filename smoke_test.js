// Loads mangled.js + inject.js for each supported hostname under minimal DOM
// stubs and checks the IIFE runs all the way to the end.
//
//     node smoke_test.js
//
// `node --check` only parses; it cannot see a temporal-dead-zone reference, a
// read of a dictionary group that isn't there, or anything else that throws
// during module evaluation. Any of those aborts inject.js before it defines a
// single global, which in the browser looks identical to the extension never
// having loaded — no output at all, on any channel. This catches that class
// of failure, and asserts an unsupported host aborts cleanly with exactly one
// console.error rather than throwing.
//
// It does NOT stub the game, so appCaptured/gameCaptured are expected false;
// what's under test is that the file evaluates, not that it finds a match.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = __dirname;

function makeEl() {
  const el = {
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){return false} },
    children: [], attributes: {},
    appendChild(c){ this.children.push(c); return c; }, removeChild(){}, remove(){},
    setAttribute(k,v){ this.attributes[k]=v; }, getAttribute(k){ return this.attributes[k]; },
    addEventListener(){}, removeEventListener(){}, insertBefore(c){ this.children.push(c); return c; },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    getBoundingClientRect(){ return {left:0,top:0,width:800,height:600,right:800,bottom:600}; },
    getContext(){ return new Proxy({}, { get: () => () => ({}) }); },
    focus(){}, blur(){}, click(){}, contains(){ return false; },
  };
  return new Proxy(el, {
    get: (t,k) => (k in t ? t[k] : (typeof k === 'string' ? undefined : undefined)),
    set: (t,k,v) => { t[k]=v; return true; },
  });
}

function run(hostname) {
  const doc = {
    readyState: 'loading',
    documentElement: makeEl(), head: makeEl(), body: makeEl(),
    createElement: () => makeEl(), createElementNS: () => makeEl(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  };
  const errors = [];
  const g = {
    location: { hostname, href: `https://${hostname}/`, origin: `https://${hostname}` },
    document: doc, navigator: { userAgent: 'node', clipboard: {} },
    performance: { now: () => Date.now() },
    setTimeout: () => 0, clearTimeout(){}, setInterval: () => 0, clearInterval(){},
    requestAnimationFrame: () => 0, cancelAnimationFrame(){},
    console: { log(){}, warn(){}, info(){}, debug(){}, error: (...a) => errors.push(a.join(' ')) },
    JSON, Math, Date, Object, Array, String, Number, Boolean, Map, Set, WeakMap, WeakSet,
    Promise, Symbol, Error, TypeError, RangeError, Proxy, Reflect, isNaN, isFinite,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent, fetch: () => Promise.resolve({}),
    CanvasRenderingContext2D: function(){}, Image: function(){ return makeEl(); },
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  };
  g.window = g; g.self = g; g.globalThis = g; g.top = g; g.parent = g;
  g.postMessage = () => {}; g.addEventListener = () => {}; g.removeEventListener = () => {};
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  vm.createContext(g);

  const out = { host: hostname, mangled: null, injected: false, error: null, consoleErrors: errors };
  try {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'mangled.js'), 'utf8'), g, { filename: 'mangled.js' });
    out.mangled = g.window.__SURVEV_MANGLED_SITE__;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8'), g, { filename: 'inject.js' });
    // The tail of the IIFE defines these; their presence proves it ran through.
    out.injected = typeof g.window.__captureDiag === 'function';
    out.diag = out.injected ? g.window.__captureDiag() : null;
  } catch (e) {
    out.error = `${e.name}: ${e.message}` + (e.stack ? '\n      ' + e.stack.split('\n')[1].trim() : '');
  }
  return out;
}

let bad = 0;
for (const host of ['survev.io', 'surviv.io']) {
  const r = run(host);
  const ok = r.mangled === host && r.injected && !r.error;
  if (!ok) bad++;
  console.log(`${host.padEnd(14)} dict=${String(r.mangled).padEnd(13)} ranToEnd=${String(r.injected).padEnd(5)} ${ok ? 'OK' : 'FAIL'}`);
  if (r.error) console.log(`   threw: ${r.error}`);
  if (r.consoleErrors.length) console.log(`   console.error: ${r.consoleErrors.join(' | ').slice(0, 200)}`);
  if (r.diag) console.log(`   captureDiag: appCaptured=${r.diag.appCaptured} gameCaptured=${r.diag.gameCaptured} bindHook.installed=${r.diag.bindHook.installed}`);
}
// An unmatched host must abort cleanly, not throw.
const un = run('example.com');
const unOk = un.mangled === null && !un.injected && !un.error && un.consoleErrors.length === 1;
console.log(`${'example.com'.padEnd(14)} dict=null       aborted cleanly=${!un.error && !un.injected} ${unOk ? 'OK' : 'FAIL'}`);
if (!unOk) { bad++; console.log('   ', un.error || JSON.stringify(un.consoleErrors)); }
console.log(bad === 0 ? '\nAll sites execute to completion.' : `\n${bad} FAILURE(S)`);
process.exit(bad ? 1 : 0);
