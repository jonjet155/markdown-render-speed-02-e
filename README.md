# Markdown Render Speed 02 — Candidate E

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/markdown-render-speed-02)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A dependency-free, single-pass Markdown renderer that returns exactly the
HTML [marked 18.1.3](https://github.com/markedjs/marked) produces with its
default options (GFM on, breaks off), for the
[make.fun markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02).

## How it works

`parse.js` is a hand-written, index-scanning parser that emits marked-exact
HTML directly — no token tree, no AST. The block parser walks the document
line by line (ATX/setext headings, fenced and indented code, block quotes,
nested bullet/ordered/task lists, GFM tables, raw HTML blocks, thematic
breaks, link reference definitions), and the inline parser resolves
emphasis, links, images, code spans, autolinks and extended autolinks in a
single pass with a delimiter stack and a bracket stack, following the
CommonMark flanking and odd-match rules.

`main.ts` is the driver the harness runs: it reads `/input/cases.json`,
renders each case alone with `parse()`, and writes `/output/html.json`.

## Layout

- `parse.js` — the renderer (`export function parse(markdown)`)
- `main.ts` — the driver
- `LICENSE` — MIT

## Verify locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```
