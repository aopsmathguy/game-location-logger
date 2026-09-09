'use strict';

// Keeps core/mangled.js current with whatever build of survev the browser is
// actually being served.
//
// survev re-mangles its bundle on every deploy, and the bundle filenames are
// content-hashed, so a deploy is visible as a change in the /js/ references of
// the HTML we proxy. We see that HTML on every page load, before the browser
// has asked for anything else — which makes the proxy the one place that can
// notice a redeploy at exactly the moment it starts to matter, and fix it
// before the page it is about to break.
//
// The timing works because of what the injected scripts are. They are classic
// blocking scripts at the top of <head> (see INJECTED_HTML in server.js), so
// the browser stops there and waits. Detection happens while the HTML is
// already streaming out — too late for that response — but the very next
// request is /__ext/mangled.js, and holding *that* stalls page startup at a
// point where nothing has run yet. So the page does not reload, does not flash
// a stale overlay, and does not run one frame of game code against a
// dictionary of names that no longer exist. It just takes longer to load, once.
//
// Failure is expected and must not cascade. derive_mangled.py exits non-zero
// when an anchor stops matching, which means survev changed the *shape* of the
// bundle and a human has to write a new regex. Retrying that on every page
// load would spawn a doomed 30-second Python run per request, so a failed
// build hash is remembered and not attempted again.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DIR = path.resolve(__dirname, '..', '..');
const JS_DUMP_DIR = path.join(REPO_DIR, 'js_dump');
const TOOLS_DIR = path.join(REPO_DIR, 'tools');

const PYTHON = process.env.PYTHON || 'python3';
const ENABLED = process.env.REGEN !== 'off';
// Generous: a cold run downloads ~2.5MB of bundle and pushes 1.4MB of it
// through jsbeautifier, which is the slow half.
const TIMEOUT_MS = Number(process.env.REGEN_TIMEOUT_MS || 180000);

function log(...args) {
  console.log('[regen]', ...args);
}

// ---------------------------------------------------------------- detection

