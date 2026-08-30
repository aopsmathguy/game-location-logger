#!/usr/bin/env python3
"""Refresh mangled.js from the live client bundles of every supported site.

Two sites ship the same game from two different builds:

  survev.io     — open-source reimplementation, Rollup/Vite, class-field syntax
  surviv.io     — the original client, Webpack, `X.prototype = {...}` syntax

Two stages, run back to back by default, once per site:

  fetch  — download the site's HTML, follow every same-origin .js reference,
           save each bundle raw + prettified into js_dump/<site>/.
  derive — read js_dump/<site>/*_formatted.js, identify the gameplay bundle
           (the one containing the Player + Game classes), extract that
           build's mangled symbol names, and write them into mangled.js under
           the site's hostname.

Deriving anchors on STABLE READABLE patterns the builds keep un-mangled: real
TypeScript/JS field names like `bodySprite`, `onJoin`, `posInterpTicker`,
`gunSwitchCooldown`, `isBindDown`, `visualPosOld`, `activeCount`, plus the
server-protocol field names on update payloads (`e.pos`, `e.activeWeapon`,
`e.zoom`, ...).

The two builds diverge, so every anchor is a LIST of alternatives tried in
order — see ANCHORS below. Nothing in this file branches on which site is
being derived: a site is supported exactly when some alternative in each list
matches its bundle. When a new build breaks an entry, the fix is to add
another alternative to that entry's list, not to special-case a site.

If every alternative for an entry fails, the script aborts naming that entry
and the site it was deriving, and leaves the other sites' entries in
mangled.js untouched.

Usage:
    python update_mangled.py                       # every site: fetch, then derive
    python update_mangled.py --site surviv.io      # just one site
    python update_mangled.py --fetch-only          # download bundles only
    python update_mangled.py --derive-only         # re-derive from existing js_dump/
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from collections.abc import Callable
from pathlib import Path

try:
    import jsbeautifier
except ImportError:
    sys.exit("jsbeautifier not installed. Run: pip install jsbeautifier")

ROOT = Path(__file__).parent
JS_DUMP = ROOT / "js_dump"
MANGLED_JS = ROOT / "mangled.js"
BACKUP_JS = ROOT / "mangled.js.bak"

# Hostname -> origin to fetch. The hostname is also the key inject.js looks
# itself up by at runtime (see mangled.js), and the js_dump/ subdirectory name.
SITES: dict[str, str] = {
    "survev.io": "https://survev.io",
    "surviv.io": "https://surviv.io",
}
# Per-site policy that is NOT derived from the bundle — a standing decision
# about how the extension behaves on that site. Emitted verbatim into each site
# block by render_site_block(); re-deriving must never touch it.
#
#   antiDetect.webpackChunkHook
#       Install the webpack chunk hook that neutralises the client's
#       sprite-transparency check. Only surviv.io ships that check, and only
#       surviv.io is a webpack build with a chunk queue to hook.
#       See DISCONNECT_PREVENTION_PLAN.md section 1.
#
#   capture.protoTrap
#       Install Object.prototype setter traps for `seedNames` to capture the
#       Game. Needed where the Game class uses CLASS FIELDS (survev.io),
#       whose [[DefineOwnProperty]] never walks the prototype chain and so
#       cannot be caught any other way. surviv.io's bundle is
#       ES5-transpiled and its app singleton is already caught by the
#       Function.prototype.bind hook, so the trap buys nothing there — and it
#       costs `in`-operator semantics for every object on the page, which is
#       not something to run under an anti-cheat for no gain.
SITE_POLICY: dict[str, dict] = {
    "survev.io":    {"webpackChunkHook": False, "protoTrap": True},
    "surviv.io":    {"webpackChunkHook": True,  "protoTrap": False},
}

# A site with no entry gets the conservative default: no hook, trap on.
POLICY_DEFAULT = {"webpackChunkHook": False, "protoTrap": True}

USER_AGENT ="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# Mangled-identifier shape. The builds mangle to 2–8 char mixed-case
# identifiers, but we don't bound length — capture any plausible JS ident.
# (On surviv.io several of these fields aren't mangled at all and this matches
# the real name, e.g. `pos`, which is exactly what we want to record.)
IDENT = r"[A-Za-z_$][A-Za-z0-9_$]*"


class DeriveError(RuntimeError):
    pass


def dump_dir(site: str) -> Path:
    return JS_DUMP / site


# ---------------------------------------------------------------------------
# Stage 1: fetch
# ---------------------------------------------------------------------------
#
# Every site content-hashes its bundle filenames, so each deploy lands under a
# new name. Files from previous fetches are deleted once the current fetch has
# fully succeeded, leaving js_dump/<site>/ holding exactly one build —
# otherwise stale gameplay bundles accumulate and the derive stage has to guess
# which is current. Pass --keep-old to leave them alone.

# A site behind Cloudflare starts serving the JS "Just a moment..."
# interstitial instead of the page once a scripted client has made a burst of
# requests. It answers a browser fine, so this is a rate-limit to back off
# from, not a permanent block.
CHALLENGE_MARKERS = (b"Just a moment", b"cdn-cgi/challenge-platform", b"cf_chl_opt")
# Politeness gap between downloads. A site can ship a dozen-plus chunks and
# there is no hurry — a maintenance script that trips the bot check is worse
# than a slow one.
FETCH_DELAY_S = 0.3


class ChallengedError(DeriveError):
    """The host served a bot-check interstitial instead of the content."""


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        body = e.read()
        if e.code in (403, 429, 503) and any(m in body for m in CHALLENGE_MARKERS):
            raise ChallengedError(
                f"{urllib.parse.urlparse(url).netloc} served a Cloudflare bot check "
                f"(HTTP {e.code}) instead of {url}.\n"
                f"    This is rate limiting, not a permanent block — wait a few minutes and "
                f"re-run with --site {urllib.parse.urlparse(url).netloc}.\n"
                f"    To work around it now: open the site in a browser, save its /js/ "
                f"scripts into {dump_dir(urllib.parse.urlparse(url).netloc)}/ "
                f"(both `<name>.js` and a prettified `<name>_formatted.js`), then re-run "
                f"with --derive-only."
            ) from e
        raise
    if any(m in body[:4096] for m in CHALLENGE_MARKERS):
        raise ChallengedError(
            f"{urllib.parse.urlparse(url).netloc} returned a bot-check interstitial "
            f"for {url} — wait a few minutes and re-run."
        )
    return body


def strip_foreign_urls(html: str, host: str) -> str:
    """Blank out absolute URLs pointing at other hosts.

    The loose `/js/...` scan in find_script_urls would otherwise turn the path
    component of a third-party tag (`https://securepubads.g.doubleclick.net/
    tag/js/gpt.js` on surviv.io) into a same-origin URL that 404s, and a failed
    download suppresses the stale-file cleanup.
    """
    def repl(m: re.Match[str]) -> str:
        return m.group(0) if urllib.parse.urlparse(m.group(0)).netloc == host else " "

    return re.sub(r'https?://[^\s"\'<>)]+', repl, html)


def find_script_urls(html: str, base_url: str) -> list[str]:
    """Absolute URLs of every same-origin .js the page references.

    Covers both sites' reference styles: absolute (`/js/x.js`), relative
    (`js/app.<hash>.js` on surviv.io), from `src=` on a script tag or `href=`
    on a modulepreload link, and bare paths inside inline script. Off-origin scripts (ad tags, Kongregate's API,
    Cloudflare Turnstile) are dropped — none of them carry game code.
    """
    host = urllib.parse.urlparse(base_url).netloc
    scoped = strip_foreign_urls(html, host)

    refs: set[str] = set()
    refs.update(re.findall(r'(?:src|href)\s*=\s*["\']([^"\']+?\.js)(?:\?[^"\']*)?["\']', scoped, re.I))
    refs.update(re.findall(r'["\'(]((?:\.{0,2}/)?js/[^"\'()\s]+?\.js)\b', scoped))

    urls: set[str] = set()
    for ref in refs:
        parsed = urllib.parse.urlparse(urllib.parse.urljoin(base_url, ref))
        if parsed.scheme not in ("http", "https") or parsed.netloc != host:
            continue
        # Same-origin but never game code: Cloudflare proxies its bot-check
        # script under /cdn-cgi/.
        if parsed.path.startswith("/cdn-cgi/"):
            continue
        urls.add(parsed._replace(query="", fragment="").geturl())
    return sorted(urls)


def prettify(src: str) -> str:
    opts = jsbeautifier.default_options()
    opts.indent_size = 4
    opts.preserve_newlines = True
    return jsbeautifier.beautify(src, opts)


def prune_stale(out_dir: Path, keep: set[str]) -> None:
    """Delete .js files in out_dir that aren't part of the current fetch.

    Only .js files are considered, so anything else the user keeps alongside
    the dumps survives. Callers must only invoke this after a fully successful
    fetch — a partial one would make still-needed bundles look stale.
    """
    stale = sorted(p for p in out_dir.glob("*.js") if p.name not in keep)
    if not stale:
        return
    print(f"  removing {len(stale)} file(s) from previous fetches:")
    for p in stale:
        print(f"    - {p.name}")
        p.unlink()


def run_fetch(site: str, keep_old: bool) -> None:
    base_url = SITES[site]
    out_dir = dump_dir(site)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Fetching {base_url} ...")
    html = fetch(base_url).decode("utf-8", errors="replace")

    urls = find_script_urls(html, base_url)
    if not urls:
        raise DeriveError(f"no same-origin .js references found in {base_url} HTML")

    print(f"  found {len(urls)} script reference(s).")

    keep: set[str] = set()
    failed = 0

    for url in urls:
        filename = Path(urllib.parse.urlparse(url).path).name
        out_raw = out_dir / filename
        out_pretty = out_dir / (filename.removesuffix(".js") + "_formatted.js")

        print(f"  -> {url}")
        try:
            time.sleep(FETCH_DELAY_S)
            src = fetch(url).decode("utf-8", errors="replace")
        except ChallengedError:
            # Every remaining download will hit the same wall, and half a build
            # in js_dump/ is worse than none, so stop the site here.
            raise
        except Exception as e:
            print(f"     failed: {e}")
            failed += 1
            continue

        out_raw.write_text(src, encoding="utf-8")
        out_pretty.write_text(prettify(src), encoding="utf-8")
        keep.update((out_raw.name, out_pretty.name))

    # Never prune on an incomplete fetch: a bundle that failed to download this
    # run may still be present from the last one, and deleting it would leave
    # js_dump/<site>/ with no usable gameplay bundle at all.
    if not keep:
        raise DeriveError(f"no scripts downloaded — leaving {out_dir}/ untouched")
    if keep_old:
        print("  keeping previous fetches' files (--keep-old).")
    elif failed:
        print(f"  {failed} download(s) failed — skipping cleanup, previous files left in place.")
    else:
        prune_stale(out_dir, keep)

    print(f"  fetch done, output in {out_dir}/")


# ---------------------------------------------------------------------------
# Stage 2: derive — bundle selection
# ---------------------------------------------------------------------------

def find_gameplay_dump(site: str, preferred: str | None = None) -> tuple[Path, str]:
    """Return (path, contents) for the site's gameplay bundle.

    Each site ships several JS files (survev.io two, surviv.io three),
    only one of which holds the Player + Game classes.
    We pick it by looking for the Player class's un-mangled sprite-field
    declarations, which every build keeps under their real names.

    The fetch stage normally prunes previous fetches, so js_dump/<site>/ holds
    one build and exactly one file matches. It skips that cleanup after a
    partial fetch and when run with --keep-old, in which case several
    content-hashed gameplay bundles can match at once. We then take the most
    recently written one (the fetch just run) rather than making the caller
    hand-clean the directory. `preferred` (--bundle) overrides the choice.
    """
    out_dir = dump_dir(site)
    candidates = sorted(out_dir.glob("*_formatted.js"))
    if not candidates:
        raise DeriveError(f"no *_formatted.js in {out_dir}/ — run the fetch stage first")

    if preferred is not None:
        candidates = [p for p in candidates if p.name == preferred or p.stem == preferred]
        if not candidates:
            raise DeriveError(f"--bundle {preferred!r} matched nothing in {out_dir}/")

    matches: list[tuple[Path, str]] = []
    for path in candidates:
        text = path.read_text(encoding="utf-8", errors="replace")
        # All three names must coexist in the same file — they're all in the
        # Player class. If they're split across files, the bundle structure
        # changed enough that we need to rethink.
        if (
            re.search(r"\bbodySprite\s*=\s*\w+\(\)", text)
            and re.search(r"\bhelmetSprite\s*=\s*\w+\(\)", text)
            and re.search(r"\bmeleeSprite\s*=\s*\w+\(\)", text)
        ):
            matches.append((path, text))

    if not matches:
        raise DeriveError(
            f"no gameplay bundle found in {out_dir}/ — looked for files containing "
            "bodySprite/helmetSprite/meleeSprite Player-class declarations."
        )
    if len(matches) == 1:
        return matches[0]

    # Newest first; break equal mtimes by name only to keep the order stable.
    matches.sort(key=lambda pair: (-pair[0].stat().st_mtime, pair[0].name))
    newest_mtime = matches[0][0].stat().st_mtime
    tied = [p.name for p, _ in matches if p.stat().st_mtime == newest_mtime]
    if len(tied) > 1:
        # Same-mtime candidates can't be ordered (e.g. after a fresh clone or a
        # bulk copy), and guessing risks deriving against a stale build.
        raise DeriveError(
            f"multiple gameplay bundles share the newest timestamp ({', '.join(tied)}), "
            f"so the current one can't be identified. Delete the stale dumps from "
            f"{out_dir}/, or pick one explicitly with --bundle <name>."
        )

    skipped = ", ".join(p.name for p, _ in matches[1:])
    print(f"  note: {len(matches)} gameplay bundles — using newest, ignoring {skipped}")
    return matches[0]


# ---------------------------------------------------------------------------
# Match helpers
#
# Every anchor is a list of (pattern, group) alternatives. `first_of` takes the
# earliest alternative that matches at all — use it when the alternatives are
# ranked by how specific they are. `vote_of` pools the matches from ALL
# alternatives and requires a clear majority — use it when several independent
# shapes should agree on the same name, which is what catches a regex that has
# started matching the wrong thing.
# ---------------------------------------------------------------------------

# (pattern, capture group) or (pattern, capture group, start offset). The
# third element overrides the call-wide `start`, for the case where one
# alternative needs a different search window than its siblings — e.g. an
# anchor sitting in the entity classes next to one that must be scoped to the
# Game class.
Anchor = tuple


def _unpack(anchor: Anchor, default_start: int) -> tuple[str, int | str, int]:
    pattern, group = anchor[0], anchor[1]
    return pattern, group, anchor[2] if len(anchor) > 2 else default_start


def _matches(text: str, pattern: str, group: int | str, start: int) -> list[str]:
    return [m.group(group) for m in re.finditer(pattern, text[start:])]


def first_of(label: str, text: str, anchors: list[Anchor], start: int = 0) -> str:
    for anchor in anchors:
        found = _matches(text, *_unpack(anchor, start))
        if found:
            return found[0]
    listed = "\n".join(f"    {a[0]}" for a in anchors)
    raise DeriveError(
        f"anchor for {label!r} did not match. This build's structure isn't covered "
        f"by any known alternative — add one to update_mangled.py.\n"
        f"  tried {len(anchors)} pattern(s):\n{listed}"
    )


def vote_of(label: str, text: str, anchors: list[Anchor], start: int = 0, min_count: int = 2) -> str:
    values: list[str] = []
    for anchor in anchors:
        values.extend(_matches(text, *_unpack(anchor, start)))
    if not values:
        listed = "\n".join(f"    {a[0]}" for a in anchors)
        raise DeriveError(
            f"{label}: none of the {len(anchors)} anchors matched.\n{listed}"
        )
    counts = Counter(values)
    top = counts.most_common(2)
    winner, n = top[0]
    if n < min_count:
        raise DeriveError(
            f"{label}: top candidate {winner!r} only appeared {n}x (need >= {min_count}). "
            f"Distribution: {dict(counts)}"
        )
    if len(top) > 1 and top[1][1] == n:
        raise DeriveError(
            f"{label}: tie between {winner!r} and {top[1][0]!r} ({n}x each). "
            f"Distribution: {dict(counts)}"
        )
    return winner


# ---------------------------------------------------------------------------
# Class offsets
# ---------------------------------------------------------------------------

def player_class_start(text: str) -> int:
    """Byte offset of the Player class start, anchored on `bodySprite = ...`.

    Several other classes (Obstacle, Loot, Decal, DeadBody) use very similar
    interpolation setup code — and on some builds do so under fully READABLE
    names (`this.visualPos = lerp(t, this.visualPosOld, this.pos)`), which is
    exactly the shape some of the Player anchors below look for. Every
    Player-class anchor must therefore search from this offset, or it will pick
    up a sibling class's field instead.
    """
    m = re.search(r"\bbodySprite\s*=\s*\w+\(\)", text)
    if not m:
        raise DeriveError("could not locate Player class (bodySprite declaration)")
    return m.start()


def game_class_start(text: str) -> int:
    """Byte offset of the Game class start.

    `debugHUD` is a real readable Game field on the survev.io build. The
    original surviv.io client has no debug HUD at all, so we fall back to the
    `onJoin`/`onQuit` callback pair its constructor assigns — readable on both
    builds, and landing only a few hundred chars past the debugHUD
    anchor on the builds that have both.
    """
    for pattern in (
        r"\bdebugHUD\s*;",
        r"\bdebugHUD\s*=\s*new\s+\w+",
        rf"this\.onJoin\s*=\s*[a-z]\s*,\s*this\.onQuit\s*=\s*[a-z]",
    ):
        m = re.search(pattern, text)
        if m:
            return m.start()
    raise DeriveError("could not locate Game class (debugHUD / onJoin+onQuit anchors)")


# ---------------------------------------------------------------------------
# Anchors
#
# `<p>` below is a network-update parameter and `<f>` a snapshot flag; both are
# single-letter locals that rotate every build (`e`/`n` one build, `t`/`r` the
# next), so patterns match any letter and backreference rather than hardcoding.
# ---------------------------------------------------------------------------

def derive_net_data(text: str, player_start: int) -> str:
    """The Player.netData sub-object — everything the server sends about a
    player that everyone can see.

    Six independent shapes, majority-voted. The first three read the
    server-protocol field names straight off the update payload, which the
    survev.io build leaves readable; surviv.io mangles its payload fields
    too, so it is carried by the last three, which anchor on readable names on
    the Player side of the assignment instead (`this.downed`, the collider
    radius computed from `GameConfig.player.radius`, and the gun sprite pair).
    """
    return vote_of("player.netData", text, [
        (rf"this\.({IDENT})\.{IDENT}\s*=\s*[a-z]\.activeWeapon\b", 1),
        (rf"this\.({IDENT})\.{IDENT}\s*=\s*[a-z]\.dead\b", 1),
        (rf"this\.({IDENT})\.{IDENT}\s*=\s*[a-z]\.downed\b", 1),
        (rf"this\.downed\s*=\s*this\.({IDENT})\.{IDENT}\b", 1),
        (rf"this\.{IDENT}\s*=\s*this\.({IDENT})\.{IDENT}\s*\*\s*{IDENT}\.player\.radius", 1),
        (rf"this\.gunRSprites\.setType\(\s*this\.({IDENT})\.{IDENT}", 1),
    ], start=player_start, min_count=2)


def derive_local_data(text: str, player_start: int) -> str:
    """The Player.localData sub-object — the extra state the server sends only
    about you. Both builds leave this payload's field names readable."""
    return vote_of("player.localData", text, [
        (rf"this\.({IDENT})\.{IDENT}\s*=\s*[a-z]\.zoom\b", 1),
        (rf"this\.({IDENT})\.{IDENT}\s*=\s*[a-z]\.health\b", 1),
        (rf"this\.({IDENT})\.{IDENT}\s*=\s*[a-z]\.curWeapIdx\b", 1),
    ], start=player_start, min_count=2)


