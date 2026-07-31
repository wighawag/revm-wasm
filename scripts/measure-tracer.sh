#!/usr/bin/env bash
# What would enabling revm's `tracer` feature cost in the shipped artifact?
#
# v1 ships WITHOUT a tracer. This measures the future decision now, while it is
# nearly free to measure, so that decision is informed rather than speculative.
#
#   scripts/measure-tracer.sh
#
# Method: the ablation method from the spike reports. Build the same source
# twice, once with the feature and once without, and gzip both with the exact
# same invocation. Needs a Rust toolchain.
#
# READ THIS BEFORE QUOTING THE NUMBER
#
# 1. The cargo feature alone measures the LINKING FLOOR, not the cost of a
#    working tracer. Nothing in this build references the inspector machinery, so
#    LTO is free to drop most of it. A real tracer that buffers a trace in wasm
#    and returns it in the outcome would cost more than this number, not less.
# 2. Sub-kilobyte gzip deltas on a ~1.2 MB artifact are NOT reliable. The spike
#    measured the same feature at 238 bytes in one run and 439 in another, and
#    produced two confidently wrong numbers before a right one. If the delta
#    comes back under about a kilobyte, report it as "sign known, magnitude
#    approximate" and not as a figure.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/measurements"
mkdir -p "$OUT"

WASM_OPT="${WASM_OPT:-}"
if [ -z "$WASM_OPT" ]; then
	if command -v wasm-opt >/dev/null 2>&1; then
		WASM_OPT="wasm-opt"
	elif [ -x /tmp/wasmtools/node_modules/binaryen/bin/wasm-opt ]; then
		WASM_OPT="/tmp/wasmtools/node_modules/binaryen/bin/wasm-opt"
	else
		echo "wasm-opt not found; set WASM_OPT=/path/to/wasm-opt" >&2
		exit 1
	fi
fi
export WASM_OPT

build() {
	local name="$1" feats="$2"
	./scripts/build-wasm.sh --features "$feats" --out "$OUT/$name.wasm" >/dev/null
	gzip -9 -c "$OUT/$name.wasm" | wc -c
}

echo "measuring the tracer feature (ablation method, gzip -9 -c)"
BASE=$(build baseline "precompiles-all")
TRACER=$(build tracer "precompiles-all,measure-tracer")
DELTA=$((TRACER - BASE))

printf '%-34s %12s\n' 'shipped (no tracer feature)' "$BASE"
printf '%-34s %12s\n' 'with revm tracer feature' "$TRACER"
printf '%-34s %12s\n' 'delta' "$DELTA"

ABS=${DELTA#-}
if [ "$ABS" -lt 1024 ]; then
	echo
	echo "NOTE: |delta| < 1 KB. Per the spike's own negative result about this"
	echo "method, report this as 'sign known, magnitude approximate', not as a figure."
fi

node -e '
const fs = require("fs");
const out = process.argv[1];
const row = {
  measuredAt: new Date().toISOString(),
  method: "cargo feature ablation, gzip -9 -c, same source both sides",
  baselineGz: Number(process.argv[2]),
  tracerFeatureGz: Number(process.argv[3]),
  deltaBytes: Number(process.argv[4]),
  caveat: "The cargo feature alone measures the linking floor: nothing references the inspector machinery, so LTO drops most of it. A tracer that actually buffers a trace would cost MORE than this.",
};
fs.writeFileSync(out + "/tracer-size.json", JSON.stringify(row, null, 2) + "\n");
' "$OUT" "$BASE" "$TRACER" "$DELTA"

rm -f "$OUT"/baseline.wasm "$OUT"/tracer.wasm
echo "wrote measurements/tracer-size.json"
