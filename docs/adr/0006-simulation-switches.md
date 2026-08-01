# ADR 0006: expose revm's validation switches, off by default, never committed

- Status: accepted
- Date: 2026-08-01
- Applies to: `ExecuteOptions`, flag bits 4-6, the shipped cargo feature set

## Context

`call()` validated every execution as if it were a transaction that would be mined, even though it never commits. Two of those checks are unsatisfiable for a node serving `eth_call`, and both are correct for a real transaction:

- **`GasPriceLessThanBasefee`.** A real block carries a non-zero base fee. An `eth_call` typically arrives with no gas price at all.
- **`LackOfFundForMaxFee`.** `eth_call` defaults `from` to the zero address, and callers routinely simulate from addresses that hold no ether.

The first consumer, `embedded-eth-node`, worked around this by passing `baseFeePerGas: 0n` on every read while passing the real `number`, `timestamp`, `gasLimit`, `coinbase` and `excessBlobGas` through. That reproduces the intended effect from outside and does not move gas, because the charge is fee-independent. What it costs is a **user-visible divergence**: a contract reading `block.basefee` inside a view function sees 0 here and the node's real base fee on `@ethereumjs/evm`. The two alternatives were worse. Passing a real base fee plus a matching gas price breaks `eth_call` from any unfunded address, which is the common case, and pre-funding the caller invents state that a read must not invent.

The capability already existed in revm (`CfgEnv::disable_base_fee`, `disable_balance_check`, `disable_block_gas_limit`; upstream clients set exactly these to serve `eth_call`) and even in this repository: flag bit 2 and the `relaxed-validation` cargo feature. Neither was reachable, because the feature was not in the shipped build and the bit was honoured only on the light path. It was scoped as a *performance* experiment, priced at 0.01 microseconds, and correctly judged not worth its bytes on that basis.

That judgement was answering the wrong question. The switches are not a speedup, they are the difference between a read that can keep its real block environment and one that has to lie about it.

## Decision

### 1. Three named booleans on `ExecuteOptions`, each defaulting to `false`

`disableBaseFee`, `disableBalanceCheck`, `disableBlockGasLimit`, mapping 1:1 onto revm's own `CfgEnv` fields and onto flag bits 4, 5 and 6. Named after the check they remove, not after the use case they enable, because `simulate: true` would be a single knob that quietly grows more meanings.

**Defaulting them off is the load-bearing part.** Turning them on for `call()` would have been defensible (it is what `eth_call` means) and is still wrong here: it would move the behaviour of every existing caller in a release that claims to add an option, and it would decide on a consumer's behalf that a rejected read is better reported as a successful one. A node opts in per call; the recorded corpus is untouched, which is what keeps it a valid non-regression control for this change.

### 2. They may not be combined with committing

`transact({commit: true, disableBalanceCheck: true})` throws rather than executing. `disableBalanceCheck` makes revm raise the caller's post-deduction balance to at least the value being sent (`calculate_caller_fee`), so an account with nothing in it can send an ether and the recipient is credited out of nothing. Committing that writes funds that never existed into the consumer's own state, silently. `disableBaseFee` and `disableBlockGasLimit` do not fabricate state but do admit a transaction the chain would have rejected, which breaks the equivalence the consumer's cross-engine gate exists to protect.

`transact({commit: false, ...})` is allowed and is the supported way to simulate a transaction from an account that cannot pay for it.

### 3. `relaxed-validation` is now shipped and part of `default`

The three `revm/optional_*` features are in the default feature set of both crates and in `scripts/build-wasm.sh`. Every switch still defaults to `false`, and revm's `is_*_disabled()` accessors return exactly what they return when the fields do not exist, so **enabling the feature changes the behaviour and the gas of nothing that does not explicitly ask**. The full recorded corpus passes unchanged, which is the evidence for that claim rather than the argument for it.

Size, measured by the repository's own method (`gzip -9 -c`, same rustc and wasm-opt):

| build | raw (opt) | gzipped |
| --- | --- | --- |
| shipped, with the switches | 1,227,193 | 420,211 |
| identical source, `--features precompiles-all` | 1,226,828 | 420,280 |
| **delta** | **+365** | **-69** |

The gzipped figure is *negative*, which is not a saving: it is the noise floor. ADR 0004 and the spike both record that sub-kilobyte deltas on a 420 KB artifact are not trustworthy (the same feature measured 238 bytes in one run and 439 in another). The honest statement is that the switches cost a few hundred bytes uncompressed and nothing measurable compressed.

A build *without* the feature ignores the bits down in wasm, so the loader refuses the options up front, quoting the artifact's build string, rather than letting the very check the caller asked to skip reject the call with a confusing reason.

### 4. Bit 2 keeps its meaning

`RELAX_VALIDATION` becomes a documented superset shortcut for bits 4, 5 and 6, and is now honoured on both execution paths instead of only the light one. ADR 0004 requires that its meaning never be quietly reused; making it exactly the union of the three switches it always described honours that, and a test asserts the two spellings produce identical outcome bytes.

## Also: the block environment is now fully expressible, and no longer sticky

`prevRandao` was unsettable, so `PREVRANDAO` read zero in every execution. It is now a `BlockEnv` field, encoded as an appended section of the extras blob (`present` bit 3) rather than inserted into the fixed head, per the append-only discipline in ADR 0004.

Adding it surfaced a related bug and the fix is part of this change. **The executor is persistent across calls**, so any block field written only when the caller supplies it inherits the previous call's value. `excessBlobGas` was written that way: a call that set it left the blob gas price in place for every subsequent call that did not, which makes the block environment depend on execution history. `apply_block` now assigns every field on every call, with an absent value meaning its zero rather than "leave whatever is there". Absent `excessBlobGas` still yields the 1 wei minimum blob gas price, so nothing moves for a caller who always passed it (the recorded corpus included).

## Consequences

- A node can keep its real block environment for reads and get correct `BASEFEE` and `PREVRANDAO` inside a view function.
- Existing callers see no change: every switch is off unless named, and the corpus is byte-identical.
- Flag bits 7 and above remain unallocated; three of the reserved bits are now spent, which was what they were reserved for.
- The gap this leaves is deliberate: revm's `disable_eip3607` (simulating from an address that has code) and `disable_fee_charge` are not exposed. Neither has a demonstrated consumer, and each would be another `optional_*` feature in the shipped build. Add them the same way, with a use case attached.