def derive_player_pos(text: str, player_start: int) -> str:
    """Player position — the authoritative value the renderer interpolates
    towards.

    Anchor 1 is survev.io's interpolation setup, keyed on the readable
    `posInterpTicker` reset and the readable `pos` field on the payload.
    Anchors 2 and 3 cover surviv.io, which doesn't mangle the Player's own
    `pos` at all and simply reads it next to the readable `posOld` /
    `visualPosOld` snapshots — both scoped past the Player class start, since
    the sibling entity classes have the identical readable shape.
    """
    return first_of("player.pos", text, [
        (rf"\.eq\((?P<p>[a-z])\.pos,\s*this\.{IDENT}\)\s*\|\|\s*"
         rf"\(this\.{IDENT}\s*=\s*\w+\.copy\([a-z]\s*\?\s*(?P=p)\.pos\s*:\s*this\.(?P<field>{IDENT})\)"
         rf"\s*,\s*this\.posInterpTicker\s*=\s*0", "field"),
        (rf"this\.posOld\s*=\s*{IDENT}\.copy\(this\.({IDENT})\)", 1),
        (rf"\.lerp\(\s*{IDENT}\s*,\s*this\.visualPosOld\s*,\s*this\.({IDENT})\s*\)", 1),
    ], start=player_start)


