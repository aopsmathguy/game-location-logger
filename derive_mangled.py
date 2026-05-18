#!/usr/bin/env python3
"""Derive a fresh mangled.js from the prettified survev bundles in js_dump/.

Run AFTER fetch_survev_js.py. This script reads js_dump/*_formatted.js,
identifies the gameplay bundle (the one containing the Player + Game classes),
and extracts the current mangled symbol names by anchoring on STABLE READABLE
patterns that survev keeps un-mangled across builds: real TypeScript field
names like `bodySprite`, `onJoin`, `playerPool`, `gunSwitchCooldown`,
`isBindDown`, plus the server-protocol field names on update payloads
(`e.pos`, `e.dir`, `e.activeWeapon`, `e.zoom`, ...).

If any anchor fails to match, the script aborts naming the specific field that
broke — that means survev changed the bundle in a way the current anchor
doesn't cover, and a new fallback needs to be added below. Each anchor is
purposefully narrow (multiple stable-name landmarks per regex) so a stray
match somewhere else in the bundle can't poison the result.
"""

from __future__ import annotations

import re
import shutil
import sys
from collections import Counter
from pathlib import Path

JS_DUMP = Path(__file__).parent / "js_dump"
MANGLED_JS = Path(__file__).parent / "mangled.js"
BACKUP_JS = Path(__file__).parent / "mangled.js.bak"

# Mangled-identifier shape. survev mangles to 2–8 char mixed-case identifiers,
# but we don't bound length — capture any plausible JS ident.
IDENT = r"[A-Za-z_$][A-Za-z0-9_$]*"


class DeriveError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Bundle selection
# ---------------------------------------------------------------------------

def find_gameplay_dump() -> tuple[Path, str]:
    """Return (path, contents) for the gameplay bundle (Player + Game classes).

    survev currently ships two JS files: a small ~18k-line gameplay bundle and
    a large ~73k-line asset/definitions bundle. We pick the gameplay bundle by
    looking for the Player class's un-mangled sprite-field declarations, which
    are stable across builds because survev declares them with real names.
    """
    candidates = sorted(JS_DUMP.glob("*_formatted.js"))
    if not candidates:
        raise DeriveError(f"no *_formatted.js in {JS_DUMP}/ — run fetch_survev_js.py first")

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
            "no gameplay bundle found in js_dump/ — looked for files containing "
            "bodySprite/helmetSprite/meleeSprite Player-class declarations."
        )
    if len(matches) > 1:
        names = ", ".join(p.name for p, _ in matches)
        raise DeriveError(
            f"multiple gameplay-bundle candidates ({names}). "
            "Delete stale dumps from js_dump/ and re-run."
        )
    return matches[0]


def player_class_start(text: str) -> int:
    """Byte offset of the Player class start, anchored on `bodySprite = ...`.

    Several other classes in the bundle (Obstacle, Loot, Decal) use very
    similar interpolation setup code with `e.pos`/`posInterpTicker`, so any
    anchor on Player-class internals must search *after* this offset to
    avoid false-positive matches against those siblings.
    """
    m = re.search(r"\bbodySprite\s*=\s*\w+\(\)", text)
    if not m:
        raise DeriveError("could not locate Player class (bodySprite declaration)")
    return m.start()


def game_class_start(text: str) -> int:
    """Byte offset of the Game class start, anchored on a debugHUD field
    declaration that the Game class makes near its other top-level fields."""
    # debugHUD is a real readable name on the Game class. It's declared as a
    # bare class field (no initializer), then later instantiated in init().
    m = re.search(r"\bdebugHUD\s*;", text)
    if not m:
        # Fallback: try the init() assignment instead.
        m = re.search(r"\bdebugHUD\s*=\s*new\s+\w+", text)
    if not m:
        raise DeriveError("could not locate Game class (debugHUD anchor)")
    return m.start()


# ---------------------------------------------------------------------------
# Match helpers
# ---------------------------------------------------------------------------

def must_match(label: str, text: str, pattern: str, group: int = 1, start: int = 0) -> str:
    m = re.search(pattern, text[start:])
    if not m:
        raise DeriveError(
            f"anchor for {label!r} did not match. "
            f"The bundle's structure may have changed — update the anchor in derive_mangled.py.\n"
            f"  pattern: {pattern}"
        )
    return m.group(group)


