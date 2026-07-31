# ADR 0004: what v1 deliberately leaves open, and the rules for adding it

- Status: accepted
- Date: 2026-07-31
- Applies to: the whole public API

## Context

Three capabilities are out of scope for v1 and are likely later:

1. an execution **tracer**;
2. **custom precompiles** (revm exposes `PrecompileProvider`, and the spike already implemented one);
3. additional **build variants**, such as a size-optimised artifact.

None of them should require a breaking change to add. This ADR records the four decisions in v1 that keep them additive, and the two rules that must be obeyed when they are added.

## Decision: the four things v1 does to stay open

### 1. Options objects everywhere, never positional arguments

`createRevm({...})`, `call({...})`, `transact({...})`, `create({...})`, `recoverSigner({...})`. A new option is a non-breaking change; a new positional argument is not. This is why `call(caller, to, data, gasLimit, value, spec, chainId, ...)` (the spike's thirteen-argument entry point) is not the shape shipped, even though it was proven.

### 2. The outcome format's discipline is an explicit, documented invariant

- **The head stays at fixed offsets across versions.** `status | gasUsed | totalGasSpent | refunded | returnData` is at identical byte offsets in v1, v2 and v3 of the format, and will be in v4.
- **New sections are appended after it**, never inserted into it.
- **The format version is readable at runtime** (`revm.outcomeFormatVersion`), so a decoder can refuse a format it does not understand instead of misreading it.

That discipline is the only reason a downstream decoder survived v1 to v2 to v3 while the format gained logs, code bytes, a conditional bloom and a trailing effective gas price. A trace section would be exactly the same additive move: appended, gated, versioned.

See `docs/outcome-format.md` for the layout and for the two conditional fields a hand-rolled decoder gets wrong.

### 3. Flag-word bits 4 and above are unallocated

The per-call flag word currently uses four bits:

| bit | name |
| --- | --- |
| 0 | `COMMIT` |
| 1 | `CREATE` |
| 2 | `RELAX_VALIDATION` |
| 3 | `CHECK_NONCE` |

**Bits 4 and above are reserved and unallocated.** A future capability can be enabled per call by setting a new bit, with no new argument and no change to any signature. An artifact that does not know a bit ignores it, so an older artifact paired with a newer caller degrades to "the capability did not happen" rather than trapping.

Bit 2 stays allocated even though the shipped build does not enable the `relaxed-validation` cargo feature, so that the meaning of bit 2 can never be quietly reused for something else.

### 4. The request blob has the same discipline

Its head is at fixed offsets 0..140, the calldata and the fee/typed section are length-prefixed after it, and a new section is appended rather than inserted.

## Rule one: a tracer must BUFFER IN WASM, not call back per step

When a tracer is added, the trace must be **accumulated inside wasm and returned as a section of the outcome blob**. It must not be a per-opcode JavaScript callback.

The arithmetic is not close. A state read currently costs one boundary crossing per **cold** access. A callback per step would be one crossing per **opcode**, which is millions of crossings on the workloads this package exists for. That difference is a large part of why a callback-per-step competitor measures an order of magnitude slower than this approach. The boundary crossing itself was measured at about 0.51 microseconds; multiply by an opcode count and the tracer costs more than the execution.

Concretely: a new flag bit turns tracing on for one call, the trace is appended to the outcome as a new section after the existing ones, and `outcomeFormatVersion` goes to 4.

### What we already know it costs, and what we do not

Measured on this machine, by the ablation method, and recorded in `measurements/tracer-size.json`:

| build | gzipped |
| --- | --- |
| shipped (no tracer feature) | 420,029 |
| `--features measure-tracer` (revm's `tracer` on) | 422,628 |
| **delta** | **+2,599 bytes, +0.62%** |

Two caveats that matter more than the number:

- **This is the linking floor, not the cost of a working tracer.** Nothing in that build references the inspector machinery, so LTO drops most of it. A tracer that actually buffers a trace will cost more than 2.6 KB, not less. The number is a lower bound.
- **The delta is above the reliability threshold, but only just.** The spike's own negative result about this method is that sub-kilobyte deltas on an artifact this size are not trustworthy: the same feature measured 238 bytes in one run and 439 in another, and a mis-scoped lever produced a confident, precise, wrong 455 bytes for something that was actually 1,700. At 2.6 KB this is outside that band, so it is reported as a figure rather than as a sign, but it should not be quoted to the byte.

### A blocker a future tracer has to clear first

**revm's `tracer` feature does not build for `wasm32-unknown-unknown` as it stands.** Enabling it transitively enables `std` across the revm stack, which enables `k256/std`, which enables `elliptic-curve` -> `rand_core/getrandom`, and getrandom 0.2 has no backend for that target:

```
error: the wasm32-unknown-unknown targets are not supported by default,
       you may need to enable the "js" feature
```

This contradicts part 1 of the spike report, whose feature table lists `tracer` and `std` as building for wasm32. Re-checked today against the same revm checkout the spike used, both now fail, so the dependency graph has moved since that table was written. Reported here rather than quietly worked around.

The measurement above was obtained by registering a **stub** getrandom backend (`getrandom`'s `custom` feature plus `register_custom_getrandom!`) that always returns `Error::UNSUPPORTED`. An EVM never asks for randomness, so the stub is unreachable. Deliberately NOT getrandom's `js` feature, which would drag wasm-bindgen and js-sys back in and make the measured delta meaningless (and undo ADR 0002).

A real tracer therefore needs one of: the stub above made permanent and documented, an upstream fix so `tracer` does not imply `std`, or getrandom 0.3 with `getrandom_backend="wasm_js"`.

## Rule two: a custom precompile is a LOUD opt-in that leaves mainnet gas equivalence

`FixedPrecompiles` in `crates/core/src/lib.rs` is already the seam: it is a `PrecompileProvider` whose set is fixed at construction and whose `set_spec` does not rebuild the map. Adding a custom precompile is a matter of extending that set, not of restructuring anything.

The thing that must not be quiet is the consequence. **A custom precompile changes gas relative to mainnet.** Its address has to be pre-warmed by `warm_addresses()` to be cheap, and a mainnet EVM does not have that address at all, so:

- with the address pre-warmed, touching it costs 100 gas here and 2,600 on mainnet;
- without it, the precompile is 2,500 gas more expensive on every touch.

Either way the build is no longer mainnet-gas-equivalent. That equivalence is the property the consumer's entire cross-engine test gate exists to protect: `embedded-eth-node`'s acceptance bar is that a transaction executed through this package is indistinguishable from an `@ethereumjs/vm` `runTx` in receipt and post-state, and a custom precompile breaks that by construction.

So when the capability lands it must be:

- **explicit per instance or per call**, never a default and never inherited from an environment;
- **named in the option** in terms of what it gives up, not just what it adds;
- **stated at the top of its documentation**, in the same place and the same tone as ADR 0001's warning about subsetting;
- **reflected in the runtime build info**, so a bug report from a non-mainnet-equivalent instance says so without anyone having to ask.

## Rule three: a build variant is a separate artifact, loudly labelled

If a size-optimised variant is ever published, it is an additional `.wasm` with its own entry point, not a change to this one. ADR 0001 has the numbers on what `-Oz` costs (2.4x to 6x on keccak) and what a precompile subset costs (gas equivalence). A variant may choose to pay those; it must say which it paid.

## Consequences

- v1's API can grow all three capabilities without a major version bump.
- The reserved flag bits and the append-only formats are load-bearing and must not be "tidied up".
- The tracer's size cost is known well enough to plan with, and its build blocker is known before anyone starts.
