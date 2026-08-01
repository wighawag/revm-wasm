---
'revm-wasm': minor
---

Expose revm's transaction-validation switches on `ExecuteOptions`, so a read can keep its real block environment.

`call()` validated every execution as if it were going to be mined, and two of those checks are unsatisfiable for a node serving `eth_call`: the gas price against the block's base fee (`GasPriceLessThanBasefee`), and the caller's balance against `gasLimit * gasPrice` (`LackOfFundForMaxFee`). `eth_call` defaults `from` to the zero address and callers routinely simulate from addresses holding no ether, against blocks that carry a non-zero base fee. The only way through was to pass `baseFeePerGas: 0n` on every read, which makes a contract that reads `block.basefee` in a view function see a number the chain never had.

**New options, all defaulting to `false`, so nothing changes for a caller that does not ask:**

- `disableBaseFee` (revm's `disable_base_fee`) skips `gasPrice >= block base fee`
- `disableBalanceCheck` (revm's `disable_balance_check`) skips `balance >= gasLimit * gasPrice + value`
- `disableBlockGasLimit` (revm's `disable_block_gas_limit`) skips `gasLimit <= block gas limit`

```ts
evm.call({
  from, to, data, gasLimit,
  block: {...realBlock},      // the real base fee, not a zeroed one
  disableBaseFee: true,
  disableBalanceCheck: true,
});
```

Gas does not move: the charge is fee-independent, so a consumer replacing the zeroed-base-fee workaround with the real base fee plus `disableBaseFee` sees identical `gasUsed`, `totalGasSpent` and `gasRefunded`. What changes is that `BASEFEE` now reports the truth.

**They cannot be combined with committing.** `transact({commit: true, disableBalanceCheck: true})` throws. revm raises the caller's balance to cover the value being sent, so committing would write funds that never existed into your store, silently. Use `call()`, or `transact({commit: false})` to simulate a transaction from an account that cannot pay for it.

**`block.prevRandao` is now settable**, so `PREVRANDAO` reads the block's real value instead of always zero.

**Fixed: the block environment no longer leaks between calls.** One EVM instance serves many calls, and `excessBlobGas` was only written when the caller supplied it, so a call that set it left the blob gas price in place for every later call that did not. Every block field is now assigned on every call; an absent value means its zero rather than "whatever ran last". Absent `excessBlobGas` still yields the 1 wei minimum blob gas price, so nothing moves for a caller that always passed it.

The shipped `revm.wasm` now enables revm's `optional_balance_check`, `optional_no_base_fee` and `optional_block_gas_limit` features. Every switch defaults to false and revm's accessors return the same values as when the fields are absent, so no existing behaviour or gas changes; the full recorded corpus is byte-identical. Cost: +365 bytes raw, nothing measurable gzipped (`measurements/validation-switches-size.json`). See `docs/adr/0006-simulation-switches.md`.
