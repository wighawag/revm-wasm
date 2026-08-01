# The wire formats

**You should not need this document.** `revm-wasm` decodes the outcome for you and encodes the request for you, and the whole point of the package is that a consumer never sees a byte offset, a flag bit or a packed account layout. This is here for maintainers, and for anyone debugging a blob captured from a bug report.

Everything below is produced and consumed in exactly two files: `crates/core/src/lib.rs` (Rust) and `packages/revm-wasm/src/{request,outcome}.ts` (TypeScript).

## The forward-compatibility discipline

This is the part that matters more than any individual field.

1. **The head stays at fixed offsets across versions.** In the outcome blob that is `status | gasUsed | totalGasSpent | refunded | returnData`, which has been at identical offsets in v1, v2 and v3. In the request blob it is offsets 0..140.
2. **New sections are appended after the head**, never inserted into it.
3. **The version is readable at runtime**, so a decoder can refuse a format it does not understand rather than misread it:

```ts
evm.outcomeFormatVersion; // 3
evm.abiVersion; // 1
```

That discipline is the only reason a downstream decoder survived v1 (read-only) to v2 (logs and code bytes) to v3 (conditional bloom and trailing effective gas price). A future trace section is the same move again.

**Flag-word bits 4 and above are unallocated and reserved**, so a future per-call capability needs no new argument. See ADR 0004.

## Outcome blob, version 3

```text
u8   status: 0 success, 1 revert, 2 halt, 3 validation error
u64  gas used (LE), net of refunds
u64  total gas spent before refunds (LE)
u64  refunded gas (LE)
u32  return data length, then that many bytes
--- everything above is the HEAD and is at fixed offsets ---
u32  log count, then per log IN EMISSION ORDER:
       [20] emitting address
       u8   topic count (0..=4)
       [32] * that many topics
       u32  data length, then bytes
     if the log count is NON-ZERO, [256] receipts logs bloom
u32  account count, then per account (sorted by address):
       [20] address
       u8   flags: bit0 selfdestructed, bit1 touched, bit2 created,
                   bit3 code changed, bit4 deleted
       [32] balance (BE)
       u64  nonce (LE)
       [32] code hash
       if bit3: u32 code length, then bytes
       u32  changed slot count, then [32] key + [32] value each
[16] effective gas price (BE)
```

### The two things a hand-rolled decoder gets wrong

Both of these have broken a real consumer.

**1. The 256-byte bloom is conditional.** It is present only when the log count is non-zero, because a zero-log receipt's bloom is 256 zero bytes and the host already knows that. Over a 63,551-call corpus only 1.0% of calls emit logs, so paying 256 bytes on every `eth_call` would be waste. A decoder that always skips 256 bytes works on exactly the calls that are easiest to test with, then desynchronises the instant a call emits nothing.

**2. Code bytes mean "the code HASH changed", not "revm loaded some code".** `JournaledAccount::load_code_preserve_error` populates `AccountInfo::code` for **any** contract that merely executes. Emitting on that signal would ship the full bytecode of every contract touched, on every call: a 20 KB contract would cost 20 KB across the boundary per `eth_call`. The engine records each address's pre-transaction code hash on first load and emits bytes only when the final hash differs. Measured over the spike's corpus: 7,319 flagged accounts, zero that were not created, zero that emitted empty bytes.

### Other things worth knowing

- **Logs are not sorted.** Emission order is the semantics receipts and `eth_getLogs` need, and it is already deterministic. Accounts and slots *are* sorted by key, so the blob is byte-for-byte diffable between two runners.
- **Reverted frames contribute no logs.** revm has already filtered them before this encoding sees them, because a reverted checkpoint truncates the journal's log vector.
- **`deleted` (bit 4) is stated, not derived.** It is set when an account must be REMOVED with its storage, which is `SELFDESTRUCT` or EIP-161 empty-account clearing. It exists so a host applying changes itself never has to re-implement EIP-161. The commit path and the encoder share one `account_is_deleted()` predicate so they cannot drift.
- **Expect `deleted` on the coinbase constantly.** With a zero priority fee the coinbase is credited nothing, stays touched-and-empty, and is correctly deleted. `@ethereumjs/vm` does the same. It looks alarming the first time.
- **The effective gas price is revm's own** `Transaction::effective_gas_price`, not a second implementation of `min(maxFee, baseFee + tip)`. It is trailing, so anything that decodes sequentially and stops after the account list is unaffected. It costs about 1.7 KB gzipped in the artifact for a 16-byte field, which is out of proportion and unexplained, and it is still the right trade: the alternative is reimplementing fee arithmetic host-side.
- **A validation error (status 3)** carries revm's own `InvalidTransaction` variant as UTF-8 text in the return-data slot, for example `NonceTooHigh { tx: 99, state: 5 }`. The decoder surfaces it as `outcome.error`.
- **The light path stops after the head.** `returnState: false` returns status, gas and return data only, with no logs, no bloom, no state and no trailing price. It is worth about 0.9 microseconds per call, all of it from skipping the state encoding.

## Request blob, version 1

```text
0    u8   version (1)
1    u8   spec id (revm SpecId discriminant)
2    u16  reserved, must be 0
4    u32  flags
8    u64  gas limit
16   u64  chain id
24   u64  block number
32   u64  block timestamp
40   u64  block gas limit
48   [20] caller
68   [20] to (ignored when CREATE is set)
88   [20] coinbase
108  [32] value (BE)
--- everything above is the HEAD and is at fixed offsets 0..140 ---
140  u32  calldata / init-code length, then bytes
+    u32  extras length (0 for none), then the extras blob
```

