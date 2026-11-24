# ADR 0007: record call inputs to one address, through the precompile seam, not an inspector

- Status: accepted
- Date: 2026-11-24
- Applies to: `ExecuteOptions.recordCallsTo`, `Outcome.recordedCalls`, flag bit 9, outcome format v5, `FixedPrecompiles`

## Context

`webevm` is adding Hardhat / forge-std `console.log` support. Those libraries STATICCALL the fixed address `0x000000000000000000636F6e736F6c652e6c6f67` with ABI-encoded arguments. On a real chain that address is an empty account: the call costs a cold access, runs no code and succeeds. A node that wants to print the logs has to **observe** those calls without changing execution.

Two obvious answers are wrong:

- **A precompile at that address.** It would have to be pre-warmed by `warm_addresses()`, so touching it would cost 100 gas instead of a real chain's 2,600: exactly the hazard rule two of [ADR 0004](0004-what-v1-leaves-open.md) and the gas table in [ADR 0001](0001-all-precompiles-opt-level-3.md) describe. Leaving it un-warmed does not help either, because a precompile's dispatch replaces the empty account's semantics.
- **revm's inspector.** v1 ships none, and revm's `tracer` feature still does not build for `wasm32-unknown-unknown` without a getrandom stub (ADR 0004, "A blocker a future tracer has to clear first"). It is also far more machinery than this needs.

On its default engine (`@ethereumjs/evm`) webevm uses the `beforeMessage` event. This ADR gives the revm engine the equivalent for one address.

## Decision

### 1. Observe from `FixedPrecompiles::run`, which revm calls for every call frame

revm's `EthFrame::make_call_frame` asks the precompile provider about **every** call frame, to find out whether the target is a precompile, after its depth check and value transfer and before it loads any bytecode. `FixedPrecompiles` (the seam ADR 0001 keeps for exactly this kind of extension) now carries a `CallRecorder`. When it is armed and `inputs.bytecode_address` equals the target, `run` pushes `inputs.input.bytes(ctx)` and then delegates to the stock `EthPrecompiles` unchanged.

That location is what makes the recorder free of side effects by construction:

- `warm_addresses()` and `contains()` are untouched, so nothing is pre-warmed and the address stays an ordinary, cold, empty account;
- `run` still returns `Ok(None)` for a non-precompile, so dispatch is the same;
- the buffer lives outside the journal, so recording neither touches state nor is undone by a revert.

### 2. What is recorded

- **Matched on the code address** (`CallInputs::bytecode_address`). For CALL and STATICCALL that is the target. DELEGATECALL and CALLCODE *into* the address are recorded too, because that is the frame running the address's code and it is the field revm dispatches precompiles on. The transaction's own top-level frame counts when `to` is the address. CREATE frames never do.
- **In the order frames are entered**, including frames inside sub-calls that later revert and every frame of a transaction that reverts as a whole. Reverting a sub-call removes its logs; it does not remove what it printed, and `console.log` output from a failing transaction is exactly what a developer wants to see.
- **Only frames that are entered.** A frame refused before `make_call_frame` consults the provider (call depth over 1024, a value transfer the caller cannot afford) is not recorded. It never ran. `@ethereumjs/evm` makes the same cut, since its interpreter refuses those calls before a message, and so before `beforeMessage`, exists.
- One address per call, given by the caller. Nothing is hard-coded.

### 3. Wire format

**Request.** Flag bit 9, `RECORD_CALLS`. When it is set, a `[20]` target is appended after the extras section. The 140-byte head and the request version are unchanged.

**Outcome, format v5.** When and only when the request set bit 9, the blob ends with:

```text
u32  recorded call count, then per call: u32 input length, then bytes
u32  byte length of that section (a footer)
```

**Everything before the section is byte-for-byte the v4 blob the same request produces without the bit**, whichever path produced it: the full outcome, the light head, a validation error, or a malformed request. The footer is what makes that path-independent: the decoder strips `section + 4` bytes off the end and decodes the rest exactly as v4, without branching on status or path. The light path's validation errors use the full layout, so a section placed directly after "whatever came before" would have forced exactly the status-dependent decoding that the conditional bloom shows to be a hazard.