def all_matches(text: str, pattern: str, group: int = 1, start: int = 0) -> list[str]:
    return [m.group(group) for m in re.finditer(pattern, text[start:])]


def majority_value(label: str, values: list[str], min_count: int = 2) -> str:
    """Return the most-common value, requiring at least `min_count` occurrences
    and a clear win over any other candidate."""
    if not values:
        raise DeriveError(f"{label}: no candidates found")
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
# Anchors
# ---------------------------------------------------------------------------

def derive_player_pos(text: str, player_start: int) -> str:
    """Player position field. The network-update method sets up interpolation
    via:
        <V>.eq(e.pos, this.<posInterp>) || (this.<posInterp> = <V>.copy(n ? e.pos : this.<POS>), this.posInterpTicker = 0)
    `posInterpTicker` is a real readable name. Other classes (Obstacle, Loot,
    Decal) share this shape — we constrain the search to start at the Player
    class declaration to pick the right one.
    """
    pat = (
        rf"\.eq\(e\.pos,\s*this\.{IDENT}\)\s*\|\|\s*"
        rf"\(this\.{IDENT}\s*=\s*\w+\.copy\(n\s*\?\s*e\.pos\s*:\s*this\.({IDENT})\)"
        rf"\s*,\s*this\.posInterpTicker\s*=\s*0"
    )
    return must_match("player.pos", text, pat, start=player_start)


def derive_player_dir(text: str, player_start: int) -> str:
    """Player direction field — same shape as pos with dirInterpolationTicker.
    `dirInterpolationTicker` actually appears to be Player-class-unique, but we
    still scope the search for consistency."""
    pat = (
        rf"\.eq\(e\.dir,\s*this\.{IDENT}\)\s*\|\|\s*"
        rf"\(this\.{IDENT}\s*=\s*\w+\.copy\(n\s*\?\s*e\.dir\s*:\s*this\.({IDENT})\)"
        rf"\s*,\s*this\.dirInterpolationTicker\s*=\s*0"
    )
    return must_match("player.dir", text, pat, start=player_start)


def derive_player_pos_alt(text: str, pos_field: str, player_start: int) -> str:
    """Interpolated/rendered position used as a fallback for reads.

    Anchor 1 (preferred): the lerp in the render-update path:
        this.<posAlt> = <V>.lerp(<t>, this.<prev>, this.<pos>)
    Anchor 2 (fallback): the snap-on-respawn branch:
        this.<posAlt> = <V>.copy(this.<pos>)
    Other classes (smokeBarn particles, playerStatus updaters) have
    `this.posTarget = w.copy(this.pos)` shapes with REAL readable names — we
    skip past them by searching from the Player class start.
    """
    pos_re = re.escape(pos_field)
    scoped = text[player_start:]
    lerp_pat = rf"this\.({IDENT})\s*=\s*\w+\.lerp\(\w+\s*,\s*this\.{IDENT}\s*,\s*this\.{pos_re}\)"
    m = re.search(lerp_pat, scoped)
    if m:
        return m.group(1)
    copy_pat = rf"this\.({IDENT})\s*=\s*\w+\.copy\(this\.{pos_re}\)"
    m = re.search(copy_pat, scoped)
    if m:
        return m.group(1)
    raise DeriveError(
        f"player.posAlt: neither lerp nor copy anchor matched.\n"
        f"  lerp: {lerp_pat}\n  copy: {copy_pat}"
    )


def derive_net_data(text: str, player_start: int) -> str:
    """The Player.netData sub-object. The network-update method writes many
    fields onto it; we anchor on activeWeapon/dead/downed (real names) and
    require majority agreement on the mangled parent field across all three."""
    candidates = (
        all_matches(text, rf"this\.({IDENT})\.{IDENT}\s*=\s*e\.activeWeapon\b", start=player_start)
        + all_matches(text, rf"this\.({IDENT})\.{IDENT}\s*=\s*e\.dead\b", start=player_start)
        + all_matches(text, rf"this\.({IDENT})\.{IDENT}\s*=\s*e\.downed\b", start=player_start)
    )
    return majority_value("player.netData", candidates, min_count=2)


