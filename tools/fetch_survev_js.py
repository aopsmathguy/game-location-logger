#!/usr/bin/env python3
"""Fetch survev.io HTML, find /js/ script references, download them, and prettify.

survev's bundle filenames are content-hashed, so each deploy lands under a new
name. Files from previous fetches are deleted once the current fetch has fully
succeeded, leaving js_dump/ holding exactly one build — otherwise stale
gameplay bundles accumulate and derive_mangled.py has to guess which is
current. Pass --keep-old to leave them alone.

The webapp calls this with --paths, handing over the bundle references it just
saw in the HTML it was proxying. That skips a second HTML fetch and closes the
window where survev could redeploy between the server reading the page and this
script asking for its own copy — which would leave js_dump/ holding a build the
player is not actually running.
"""

import argparse
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import jsbeautifier
except ImportError:
    sys.exit("jsbeautifier not installed. Run: pip install jsbeautifier")

BASE_URL = "https://survev.io"

# Anchored at the repo root, not the cwd: the webapp spawns this script from
# its own directory, and js_dump/ is a repo-level cache shared with
# derive_mangled.py.
REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "js_dump"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def find_js_paths(html: str) -> list[str]:
    # Match anything that looks like a /js/<file>.js reference (src="...", href="...", or raw)
    paths = set(re.findall(r'["\'\(](/js/[^"\'\)\s]+\.js)', html))
    paths.update(re.findall(r'(/js/[A-Za-z0-9_\-]+\.js)', html))
    return sorted(paths)


def prettify(src: str) -> str:
    opts = jsbeautifier.default_options()
    opts.indent_size = 4
    opts.preserve_newlines = True
    return jsbeautifier.beautify(src, opts)


def prune_stale(keep: set[str]) -> None:
    """Delete .js files in OUTPUT_DIR that aren't part of the current fetch.

    Only .js files are considered, so anything else the user keeps alongside
    the dumps survives. Callers must only invoke this after a fully successful
    fetch — a partial one would make still-needed bundles look stale.
    """
    stale = sorted(p for p in Path(OUTPUT_DIR).glob("*.js") if p.name not in keep)
    if not stale:
        return
    print(f"Removing {len(stale)} file(s) from previous fetches:")
    for p in stale:
        print(f"  - {p.name}")
        p.unlink()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--keep-old",
        action="store_true",
        help=f"don't delete previous fetches' files from {OUTPUT_DIR}",
    )
    ap.add_argument(
        "--paths",
        metavar="PATH",
        nargs="+",
        help="download these /js/ paths instead of scraping the HTML for them. "
        "Must be the complete set for the build, since anything not listed is "
        "treated as stale and pruned.",
    )
    ap.add_argument(
        "--base-url",
        default=BASE_URL,
        help=f"origin to download from (default: {BASE_URL})",
    )
    args = ap.parse_args()

    base_url = args.base_url.rstrip("/")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if args.paths:
        js_paths = sorted(set(args.paths))
        print(f"Using {len(js_paths)} script reference(s) supplied by --paths.")
    else:
        print(f"Fetching {base_url} ...")
        html = fetch(base_url).decode("utf-8", errors="replace")

        js_paths = find_js_paths(html)
        if not js_paths:
            sys.exit("No /js/ references found in HTML.")

        print(f"Found {len(js_paths)} script reference(s).")

    keep: set[str] = set()
    failed = 0

    for path in js_paths:
        url = urllib.parse.urljoin(base_url + "/", path.lstrip("/"))
        filename = os.path.basename(path)
        out_raw = os.path.join(OUTPUT_DIR, filename)
        out_pretty = os.path.join(OUTPUT_DIR, filename.removesuffix(".js") + "_formatted.js")

        print(f"  -> {url}")
        try:
            src = fetch(url).decode("utf-8", errors="replace")
        except Exception as e:
            print(f"     failed: {e}")
            failed += 1
            continue

        with open(out_raw, "w", encoding="utf-8") as f:
            f.write(src)
        with open(out_pretty, "w", encoding="utf-8") as f:
            f.write(prettify(src))
        keep.update((os.path.basename(out_raw), os.path.basename(out_pretty)))

    # Never prune on an incomplete fetch: a bundle that failed to download this
    # run may still be present from the last one, and deleting it would leave
    # js_dump/ with no usable gameplay bundle at all.
    if not keep:
        sys.exit(f"No scripts downloaded — leaving {OUTPUT_DIR} untouched.")
    if args.keep_old:
        print("Keeping previous fetches' files (--keep-old).")
    elif failed:
        print(f"{failed} download(s) failed — skipping cleanup, previous files left in place.")
    else:
        prune_stale(keep)

    print(f"Done. Output in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
