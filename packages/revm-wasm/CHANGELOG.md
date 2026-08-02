# revm-wasm

## 0.3.1

### Patch Changes

- d302e99: Fix intrinsic gas computed at wrong spec (GitHub issue #4)

  `CallExecutor::new` set `CfgEnv::spec` directly, which left `CfgEnv::gas_params`
  at the `Context::mainnet()` default (`SpecId::OSAKA`). The intrinsic-gas table
  therefore always carried EIP-3860's initcode word cost (introduced in Shanghai)
  and EIP-7623's calldata floor (introduced in Prague), regardless of the spec
  the caller requested.

  This caused two observable bugs on pre-Shanghai and pre-Prague forks:

  1. `Outcome.gasUsed` reported the EIP-7623 calldata floor on specs that predate
     Prague.
  2. EIP-3860's initcode word cost was _charged_ on specs that predate Shanghai
     (`BERLIN`, `LONDON`, `MERGE`).

  Opcode gating was unaffected because the instruction table is built from the
  correct spec; only the intrinsic-gas path used the stale `gas_params`.

  The fix replaces `c.spec = spec` with `c.set_spec_and_mainnet_gas_params(spec)`,
  which rebuilds the gas table for the requested spec (and enables EIP-8037/EIP-2780
  for AMSTERDAM and later).

## 0.3.0

### Minor Changes

- 778d788: Expose `disableEip3607` on `ExecuteOptions`, so a `call()` can be made from a contract address.

  EIP-3607 rejects a transaction whose sender has deployed code. It is a transaction-validity rule, not an execution rule — it stops a transaction being _sent_ from an address that carries code — but revm applies it on the `call()` path too, so an `eth_call` from a contract address is rejected with `Transaction(RejectCallerWithCode)`. Simulating a call from a contract address is ordinary practice: smart-account and ERC-4337 flows, multicall aggregators, and any UI that previews what one contract sees when called by another. `@ethereumjs/evm`'s `runCall` (which is what `eth_call` goes through) does not enforce EIP-3607 at all, so the same read succeeds on ethereumjs and fails on revm, and a user gets a different answer purely from which engine they opted into.

  **New option, defaulting to `false`, so nothing changes for a caller that does not ask:**

  - `disableEip3607` (revm's `disable_eip3607`) skips EIP-3607, so a read from a contract address succeeds

  ```ts
  evm.call({
  	from: contractAddress,
  	to,
  	data,
  	gasLimit,
  	disableEip3607: true,
  });
  ```

  Gas does not move: EIP-3607 is a pre-execution check, so disabling it changes whether the call runs at all, never what it costs once it does.

  **It may not be combined with committing**, for the same reason as the other simulation switches: a committed transaction from a contract address is one the chain would reject, which breaks the cross-engine equivalence a consumer's gate exists to protect. `transact({commit: true, disableEip3607: true})` throws. Use `call()`, or `transact({commit: false})`.

  The legacy `RELAX_VALIDATION` bit (bit 2) is **not** extended to include EIP-3607: its meaning is fixed by ADR 0004 as exactly the union of the three switches it always described (`disableBaseFee`, `disableBalanceCheck`, `disableBlockGasLimit`), and reusing it for a new capability would silently change every caller that sets it. `disableEip3607` is opted into individually through its own flag bit (bit 7).

  The shipped `revm.wasm` now enables revm's `optional_eip3607` feature (added to the `relaxed-validation` cargo feature). The switch defaults to `false` and revm's accessor returns the same value as when the field is absent, so no existing behaviour or gas changes. See `docs/adr/0006-simulation-switches.md`.

## 0.2.0

### Minor Changes

- b5d2e0e: Expose revm's transaction-validation switches on `ExecuteOptions`, so a read can keep its real block environment.

  `call()` validated every execution as if it were going to be mined, and two of those checks are unsatisfiable for a node serving `eth_call`: the gas price against the block's base fee (`GasPriceLessThanBasefee`), and the caller's balance against `gasLimit * gasPrice` (`LackOfFundForMaxFee`). `eth_call` defaults `from` to the zero address and callers routinely simulate from addresses holding no ether, against blocks that carry a non-zero base fee. The only way through was to pass `baseFeePerGas: 0n` on every read, which makes a contract that reads `block.basefee` in a view function see a number the chain never had.

  **New options, all defaulting to `false`, so nothing changes for a caller that does not ask:**

  - `disableBaseFee` (revm's `disable_base_fee`) skips `gasPrice >= block base fee`
  - `disableBalanceCheck` (revm's `disable_balance_check`) skips `balance >= gasLimit * gasPrice + value`
  - `disableBlockGasLimit` (revm's `disable_block_gas_limit`) skips `gasLimit <= block gas limit`

  ```ts
  evm.call({
  	from,
  	to,
  	data,
  	gasLimit,
  	block: {...realBlock}, // the real base fee, not a zeroed one
  	disableBaseFee: true,
  	disableBalanceCheck: true,
  });
  ```

  Gas does not move: the charge is fee-independent, so a consumer replacing the zeroed-base-fee workaround with the real base fee plus `disableBaseFee` sees identical `gasUsed`, `totalGasSpent` and `gasRefunded`. What changes is that `BASEFEE` now reports the truth.

  **They cannot be combined with committing.** `transact({commit: true, disableBalanceCheck: true})` throws. revm raises the caller's balance to cover the value being sent, so committing would write funds that never existed into your store, silently. Use `call()`, or `transact({commit: false})` to simulate a transaction from an account that cannot pay for it.

  **`block.prevRandao` is now settable**, so `PREVRANDAO` reads the block's real value instead of always zero.

  **Fixed: the block environment no longer leaks between calls.** One EVM instance serves many calls, and `excessBlobGas` was only written when the caller supplied it, so a call that set it left the blob gas price in place for every later call that did not. Every block field is now assigned on every call; an absent value means its zero rather than "whatever ran last". Absent `excessBlobGas` still yields the 1 wei minimum blob gas price, so nothing moves for a caller that always passed it.

  The shipped `revm.wasm` now enables revm's `optional_balance_check`, `optional_no_base_fee` and `optional_block_gas_limit` features. Every switch defaults to false and revm's accessors return the same values as when the fields are absent, so no existing behaviour or gas changes; the full recorded corpus is byte-identical. Cost: +365 bytes raw, nothing measurable gzipped (`measurements/validation-switches-size.json`). See `docs/adr/0006-simulation-switches.md`.

## 0.1.0

### Minor Changes

- 82f3e91: Initial release: revm compiled to WebAssembly with a typed JavaScript API.

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