def derive_local_data(text: str, player_start: int) -> str:
    """The Player.localData sub-object. Anchored on e.zoom, e.health,
    e.curWeapIdx (all real readable names) with majority cross-check."""
    candidates = (
        all_matches(text, rf"this\.({IDENT})\.{IDENT}\s*=\s*e\.zoom\b", start=player_start)
        + all_matches(text, rf"this\.({IDENT})\.{IDENT}\s*=\s*e\.health\b", start=player_start)
        + all_matches(text, rf"this\.({IDENT})\.{IDENT}\s*=\s*e\.curWeapIdx\b", start=player_start)
    )
    return majority_value("player.localData", candidates, min_count=2)


def derive_field_on(text: str, parent: str, readable: str, label: str, start: int = 0) -> str:
    """Find `this.<parent>.<X> = e.<readable>` and return X."""
    pat = rf"this\.{re.escape(parent)}\.({IDENT})\s*=\s*e\.{re.escape(readable)}\b"
    return must_match(label, text, pat, start=start)


def derive_local_weapons(text: str, local_field: str, player_start: int) -> str:
    """The weapons slot array on localData. The local-update method does:
        this.<localData>.<weapons> = [];
        ...
        this.<localData>.<weapons>.push(n);
    The same mangled name shows up on both lines — we require it.
    """
    parent = re.escape(local_field)
    pat = (
        rf"this\.{parent}\.({IDENT})\s*=\s*\[\]"
        rf"[\s\S]{{0,800}}?"
        rf"this\.{parent}\.\1\.push\b"
    )
    return must_match("localData.weapons", text, pat, start=player_start)


def derive_game_local_player(text: str, game_start: int) -> str:
    """Game.localPlayer (the local Player ref on the Game instance). Anchored on
    `this.<X>.gunSwitchCooldown = 0` (real readable name on Player; the
    local-player ref is the only thing assigned this field on the Game class)."""
    a = all_matches(text, rf"this\.({IDENT})\.gunSwitchCooldown\s*=\s*0", start=game_start)
    if not a:
        raise DeriveError("game.localPlayer: no this.<X>.gunSwitchCooldown=0 match")
    return majority_value("game.localPlayer", a, min_count=1)


def derive_game_roster(text: str, game_start: int) -> str:
    """Game.roster (player-barn / roster). `anonPlayerNames` is a real readable
    string assigned onto the roster in init()."""
    a = all_matches(text, rf"this\.({IDENT})\.anonPlayerNames\s*=", start=game_start)
    if not a:
        raise DeriveError("game.roster: no this.<X>.anonPlayerNames anchor")
    return majority_value("game.roster", a, min_count=1)


def derive_game_input_binds(text: str, game_start: int) -> str:
    """Game.inputBinds. The input loop fires many .isBindDown(...) and
    .isBindPressed(...) calls through this field."""
    a = (
        all_matches(text, rf"this\.({IDENT})\.isBindDown\(", start=game_start)
        + all_matches(text, rf"this\.({IDENT})\.isBindPressed\(", start=game_start)
    )
    return majority_value("game.inputBinds", a, min_count=3)


def derive_pool_get_all(text: str) -> str:
    """Pool.getAll. The bundle invokes it as `<obj>.playerPool.<getAll>()` in
    many places (`playerPool` is a real readable name on the roster class)."""
    a = all_matches(text, rf"\.playerPool\.({IDENT})\(\)")
    return majority_value("pool.getAll", a, min_count=2)


