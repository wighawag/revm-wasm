# ADR 0002: a raw C ABI instead of wasm-bindgen

- Status: accepted
- Date: 2026-07-31
- Applies to: `crates/wasm/src/lib.rs`, `packages/revm-wasm/src/instance.ts`

## Context

The feasibility spike this package was extracted from used `wasm-bindgen`. This package does not. That is a deliberate deviation from the source material and it deserves its own record, because "the spike used X" is otherwise a good enough reason to keep X.

The reason is **instance isolation**, and it comes from a bug the spike actually hit.

`wasm-bindgen --target web` emits an ES module that holds the instantiated exports in a module-level `let wasm`, and routes imported host functions through module-level bindings in a sibling module. Both are per *module instance*, not per *wasm instance*. Load two wasm builds in one JS realm through the same glue and they share those bindings: the second instance's linear memory ends up answering the first instance's state reads.

From part 3 of the spike report, verbatim in substance:

> Before it, loading two builds in one process silently made the second one's linear memory answer the first one's state reads, which is exactly what happened the first time I tried to benchmark the bloom against an ablated build. It was invisible: the run produced plausible numbers with the wrong sign.

The spike's fix was to append a `?dist=<name>` query string to the host module specifier so each build imported a *separate module instance* of the same file. That works for a benchmark harness. It is not something a published package can ship to consumers, because it makes "how many EVM instances can I create?" depend on a naming convention in a generated glue file.

## Decision

The wasm module exposes a **raw C ABI**. No `wasm-bindgen` anywhere in the build or at runtime.

- Host functions are declared with `#[link(wasm_import_module = "revm_wasm_host")] extern "C"`, so they appear directly in the wasm import section and are supplied **per `WebAssembly.instantiate`**.
- Exports are `#[no_mangle] pub extern "C" fn` taking and returning `u32`.
- One request blob goes in and one outcome blob comes out per call, through two reused buffers inside the module.

The TypeScript loader instantiates the module itself and binds the host through a closure over that instance's memory. Two instances in one page therefore cannot see each other, by construction rather than by convention. `packages/revm-wasm/test/isolation.test.ts` and the browser suite both pin this.

## Consequences

**Good.**

- The whole class of cross-instance leakage is gone, not worked around. A consumer can hold one instance per chain, or one per test, without knowing why that used to be dangerous.
- One fewer tool version affects the output bytes. Only rustc, wasm-opt and revm remain pinned (ADR 0005). Note the instruction this package was built to said to pin wasm-bindgen too; that instruction assumed wasm-bindgen was in the pipeline, and it no longer is.
- No JS glue file to publish, version or keep in sync. The `.wasm` **is** the artifact. That is worth about 3.3 KB gzipped on its own, and it removes the possibility of a glue/wasm mismatch entirely.
- The artifact is smaller: 420,025 gzipped against the spike's 434,009 for the wasm alone, and 437,336 including its glue.
- Argument marshalling got cheaper, not more expensive. wasm-bindgen's `call` took thirteen arguments, six of which were byte slices, and each of those was a `malloc` plus a copy across the boundary. One request blob is one allocation and one copy.

**Costs, stated plainly.**

- The request encoding is now this package's responsibility rather than a generated wrapper's. That is a real surface where an off-by-one can hide, which is why the request head is at fixed offsets, why the encoder lives in exactly one file, and why the differential corpus compares whole blobs rather than decoded fields.
- Anything that wanted to add a JS-visible export now needs a hand-written ABI entry rather than an attribute. This is a small package with a deliberately narrow API, so that cost is bounded.
- The spike's proven artifact is not the artifact we ship. That risk is retired by acceptance, not by argument: all nine fixtures, 63 calls, match outcomes recorded from **native** revm byte for byte, in Node, in Chromium and in WebKit.

## The boundary shape did NOT change

What is unchanged, on purpose, is the shape of the host interface, because it is a measured decision and not an incidental one:

- every state access is exactly one wasm-to-JS call;
- every argument is an integer offset into linear memory;
- the host writes its answer directly into that memory;
- nothing is serialised, boxed or allocated per access on either side;
- block numbers cross as two `u32` halves to avoid a BigInt per call.

The spike measured the crossing itself at about 0.51 microseconds against a null host, against about 1.30 for a `Map`-backed one. Changing the shape would move the smaller number.

## What would change this decision

- wasm-bindgen gaining a supported way to bind imports per instantiation rather than per module. Then the convenience would come without the hazard.
- A need for rich JS objects across the boundary. There is none: the one blob in, one blob out design is what keeps `js_sys` and `serde-wasm-bindgen` out of the artifact.