Integers are little-endian; 256-bit quantities are big-endian.

### Flags

| bit | name | meaning |
| --- | --- | --- |
| 0 | `COMMIT` | write the resulting state back through the host before returning |
| 1 | `CREATE` | contract creation: `to` is ignored, calldata is the init code |
| 2 | `RELAX_VALIDATION` | bits 4, 5 and 6 at once; predates them and keeps its meaning (ADR 0004) |
| 3 | `CHECK_NONCE` | enforce the nonce against the sender's account nonce |
| 4 | `DISABLE_BASE_FEE` | skip `gasPrice >= block base fee` (revm `disable_base_fee`) |
| 5 | `DISABLE_BALANCE_CHECK` | skip `balance >= gasLimit * gasPrice + value` (revm `disable_balance_check`) |
| 6 | `DISABLE_BLOCK_GAS_LIMIT` | skip `gasLimit <= block gas limit` (revm `disable_block_gas_limit`) |
| 7+ | reserved | unallocated; an artifact that does not know a bit ignores it |

Bits 4 to 6 need the `relaxed-validation` cargo feature, which the shipped build enables. An artifact built without it ignores them, and the check the caller asked to skip then rejects the transaction with revm's own reason: loud, never a silently different number. The TypeScript layer refuses the options up front in that case, and refuses them on any committing path (see ADR 0006).

`CHECK_NONCE` is off in the raw ABI unless set. The TypeScript layer defaults it **on** for `transact` and `create` and **off** for `call`, because a transaction executed without a nonce check is silently replayable and that is not a default worth shipping.

### The extras blob (fee market and typed transactions)

Omitted entirely when a call has nothing to say, which is how a zero-fee corpus stays usable as a non-regression control.

```text
0    u8   version (1)
1    u8   present: bit0 priority fee, bit1 explicit tx type, bit2 excess blob gas,
              bit3 prevRandao (appended after the authorization list)
2    u8   tx type (meaningful only if bit1)
3    u8   reserved
4    [16] gas price / max fee per gas (BE)
20   [16] max priority fee per gas (BE)
36   [16] max fee per blob gas (BE)
52   u64  block base fee (LE)
60   u64  nonce (LE)
68   u64  excess blob gas (LE)
76   u32  access list entries, then per entry: [20] address, u32 keys, [32] * keys
+    u32  blob hashes, then [32] * that many
+    u32  authorizations, then per authorization:
           [32] chain id (BE), [20] address, u64 nonce (LE), u8 yParity, [32] r, [32] s
+    [32] prevRandao, present only if `present` bit3 is set
```

`prevRandao` is **appended after the variable-length sections**, not placed in the fixed head, which is why the version byte stays at 1. An artifact that predates it reads the sections it knows, ignores the `present` bit it does not, and stops: it degrades to "the capability did not happen" rather than misreading the blob. Same discipline as the outcome format, for the same reason.

**`undefined` and `0` are not interchangeable** for the priority fee, the transaction type and `excessBlobGas`. The *presence* of a priority fee is what makes revm derive a 1559-family transaction type, which is why there is a `present` bitmask rather than a sentinel value.

**revm keeps legacy `gasPrice` and EIP-1559 `maxFeePerGas` in one field** and reads it through `Transaction::max_fee_per_gas`. That is revm's model, not a simplification here; duplicating the distinction would mean reimplementing the fee market.

## The call ABI

Ten imported host functions in module `revm_wasm_host`, and a handful of exports. Every argument is a `u32` offset into linear memory. Nothing is marshalled.

```text
imports (module "revm_wasm_host"):
  basic(addrPtr, outPtr) -> u32     out: [32] balance BE | [8] nonce LE | [32] codeHash
  storage(addrPtr, keyPtr, outPtr)
  code_len(hashPtr) -> u32
  code_copy(hashPtr, outPtr)
  block_hash(numLo, numHi, outPtr)  number split to avoid a BigInt per call
  set_account(addrPtr, packedPtr)
  set_code(hashPtr, codePtr, len)
  set_storage(addrPtr, keyPtr, valPtr)
  clear_storage(addrPtr)
  remove_account(addrPtr)

exports:
  revm_wasm_abi_version() -> u32
  revm_wasm_outcome_format_version() -> u32
  revm_wasm_info_ptr() -> u32       static JSON: revm version, revm revision, build config
  revm_wasm_info_len() -> u32
  revm_wasm_request_buffer(len) -> u32   reserve and return the inbound buffer
  revm_wasm_execute(len) -> u32          returns the outcome length
  revm_wasm_execute_light(len) -> u32    head only, never commits
  revm_wasm_outcome_ptr() -> u32         valid until the next call into the module
  revm_wasm_ecrecover() -> u32           reads [32] hash | [1] v | [32] r | [32] s
```

`basic` never returns code. `AccountInfo::code` is left `None`, so revm calls `code_by_hash` only when the code is actually needed and a balance read never pays for a code copy. `code_len` and `code_copy` are split so wasm allocates exactly once and the host memcpys straight into linear memory.

The host functions are supplied **per `WebAssembly.instantiate`**, which is what makes two instances in one page isolated. See ADR 0002.
