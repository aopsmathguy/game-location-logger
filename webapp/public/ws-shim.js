// Optionally routes the page's WebSocket connections back through this proxy.
//
// Off by default — see WS_MODE in server.js. With the default `direct` mode
// this file returns immediately and the page's sockets behave exactly as they
// do on survev.io: the browser dials each regional game server itself, and
// the proxy never sees a single game frame. That is the closest match to the
// real site, and it is what you want unless you have a reason to inspect the
// traffic.
//
// survev opens three kinds of socket:
//   - `wss://<host>/team_v2` — same-origin, built from window.location.host.
//     Always reaches the proxy and is forwarded there by path; the client has
//     no way to name any other host for it, so this shim leaves it alone in
//     both modes.
//   - `wss://<gameserver>/play?...` — absolute URLs handed back by
//     /api/find_game_v2, on whichever regional server won.
//   - `ws(s)://<region-host>/ptc` — the region latency probes.
//
// Under WS_MODE=proxy the last two get rewritten to /__ws?target=<url> so the
// server can splice them, which is useful for watching the wire but puts an
// extra hop under the game's tick.
//
// When it does run, it runs before survev's bundles (the server injects it as
// the first script in <head>, and survev's own scripts are deferred modules),
// so every socket the game ever constructs goes through the patched
// constructor.
(() => {
  const cfg = window.__SURVEV_PROXY__ || {};
  if (cfg.wsMode !== 'proxy') return;

  const Native = window.WebSocket;
  const WS_PATH = '/__ws';

  function rewrite(input) {
    let url;
    try {
      // Relative WebSocket URLs are legal and resolve against the document.
      url = new URL(String(input), location.href);
    } catch {
      return input;
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return input;
    // Already ours: same-origin sockets are proxied server-side by path, and
    // /__ws must never be wrapped in a second layer of itself.
    if (url.host === location.host) return input;

    const proxy = new URL(WS_PATH, location.href);
    proxy.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    proxy.search = '';
    proxy.searchParams.set('target', url.toString());
    return proxy.toString();
  }

  // A Proxy rather than a subclass so that everything the page can observe
  // about the constructor is unchanged: `WebSocket.OPEN` and friends still
  // read through, `instanceof` still matches (the trap builds a real native
  // socket), and `WebSocket.name`/`length` are untouched.
  window.WebSocket = new Proxy(Native, {
    construct(target, args, newTarget) {
      if (args.length) args = [rewrite(args[0]), ...args.slice(1)];
      return Reflect.construct(target, args, newTarget);
    },
  });
})();
