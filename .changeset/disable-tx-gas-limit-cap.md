---
'revm-wasm': minor
---

Expose `disableTxGasLimitCap` on `ExecuteOptions`, so a read can ask for more gas than EIP-7825's per-transaction cap.

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