// Same shape derive_mangled.py and fetch_survev_js.py look for. Matches the
// src="..." form and bare occurrences alike, because survev references some
// bundles from inside other bundles.
const JS_REF = /["'(](\/js\/[^"')\s]+\.js)/g;
const JS_REF_BARE = /(\/js\/[A-Za-z0-9_-]+\.js)/g;

function bundlePathsInHtml(html) {
  const found = new Set();
  for (const m of html.matchAll(JS_REF)) found.add(m[1]);
  for (const m of html.matchAll(JS_REF_BARE)) found.add(m[1]);
  return [...found].sort();
}

// What js_dump/ holds right now, as /js/<name>.js paths. The _formatted.js
// siblings are derived, not downloaded, so they are not part of the identity
// of the cached build.
function bundlePathsOnDisk() {
  let names;
  try {
    names = fs.readdirSync(JS_DUMP_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.js') && !n.endsWith('_formatted.js'))
    .map((n) => `/js/${n}`)
    .sort();
}

// Staleness is "the page is loading a bundle we never derived against", not
// "the two lists differ". A leftover in js_dump/ from a previous build is
// harmless — derive_mangled.py picks the gameplay bundle by content, not by
// filename — whereas a referenced bundle that is absent means core/mangled.js
// was derived from something the player is no longer running.
function covered(wanted, onDisk) {
  const have = new Set(onDisk);
  return wanted.every((p) => have.has(p));
}

function sameBuild(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ------------------------------------------------------------------ running

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON,
      [path.join(TOOLS_DIR, script), ...args],
      { cwd: REPO_DIR, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message).trim().split('\n').slice(-6).join('\n');
          reject(new Error(`${script} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.on('error', reject);
  });
}

// --------------------------------------------------------------- the state

// Single-flight. Every page load that notices the same staleness attaches to
// the one run rather than starting another.
let inflight = null;
// Build we last tried and could not derive. Not retried: it needs a human.
let poisoned = null;
let lastError = null;
// Our own fetches write into the directory we are watching, and the watcher's
// debounce fires after the run has already finished — so an `inflight` check
// alone does not stop a server-initiated fetch from provoking a second,
// pointless derive of the files it just downloaded. Deafen the watcher for a
// moment afterwards instead.
let selfWriteUntil = 0;
const WATCH_DEBOUNCE_MS = 1500;
const WATCH_GRACE_MS = 5000;

async function regenerate(paths, { fetchFirst }) {
  if (fetchFirst) {
    log(`survev redeployed — fetching ${paths.length} bundle(s)`);
    await run('fetch_survev_js.py', ['--paths', ...paths]);
  }
  log('deriving mangled names');
  const out = await run('derive_mangled.py', []);
  const summary = out.split('\n').filter((l) => /No changes|->|Wrote/.test(l)).slice(-3);
  log('done.', summary.join(' | ') || 'ok');
}

function start(paths, opts) {
  inflight = regenerate(paths, opts)
    .then(() => {
      poisoned = null;
      lastError = null;
    })
    .catch((err) => {
      poisoned = paths;
      lastError = err.message;
      // Loud, because the toolkit is now running on a dictionary that does not
      // match the bundle: features will silently do nothing until this is fixed.
      log('FAILED — serving the last known-good mangled.js.');
      log(err.message);
      log('survev likely changed the bundle shape; an anchor in derive_mangled.py needs updating.');
    })
    .finally(() => {
      if (opts.fetchFirst) selfWriteUntil = Date.now() + WATCH_GRACE_MS;
      inflight = null;
    });
  return inflight;
}

// Called from the HTML hop with the bundle paths just seen in the page.
// Returns a promise when a run was started or is already going, else null.
function ensureFresh(html) {
  if (!ENABLED) return null;
  if (inflight) return inflight;

  const wanted = bundlePathsInHtml(html);
  if (!wanted.length) return null;
  if (covered(wanted, bundlePathsOnDisk())) return null;
  if (poisoned && sameBuild(wanted, poisoned)) return null;

  return start(wanted, { fetchFirst: true });
}

// Called from the js_dump/ watcher: the files changed underneath us (someone
// ran fetch_survev_js.py by hand), so re-derive without downloading anything.
function deriveOnly() {
  if (!ENABLED || inflight) return inflight;
  log('js_dump/ changed on disk — re-deriving');
  return start(bundlePathsOnDisk(), { fetchFirst: false });
}

// Called before serving /__ext/mangled.js. This is the stall that makes the
// whole thing safe: the browser is sitting on a blocking <script> in <head>,
// so waiting here delays page startup rather than corrupting it.
async function settle() {
  if (!inflight) return;
  await inflight;
}

// Manual kick from /__ext/regen. Clears the poisoned marker first: the reason
// to ask for this by hand is that you just fixed the anchor that failed, and
// the bundles it needs are already sitting in js_dump/.
function forceDerive() {
  poisoned = null;
  lastError = null;
  if (inflight) return inflight;
  log('forced re-derive requested');
  return start(bundlePathsOnDisk(), { fetchFirst: false });
}

// A debounced watcher, so a fetch writing eight files does not kick off eight
// derives, and one deaf to the writes our own fetches make.
function watchJsDump() {
  if (!ENABLED) return null;
  fs.mkdirSync(JS_DUMP_DIR, { recursive: true });
  let timer = null;
  try {
    return fs.watch(JS_DUMP_DIR, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (inflight || Date.now() < selfWriteUntil) return;
        deriveOnly();
      }, WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    log(`cannot watch ${JS_DUMP_DIR}: ${err.message}`);
    return null;
  }
}

function status() {
  return {
    enabled: ENABLED,
    running: Boolean(inflight),
    onDisk: bundlePathsOnDisk(),
    poisoned,
    lastError,
  };
}

module.exports = {
  ensureFresh,
  deriveOnly,
  forceDerive,
  settle,
  watchJsDump,
  status,
  bundlePathsInHtml,
  bundlePathsOnDisk,
  JS_DUMP_DIR,
};
