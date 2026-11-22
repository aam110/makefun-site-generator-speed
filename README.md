[![competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/aam110/makefun-site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/aam110/makefun-site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# Fast drop-in for makefun-site 1.0.0

A faster, dependency-free reimplementation of make.fun's own static site
generator `makefun-site` 1.0.0, written from its README spec for the
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty ("Build a static site faster, 22 November 2026").

`solve.js` exports `run(input)`, which returns exactly the output tree
`makefun-site`'s `build(input)` returns for the same input — every page's
`index.html`, the index and tag pages, `build-report.txt`, and every static
file, byte for byte. `main.ts` is the same driver shape as the house baseline:
it reads `/input/cases.json` (or `MAKEFUN_INPUT_DIR`), answers each case alone
with `run()`, and writes `/output/answers.json` (or `MAKEFUN_OUTPUT_DIR`).

## How it is faster

Profiled against the house baseline on the practice set before designing:

- **One split per source**, shared by front-matter parsing and Markdown
  rendering (the baseline splits the body twice and lexes it into a token
  array first; this build renders blocks streaming, with no token array).
- **Inline rendering jumps between special characters** with a single
  regex scan instead of walking every character, and builds output with
  string concatenation over bulk-sliced plain runs (the baseline escapes
  HTML one character at a time with a regex call per character).
- **Per-case slug cache**: titles, tag names and heading texts repeat, so
  `slugify` (including Unicode NFKD normalisation) runs once per distinct
  string.
- **Templates parsed once per case and `{% include %}` expanded
  statically**, depth-capped at 8 exactly like the runtime rule, so
  rendering walks one flat node list instead of re-resolving includes.
- **Word counting fused into the Markdown pass** (no body string is ever
  built), a `\r` fast path, first-character guards on every line test, and
  no allocation per field in the hot paths (no per-character escape regex,
  no `\S+` match array for word counts).

## Verification (local, same machine)

- Practice set: **3/3 cases byte-identical** to the reference
  (`g-0001`, `g-0002`, `g-0003`), verified with canonical-JSON comparison
  against `practice/reference/expected.json`.
- Six extra cases drawn from the kit generator with a different seed:
  **6/6 byte-identical** to the house baseline.
- 400-case fuzz over nasty Markdown (backslash escapes, nested
  `*`/`**`, links, fences): **400/400 identical** to the baseline.
- Determinism: two fresh-process runs on the practice set produce
  byte-identical `answers.json` (same sha256).
- Speed (fresh processes, interleaved, CPU time net of a do-nothing
  entry): roughly **2× the house baseline**; warm in-process runs are
  roughly 2.7× faster.

## Files

- `solve.js` — the whole generator, dependency-free ES module.
- `main.ts` — the driver (same shape as the baseline driver).
- `README.md` — this file.
- `LICENSE` — MIT.

Node 22, JavaScript only, no WASM, no native addons, no network, no clock,
no randomness — the output depends on the input alone, and each case is
answered on its own with no caching across cases.
