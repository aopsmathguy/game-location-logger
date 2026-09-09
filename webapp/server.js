#!/usr/bin/env node
'use strict';

// Reverse proxy that mirrors survev.io with the enemy-location-logger
// extension already loaded.
//
// Everything the browser asks for — HTML, JS bundles, images, audio, /api/*,
// WebSockets — is fetched from survev and handed back unchanged, except that
// HTML documents get the extension's scripts spliced into the top of <head>.
// Those are the two MAIN-world content scripts from manifest.json, and
// loading them as ordinary blocking scripts reproduces the extension's
// `run_at: document_start` timing: survev ships its bundles as deferred
// modules, so a classic script in <head> always finishes first.
//
// Game sockets are dialled straight from the browser (WS_MODE=direct, the
// default): the page connects to the regional game server itself, exactly as
// it would on survev.io, and this proxy never sees that traffic. WS_MODE=proxy
// routes them through /__ws instead. The team-lobby socket is same-origin
// either way — the client builds its URL from window.location.host — so it is
// always forwarded here by path.
//
// Two upstreams, because survev is two hosts. The static client comes off
// survev.io; every /api/ call and the team-lobby socket go to api.survev.io.
// The client picks that API host itself, from a table in the bundle keyed by
// a *substring* match on window.location.hostname — and a hostname that
// matches nothing (localhost, say) falls through to a `default` entry
// pointing at an unrelated third-party backend. So the bundle's API base URLs
// are rewritten to this proxy's own origin on the way through, which keeps
// the client same-origin with us on any hostname and puts us back in the
// path for the calls that matter.
//
// Usage:  node server.js        (then open http://localhost:8080)
// Env:    PORT, HOST, UPSTREAM, API_UPSTREAM, WS_MODE=direct|proxy

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const regen = require('./lib/regen');

const PORT = Number(process.env.PORT || 8080);
const BIND = process.env.HOST || '127.0.0.1';
const SITE_UPSTREAM = process.env.UPSTREAM || 'survev.io';
const API_UPSTREAM = process.env.API_UPSTREAM || 'api.survev.io';
const WS_MODE = process.env.WS_MODE === 'proxy' ? 'proxy' : 'direct';

const REPO_DIR = path.resolve(__dirname, '..');
const CORE_DIR = path.join(REPO_DIR, 'core');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Explicit allowlist rather than a served directory. core/ holds only the two
// toolkit files today, but derive_mangled.py also drops a mangled.js.bak
// beside them, and nothing outside this map should be reachable over HTTP.
const EXT_FILES = new Map([
  ['ws-shim.js', path.join(PUBLIC_DIR, 'ws-shim.js')],
  ['mangled.js', path.join(CORE_DIR, 'mangled.js')],
  ['inject.js', path.join(CORE_DIR, 'inject.js')],
]);

const EXT_PREFIX = '/__ext/';
const WS_PREFIX = '/__ws';

// Injected in order: config first (the shim reads it), then the extension's
// own two files in the order the manifest lists them — inject.js bails out if
// mangled.js has not already defined window.__SURVEV_MANGLED__.
const INJECTED_HTML =
  `<script src="${EXT_PREFIX}config.js"></script>` +
  `<script src="${EXT_PREFIX}ws-shim.js"></script>` +
  `<script src="${EXT_PREFIX}mangled.js"></script>` +
  `<script src="${EXT_PREFIX}inject.js"></script>`;

// Absolute survev origins that appear inside HTML and JS. Every one is
// pointed back at this proxy so no page code reaches around us; the API hosts
// have to become absolute origins rather than relative paths because the
// bundle feeds them to `new URL(...)` to derive the team-socket host.
const REWRITTEN_ORIGINS = [
  `https://${API_UPSTREAM}`,
  `https://${SITE_UPSTREAM}`,
  `http://${SITE_UPSTREAM}`,
  // The `default` entry of the bundle's host table. Reached whenever the
  // page is served from a hostname that doesn't contain "survev.io" — i.e.
  // localhost, which is the normal way to run this.
  'https://surviv.mathsiscoolfun.com',
];

// Paths that belong to the API host rather than the static site.
function upstreamForPath(url) {
  const p = url.split('?')[0];
  return p.startsWith('/api/') || p === '/team_v2' ? API_UPSTREAM : SITE_UPSTREAM;
}

// Connection-level headers that describe *this* hop and must not be copied
// onto the next one.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// Dropped from upstream responses: survev's CSP names its own origins, so it
// would block the injected scripts and the proxied WebSocket endpoint, and
// the transport-security and framing headers describe a host that isn't us.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'strict-transport-security', 'x-frame-options', 'content-length',
  'content-encoding', 'report-to', 'nel',
]);

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function log(...args) {
  console.log('[proxy]', ...args);
}

