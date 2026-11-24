---
'revm-wasm': minor
---

Add `recordCallsTo` on `ExecuteOptions`, which records the input bytes of every call frame that runs one address's code and returns them as `outcome.recordedCalls`. It is built for Hardhat / forge-std `console.log`, whose calls to the empty account `0x000000000000000000636F6e736F6c652e6c6f67` can now be observed on this engine without changing execution.

```ts
const out = evm.call({from, to, data, gasLimit, recordCallsTo: CONSOLE_ADDRESS});
out.recordedCalls; // Uint8Array[], in the order the frames were entered
```

**It is off unless set, and it observes only.** Gas, return data, logs, state changes and the committed state are identical with it on or off, and a test asserts that over the full outcome on every entry point. Nothing is pre-warmed: the address stays an ordinary cold, empty account, which a precompile at that address would not be. There is no measurable cost when it is off, neither in time nor in artifact size (gzipped delta +135 bytes, inside the noise floor).

- CALL, STATICCALL, DELEGATECALL and CALLCODE into the address are recorded (matched on the code address), and so is the transaction's own top-level frame. CREATE frames are not.
- Frames inside sub-calls that later revert, and in transactions that revert as a whole, are included.
- It works on `call`, `transact` and `create`, committing or not, and with `returnState: false`. It is not a simulation switch.

It travels as request flag bit 9 plus a trailing 20-byte target, and the outcome gains a section appended only when the bit is set, so `outcomeFormatVersion` goes from 4 to 5. **A request without the option produces byte-identical v4 outcomes.** The loader refuses `recordCallsTo` against an artifact whose `outcomeFormatVersion` is below 5, rather than returning a silently empty list. `decodeOutcome` takes a new optional `{recordedCalls: true}` argument for raw blobs produced with the bit. See ADR 0007. This is not a general tracer.
