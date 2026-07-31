# revm-wasm

[revm](https://github.com/bluealloy/revm) compiled to WebAssembly, with a typed JavaScript API. Run a real EVM in a browser without a Rust toolchain.

> **This is an UNOFFICIAL binding.** It is not affiliated with, endorsed by, or maintained by the revm project. revm is by [bluealloy](https://github.com/bluealloy) and contributors, and is MIT licensed. All of the EVM in this package is theirs; this package is a build configuration, a host interface and a decoder.
>
> **It is deliberately not a general-purpose binding.** The build configuration is fixed (every precompile, `opt-level = 3`, and [neither half is negotiable](docs/adr/0001-all-precompiles-opt-level-3.md)). The host interface has one shape. v1 ships **no custom precompiles** and **no inspector**. If you want a configurable revm binding, this is the wrong package and you should build against revm directly.

## What you get

- One prebuilt `.wasm` (420 KB gzipped) in the published tarball. No Rust, ever, in your project or your CI.
- A typed API where you never see a byte offset, a flag bit or a packed account layout.
- Mainnet-equivalent gas. The full precompile set is present precisely so gas matches a real node.
- A state interface that is an **adapter over your storage**, not a place state lives.
- The revm version, the exact revm revision, and the outcome format version readable at runtime.

## Install

```bash
npm install revm-wasm
```

## Use

```ts
import {createRevm, MemoryStore} from 'revm-wasm';
import {wasmUrl} from 'revm-wasm/wasm-url';

const evm = await createRevm({wasm: wasmUrl, spec: 'CANCUN', chainId: 1n});

// eth_call: read-only, never commits, no nonce check.
const out = evm.call({
  from: sender,
  to: contract,
  data: calldata,
  gasLimit: 200_000n,
});

out.success; // boolean
out.gasUsed; // bigint
out.returnData; // Uint8Array
out.logs; // [{address, topics, data}]
out.stateChanges; // what WOULD have changed
```

```ts
// A transaction: charges the sender, credits the coinbase, commits the result.
const receiptish = evm.transact({
  from: sender,
  to: recipient,
  value: 10n ** 18n,
  gasLimit: 100_000n,
  maxFeePerGas: 30_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  nonce: 7n,
  block: {number: 21_000_000n, timestamp: 1_735_000_000n, coinbase, baseFeePerGas: 20_000_000_000n},
});

receiptish.effectiveGasPrice; // revm's own, not a second min(maxFee, baseFee + tip)
receiptish.logsBloom; // 256 bytes, always
```

```ts
// A deployment. `data` is the init code; `to` is ignored.
const created = evm.create({from: sender, data: initCode, gasLimit: 3_000_000n, nonce: 8n});
const address = created.stateChanges!.find((c) => c.created)!.address;
```

```ts
// Recover a sender before you have any state to run its transaction against.
const signer = evm.recoverSigner({hash, v: 28, r, s});
```

```ts
// What is actually running, for a bug report.
evm.revmVersion; // '42.0.1'
evm.revmRevision; // '640eafa91beae73bafb7776845d53133f603048f'
evm.outcomeFormatVersion; // 3
evm.abiVersion; // 1
```

### Loading the wasm

`createRevm` takes bytes, a URL, a `Response`, or an already-compiled `WebAssembly.Module`:

```ts
await createRevm({wasm: new URL('./revm.wasm', import.meta.url)});
await createRevm({wasm: fetch('/assets/revm.wasm')});
await createRevm({wasm: myUint8Array});

// Compilation is the expensive part, so share a Module across instances:
const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
const a = createRevmSync({wasm: module, state: storeA});
const b = createRevmSync({wasm: module, state: storeB});
```

`revm-wasm/wasm-url` exports the packaged file's URL. The raw file is also reachable at the `revm-wasm/revm.wasm` export subpath if your bundler prefers that.

**Instances are isolated.** Two instances in one page never see each other's state: host functions are bound per `WebAssembly.instantiate`, not through a shared module-level binding. That is a deliberate design decision with a scar behind it ([ADR 0002](docs/adr/0002-raw-abi-no-wasm-bindgen.md)).

## Bringing your own state

**Yes, the host interface can be backed by an external store.** That is the point of it. `MemoryStore` exists so the package is runnable out of the box; nothing requires it.

Implement `StateStore` over whatever you already have:

```ts
import {createRevm, type StateStore} from 'revm-wasm';

const myStore: StateStore = {
  getAccount(address) {
    /* -> {balance, nonce, codeHash} | undefined */
  },
  getStorage(address, slot) {
    /* -> Uint8Array(32) | undefined */
  },
  getCode(codeHash) {
    /* -> Uint8Array | undefined */
  },
  getBlockHash(blockNumber) {
    /* -> Uint8Array(32) | undefined */
  },

  setAccount(address, account) {},
  setCode(codeHash, code) {},
  setStorage(address, slot, value) {},
  clearStorage(address) {},
  removeAccount(address) {},
};

const evm = await createRevm({wasm: wasmUrl, state: myStore});
```

Four things to know:

1. **Reads must be synchronous.** The interpreter is a synchronous loop inside wasm and a state read happens in the middle of an opcode; there is no suspension point to await at. If your state is async, pre-load what a call needs, or run this in a worker with a synchronous view.
2. **On the read methods, the `Uint8Array` you receive is a reused scratch buffer**, valid only for that call. That is what makes a read allocation-free. Copy it if you retain it. The write methods always hand you fresh arrays.
3. **Writes arrive with revm's own commit semantics already applied.** `SELFDESTRUCT` and EIP-161 clearing both arrive as `clearStorage` then `removeAccount`; a created account arrives with `clearStorage` first so it cannot inherit storage from a previous life at that address. You do not re-derive any of it.
4. **Index storage per account.** `clearStorage` must be O(that account), not O(total state). It is hit by every `SELFDESTRUCT` and by every contract creation. `MemoryStore` does this; with 200,000 unrelated slots resident, clearing one account takes 0.14 ms here against 14.6 ms for the flat-map shape it replaces.

If even that is too much marshalling, `createRevm({host: (memory) => ...})` takes the raw pointer-level interface directly. It is exported and supported; most consumers should not need it.

## What this package will not do

- No node, no mempool, no JSON-RPC. Interpreter, state interface and transaction execution only.
- No reimplementation of fee arithmetic, EIP-161, EIP-6780, access-list warming or gas accounting. All of it is driven out of revm's own paths, on purpose.
- No vendored or forked revm. It is a pinned git revision.
- No configurable precompile set, and no inspector, in v1. Both are [designed to be addable without a breaking change](docs/adr/0004-what-v1-leaves-open.md), and both are absent today.

## Sizes and numbers

| | |
| --- | --- |
| `revm.wasm`, raw | 1,226,474 bytes |
| **gzipped** | **420,025 bytes** |
| brotli | 306,228 bytes |

Measured with `gzip -9 -c <file>`, which is the only invocation used anywhere in this repository. (Node's zlib at level 9 lands about 0.6% higher on these artifacts, and `gzip -c <file>` stores the filename in the header while `gzip -c < file` does not. Both are big enough to fake a 1% delta.)

Throughput, from the feasibility spike this package was extracted from, measured interleaved against `@ethereumjs/evm` 10.1.2 on the same machine:

| shape | `@ethereumjs/evm` | this | ratio |
| --- | --- | --- | --- |
| tight arithmetic loop | 18.3-19.0 MGas/s | 306-314 | ~16.8x |
| keccak256 over 32 B | 7.63-7.84 | 107-130 | ~15.9x |
| keccak256 over 256 B | 7.47-7.81 | 96-123 | ~14.8x |

Read those as a lower bound: they were taken on a power-limited laptop under real background load, and the wasm side varied by up to 40% run to run. Re-measure on hardware you care about.

Per-call overhead is about 3 microseconds for an empty call with a persistent instance, of which the wasm boundary itself is about 0.37. Irrelevant for a compute-heavy `eth_call`; a ceiling of roughly 250k trivial calls per second if that is your workload.

## Documentation

- [ADR 0001: all precompiles, opt-level 3, and why neither half is negotiable](docs/adr/0001-all-precompiles-opt-level-3.md) — **read this before trying to make the artifact smaller**
- [ADR 0002: a raw C ABI instead of wasm-bindgen](docs/adr/0002-raw-abi-no-wasm-bindgen.md)
- [ADR 0003: the built `.wasm` is committed, not built at release](docs/adr/0003-commit-the-wasm.md)
- [ADR 0004: what v1 deliberately leaves open, and the rules for adding it](docs/adr/0004-what-v1-leaves-open.md)
- [ADR 0005: pin revm, rustc and wasm-opt; accept behaviourally, not byte for byte](docs/adr/0005-pinned-toolchain.md)
- [The wire formats](docs/outcome-format.md) — you should not need this, and it is here anyway

## Development

```bash
pnpm install
pnpm build        # tsc. Does NOT build the wasm, and does NOT need Rust.
pnpm test         # the differential corpus in Node. No Rust.
pnpm test:browser # the same corpus in Chromium (V8) and WebKit (JavaScriptCore)
```

**The test suite needs no Rust toolchain, and that property is protected deliberately.** The artifact and the recorded expectations are both checked in, so a contributor can clone, install and run the whole suite.

Rebuilding the wasm is a separate, explicitly-invoked step:

```bash
rustup toolchain install 1.91.1
rustup target add wasm32-unknown-unknown --toolchain 1.91.1
# plus wasm-opt (binaryen) 131 on PATH

pnpm build:wasm          # -> packages/revm-wasm/wasm/revm.wasm
pnpm measure:size
pnpm measure:tracer      # prices a future capability; see ADR 0004
```

**The acceptance check for a rebuild is `pnpm test`, not a byte comparison.** Reproducible wasm is hard: rustc, wasm-opt and revm all move the bytes, and three builds of identical source here produced 420,025, 420,027 and 420,029 bytes gzipped. What must not move is gas and results.

### The corpus

Nine fixtures, 63 calls, covering opcode edge cases, storage, revert rollback, out-of-gas, invalid opcodes, CREATE2, environment opcodes, nested calls, precompiles 0x01-0x04, BLS12-381 and KZG, log emission order and reverted-frame filtering, the receipts bloom, the fee market (sender charge, coinbase credit, base-fee burn, refund at the effective price, all four rejection paths), EIP-2930 access lists in both directions, type-3 blob hashes, a real signed EIP-7702 delegation, and committing execution including selfdestruct, EIP-161 and EIP-6780.

**Every expected outcome was recorded from native revm**, not from this package, so a pass means "this agrees with real revm" rather than "this agrees with its last run". The comparison is the entire outcome blob as hex.

Contributions welcome; every user-facing change needs a changeset (`pnpm changeset`).

## Credits and licence

**revm** is by [bluealloy](https://github.com/bluealloy) and its contributors, MIT licensed. This package compiles it, unmodified and unvendored, from pinned revision `640eafa91beae73bafb7776845d53133f603048f` (crate version 42.0.1). If this package is useful to you, the credit belongs upstream.

This package is MIT licensed, matching revm. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
