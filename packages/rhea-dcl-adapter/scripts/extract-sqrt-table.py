#!/usr/bin/env python3
"""Regenerates src/sqrt-table.ts from Rhea's frontend source so the constants are never retyped.

Usage: git clone --depth 1 https://github.com/ref-finance/ref-ui /tmp/ref-ui
       python3 scripts/extract-sqrt-table.py /tmp/ref-ui/src/services/compute_liquidity.ts > src/sqrt-table.ts
(The checked-in file was generated from ref-ui commit 1938efc.)
"""
import re, sys

src = open(sys.argv[1]).read()
body = src[src.index('const get_sqrt_price'):src.index('const update_value')]
steps = re.findall(r"(0x[0-9a-f]+),\s*new BigNumber\('(0x[0-9a-f]+)'\)", body)
assert len(steps) == 19, len(steps)
print("// Machine-extracted from ref-finance/ref-ui src/services/compute_liquidity.ts `get_sqrt_price`")
print("// (itself a port of iZiSwap LogPowMath.sol). Extracted by script, not retyped.")
print("// [bit mask of |point|, Q128 multiplier]")
print("export const SQRT_PRICE_STEPS: ReadonlyArray<readonly [number, bigint]> = [")
for a, b in steps:
    print(f"  [{a}, {b}n],")
print("];\n")
print("/** Q128 start value when bit 0 of |point| is clear / set. */")
print("export const SQRT_PRICE_INIT_EVEN = 0x100000000000000000000000000000000n;")
print("export const SQRT_PRICE_INIT_ODD = 0xfffcb933bd6fad37aa2d162d1a594001n;")
