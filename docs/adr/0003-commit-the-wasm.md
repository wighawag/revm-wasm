# ADR 0003: the built `.wasm` is committed, not built at release

- Status: accepted
- Date: 2026-07-31
- Applies to: `packages/revm-wasm/wasm/revm.wasm`, `.gitignore`, `package.json`

## Context

The package publishes a prebuilt WebAssembly artifact. It has to be produced by a Rust toolchain somewhere. There are two places that can happen: a contributor's machine, with the result committed to git, or a release job, with the result produced fresh and never stored.

## Decision

**The optimised `revm.wasm` is committed to the repository**, and it is listed in the package's `files` array so it lands in the published tarball.

```json
"files": ["dist", "src", "wasm/revm.wasm"]
```

The intermediate pre-`wasm-opt` artifact (`*.unopt.wasm`) is gitignored. Only the shipped bytes are tracked.

## Why

**It keeps `prepublishOnly` free of Rust.** The release ritual is the template's: `pnpm format:check && pnpm build && pnpm test`, then `changeset publish`. None of that needs a Rust toolchain, a pinned rustc, a wasm32 target or binaryen. If the wasm were built at release, every one of those would have to exist in the release environment and be pinned there, and a release would be able to fail for a reason unrelated to the release.

**It keeps the test suite runnable with no toolchain.** This is the property most worth protecting. A contributor clones, runs `pnpm install && pnpm test`, and the differential corpus runs against the real artifact. The recorded expectations are checked in for the same reason. Nobody has to install Rust to fix a typo in the decoder, and nobody has to install Rust to find out whether they broke it.

**The binary is not incidental weight.** This package's entire reason to exist IS that binary. A repository whose deliverable is a 1.2 MB wasm artifact, storing that artifact, is storing its deliverable. The usual argument against committing build output (it is derived, it bloats history, it goes stale) applies to output nobody would miss. It does not apply here.

**Forgetting `files` is a silent failure.** The house template ships only `dist` and `src`. A `.wasm` left out of that list produces a package that installs, resolves, type-checks, and then fails at runtime in a consumer's browser. That is why `wasm/revm.wasm` is in `files` explicitly and why a test asserts the artifact loads from its packaged location.

## Consequences

- Rebuilding the artifact is an explicit, reviewable commit. A diff that changes `revm.wasm` is visible in review, which is the right amount of friction for changing the thing the package is.
- Git history grows by roughly 1.2 MB per rebuild. Rebuilds are rare (a revm bump, a toolchain bump, an ABI change), so this is acceptable. If it ever stops being acceptable, the answer is a release-built artifact plus a pinned toolchain in the release job, and this ADR is what should be revisited first.
- **The acceptance check for a rebuild is behavioural, not byte-identity.** Reproducible wasm is genuinely hard: rustc, wasm-bindgen and wasm-opt versions all move the bytes, and even two builds of identical source on this machine came out 420,025, 420,027 and 420,029 bytes gzipped. So the check is `pnpm test`: gas, status, return data, logs, bloom, state and effective gas price must match the recorded native-revm outcomes. Never assert the bytes match. See ADR 0005.
- The `build:wasm` script is deliberately NOT part of `pnpm build`. `pnpm build` is `tsc`, and a contributor running it must not need cargo.

## What would change this decision

- The artifact growing large enough that git history becomes a real problem. Several rebuilds per week rather than several per year.
- A requirement to publish several build variants (ADR 0004), where committing each one multiplies the cost. At that point a release job that builds all variants from a pinned toolchain, with the behavioural acceptance suite gating it, is the better shape.
