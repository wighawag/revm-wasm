# revm-wasm

## 0.6.0

### Minor Changes

- 23cb473: Add `recordCallsTo` on `ExecuteOptions`, which records the input bytes of every call frame that runs one address's code and returns them as `outcome.recordedCalls`. It is built for Hardhat / forge-std `console.log`, whose calls to the empty account `0x000000000000000000636F6e736F6c652e6c6f67` can now be observed on this engine without changing execution.

  ```ts
  const out = evm.call({
  	from,
  	to,
  	data,
  	gasLimit,
  	recordCallsTo: CONSOLE_ADDRESS,
  });
  out.recordedCalls; // Uint8Array[], in the order the frames were entered
  ```

  **It is off unless set, and it observes only.** Gas, return data, logs, state changes and the committed state are identical with it on or off, and a test asserts that over the full outcome on every entry point. Nothing is pre-warmed: the address stays an ordinary cold, empty account, which a precompile at that address would not be. There is no measurable cost when it is off, neither in time nor in artifact size (gzipped delta +135 bytes, inside the noise floor).

  - CALL, STATICCALL, DELEGATECALL and CALLCODE into the address are recorded (matched on the code address), and so is the transaction's own top-level frame. CREATE frames are not.
  - Frames inside sub-calls that later revert, and in transactions that revert as a whole, are included.
  - It works on `call`, `transact` and `create`, committing or not, and with `returnState: false`. It is not a simulation switch.

  It travels as request flag bit 9 plus a trailing 20-byte target, and the outcome gains a section appended only when the bit is set, so `outcomeFormatVersion` goes from 4 to 5. **A request without the option produces byte-identical v4 outcomes.** The loader refuses `recordCallsTo` against an artifact whose `outcomeFormatVersion` is below 5, rather than returning a silently empty list. `decodeOutcome` takes a new optional `{recordedCalls: true}` argument for raw blobs produced with the bit. See ADR 0007. This is not a general tracer.

## 0.5.0

### Minor Changes

- fdf8dea: Expose `disableTxGasLimitCap` on `ExecuteOptions`, so a read can ask for more gas than EIP-7825's per-transaction cap.

  From Osaka on, a transaction may not ask for more than 16,777,216 gas (EIP-7825), and revm applies that to every execution. A `call()` at Osaka with a `gasLimit` above the cap was rejected with `TxGasLimitGreaterThanCap`, even with `disableBlockGasLimit`. geth skips the cap for `eth_call` (it still applies it to transactions and to `eth_estimateGas`), and `@ethereumjs/evm`'s `runCall` does not enforce it at all, so a node serving reads through this package had to be stricter than geth.

  **New option, defaulting to `false`, so nothing changes for a caller that does not ask:**

  - `disableTxGasLimitCap` sets revm's `CfgEnv::tx_gas_limit_cap` to `u64::MAX` for that execution. The call runs with its whole `gasLimit`, and gas is what it would be with no cap.

  ```ts
  evm.call({
  	from,
  	to,
  	data,
  	gasLimit: 30_021_000n,
  	spec: 'OSAKA',
  	disableTxGasLimitCap: true,
  });
  ```

  It lifts only the cap. EIP-7623's calldata floor (`GasFloorMoreThanGasLimit`), the intrinsic-gas check and every other validation still apply. Before Osaka there is no cap, and from Amsterdam on (EIP-8037) the cap no longer rejects a transaction but splits its gas between regular gas and the state-gas reservoir, so in both cases the switch changes nothing.

  **It may not be combined with committing**, like the other simulation switches: a committed transaction above the cap is one the chain would reject. `transact()` and `create()` throw when it is set and they commit (their default). Use `call()`, `transact({commit: false})` or `create({commit: false})`.

  It travels as a new request flag bit (bit 8). The request and outcome layout versions do not change. The legacy `RELAX_VALIDATION` bit does not set it. An older `revm.wasm` that does not know bit 8 ignores it, so the cap stays enforced and the call is rejected with `TxGasLimitGreaterThanCap` rather than producing a different number.

## 0.4.0

### Minor Changes

- 97cbc6c: Add `blobGasUsed` and `blobGasPrice` to the execution outcome

  The artifact already supported EIP-4844 blob transactions correctly:
  `blobVersionedHashes` and `maxFeePerBlobGas` are accepted on the execute
  options, `BLOBHASH` and `BLOBBASEFEE` work, versioned-hash validation happens,
  and the differential corpus covers thousands of blob transactions. What was
  missing was purely a **reporting gap**: the outcome blob carried status, gas
  used, total gas spent, refunded, return data, logs, the conditional logs bloom,
  the per-account change set and the effective gas price, and nothing about blob
  gas. A consumer executing a type-3 transaction could not fill `blobGasUsed` or
  `blobGasPrice` on the receipt it hands its own callers, and its only honest
  options were to refuse blob transactions or return a receipt it knew was
  incomplete.

  This closes that gap. The outcome now carries two trailing fields:

  - **`blobGasUsed`** — revm's own `Transaction::total_blob_gas`, i.e. the
    versioned-hash count times the per-blob gas constant (`GAS_PER_BLOB`). Zero
    for a non-blob transaction.
  - **`blobGasPrice`** — revm's own `Block::blob_gasprice`, i.e.
    `calc_blob_gasprice` over the block's excess blob gas (the `fake_exponential`
    rule the engine charges blob gas with, not a second implementation in
    JavaScript). Zero for a non-blob transaction.

  Both are computed inside the artifact from revm's own API surface, so a
  consumer reads them straight off `Outcome` without reimplementing EIP-4844 fee
  arithmetic. `embedded-eth-node`, which puts receipts on an EIP-1193 surface,
  previously worked around this gap by refusing blob transactions; it can now
  stop.

  **Outcome format version bumped to 4.** The two fields are appended after the
  effective gas price, the head offsets are unchanged, and `decodeOutcome` is
  updated. The existing differential corpus still passes byte for byte against
  native revm.

  The two fields are written **unconditionally** (zero for a non-blob
  transaction) rather than made conditional on the versioned-hash count. The
  256-byte logs bloom is conditional on a non-zero log count, and that
  conditionality is the thing the format's own documentation names as what bites
  a hand-rolled decoder: it works on exactly the calls that are easiest to test
  with and then desynchronises on the first call that emits no logs. Two small
  fixed-width fields do not pay for that hazard, so they are always present and a
  decoder never has to branch on a count it has already parsed to know where the
  next section starts.

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
