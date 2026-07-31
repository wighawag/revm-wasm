# ADR 0001: all precompiles, opt-level 3, and why neither half is negotiable

- Status: accepted
- Date: 2026-07-31
- Applies to: the shipped `revm.wasm` artifact and `crates/*/Cargo.toml`

## Context

`revm-wasm` publishes one prebuilt WebAssembly artifact. Its build configuration is fixed: the **full mainnet precompile set** (`precompiles-all`), compiled at **`opt-level = 3`** with `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, then post-processed with `wasm-opt -O3`.

The artifact is around 425 KB gzipped. That is large enough that a future maintainer will, sooner or later, open this repository intending to make it smaller. There are exactly two obvious levers, and **both of them are traps**. This ADR exists so that maintainer finds out what breaks before they pull one.

Everything below was measured during the feasibility spike that this package was extracted from (`REVM-WASM-SPIKE.md` sections 2.2, 2.3, 2.4 and 5.4). The numbers are reproduced here rather than merely cited, because the reports live in a different repository.

## Decision

Ship one build: **all precompiles, `opt-level = 3`**. Do not subset the precompile set. Do not switch to `opt-level = "z"`.

## Half one: subsetting precompiles changes gas

The tempting lever is "we only need ecrecover, sha256, ripemd160, identity, modexp and bn254, so drop the rest". This is wrong for three separate reasons, in increasing order of severity.

### It barely saves anything

`revm-precompile` has **no per-precompile cargo features**. `k256`, `ark-bn254`, `ark-bls12-381`, `p256` and `aurora-engine-modexp` are unconditional dependencies. The only lever available is *reachability*: whether a `PrecompileFn` is ever statically referenced, so that LTO can drop it.

Reachability is then defeated by `revm::precompile::interface`:

```rust
static CRYPTO: OnceLock<Box<dyn Crypto>> = OnceLock::new();
pub fn crypto() -> &'static dyn Crypto { CRYPTO.get_or_init(|| Box::new(DefaultCrypto)).as_ref() }
```

`Crypto` is a trait whose *default method bodies* call every backend, and `crypto()` materialises a `Box<dyn Crypto>`. Constructing that trait object forces codegen of the whole vtable, so **any precompile that calls `crypto()` drags in BLS12-381, P-256, bn254 and modexp**. Measured consequence: the six-precompile build is 5% smaller than the full set at `-Oz` and 6% smaller at `-O3`. Six percent.

### It changes gas, which makes the build wrong rather than merely small

`handler::pre_execution::load_accounts` warms the precompile provider's `warm_addresses()` into the journal. Omit a precompile and its address is no longer pre-warmed, so touching it costs a **cold** access instead of a warm one.

Measured with a contract doing `BALANCE(0x08); BALANCE(0x09); BALANCE(0x0a)`:

| build | gas |
| --- | --- |
| all precompiles | 21,324 |
| common precompiles only | 26,324 (+5,000: 0x09 and 0x0a now cold) |
| no precompiles | 28,824 (+7,500: all three cold) |

Exactly **+2,500 gas per cold access to an omitted address** (2,600 cold against 100 warm). A subset build is not a smaller version of this package. It is a different, non-mainnet EVM that silently disagrees with every real node about gas. The consumer of this package (`embedded-eth-node`) exists to be indistinguishable from `@ethereumjs/vm`, so this alone is disqualifying.

### The measurement that "proves" subsetting works is very easy to fake

The spike's first measurement run reported 205 to 207 KB gzipped for *every* configuration, including "interpreter only, no precompiles", with function counts within 0.5% of each other. That result was wrong, and it was wrong **silently**: "no precompiles" was byte-for-byte the size of "all precompiles".

Three revm behaviours cause it, and all three must be addressed before any size number about precompiles means anything:

1. **`revm-precompile` has no per-precompile features** (above). The only lever is reachability.
2. **`MainBuilder::build_mainnet()` references every precompile.** It hardcodes `precompiles: EthPrecompiles::new(spec)`, which calls `Precompiles::new(..)`, which references all of them. Building through `build_mainnet()` and *then* overwriting `evm.precompiles` is too late: the static reference already exists. You must construct `Evm::new(ctx, instructions, precompiles)` directly.
3. **`EthPrecompiles::set_spec` rebuilds the map on every transaction.** `handler::pre_execution::load_accounts` calls `set_spec` per transaction, and `set_spec` does `self.precompiles = Precompiles::new(..)`. So assigning a custom map is defeated twice over: the static reference keeps the code alive, *and* your map is replaced at runtime.

This package carries the workaround (`FixedPrecompiles` in `crates/core/src/lib.rs`), which delegates `run` to the stock `EthPrecompiles` so that dispatch and gas accounting are unmodified revm, but makes `set_spec` a no-op on the map. With all three addressed, the "no precompiles" build dropped from 895,921 to 486,171 bytes unstripped (1,616 to 923 functions), and symbols matching `ark_|bn254|bls12|p256|modexp|secp256|ripemd` dropped from 338 to 0.

**`FixedPrecompiles` is kept even though this package ships the full set.** It is what makes the set *fixed*, i.e. what stops `set_spec` from rebuilding the map on every single transaction, and it is the seam a future custom-precompile capability plugs into. Removing it because "we ship all of them anyway" would reintroduce a per-transaction `Precompiles::new()` allocation and delete the extension point.

## Half two: `opt-level = "z"` costs 2.4x to 6x on keccak

`opt-level = "z"` roughly halves the artifact: 434 KB gzipped becomes about 216 KB. That is a real and tempting saving, and it costs the workload this package was built for.

Measured **paired**, `-Oz` and `-O3` back to back in each round so machine load hits both equally (MGas/s):

| round | arithmetic loop | keccak256 over 32 B | keccak256 over 256 B |
| --- | --- | --- | --- |
| Node 1 | 149 -> 191 | **21.3 -> 75.9** (3.6x) | 15.2 -> 126.7 |
| Node 2 | 149 -> 150 | **21.3 -> 51.0** (2.4x) | 14.6 -> 43.2 |
| Node 3 (loaded) | 47.7 -> 159 | **10.0 -> 63.8** (6.4x) | 10.3 -> 57.8 |
| Chromium | 107-144 -> 164-281 | **22.6-24.1 -> 72-129** (~5x) | 20.9-21.2 -> 64-123 |

The pattern is specific and consistent: `-Oz` barely affects the arithmetic loop and costs **2.4x to 6x on keccak**, which is what you would expect from the keccak-f1600 permutation not being unrolled. Note how stable the `-Oz` keccak figure is across quiet rounds (21.3, 21.3, 22.6, 24.1): that is a real ceiling, not noise.

At `-Oz` the keccak advantage over `@ethereumjs/evm` shrinks from roughly 16x to roughly 2.7x (21 against 7.7 MGas/s). Keccak-heavy execution is precisely the workload that motivated replacing `@ethereumjs/evm`, so `-Oz` throws away most of the reason this package exists.

One related finding, so nobody re-runs it: `wasm-opt` cannot recover the difference. A hybrid build (rustc `opt-level = 3`, then `wasm-opt -Oz`) lands within 0.4% of the full `-O3` build. **The size gap between the profiles is rustc's codegen, not binaryen's post-pass.**

## Consequences

- The artifact is roughly 425 KB gzipped and will not get materially smaller without giving up gas equivalence or keccak throughput.
- `FixedPrecompiles` must stay, and `Evm::new(..)` must be used instead of `build_mainnet()`, even though this build wants the full set.
- Any future size work should target a **separate build variant** (see ADR 0003), explicitly labelled with what it gives up, rather than changing this one.
- If a variant ever ships a subset of precompiles, it is **not mainnet-gas-equivalent** and must say so at the top of its documentation, in the same way a custom precompile must (ADR 0004).

## What would change this decision

- revm gaining genuine per-precompile cargo features **and** removing the `Box<dyn Crypto>` vtable materialisation, which together would make subsetting actually save bytes. It would still change gas.
- A future EIP pre-warming precompile addresses independently of the provider's `warm_addresses()`, which would decouple the set from gas. Unlikely.
- A consumer who explicitly does not need mainnet gas equivalence. That is a different package, or at minimum a different, loudly-labelled build variant.