// ---------------------------------------------------------------- extension

function serveExtFile(req, res) {
  const name = req.url.slice(EXT_PREFIX.length).split('?')[0];

  if (name === 'config.js') {
    // Read by ws-shim.js. Its own file rather than an inline script so that a
    // CSP we failed to strip would still not block it.
    const body = `window.__SURVEV_PROXY__=${JSON.stringify({ wsMode: WS_MODE, upstream: SITE_UPSTREAM })};`;
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }

  if (name === 'status.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(regen.status(), null, 2));
    return;
  }

  if (name === 'regen') {
    // Manual kick, for after you have fixed an anchor that derive_mangled.py
    // gave up on — the failed build is otherwise not retried.
    regen.forceDerive();
    res.writeHead(202, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('regenerating; watch the server log\n');
    return;
  }

  const file = EXT_FILES.get(name);
  if (!file) {
    res.writeHead(404).end('not found');
    return;
  }

  // mangled.js is the one file that can be mid-regeneration when it is asked
  // for, and the only one where serving a stale copy is actively harmful. The
  // browser is parked on a blocking <script> in <head> at this point, so
  // waiting here costs page-load time and nothing else. Every other file, and
  // a failed or disabled regeneration, falls straight through to the last
  // known-good copy on disk.
  const gate = name === 'mangled.js' ? regen.settle() : Promise.resolve();

  gate.then(() => {
    // no-store, so that editing inject.js and reloading the page is the whole
    // edit loop — the main reason to run the toolkit this way instead of as an
    // unpacked extension.
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(500).end(`cannot read ${name}: ${err.message}`);
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': buf.length,
      });
      res.end(buf);
    });
  });
}

// --------------------------------------------------------------- rewriting

function rewriteOrigins(text, selfOrigin) {
  let out = text;
  for (const origin of REWRITTEN_ORIGINS) out = out.split(origin).join(selfOrigin);
  return out;
}

function injectScripts(html) {
  const head = html.match(/<head[^>]*>/i) || html.match(/<html[^>]*>/i);
  if (!head) return INJECTED_HTML + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + INJECTED_HTML + html.slice(at);
}

function rewriteSetCookie(values, requestIsSecure) {
  return values.map((cookie) => {
    const parts = cookie.split(';').filter((part) => {
      const name = part.trim().split('=')[0].toLowerCase();
      // Domain=survev.io would make the browser reject the cookie outright on
      // our host; dropping the attribute makes it a host cookie for us.
      if (name === 'domain') return false;
      // Secure cookies are silently discarded over plain http://localhost.
      if (name === 'secure' && !requestIsSecure) return false;
      return true;
    });
    // SameSite=None is only honoured alongside Secure, so downgrade it when
    // Secure has just been stripped.
    if (!requestIsSecure) {
      return parts
        .map((p) => (/^\s*samesite\s*=\s*none\s*$/i.test(p) ? ' SameSite=Lax' : p))
        .join(';');
    }
    return parts.join(';');
  });
}

// ---------------------------------------------------------------- http hop