def derive_player_dir(text: str, player_start: int) -> str:
    """Player aim direction — same three shapes as `pos`, one field over."""
    return first_of("player.dir", text, [
        (rf"\.eq\((?P<p>[a-z])\.dir,\s*this\.{IDENT}\)\s*\|\|\s*"
         rf"\(this\.{IDENT}\s*=\s*\w+\.copy\([a-z]\s*\?\s*(?P=p)\.dir\s*:\s*this\.(?P<field>{IDENT})\)"
         rf"\s*,\s*this\.dirInterpolationTicker\s*=\s*0", "field"),
        (rf"this\.dirOld\s*=\s*{IDENT}\.copy\(this\.({IDENT})\)", 1),
        (rf"\.lerp\(\s*{IDENT}\s*,\s*this\.visualDirOld\s*,\s*this\.({IDENT})\s*\)", 1),
    ], start=player_start)


def derive_player_visual_vec(text: str, src_field: str, label: str, player_start: int) -> str:
    """Interpolated/rendered copy of a Player vector field (pos or dir), i.e.
    what the renderer actually draws from.

    Anchor 1 (preferred): the lerp in the render-update path:
        this.<visual> = <V>.lerp(<t>, this.<prev>, this.<src>)
    Anchor 2 (fallback): the interpolation-disabled branch:
        this.<visual> = <V>.copy(this.<src>)
    Scoped past the Player class start for the same sibling-class reason as
    derive_player_pos.
    """
    src_re = re.escape(src_field)
    return first_of(label, text, [
        (rf"this\.({IDENT})\s*=\s*\w+\.lerp\(\w+\s*,\s*this\.{IDENT}\s*,\s*this\.{src_re}\)", 1),
        (rf"this\.({IDENT})\s*=\s*\w+\.copy\(this\.{src_re}\)", 1),
    ], start=player_start)