The section is conditional on the **request**, never on the data: the caller set the bit, so it knows the section is there. A requested section is always present, empty when nothing matched or the transaction failed pre-execution validation, so an empty list always means "nothing called the address".

`outcomeFormatVersion` goes from 4 to 5. A request without the bit gets v4 bytes, so for an existing caller nothing moves.

### 4. Degradation

| caller | artifact | result |
| --- | --- | --- |
| older (never sets bit 9) | newer | byte-identical v4 outcomes |
| newer, `recordCallsTo` set | older (`outcomeFormatVersion < 5`) | the loader **throws** up front, quoting the build |
| raw request with bit 9 | older | the bit and the trailing 20 bytes are ignored, as ADR 0004 promises |

The loader refuses rather than degrading silently, because an older artifact would return a list that is empty for the wrong reason, and a missing `console.log` looks exactly like a contract that did not log.

### 5. It is observation, not simulation

It is not in `SIMULATION_FLAGS` and is allowed with committing, on `call`, `transact` and `create`, and with `returnState: false`. It admits nothing the chain would reject and writes nothing.

## Evidence

- `test/record-calls.test.ts` runs nine scenarios twice each, recorder on and off, on separate fresh stores: `call` (full, light, reverting, light-reverting), `transact` (committing, committing-reverting, `commit: false`), `create` (init code that calls the address), and a validation error. It compares the **whole decoded outcome** (status, gas used, total gas, refund, return data, logs, bloom, every state change, effective and blob gas prices, error) and the **whole committed store**. It also asserts at the byte level that the v5 blob starts with the v4 blob, on both the full and the light path. The contract exercises CALL, STATICCALL, DELEGATECALL and CALLCODE into the address, a STATICCALL to another address (not recorded), a sub-call that records and then reverts, a log, a storage write and a whole-transaction revert.
- Two tests pin the gas identity directly. In the first, the recorded call is the transaction's first touch of the target, and it costs exactly what the same bytecode costs against a different cold, empty address, so the target is charged cold (2,600), not warm (100). In the second, the first touch happens inside a sub-call that reverts, and the outcome is identical with the recorder on and off.
- The recorded 63-call differential corpus is byte-identical, in Node, Chromium and WebKit.
- A recording call followed by a plain one leaves no trace: the plain call's blob equals one from a fresh instance. The executor is persistent, so the recorder is reset on every request, like every other per-request field.

## Cost

**Size.** Same source with and without the change, same rustc 1.91.1 and wasm-opt 131, `gzip -9 -c`:

| build | raw (opt) | gzipped |
| --- | --- | --- |
| before (rebuilt from `main`) | 1,232,873 | 422,114 |
| with the recorder | 1,232,403 | 422,249 |
| **delta** | **-470** | **+135** |

Both figures are inside the noise floor that ADR 0004 and ADR 0006 describe (sub-kilobyte deltas on this artifact are not trustworthy): an earlier build of this change measured -289 gzipped, and the raw delta is negative. The honest statement: no measurable size cost. Recorded in `measurements/call-recorder-size.json`.

**Time, off.** One `Option` check per call frame, and the recorder is reset on every request. Measured on the worst case for it, a contract making 200 STATICCALLs to the console address per call, with the old and the new artifact alternating in the same process over 30 rounds: the new/old ratio had a median of 1.000 in one run and 1.009 in another, with a p10 to p90 band of about ±4 to 9%. That is indistinguishable from noise.

**Time, on.** About 75 nanoseconds per recorded frame on that workload (70 against 56 microseconds per call for 200 frames), which is the input copy plus decoding the section. It is paid only by a caller who asked.

## Consequences

- webevm's revm engine can serve `console.log` with mainnet-equivalent gas, and can lift its connect-time refusal once a release carries this.
- Flag bits 10 and above remain unallocated.
- This is **not a tracer** and must not grow into one by accretion. It records one address's call inputs and nothing else. A future tracer still follows rule one of ADR 0004 (buffer in wasm, return as a section) and still has to clear the `tracer` build blocker. It may reuse this section's framing (appended, request-gated, length footer), but it is a separate capability with its own bit.
- `FixedPrecompiles` now has a second reason to exist beyond ADR 0001's: it is the per-frame observation point. Removing it would remove this capability too.
