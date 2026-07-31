# Architecture decision records

| # | title | the one-line reason it exists |
| --- | --- | --- |
| [0001](0001-all-precompiles-opt-level-3.md) | all precompiles, opt-level 3, and why neither half is negotiable | someone will try to make the 420 KB artifact smaller, and both obvious levers are traps |
| [0002](0002-raw-abi-no-wasm-bindgen.md) | a raw C ABI instead of wasm-bindgen | module-level glue made two instances share linear memory, silently |
| [0003](0003-commit-the-wasm.md) | the built `.wasm` is committed, not built at release | so the tests, and the publish step, need no Rust |
| [0004](0004-what-v1-leaves-open.md) | what v1 deliberately leaves open, and the rules for adding it | a tracer, custom precompiles and build variants must stay additive |
| [0005](0005-pinned-toolchain.md) | pin revm, rustc and wasm-opt; accept behaviourally, not byte for byte | three things move the bytes, and the bytes are not the contract |

If you are about to change the build configuration, read 0001 first. If you are about to add a capability, read 0004 first.