def derive_net_field(text: str, net: str, label: str, anchors: list[Anchor], player_start: int) -> str:
    return first_of(label, text, anchors, start=player_start)


def derive_field_on(text: str, parent: str, readable: str, label: str, start: int = 0) -> str:
    """Find `this.<parent>.<X> = <p>.<readable>` and return X — the plain case
    where the build leaves the payload's field name readable."""
    pat = rf"this\.{re.escape(parent)}\.({IDENT})\s*=\s*[a-z]\.{re.escape(readable)}\b"
    return first_of(label, text, [(pat, 1)], start=start)


def derive_local_weapons(text: str, local_field: str, player_start: int) -> str:
    """The weapons slot array on localData. The local-update method does:
        this.<localData>.<weapons> = [];
        ...
        this.<localData>.<weapons>.push(n);
    The same mangled name shows up on both lines — we require it.
    """
    parent = re.escape(local_field)
    return first_of("localData.weapons", text, [
        (rf"this\.{parent}\.({IDENT})\s*=\s*\[\][\s\S]{{0,800}}?this\.{parent}\.\1\.push\b", 1),
    ], start=player_start)


def derive_game_local_player(text: str, game_start: int) -> str:
    """Game.localPlayer (the local Player ref on the Game instance). Anchored on
    `this.<X>.gunSwitchCooldown = 0` (real readable name on Player; the
    local-player ref is the only thing assigned this field on the Game class)."""
    return vote_of("game.localPlayer", text, [
        (rf"this\.({IDENT})\.gunSwitchCooldown\s*=\s*0", 1),
    ], start=game_start, min_count=1)


def derive_game_roster(text: str, game_start: int) -> str:
    """Game.roster (player-barn / roster). `anonPlayerNames` is a real readable
    string assigned onto the roster in init()."""
    return vote_of("game.roster", text, [
        (rf"this\.({IDENT})\.anonPlayerNames\s*=", 1),
    ], start=game_start, min_count=1)


def derive_game_input_binds(text: str, game_start: int) -> str:
    """Game.inputBinds. The input loop fires many .isBindDown(...) and
    .isBindPressed(...) calls through this field."""
    return vote_of("game.inputBinds", text, [
        (rf"this\.({IDENT})\.isBindDown\(", 1),
        (rf"this\.({IDENT})\.isBindPressed\(", 1),
    ], start=game_start, min_count=3)


def derive_camera_interp_window(text: str, game_start: int) -> str:
    """Camera.interpWindow — the seconds-per-server-update figure every entity
    divides its `posInterpTicker` by to get its 0..1 lerp fraction.

    Anchor 1 is the division itself and carries every build on its own
    (`posInterpTicker` is readable everywhere, and the only thing it is ever
    divided by is this field). Anchors 2 and 3 are independent confirmations on
    the survev.io build — the gas renderer's `interpolationT` clamp and
    the update handler's inter-arrival write next to `debugHUD`. Majority-voted
    so a regex that starts matching something else gets caught rather than
    silently winning.
    """
    return vote_of("camera.interpWindow", text, [
        # Entity classes — these sit BEFORE the Game class in every bundle, so
        # they carry their own start offset rather than the game-class one.
        (rf"posInterpTicker\s*/\s*{IDENT}\.({IDENT})\b", 1, 0),
        (rf"[a-z]\.{IDENT}\s*&&\s*\({IDENT}\s*=\s*{IDENT}\.clamp\("
         rf"this\.interpolationT\s*/\s*[a-z]\.({IDENT})\s*,\s*0\s*,\s*1\)\)", 1, 0),
        # Game class — the update handler's inter-arrival write.
        (rf"this\.{IDENT}\.({IDENT})\s*=\s*[a-z]\s*/\s*(?:1e3|1000)\s*,\s*"
         rf"this\.debugHUD\.updateIntervalGraph\.addEntry\(", 1),
    ], start=game_start, min_count=3)


