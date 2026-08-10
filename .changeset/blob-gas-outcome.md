---
"revm-wasm": minor
---

Add `blobGasUsed` and `blobGasPrice` to the execution outcome

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