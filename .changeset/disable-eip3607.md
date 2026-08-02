---
'revm-wasm': minor
---

Expose `disableEip3607` on `ExecuteOptions`, so a `call()` can be made from a contract address.

EIP-3607 rejects a transaction whose sender has deployed code. It is a transaction-validity rule, not an execution rule — it stops a transaction being *sent* from an address that carries code — but revm applies it on the `call()` path too, so an `eth_call` from a contract address is rejected with `Transaction(RejectCallerWithCode)`. Simulating a call from a contract address is ordinary practice: smart-account and ERC-4337 flows, multicall aggregators, and any UI that previews what one contract sees when called by another. `@ethereumjs/evm`'s `runCall` (which is what `eth_call` goes through) does not enforce EIP-3607 at all, so the same read succeeds on ethereumjs and fails on revm, and a user gets a different answer purely from which engine they opted into.

**New option, defaulting to `false`, so nothing changes for a caller that does not ask:**

- `disableEip3607` (revm's `disable_eip3607`) skips EIP-3607, so a read from a contract address succeeds

```ts
evm.call({
  from: contractAddress,
  to, data, gasLimit,
  disableEip3607: true,
});
```

Gas does not move: EIP-3607 is a pre-execution check, so disabling it changes whether the call runs at all, never what it costs once it does.

**It may not be combined with committing**, for the same reason as the other simulation switches: a committed transaction from a contract address is one the chain would reject, which breaks the cross-engine equivalence a consumer's gate exists to protect. `transact({commit: true, disableEip3607: true})` throws. Use `call()`, or `transact({commit: false})`.

The legacy `RELAX_VALIDATION` bit (bit 2) is **not** extended to include EIP-3607: its meaning is fixed by ADR 0004 as exactly the union of the three switches it always described (`disableBaseFee`, `disableBalanceCheck`, `disableBlockGasLimit`), and reusing it for a new capability would silently change every caller that sets it. `disableEip3607` is opted into individually through its own flag bit (bit 7).

The shipped `revm.wasm` now enables revm's `optional_eip3607` feature (added to the `relaxed-validation` cargo feature). The switch defaults to `false` and revm's accessor returns the same value as when the field is absent, so no existing behaviour or gas changes. See `docs/adr/0006-simulation-switches.md`.