def derive_seed_names(text: str) -> list[str]:
    """Rr-constructor positional-param assignments. The constructor body opens
    with a sequence:
        this.<A> = e, this.<B> = t, this.<C> = n, ..., this.onJoin = l, this.onQuit = u, ...
    `onJoin`/`onQuit` are real readable names. We anchor on them and collect
    every `this.<X> = <singleLetter>,` immediately preceding.
    """
    anchor = (
        rf"((?:this\.{IDENT}\s*=\s*[a-z]\s*,\s*){{5,30}})"
        rf"this\.onJoin\s*=\s*[a-z]\s*,\s*this\.onQuit\s*="
    )
    run = must_match("seedNames (run)", text, anchor)
    names = re.findall(rf"this\.({IDENT})\s*=\s*[a-z]\b", run)
    # The Rr constructor sometimes re-assigns several params a second time on
    # the same line (idempotent). Dedupe but preserve first-seen order.
    seen: set[str] = set()
    unique = []
    for n in names:
        if n not in seen:
            seen.add(n)
            unique.append(n)
    if len(unique) < 5:
        raise DeriveError(f"seedNames: only found {len(unique)} unique names: {unique}")
    return unique


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def render_mangled_js(v: dict, seeds: list[str], source_basename: str) -> str:
    """Render mangled.js. Layout mirrors the hand-written version so diffs are
    minimal across re-derivations."""

    def q(key: str) -> str:
        return f"'{v[key]}'"

    seeds_block_lines = []
    # Re-flow seeds 5 per line, matching the hand-written formatting.
    for i in range(0, len(seeds), 5):
        chunk = seeds[i : i + 5]
        seeds_block_lines.append("    " + ", ".join(f"'{s}'" for s in chunk) + ",")
    seeds_block = "\n".join(seeds_block_lines)

    return f"""// Mangled symbol names from the survev client bundle.
//
// AUTO-GENERATED by derive_mangled.py from {source_basename}.
// Do not edit by hand — re-run `python derive_mangled.py` after each
// `python fetch_survev_js.py`.
//
// Survev ships its client bundle re-mangled on each deploy: readable
// TypeScript field names get renamed to short opaque identifiers like
// `qJm`, `TXaUHs`, etc., and those names change every build. This file
// is the single source of truth that maps semantic names (what each
// field MEANS) to mangled names (what it's CALLED in the current bundle).
// inject.js reads every name through this dictionary.
//
// The anchors used to re-derive each name are documented in derive_mangled.py.

window.__SURVEV_MANGLED__ = {{
  // ---- Player class (`er` in bundle) ----
  // Anchor: class declaring `bodySprite`, `helmetSprite`, `meleeSprite`,
  // `footLSprite`, `handLContainer`, etc. as own fields.
  player: {{
    netData:   {q("player.netData")},
    localData: {q("player.localData")},
    pos:       {q("player.pos")},
    dir:       {q("player.dir")},
    posAlt:    {q("player.posAlt")},
  }},

  // ---- Player.netData (the sub-object named by player.netData above) ----
  netData: {{
    activeWeapon: {q("netData.activeWeapon")},
    dead:         {q("netData.dead")},
    downed:       {q("netData.downed")},
  }},

  // ---- Player.localData (the sub-object named by player.localData above) ----
  localData: {{
    zoom:       {q("localData.zoom")},
    curWeapIdx: {q("localData.curWeapIdx")},
    weapons:    {q("localData.weapons")},
  }},

  // ---- Game class (`Rr` in bundle) ----
  game: {{
    localPlayer: {q("game.localPlayer")},
    roster:      {q("game.roster")},
    inputBinds:  {q("game.inputBinds")},
  }},

  // ---- Pool class (entity pools) ----
  pool: {{
    getAll: {q("pool.getAll")},
  }},

  // ---- Rr-constructor positional-param assignments ----
  // (used to seed Object.prototype setter traps so we can capture the
  // Game instance on first construction — see inject.js)
  seedNames: [
{seeds_block}
  ],
}};
"""


# ---------------------------------------------------------------------------
# Diff helper for the post-run summary
# ---------------------------------------------------------------------------

def parse_existing_mangled() -> dict[str, str] | None:
    """Best-effort parse of the existing mangled.js, returning a flat
    {dotted-key: value} dict. Used only for the diff print — failure is OK."""
    if not MANGLED_JS.exists():
        return None
    try:
        text = MANGLED_JS.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None

    out: dict[str, str] = {}
    # Match nested-object blocks: `<group>: { ... },`
    for group_match in re.finditer(rf"({IDENT})\s*:\s*\{{([^}}]*)\}}", text):
        group = group_match.group(1)
        body = group_match.group(2)
        if group == "seedNames":  # array, handled separately
            continue
        for kv in re.finditer(rf"({IDENT})\s*:\s*'([^']+)'", body):
            out[f"{group}.{kv.group(1)}"] = kv.group(2)

    seeds_match = re.search(r"seedNames\s*:\s*\[([^\]]*)\]", text)
    if seeds_match:
        seeds = re.findall(r"'([^']+)'", seeds_match.group(1))
        out["seedNames"] = ",".join(seeds)
    return out


