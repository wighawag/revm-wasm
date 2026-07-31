---
'revm-wasm': minor
---

Initial release: revm compiled to WebAssembly with a typed JavaScript API.

An UNOFFICIAL binding for [revm](https://github.com/bluealloy/revm) (bluealloy, MIT), pinned at revision `640eafa91beae73bafb7776845d53133f603048f` (crate version 42.0.1). Deliberately not a general-purpose binding: the build configuration is fixed, the host interface has one shape, and v1 ships no custom precompiles and no inspector.

**What is in it**

- A prebuilt `revm.wasm` (420 KB gzipped) shipped inside the tarball. No Rust toolchain is ever needed in a consuming project or its CI.
- `createRevm` / `createRevmSync`, taking wasm as bytes, a URL, a `Response` or a compiled `WebAssembly.Module`.
- `call` (read-only), `transact` (committing), `create` (contract creation) and `recoverSigner`. Every entry point takes an options object, never positional arguments.
- `StateStore`: a synchronous state interface that is an adapter over the consumer's own storage. `MemoryStore` is provided for tests, not as the place state lives. The raw pointer-level `HostFunctions` interface is exported for consumers who want zero marshalling.
- Typed outcomes with no byte offsets, flag bits or packed account layouts: named booleans (`created`, `deleted`, `selfdestructed`), `bigint` balances, and a `logsBloom` that is always 256 bytes.
- `revmVersion`, `revmRevision`, `outcomeFormatVersion` and `abiVersion` readable at runtime, so a bug report can state exactly what was running.

**Build configuration, which is fixed**

Every precompile, at `opt-level = 3`. Neither half is negotiable: omitting a precompile stops its address being pre-warmed and costs +2,500 gas per touch, and `opt-level = "z"` halves the artifact while costing 2.4x to 6x on keccak. See `docs/adr/0001-all-precompiles-opt-level-3.md`.

**Notable design decisions**

- No wasm-bindgen. The module exposes a raw C ABI and host functions are bound per `WebAssembly.instantiate`, so two instances in one page cannot see each other's linear memory. The glue-based approach made that failure silent and plausible-looking.
- Storage is indexed per account, so `clearStorage` is O(one account) rather than O(total state). `SELFDESTRUCT` and every contract creation hit it.
- Map keys pack two bytes per UTF-16 code unit instead of two hex characters per byte: 3.5x faster key handling on this machine.

**Testing**

Nine fixtures, 63 calls, compared byte for byte against outcomes recorded from **native** revm, run in Node, Chromium (V8) and WebKit (JavaScriptCore). The suite needs no Rust toolchain.