def derive_game_camera(text: str, interp_window: str, game_start: int) -> str:
    """Game.camera, found via the field we already know lives on it.

    Every build's update handler stamps the raw packet inter-arrival onto
    `camera.<interpWindow>` in milliseconds-over-1e3 form:
        survev.io     this.<CAM>.<WIN> = e / 1e3, this.debugHUD…
        surviv.io     this.<CAM>.<WIN> = (t - this.<last>) / 1e3
    Requiring the already-derived interpWindow name makes this exact without
    needing either build's differing neighbouring code, and the
    game-class scope keeps it away from same-shaped UI widgets earlier in the
    bundle.
    """
    win = re.escape(interp_window)
    return vote_of("game.camera", text, [
        (rf"this\.({IDENT})\.{win}\s*=\s*[^;,]{{1,60}}?/\s*(?:1e3|1000)", 1),
        (rf"this\.({IDENT})\.{win}\s*=", 1),
    ], start=game_start, min_count=1)


def derive_camera_interp_enabled(text: str, interp_window: str) -> str:
    """Camera.interpEnabled — the user-facing "interpolation" setting that
    guards every interpolation site.

    Anchor 1 is survev.io's gas renderer, the one guard site sitting
    next to a readable field (`interpolationT`). Anchor 2 is surviv.io's guard,
    `<cam>.<ENABLED> && <cam>.<WINDOW> > 0`, pinned by the already-derived
    window name. Both backreference the camera local so both halves of the
    guard have to be the same object.
    """
    win = re.escape(interp_window)
    return first_of("camera.interpEnabled", text, [
        (rf"([a-z])\.({IDENT})\s*&&\s*{IDENT}\s*=\s*{IDENT}\.clamp\("
         rf"this\.interpolationT\s*/\s*\1\.{IDENT}\s*,\s*0\s*,\s*1\)", 2),
        (rf"([a-z])\.({IDENT})\s*&&\s*\({IDENT}\s*=\s*{IDENT}\.clamp\("
         rf"this\.interpolationT\s*/\s*\1\.{IDENT}\s*,\s*0\s*,\s*1\)\)", 2),
        (rf"([a-z])\.({IDENT})\s*&&\s*\1\.{win}\s*>\s*0", 2),
    ])


def derive_roster_player_pool(text: str) -> str:
    """Roster.playerPool — the entity pool holding the Player objects the
    server has streamed to us. This is where enemies live; `playerStatus` only
    carries minimap state for your own team.

    Anchored on the roster's field-initialiser run, which is the same sequence
    on every build even though two of the three names in it are mangled on
    surviv.io:
        survev.io   playerPool = new on(cr); playerInfo = {}; playerIds = [];
        surviv.io   this.Pe = new k.Pool(A), this.ze = {}, this.playerIds = [],
    `playerIds` stays readable everywhere and pins the run.
    """
    return first_of("roster.playerPool", text, [
        (rf"(?:this\.)?({IDENT})\s*=\s*new\s+[^;,()]{{1,40}}\([^)]{{0,60}}\)\s*[,;]\s*"
         rf"(?:this\.)?{IDENT}\s*=\s*\{{\}}\s*[,;]\s*(?:this\.)?playerIds\s*=\s*\[\]", 1),
    ])


def derive_roster_get_player_info(text: str) -> str:
    """Roster.getPlayerInfo(id) — name, team and group for one player.

    Anchored on the per-frame status update, which every build writes as the
    same three statements:
        <a> = this.<getPlayerInfo>(t), <b> = this.<getPlayerById>(t);
        this.<setPlayerStatus>(t, { pos: …, health: …, disconnected: !1, … })
    The object literal's keys stay readable on both, and backreferencing
    the id local ties the three calls to one another.
    """
    return first_of("roster.getPlayerInfo", text, [
        (rf"=\s*this\.({IDENT})\(([a-z])\)\s*,\s*{IDENT}\s*=\s*this\.{IDENT}\(\2\)\s*[;,]\s*"
         rf"this\.{IDENT}\(\2\s*,\s*\{{\s*pos:", 1),
        # Fallback: the name lookup, readable on the survev.io build.
        (rf"getPlayerName\({IDENT},\s*{IDENT},\s*{IDENT}\)\s*\{{\s*let\s+{IDENT}\s*=\s*this\.({IDENT})\(", 1),
    ])


def derive_pool_get_all(text: str) -> str:
    """Pool.getAll — the accessor returning a pool's backing array.

    Anchor 1: the survev.io build calls it as `<obj>.playerPool.<getAll>()`
    all over (`playerPool` is a readable field on the roster class).
    Anchor 2: surviv.io has no `playerPool`, so we go to the Pool class itself,
    identified by its readable `activeCount`, and take the one method that
    returns the pool array the constructor set up:
        function o(e) { …, this.<arr> = [], this.activeCount = 0 }
        o.prototype = { alloc: …, free: …, <getAll>: function() { return this.<arr> } }
    """
    return first_of("pool.getAll", text, [
        (rf"\.playerPool\.({IDENT})\(\)", 1),
        (rf"this\.({IDENT})\s*=\s*\[\]\s*,\s*this\.activeCount\s*=\s*0"
         rf"[\s\S]{{0,2000}}?\b({IDENT})\s*:\s*function\s*\(\s*\)\s*\{{\s*return\s+this\.\1\s*\}}", 2),
    ])


# Readable names that show up inside the Game constructor's assignment run but
# must never be seeded as Object.prototype setter traps: they're either common
# enough to collide with unrelated page objects or are the app's own plumbing.
SEED_DENYLIST = frozenset({
    "game", "pixi", "config", "localization", "audioManager", "teamMenu",
    "account", "analytics", "adManager", "siteInfo", "pingTest", "ambience",
    "input", "inputBinds", "inputBindUi", "resourceManager", "loadoutMenu",
    "onJoin", "onQuit", "initialized", "teamMode", "active", "seq",
})
# Mangled identifiers are short; anything longer is a real name we shouldn't trap.
SEED_MAX_LEN = 8


def _seed_names_from(run: str) -> list[str]:
    """Pull `this.<X> = <singleLetter>` names out of a constructor fragment,
    dropping readable plumbing and preserving first-seen order."""
    seen: set[str] = set()
    out: list[str] = []
    for name in re.findall(rf"this\.({IDENT})\s*=\s*[a-z]\b", run):
        if name in seen or name in SEED_DENYLIST or len(name) > SEED_MAX_LEN:
            continue
        seen.add(name)
        out.append(name)
    return out


