# ADR 0005: pin revm, rustc and wasm-opt; accept behaviourally, not byte for byte

- Status: accepted
- Date: 2026-07-31
- Applies to: `crates/Cargo.toml`, `crates/rust-toolchain.toml`, `scripts/build-wasm.sh`, the test suite

## Context

Three things move the bytes of the shipped artifact: the revm revision, the rustc version, and the wasm-opt version. If any of them floats, the published binary changes without a corresponding change in this repository, and nobody can say what a given release actually contained.

## Decision

**Pin all three.**

| what | pinned to | where |
| --- | --- | --- |
| revm | `bluealloy/revm` rev `640eafa91beae73bafb7776845d53133f603048f` (crate version 42.0.1) | `crates/Cargo.toml` |
| rustc | 1.91.1 | `crates/rust-toolchain.toml` |
| wasm-opt (binaryen) | 131 | `scripts/build-wasm.sh` header, CI workflow |

revm is pinned **by exact revision**, not by a version range and not by a crates.io version. It is never vendored and never forked. `Cargo.lock` is committed, so every transitive dependency is pinned too, which matters more than it looks: the tracer build blocker in ADR 0004 is a transitive dependency graph problem, not a revm problem.

Both the revm version and the exact revision are baked into the artifact at build time and are readable at runtime:

```ts
evm.revmVersion; // '42.0.1'
evm.revmRevision; // '640eafa91beae73bafb7776845d53133f603048f'
```

so a downstream bug report can state exactly what was running, and does not depend on anyone correctly remembering which release they installed.

**wasm-bindgen is deliberately absent from this list.** It is no longer in the pipeline at all; see ADR 0002.

## And yet: the acceptance check is behavioural

Pinning makes a rebuild *reproducible in practice on a matching toolchain*. It does not make the bytes a contract, and they must not be treated as one.

**Do not assert that a rebuilt `.wasm` is byte-identical to the committed one.** Reproducible wasm is genuinely hard, and the evidence is local: three builds of *identical source* on this machine produced 420,025, 420,027 and 420,029 bytes gzipped. Cross a rustc patch release or a binaryen version and the difference is much larger. A byte-identity assertion is a test that fails for the wrong reason and teaches contributors to ignore it.

**Assert behaviour instead.** `pnpm test` replays the nine-fixture differential corpus (63 calls) against outcomes recorded from **native** revm and compares the whole outcome blob as hex: status, gas used, total gas spent, refunds, return data, every log, the receipts bloom, every account, every changed slot, emitted code bytes and the effective gas price. That check has already caught a real non-conformance, which is what makes it the right bar rather than merely the convenient one.

The browser suite runs the same corpus in Chromium (V8) and WebKit (JavaScriptCore), because a wasm module behaves differently enough across engines that testing one and implying two is a real mistake.

## Consequences

- A rebuild is a deliberate act with a known toolchain, recorded in `scripts/build-wasm.sh` and in this ADR.
- Bumping revm is a changeset-worthy, user-facing change: the runtime-reported `revmVersion` and `revmRevision` both move, and the differential corpus must still pass unmodified. If it does not, the corpus is the news, not the obstacle.
- CI can verify the committed artifact behaves correctly without any Rust at all, which is what lets the test job stay fast and lets contributors run it.
- Nothing in CI verifies that the committed `.wasm` was actually built from the committed Rust source. That is an accepted gap: the artifact is reviewed as a diff (ADR 0003) and validated behaviourally. Closing it properly means a reproducible-build job, which is a larger commitment than the risk currently justifies.