def print_diff(old: dict[str, str] | None, new_values: dict, new_seeds: list[str]) -> None:
    if old is None:
        print("\n(no existing mangled.js — emitting fresh)")
        return
    flat_new = dict(new_values)
    flat_new["seedNames"] = ",".join(new_seeds)
    changed = []
    unchanged = 0
    for k, v in flat_new.items():
        ov = old.get(k)
        if ov is None:
            changed.append((k, "(new)", v))
        elif ov != v:
            changed.append((k, ov, v))
        else:
            unchanged += 1
    if not changed:
        print(f"\nNo changes — all {unchanged} mangled names already match.")
        return
    print(f"\nDiff vs existing mangled.js ({unchanged} unchanged, {len(changed)} changed):")
    width = max(len(k) for k, _, _ in changed)
    for k, ov, nv in changed:
        print(f"  {k:<{width}}  {ov}  ->  {nv}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    try:
        path, text = find_gameplay_dump()
    except DeriveError as e:
        sys.exit(f"error: {e}")

    print(f"Analyzing {path.name} ({len(text):,} chars)")

    p_start = player_class_start(text)
    g_start = game_class_start(text)
    print(f"  Player class @ char {p_start:,}, Game class @ char {g_start:,}")

    values: dict[str, str] = {}
    steps: list[tuple[str, callable]] = [
        ("player.netData",        lambda: derive_net_data(text, p_start)),
        ("player.localData",      lambda: derive_local_data(text, p_start)),
        ("player.pos",            lambda: derive_player_pos(text, p_start)),
        ("player.dir",            lambda: derive_player_dir(text, p_start)),
        ("player.posAlt",         lambda: derive_player_pos_alt(text, values["player.pos"], p_start)),
        ("netData.activeWeapon",  lambda: derive_field_on(text, values["player.netData"], "activeWeapon", "netData.activeWeapon", start=p_start)),
        ("netData.dead",          lambda: derive_field_on(text, values["player.netData"], "dead",         "netData.dead",         start=p_start)),
        ("netData.downed",        lambda: derive_field_on(text, values["player.netData"], "downed",       "netData.downed",       start=p_start)),
        ("localData.zoom",        lambda: derive_field_on(text, values["player.localData"], "zoom",       "localData.zoom",       start=p_start)),
        ("localData.curWeapIdx",  lambda: derive_field_on(text, values["player.localData"], "curWeapIdx", "localData.curWeapIdx", start=p_start)),
        ("localData.weapons",     lambda: derive_local_weapons(text, values["player.localData"], p_start)),
        ("game.localPlayer",      lambda: derive_game_local_player(text, g_start)),
        ("game.roster",           lambda: derive_game_roster(text, g_start)),
        ("game.inputBinds",       lambda: derive_game_input_binds(text, g_start)),
        ("pool.getAll",           lambda: derive_pool_get_all(text)),
    ]

    for label, fn in steps:
        try:
            values[label] = fn()
        except DeriveError as e:
            sys.exit(f"error: {e}")
        print(f"  {label:24s} -> {values[label]!r}")

    try:
        seeds = derive_seed_names(text)
    except DeriveError as e:
        sys.exit(f"error: {e}")
    print(f"  {'seedNames':24s} -> {seeds}")

    old = parse_existing_mangled()
    print_diff(old, values, seeds)

    if MANGLED_JS.exists():
        shutil.copy2(MANGLED_JS, BACKUP_JS)
        print(f"\nBackup written to {BACKUP_JS.name}")

    out = render_mangled_js(values, seeds, path.name)
    MANGLED_JS.write_text(out, encoding="utf-8")
    print(f"Wrote {MANGLED_JS.name} ({len(out):,} bytes)")


if __name__ == "__main__":
    main()