def derive_seed_names(text: str) -> list[str]:
    """Game-constructor positional-param assignments.

    Anchor 1 — the survev.io build assigns the constructor's params in one
    contiguous run that ends at the readable `onJoin`/`onQuit` pair:
        this.<A> = e, this.<B> = t, …, this.onJoin = l, this.onQuit = u
    Anchor 2 — surviv.io puts `onJoin`/`onQuit` FIRST and interleaves readable
    fields (`pixi`, `localization`, `config`) with the mangled ones, so there
    is no run to take; we sweep a window either side of the same landmark
    instead and filter by SEED_DENYLIST.

    NOTE: these names only feed inject.js's FALLBACK capture path. Builds that
    pre-declare them as class fields install those with [[DefineOwnProperty]]
    before the constructor body runs, so the setter traps seeded from this list
    can never fire there; the game is captured via the Function.prototype.bind
    hook instead (see the "Primary capture" block in inject.js). If capture
    breaks, that hook and the app singleton's field shape are what to look at,
    not this list.
    """
    landmark = rf"this\.onJoin\s*=\s*[a-z]\s*,\s*this\.onQuit\s*=\s*[a-z]"

    run_match = re.search(
        rf"((?:this\.{IDENT}\s*=\s*[a-z]\s*,\s*){{5,30}}){landmark}", text
    )
    if run_match:
        names = _seed_names_from(run_match.group(1))
        if len(names) >= 5:
            return names

    anchor = re.search(landmark, text)
    if not anchor:
        raise DeriveError(
            "seedNames: could not find the Game constructor's onJoin/onQuit landmark"
        )
    window = text[max(0, anchor.start() - 2500) : anchor.end() + 2500]
    names = _seed_names_from(window)
    if len(names) < 5:
        raise DeriveError(f"seedNames: only found {len(names)} usable names: {names}")
    return names


# ---------------------------------------------------------------------------
# The derivation table
# ---------------------------------------------------------------------------

# Order matters: later entries read names derived by earlier ones.
ENTRIES = [
    "player.netData", "player.localData", "player.pos", "player.dir",
    "player.posAlt", "player.dirAlt",
    "netData.activeWeapon", "netData.dead", "netData.downed", "netData.scale",
    "localData.zoom", "localData.curWeapIdx", "localData.weapons",
    "game.localPlayer", "game.roster", "game.inputBinds",
    "roster.playerPool", "roster.getPlayerInfo",
    "camera.interpWindow", "game.camera", "camera.interpEnabled",
    "pool.getAll",
]


def derive_values(text: str) -> tuple[dict[str, str], list[str]]:
    """Run every anchor against one gameplay bundle."""
    p = player_class_start(text)
    g = game_class_start(text)
    print(f"  Player class @ char {p:,}, Game class @ char {g:,}")

    v: dict[str, str] = {}
    steps: dict[str, Callable[[], str]] = {
        "player.netData":   lambda: derive_net_data(text, p),
        "player.localData": lambda: derive_local_data(text, p),
        "player.pos":       lambda: derive_player_pos(text, p),
        "player.dir":       lambda: derive_player_dir(text, p),
        "player.posAlt":    lambda: derive_player_visual_vec(text, v["player.pos"], "player.posAlt", p),
        "player.dirAlt":    lambda: derive_player_visual_vec(text, v["player.dir"], "player.dirAlt", p),
        # activeWeapon: readable on the payload for the survev.io build;
        # surviv.io mangles it, so we take it off the gun-sprite call and the
        # `"fists"` comparison, both of which name it under readable company.
        "netData.activeWeapon": lambda: derive_net_field(text, v["player.netData"], "netData.activeWeapon", [
            (rf"this\.{re.escape(v['player.netData'])}\.({IDENT})\s*=\s*[a-z]\.activeWeapon\b", 1),
            (rf"this\.gunRSprites\.setType\(\s*this\.{re.escape(v['player.netData'])}\.({IDENT})", 1),
            (rf'"fists"\s*!=\s*this\.{re.escape(v["player.netData"])}\.({IDENT})', 1),
        ], p),
        # dead: readable on the payload, else off the playerStatus object
        # literal, whose `dead:`/`downed:` keys stay readable everywhere.
        "netData.dead": lambda: derive_net_field(text, v["player.netData"], "netData.dead", [
            (rf"this\.{re.escape(v['player.netData'])}\.({IDENT})\s*=\s*[a-z]\.dead\b", 1),
            (rf"\bdead:\s*{IDENT}\.{re.escape(v['player.netData'])}\.({IDENT})\s*,\s*downed:", 1),
        ], 0),
        # downed: readable on the payload, else off `this.downed = this.<net>.<X>`.
        "netData.downed": lambda: derive_net_field(text, v["player.netData"], "netData.downed", [
            (rf"this\.{re.escape(v['player.netData'])}\.({IDENT})\s*=\s*[a-z]\.downed\b", 1),
            (rf"this\.downed\s*=\s*this\.{re.escape(v['player.netData'])}\.({IDENT})\b", 1),
        ], p),
        # scale multiplies GameConfig.player.radius into the collider the game
        # actually tests bullets against, so the dodge bot's hitbox is wrong
        # without it. That multiplication is also the fallback anchor.
        "netData.scale": lambda: derive_net_field(text, v["player.netData"], "netData.scale", [
            (rf"this\.{re.escape(v['player.netData'])}\.({IDENT})\s*=\s*[a-z]\.scale\b", 1),
            (rf"this\.{IDENT}\s*=\s*this\.{re.escape(v['player.netData'])}\.({IDENT})\s*\*\s*{IDENT}\.player\.radius", 1),
        ], p),
        "localData.zoom":       lambda: derive_field_on(text, v["player.localData"], "zoom", "localData.zoom", start=p),
        "localData.curWeapIdx": lambda: derive_field_on(text, v["player.localData"], "curWeapIdx", "localData.curWeapIdx", start=p),
        "localData.weapons":    lambda: derive_local_weapons(text, v["player.localData"], p),
        "game.localPlayer":     lambda: derive_game_local_player(text, g),
        "game.roster":          lambda: derive_game_roster(text, g),
        "game.inputBinds":      lambda: derive_game_input_binds(text, g),
        "roster.playerPool":    lambda: derive_roster_player_pool(text),
        "roster.getPlayerInfo": lambda: derive_roster_get_player_info(text),
        "camera.interpWindow":  lambda: derive_camera_interp_window(text, g),
        "game.camera":          lambda: derive_game_camera(text, v["camera.interpWindow"], g),
        "camera.interpEnabled": lambda: derive_camera_interp_enabled(text, v["camera.interpWindow"]),
        "pool.getAll":          lambda: derive_pool_get_all(text),
    }

    for label in ENTRIES:
        v[label] = steps[label]()
        print(f"  {label:24s} -> {v[label]!r}")

    seeds = derive_seed_names(text)
    print(f"  {'seedNames':24s} -> {seeds}")
    return v, seeds


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

