#!/usr/bin/env python3
"""Fetch survev.io HTML, find /js/ script references, download them, and prettify."""

import os
import re
import sys
import urllib.parse
import urllib.request

try:
    import jsbeautifier
except ImportError:
    sys.exit("jsbeautifier not installed. Run: pip install jsbeautifier")

BASE_URL = "https://survev.io"
OUTPUT_DIR = "js_dump"
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


def main() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Fetching {BASE_URL} ...")
    html = fetch(BASE_URL).decode("utf-8", errors="replace")

    js_paths = find_js_paths(html)
    if not js_paths:
        sys.exit("No /js/ references found in HTML.")

    print(f"Found {len(js_paths)} script reference(s).")

    for path in js_paths:
        url = urllib.parse.urljoin(BASE_URL, path)
        filename = os.path.basename(path)
        out_raw = os.path.join(OUTPUT_DIR, filename)
        out_pretty = os.path.join(OUTPUT_DIR, filename.removesuffix(".js") + "_formatted.js")

        print(f"  -> {url}")
        try:
            src = fetch(url).decode("utf-8", errors="replace")
        except Exception as e:
            print(f"     failed: {e}")
            continue

        with open(out_raw, "w", encoding="utf-8") as f:
            f.write(src)
        with open(out_pretty, "w", encoding="utf-8") as f:
            f.write(prettify(src))

    print(f"Done. Output in ./{OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
