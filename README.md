# Row by Row — png-squeeze-01-run-20261127

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/BGBug22/png-squeeze-01-run-20261127-entry/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/BGBug22/png-squeeze-01-run-20261127-entry/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

Entry for <https://make.fun/c/png-squeeze-01-run-20261127>: a lossless PNG recompressor in one file, Node built-ins only.

It narrows the colour type (palette, grey, grey+alpha, RGB, RGBA at 8 bits), picks a filter per row along a cheapest path,
and writes the pixel stream with its own DEFLATE coder (kept matches, repeated shortest-path parses, merged blocks).
Every stream is inflated again and compared before it is used; zlib level 9 is the fallback.

    MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

MIT licensed.