FILE_HEADER = """\
// Mangled symbol names from every supported client bundle.
//
// AUTO-GENERATED by update_mangled.py. Do not edit by hand — re-run
// `python update_mangled.py` to refetch the current bundles and re-derive.
//
// Both sites ship the same game from two separately-built, separately-
// mangled clients: readable TypeScript/JS field names get renamed to short
// opaque identifiers like `qJm`, `TXaUHs`, `De`, and those names change on
// every deploy. (surviv.io leaves a few of them under their real names, e.g.
// `pos` — that's not a bug in the derivation, it's what that build calls the
// field.) This file is the single source of truth mapping semantic names
// (what each field MEANS) to the mangled name each build gives it.
//
// inject.js reads every name through the dictionary picked for the current
// hostname at the bottom of this file, so nothing else in the extension has to
// know which site it is running on.
//
// The anchors used to re-derive each name are documented in update_mangled.py.
//
// Two groups per site are NOT derived from the bundle — `antiDetect` and
// `capture` are standing per-site policy, and they live in SITE_POLICY in
// update_mangled.py. Change them there, not here.
"""

SITE_SELECTOR = """
// Pick the dictionary for whatever host this content script was injected into.
// Subdomains count (`ptr.survev.io` is the same build as `survev.io`), so we
// match on an exact hostname or a dot-suffix of one — never a bare substring,
// which would let e.g. `notsurviv.io.example.com` through.
(() => {
  const host = String(location.hostname || '').toLowerCase();
  const sites = window.__SURVEV_MANGLED_SITES__;
  let matched = null;
  for (const site of Object.keys(sites)) {
    if (host === site || host.endsWith('.' + site)) { matched = site; break; }
  }
  // Non-enumerable: keeps us out of Object.keys(window), which surviv.io's
  // `ki()` walks. Still readable by name from inject.js and the console.
  const hide = (k, v) => Object.defineProperty(window, k, {
    configurable: true, enumerable: false, writable: true, value: v,
  });
  hide('__SURVEV_MANGLED_SITE__', matched);
  hide('__SURVEV_MANGLED__', matched ? sites[matched] : null);
})();
"""


def render_site_block(site: str, v: dict[str, str], seeds: list[str], source: str) -> str:
    """Render one site's entry. Layout mirrors the original hand-written file
    so diffs across re-derivations stay minimal."""

    def q(key: str) -> str:
        return f"'{v[key]}'"

    pol = SITE_POLICY.get(site, POLICY_DEFAULT)

    def js(b: bool) -> str:
        return "true" if b else "false"

    seed_lines = []
    for i in range(0, len(seeds), 5):
        seed_lines.append("      " + ", ".join(f"'{s}'" for s in seeds[i : i + 5]) + ",")
    seeds_block = "\n".join(seed_lines)

    return f"""\
  // =====================================================================
  // {site} — derived from {source}
  // =====================================================================
  '{site}': {{
    // ---- Player class ----
    // Anchor: class declaring `bodySprite`, `helmetSprite`, `meleeSprite`,
    // `footLSprite`, `handLContainer`, etc. as own fields.
    player: {{
      netData:      {q("player.netData")},
      localData:    {q("player.localData")},
      pos:          {q("player.pos")},
      dir:          {q("player.dir")},
      posAlt:       {q("player.posAlt")},
      dirAlt:       {q("player.dirAlt")},
    }},

    // ---- Player.netData (the sub-object named by player.netData above) ----
    netData: {{
      activeWeapon: {q("netData.activeWeapon")},
      dead:         {q("netData.dead")},
      downed:       {q("netData.downed")},
      scale:        {q("netData.scale")},
    }},

    // ---- Player.localData (the sub-object named by player.localData above) ----
    localData: {{
      zoom:       {q("localData.zoom")},
      curWeapIdx: {q("localData.curWeapIdx")},
      weapons:    {q("localData.weapons")},
    }},

    // ---- Game class ----
    game: {{
      localPlayer: {q("game.localPlayer")},
      roster:      {q("game.roster")},
      inputBinds:  {q("game.inputBinds")},
      camera:      {q("game.camera")},
    }},

    // ---- Roster / player-barn class (named by game.roster above) ----
    // `playerPool` holds the streamed-in Player entities — that's where
    // enemies are. `getPlayerInfo(id)` returns name/team/group for one id.
    roster: {{
      playerPool:    {q("roster.playerPool")},
      getPlayerInfo: {q("roster.getPlayerInfo")},
    }},

    // ---- Camera class ----
    // `interpWindow` is seconds-per-server-update: the game overwrites it with
    // the RAW last packet inter-arrival on every update, and every entity
    // divides its `posInterpTicker` by it to get a 0..1 lerp fraction.
    // inject.js replaces it with a jitter-buffered estimate — see the netcode
    // smoothing block there.
    camera: {{
      interpWindow:  {q("camera.interpWindow")},
      interpEnabled: {q("camera.interpEnabled")},
    }},

    // ---- Pool class (entity pools) ----
    pool: {{
      getAll: {q("pool.getAll")},
    }},

    // ---- Client-side extension detection ----
    // NOT derived — standing policy, see SITE_POLICY in update_mangled.py.
    // surviv.io's client scans every 30 frames for sprites below an alpha
    // threshold and closes its own WebSocket when it finds one; the hook
    // neutralises that predicate before the bundle evaluates.
    antiDetect: {{ webpackChunkHook: {js(pol["webpackChunkHook"])} }},

    // ---- Game capture strategy ----
    // NOT derived — standing policy, see SITE_POLICY in update_mangled.py.
    // `protoTrap: false` means the Game is captured by the bind hook alone
    // and `seedNames` below goes unused. It is kept either way: it costs
    // nothing, and it is the cheapest way to re-enable the trap if the bind
    // hook ever regresses on that build.
    capture: {{ protoTrap: {js(pol["protoTrap"])} }},

    // ---- Game-constructor positional-param assignments ----
    // (used to seed Object.prototype setter traps so we can capture the
    // Game instance on first construction — see inject.js)
    seedNames: [
{seeds_block}
    ],
  }},
"""


def render_mangled_js(sites: dict[str, dict]) -> str:
    blocks = "\n".join(
        render_site_block(site, sites[site]["values"], sites[site]["seeds"], sites[site]["source"])
        for site in SITES
        if site in sites
    )
    # Non-enumerable, same reasoning as the two globals in SITE_SELECTOR. Site
    # blocks keep their existing two-space indent inside `value:` — re-indenting
    # them would churn every line of the diff on the first regeneration, for no
    # benefit.
    table_open = (
        "Object.defineProperty(window, '__SURVEV_MANGLED_SITES__', {\n"
        "  configurable: true, enumerable: false, writable: true,\n"
        "  value: {\n"
    )
    return f"{FILE_HEADER}\n{table_open}{blocks}}},\n}});\n{SITE_SELECTOR}"


