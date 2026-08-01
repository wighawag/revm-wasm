#!/usr/bin/env bash
# Build the shipped `revm.wasm` artifact.
#
#   scripts/build-wasm.sh                      # the shipped configuration
#   scripts/build-wasm.sh --features X,Y       # a measurement configuration
#   scripts/build-wasm.sh --profile minsize    # the size-optimised profile (NOT shipped)
#   scripts/build-wasm.sh --out /tmp/x.wasm    # write somewhere other than the package
#
# THIS IS NOT PART OF `pnpm build`, deliberately. It needs a Rust toolchain, and
# the whole point of this package is that a consumer, a contributor running the
# test suite, and the publish step never need one. The output is committed; see
# docs/adr/0003-commit-the-wasm.md.
#
# Requires:
#   rustup toolchain install 1.91.1
#   rustup target add wasm32-unknown-unknown --toolchain 1.91.1
#   wasm-opt (binaryen) 131 on PATH, or WASM_OPT=/path/to/wasm-opt
#
# All three of rustc, wasm-opt and revm move the output bytes, so all three are
# pinned. The acceptance check for a rebuild is BEHAVIOURAL, not byte-identity:
# run `pnpm test`, which replays the recorded fixtures. Reproducible wasm across
# tool versions is genuinely hard and asserting on bytes would be a test that
# fails for the wrong reason.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# The shipped feature set. `--no-default-features` below means this list is the
# whole configuration, so anything in the crates' `default` belongs here too.
FEATURES="precompiles-all,relaxed-validation"
PROFILE="release"
OUT="$ROOT/packages/revm-wasm/wasm/revm.wasm"
KEEP_UNOPT=""

while [ $# -gt 0 ]; do
	case "$1" in
	--features)
		FEATURES="$2"
		shift 2
		;;
	--profile)
		PROFILE="$2"
		shift 2
		;;
	--out)
		OUT="$2"
		shift 2
		;;
	--keep-unopt)
		KEEP_UNOPT=1
		shift
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 2
		;;
	esac
done

case "$PROFILE" in
release) OPT_FLAG="-O3" ;;
minsize) OPT_FLAG="-Oz" ;;
probe) OPT_FLAG="-O3" ;;
*)
	echo "unknown profile: $PROFILE" >&2
	exit 2
	;;
esac

WASM_OPT="${WASM_OPT:-}"
if [ -z "$WASM_OPT" ]; then
	if command -v wasm-opt >/dev/null 2>&1; then
		WASM_OPT="wasm-opt"
	elif [ -x /tmp/wasmtools/node_modules/binaryen/bin/wasm-opt ]; then
		WASM_OPT="/tmp/wasmtools/node_modules/binaryen/bin/wasm-opt"
	else
		echo "wasm-opt not found; set WASM_OPT=/path/to/wasm-opt (binaryen 131)" >&2
		exit 1
	fi
fi

# Binaryen must accept everything rustc 1.91 emits for this target.
OPT_FEATURES=(
	--enable-bulk-memory
	--enable-bulk-memory-opt
	--enable-nontrapping-float-to-int
	--enable-sign-ext
	--enable-mutable-globals
	--enable-multivalue
	--enable-reference-types
	--enable-extended-const
)

echo "building: profile=$PROFILE features=$FEATURES wasm-opt=$OPT_FLAG"
(cd crates && cargo build \
	--profile "$PROFILE" \
	--target wasm32-unknown-unknown \
	-p revm-wasm-abi \
	--no-default-features \
	--features "$FEATURES")

RAW="$ROOT/crates/target/wasm32-unknown-unknown/$PROFILE/revm_wasm.wasm"
mkdir -p "$(dirname "$OUT")"
UNOPT="${OUT%.wasm}.unopt.wasm"
cp "$RAW" "$UNOPT"
"$WASM_OPT" "$OPT_FLAG" "${OPT_FEATURES[@]}" "$UNOPT" -o "$OUT"

# `gzip -9 -c <file>` is the exact invocation every size figure in this repo and
# in the spike reports uses. Two traps that are each big enough to fake a 1%
# delta: Node's own zlib at level 9 lands ~0.6% higher than GNU gzip on these
# artifacts, and `gzip -c <file>` stores the filename in the header while
# `gzip -c < file` does not. One implementation, one invocation.
GZ=$(gzip -9 -c "$OUT" | wc -c)

printf '%-14s %12s %12s %12s\n' ARTIFACT RAW OPT GZIP
printf '%-14s %12s %12s %12s\n' \
	"$(basename "$OUT")" \
	"$(stat -c%s "$UNOPT")" \
	"$(stat -c%s "$OUT")" \
	"$GZ"

[ -n "$KEEP_UNOPT" ] || rm -f "$UNOPT"
