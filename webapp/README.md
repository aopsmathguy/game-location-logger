# webapp — survev.io mirror with the toolkit preloaded

A reverse proxy that serves survev.io from your own origin with
`core/mangled.js` + `core/inject.js` already injected. Open it in any browser — no
extension install, no unpacked-extension reload, no Chrome-only requirement.
Everything the extension does in the MOD tab works exactly the same, because
it is the same two files, loaded at the same point in page startup.

```
cd webapp
npm start            # or: node server.js
open http://localhost:8080
```

No dependencies — Node 18+ and the standard library.

| Env var        | Default         | Meaning                                          |
| -------------- | --------------- | ------------------------------------------------ |
| `PORT`         | `8080`          | Listen port                                      |
| `HOST`         | `127.0.0.1`     | Bind address                                     |
| `UPSTREAM`     | `survev.io`     | Static-site host                                 |
| `API_UPSTREAM` | `api.survev.io` | API and team-lobby host                          |
| `WS_MODE`      | `direct`        | `proxy` routes game sockets through `/__ws` instead |

## How the mirror works

**Script injection.** HTML responses get four `<script>` tags spliced in
immediately after `<head>`: a generated config, `public/ws-shim.js`, and the
toolkit's own `core/mangled.js` and `core/inject.js` read straight off disk.
The manifest loads those last two as `world: "MAIN"`, `run_at:
"document_start"` content scripts; a classic blocking script at the top of
`<head>` reproduces that timing exactly, because survev ships its bundles as
deferred ES modules and every deferred module runs after every classic script.
The order matters too — `inject.js` aborts if `mangled.js` has not already
defined `window.__SURVEV_MANGLED__`.

They are served `no-store`, so editing `inject.js` and reloading the page is
the entire edit loop. That is the main reason to play here rather than
through the unpacked extension, where every change needs a trip to
`chrome://extensions`.

**Two upstreams.** survev is two hosts: the static client on `survev.io` and
the API plus team lobby on `api.survev.io`. Requests are routed by path —
`/api/*` and `/team_v2` to the API host, everything else to the site.

**The API host rewrite.** The client does not hardcode its API host; it looks
`window.location.hostname` up in a table inside the bundle, matched by
*substring*. A hostname matching nothing — `localhost`, for instance — falls
through to a `default` entry pointing at an unrelated third-party backend, so
an untouched mirror would quietly play on someone else's servers. The proxy
therefore rewrites every survev origin it finds in HTML and JS to its own,
which keeps the client same-origin with us whatever hostname you serve from,
and puts the proxy back in the path for the calls that matter. HTML and JS are
buffered to make that rewrite; images, audio, atlases and JSON stream through
untouched.

**WebSockets.** Three kinds, and by default only one of them touches the
proxy:

- `/team_v2`, the team lobby, is same-origin — the client builds its URL from
  `window.location.host`, so it has no way to name any other host. It always
  reaches the proxy and is forwarded by path to `api.survev.io`.
- Game servers come back from `/api/find_game_v2` as absolute URLs on
  arbitrary hosts and ports. The browser dials them itself.
- The regional `/ptc` latency probes, likewise.

So gameplay traffic goes browser → game server, exactly as on survev.io, with
nothing of ours under the game's tick. `public/ws-shim.js` no-ops in this
mode.

`WS_MODE=proxy` flips that: the shim patches the `WebSocket` constructor
before any page code runs and rewrites the absolute URLs to
`/__ws?target=<url>`, and the server splices the two TCP sockets rather than
re-framing — so the 101, `permessage-deflate` and every binary frame pass
through exactly as written, and no per-frame work is added. It forces HTTP/1.1
via ALPN, which the upgrade needs and which Cloudflare will not do over h2.
Useful for watching the wire, but it is still one more hop, and a game server
that objects to the shape of a spliced handshake will simply close the socket
— which the client reports as `host_closed`, its fallback for a close that
carried no reason at all.

## Limits

- **The login buttons need turning on.** The bundle's host table only carries
  the `google`/`discord` flags for survev.io itself; from localhost it falls
  back to the table's `default` entry, which has neither, so
  `loginSupported()` came back false — the account block was hidden and,
  because `anyLoginSupported()` also selects `credentials: 'omit'`, no
  session cookie was sent with any `/api/` call. The proxy now adds both
  flags to that entry, which renders the buttons and sends the cookie.
  `LOGIN_UI=off` restores the old behaviour.
- **Signing in takes one manual step.** Google and Discord will only redirect
  to `https://api.survev.io/api/auth/<provider>/callback` — that URI is
  registered to survev's OAuth client, and any other value is refused with
  `redirect_uri_mismatch`, so the proxy cannot put itself in the browser's
  return path. Sign-in therefore ends on the real API host and fails there.
  It fails on the state check, though, before the authorization code is
  spent: `/api/auth/<provider>` is proxied, so the `<provider>_oauth_state`
  and `<provider>_code_verifier` cookies it sets came back through
  `rewriteSetCookie` and are held against the mirror's origin, not
  survev.io's. This origin is therefore the one that can still spend the
  code. Copy the failed `api.survev.io/…/callback?…` URL out of the address
  bar and paste it into **`/__login`**, which re-issues that query against
  the proxied callback path with the cookies attached; upstream matches the
  state, exchanges the code, and returns a session cookie that
  `rewriteSetCookie` rewrites onto this host. Those two cookies carry
  `Max-Age=600`, so finish within ten minutes or start the sign-in again.
- **Cloudflare Turnstile** loads from `challenges.cloudflare.com` and is not
  proxied. If the upstream turns captcha on, it will be scored against a
  widget on an origin it does not expect.
- **Bind address.** The default `127.0.0.1` keeps the mirror on your machine.
  Anyone who can reach a wider bind gets the toolkit and shares your IP with
  the upstream — set `HOST` deliberately.
- **Serving over https** needs `WS_MODE=proxy`. The `/ptc` probes are plain
  `ws://` for some regions, and a browser blocks those from an https page;
  routed through the proxy they inherit the page's scheme.
- Response CSP, HSTS and framing headers are stripped, since they name
  survev's origins and would block the injected scripts.

## Files

| File                 | Role                                                            |
| -------------------- | --------------------------------------------------------------- |
| `server.js`          | The proxy: HTTP hop, script injection, origin rewriting, WS splice |
| `public/ws-shim.js`  | Page-world `WebSocket` constructor patch                          |
| `package.json`       | `npm start`; no dependencies                                      |

`core/mangled.js` and `core/inject.js` are **not** copied here — they are read
live from `core/`, the same files the extension loads through its `core`
symlink, so the mirror and the extension can never drift apart. After a survev
deploy re-mangles the bundle, re-run `tools/fetch_survev_js.py` and
`tools/derive_mangled.py` and just reload the page.