function proxyHttp(req, res) {
  const selfHost = req.headers.host || `${BIND}:${PORT}`;
  const requestIsSecure = req.headers['x-forwarded-proto'] === 'https';
  const selfOrigin = `${requestIsSecure ? 'https' : 'http'}://${selfHost}`;
  const upstreamHost = upstreamForPath(req.url);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key)) continue;
    headers[key] = value;
  }
  headers.host = upstreamHost;
  // Identity encoding across the whole proxy: HTML and JS have to be decoded
  // to be rewritten, and the content type isn't known until the response
  // arrives. Conditionally decompressing buys little on one extra hop.
  headers['accept-encoding'] = 'identity';
  // The API host expects calls from the survev origin, not from ours.
  if (headers.origin) headers.origin = `https://${SITE_UPSTREAM}`;
  if (headers.referer) headers.referer = headers.referer.split(selfOrigin).join(`https://${SITE_UPSTREAM}`);

  const upstream = https.request(
    {
      agent,
      host: upstreamHost,
      servername: upstreamHost,
      port: 443,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      const type = String(up.headers['content-type'] || '');
      const isHtml = type.includes('text/html');
      const isJs = type.includes('javascript') || type.includes('ecmascript');

      const out = {};
      for (const [key, value] of Object.entries(up.headers)) {
        if (HOP_BY_HOP.has(key) || STRIPPED_RESPONSE_HEADERS.has(key)) continue;
        out[key] = value;
      }
      if (up.headers['set-cookie']) {
        out['set-cookie'] = rewriteSetCookie(up.headers['set-cookie'], requestIsSecure);
      }
      if (out.location) out.location = rewriteOrigins(String(out.location), selfOrigin);

      if (!isHtml && !isJs) {
        // Images, audio, atlases, JSON: streamed straight through, so the
        // large assets never sit in memory. Game-server URLs inside the
        // /api/find_game_v2 JSON need no rewriting either — ws-shim.js
        // catches those in the browser, at the WebSocket constructor.
        if (up.headers['content-length']) out['content-length'] = up.headers['content-length'];
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
        return;
      }

      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let text = rewriteOrigins(raw, selfOrigin);
        if (isHtml) {
          // Against the unrewritten page: these are the bundle hashes survev
          // is serving right now, and a change in them is a redeploy. The run
          // this may start is picked up a moment later by the request for
          // /__ext/mangled.js, which waits for it.
          regen.ensureFresh(raw);
          text = injectScripts(text);
        }
        const body = Buffer.from(text, 'utf8');
        out['content-length'] = body.length;
        res.writeHead(up.statusCode || 502, out);
        res.end(body);
      });
      up.on('error', () => res.destroy());
    },
  );

  upstream.on('error', (err) => {
    log('upstream error', req.method, req.url, err.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream error: ${err.message}`);
  });

  req.pipe(upstream);
  req.on('error', () => upstream.destroy());
}

// ------------------------------------------------------------------ ws hop

function resolveWsTarget(req) {
  if (req.url === WS_PREFIX || req.url.startsWith(`${WS_PREFIX}?`)) {
    // Rewritten by ws-shim.js: an absolute socket URL on some other host,
    // typically the regional game server named by /api/find_game_v2.
    const target = new URL(req.url, 'http://placeholder').searchParams.get('target');
    if (!target) return null;
    const url = new URL(target);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    return url;
  }
  // Same-origin socket — survev's /team_v2 lobby. Forward it by path.
  return new URL(`wss://${upstreamForPath(req.url)}${req.url}`);
}

// Forwarded verbatim from the browser's handshake. The Sec-WebSocket-* values
// have to survive untouched: the client validates the upstream's
// Sec-WebSocket-Accept against the key it generated, and this proxy splices
// the two sockets rather than re-framing, so the 101 and every frame after it
// reach the browser exactly as the game server wrote them. Splicing also
// means permessage-deflate and the binary game protocol pass through with no
// interpretation, and nothing is added to the round trip.
const WS_FORWARD_HEADERS = [
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol',
  'sec-websocket-extensions', 'user-agent', 'accept-language',
];

function proxyWs(req, clientSocket, head) {
  let target;
  try {
    target = resolveWsTarget(req);
  } catch {
    target = null;
  }
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const secure = target.protocol === 'wss:';
  const port = Number(target.port) || (secure ? 443 : 80);
  const upstream = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname, ALPNProtocols: ['http/1.1'] })
    : net.connect({ host: target.hostname, port });

  const destroy = () => {
    upstream.destroy();
    clientSocket.destroy();
  };

  upstream.once(secure ? 'secureConnect' : 'connect', () => {
    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      // The real client always connects from the survev origin; a game server
      // that checks Origin should see what it expects.
      `Origin: https://${SITE_UPSTREAM}`,
    ];
    for (const name of WS_FORWARD_HEADERS) {
      const value = req.headers[name];
      if (value) lines.push(`${name}: ${value}`);
    }
    // Session cookies belong to survev — never leak them to whatever
    // third-party host a rewritten target happens to name.
    if (req.headers.cookie && (target.host === API_UPSTREAM || target.host === SITE_UPSTREAM)) {
      lines.push(`Cookie: ${req.headers.cookie}`);
    }

    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);

    clientSocket.setNoDelay(true);
    upstream.setNoDelay(true);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    log('ws upstream error', target.host, err.message);
    if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    destroy();
  });
  upstream.on('close', destroy);
  clientSocket.on('error', destroy);
  clientSocket.on('close', () => upstream.destroy());
}

// -------------------------------------------------------------------- serve

const server = http.createServer((req, res) => {
  if (req.url.startsWith(EXT_PREFIX)) {
    serveExtFile(req, res);
    return;
  }
  proxyHttp(req, res);
});

server.on('upgrade', proxyWs);
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

for (const [name, file] of EXT_FILES) {
  if (!fs.existsSync(file)) log(`WARNING: ${name} not found at ${file}`);
}

server.listen(PORT, BIND, () => {
  log(`mirroring https://${SITE_UPSTREAM} (api: ${API_UPSTREAM}) on http://${BIND}:${PORT}`);
  log(`websocket mode: ${WS_MODE}`);

  const { enabled, onDisk } = regen.status();
  if (!enabled) {
    log('mangled.js regeneration: off (REGEN=off)');
    return;
  }
  log(`mangled.js regeneration: on — ${onDisk.length} bundle(s) cached in js_dump/`);
  // Picks up a fetch_survev_js.py run started by hand, without a page load.
  regen.watchJsDump();
});