# ---------------------------------------------------------------------------
# Reading back what's already there
# ---------------------------------------------------------------------------

def _balanced_block(text: str, open_idx: int) -> str:
    """Substring from the `{` at open_idx through its matching `}`.

    The generated file has no strings containing braces, so plain counting is
    enough and saves pulling in a JS parser.
    """
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_idx : i + 1]
    raise DeriveError("unbalanced braces in mangled.js")


def parse_existing_mangled() -> dict[str, dict]:
    """Best-effort read of the current mangled.js, per site.

    Lets `--site` / a failed site leave the other sites' entries untouched
    instead of dropping them from the regenerated file. Any parse failure just
    yields fewer sites, and those get re-derived or reported as missing.
    """
    if not MANGLED_JS.exists():
        return {}
    try:
        text = MANGLED_JS.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {}

    out: dict[str, dict] = {}
    for site in SITES:
        m = re.search(rf"'{re.escape(site)}'\s*:\s*\{{", text)
        if not m:
            continue
        try:
            block = _balanced_block(text, m.end() - 1)
        except DeriveError:
            continue

        values: dict[str, str] = {}
        for gm in re.finditer(rf"({IDENT})\s*:\s*\{{([^{{}}]*)\}}", block):
            group, body = gm.group(1), gm.group(2)
            for kv in re.finditer(rf"({IDENT})\s*:\s*'([^']+)'", body):
                values[f"{group}.{kv.group(1)}"] = kv.group(2)

        seeds: list[str] = []
        sm = re.search(r"seedNames\s*:\s*\[([^\]]*)\]", block)
        if sm:
            seeds = re.findall(r"'([^']+)'", sm.group(1))

        source_m = re.search(rf"{re.escape(site)} — derived from (\S+)", text)
        out[site] = {
            "values": values,
            "seeds": seeds,
            "source": source_m.group(1) if source_m else "(unknown)",
        }
    return out


def print_diff(site: str, old: dict | None, values: dict[str, str], seeds: list[str]) -> None:
    if not old:
        print(f"  ({site}: no previous entry — emitting fresh)")
        return
    flat_new = dict(values)
    flat_new["seedNames"] = ",".join(seeds)
    flat_old = dict(old["values"])
    flat_old["seedNames"] = ",".join(old["seeds"])

    changed = []
    unchanged = 0
    for k, new_v in flat_new.items():
        old_v = flat_old.get(k)
        if old_v is None:
            changed.append((k, "(new)", new_v))
        elif old_v != new_v:
            changed.append((k, old_v, new_v))
        else:
            unchanged += 1
    if not changed:
        print(f"  no changes — all {unchanged} names already match.")
        return
    print(f"  diff vs existing ({unchanged} unchanged, {len(changed)} changed):")
    width = max(len(k) for k, _, _ in changed)
    for k, old_v, new_v in changed:
        print(f"    {k:<{width}}  {old_v}  ->  {new_v}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def run_derive(site: str, preferred_bundle: str | None) -> dict:
    path, text = find_gameplay_dump(site, preferred_bundle)
    print(f"  analyzing {path.name} ({len(text):,} chars)")
    values, seeds = derive_values(text)
    return {"values": values, "seeds": seeds, "source": path.name}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    stage = ap.add_mutually_exclusive_group()
    stage.add_argument(
        "--fetch-only",
        action="store_true",
        help="download the bundles into js_dump/<site>/ but don't touch mangled.js",
    )
    stage.add_argument(
        "--derive-only",
        action="store_true",
        help="re-derive mangled.js from whatever is already in js_dump/<site>/",
    )
    ap.add_argument(
        "--site",
        action="append",
        metavar="HOST",
        choices=sorted(SITES),
        help=f"only handle this site (repeatable). Default: all of {', '.join(SITES)}",
    )
    ap.add_argument(
        "--keep-old",
        action="store_true",
        help="fetch stage: don't delete previous fetches' files from js_dump/<site>/",
    )
    ap.add_argument(
        "--bundle",
        metavar="NAME",
        help="derive stage: use this js_dump/<site>/ file instead of the newest "
             "gameplay bundle (only meaningful with a single --site)",
    )
    args = ap.parse_args()

    targets = args.site or list(SITES)
    if args.bundle and len(targets) > 1:
        ap.error("--bundle needs a single --site")

    existing = parse_existing_mangled()
    derived: dict[str, dict] = {}
    failures: list[tuple[str, str]] = []

    for site in targets:
        print(f"\n=== {site} ===")
        if not args.derive_only:
            try:
                run_fetch(site, args.keep_old)
            except (DeriveError, urllib.error.URLError, OSError) as e:
                print(f"  fetch failed: {e}")
                failures.append((site, f"fetch: {e}"))
                continue
        if args.fetch_only:
            continue
        try:
            result = run_derive(site, args.bundle)
        except DeriveError as e:
            print(f"  derive failed: {e}")
            failures.append((site, f"derive: {e}"))
            continue
        print_diff(site, existing.get(site), result["values"], result["seeds"])
        derived[site] = result

    if args.fetch_only:
        _report(failures)
        return

    if not derived:
        print("\nNothing derived — leaving mangled.js untouched.")
        _report(failures)
        sys.exit(1)

    # Sites we didn't derive this run (not targeted, or failed) keep whatever
    # mangled.js already had for them, so a one-site run never drops the others.
    merged = dict(existing)
    merged.update(derived)
    carried = [s for s in merged if s not in derived]
    if carried:
        print(f"\nCarrying over existing entries for: {', '.join(carried)}")
    missing = [s for s in SITES if s not in merged]
    if missing:
        print(f"WARNING: no entry at all for: {', '.join(missing)} — "
              f"the extension will do nothing on {'that site' if len(missing) == 1 else 'those sites'}.")

    if MANGLED_JS.exists():
        shutil.copy2(MANGLED_JS, BACKUP_JS)
        print(f"Backup written to {BACKUP_JS.name}")

    out = render_mangled_js(merged)
    MANGLED_JS.write_text(out, encoding="utf-8")
    print(f"Wrote {MANGLED_JS.name} ({len(out):,} bytes) for: {', '.join(s for s in SITES if s in merged)}")
    _report(failures)


def _report(failures: list[tuple[str, str]]) -> None:
    if not failures:
        return
    print(f"\n{len(failures)} site(s) failed:")
    for site, why in failures:
        print(f"  {site}: {why.splitlines()[0]}")
    sys.exit(1)


if __name__ == "__main__":
    main()
