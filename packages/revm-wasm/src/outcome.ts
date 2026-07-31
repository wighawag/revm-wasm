import type {AccountChange, ExecutionStatus, Log, Outcome} from './types.js';

const STATUS: ExecutionStatus[] = [
	'success',
	'revert',
	'halt',
	'validation-error',
];

const ZERO_BLOOM = new Uint8Array(256);

const decoder = new TextDecoder();

/**
 * The outcome blob layout, version 3.
 *
 * ```text
 * u8   status: 0 success, 1 revert, 2 halt, 3 validation error
 * u64  gas used (LE)      u64 total gas spent (LE)      u64 refunded (LE)
 * u32  return data length, then bytes
 * ---- the four lines above are the HEAD and have been at these exact offsets
 *      in every version of this format. That is a guarantee, not an accident.
 * u32  log count, then per log IN EMISSION ORDER:
 *        [20] address, u8 topic count (0..=4), [32] * that many, u32 data length + bytes
 *      if the log count is NON-ZERO, [256] receipts logs bloom
 * u32  account count, then per account (sorted by address):
 *        [20] address
 *        u8   flags: bit0 selfdestructed, bit1 touched, bit2 created,
 *                    bit3 code changed, bit4 deleted
 *        [32] balance (BE)   u64 nonce (LE)   [32] code hash
 *        if bit3: u32 code length + bytes
 *        u32  changed slot count, then [32] key + [32] value each
 * [16] effective gas price (BE)
 * ```
 *
 * Two details that a hand-rolled decoder gets wrong, both of which have bitten
 * a real consumer:
 *
 * 1. **The 256-byte bloom is CONDITIONAL.** It is present only when the log
 *    count is non-zero, because a zero-log receipt's bloom is 256 zero bytes
 *    that the host already knows. A decoder that always skips 256 bytes works on
 *    exactly the calls that are easiest to test with, and then desynchronises
 *    the moment a call emits no logs.
 * 2. **Code bytes are conditional on flag bit 3**, which means "the code hash
 *    changed", not "revm loaded some code".
 *
 * The head is at fixed offsets across versions and new sections are appended
 * after it. That discipline is the only reason a downstream decoder survived v1
 * to v2 to v3, and it is what a future trace section would follow.
 */
export const OUTCOME_FORMAT_VERSION = 3;

/**
 * Decode one outcome blob.
 *
 * `bloomWhenAbsent` is returned by reference when a call emitted no logs; it is
 * a shared all-zero array and must not be mutated by a caller.
 */
export function decodeOutcome(buf: Uint8Array): Outcome {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let o = 0;

	const status = STATUS[buf[o]] ?? 'halt';
	o += 1;
	const gasUsed = dv.getBigUint64(o, true);
	o += 8;
	const totalGasSpent = dv.getBigUint64(o, true);
	o += 8;
	const gasRefunded = dv.getBigUint64(o, true);
	o += 8;
	const retLen = dv.getUint32(o, true);
	o += 4;
	const returnData = buf.slice(o, o + retLen);
	o += retLen;

	const base: Outcome = {
		status,
		success: status === 'success',
		gasUsed,
		totalGasSpent,
		gasRefunded,
		effectiveGasPrice: 0n,
		returnData,
	};
	// A pre-execution rejection puts revm's own `InvalidTransaction` variant in
	// the return-data slot. Surfacing it as text is the difference between a
	// usable bug report and "it returned status 3".
	if (status === 'validation-error') base.error = decoder.decode(returnData);

	// The light path stops at the head: no logs, no state, no trailing price.
	if (o === buf.length) return base;

	const nLogs = dv.getUint32(o, true);
	o += 4;
	const logs: Log[] = [];
	for (let i = 0; i < nLogs; i++) {
		const address = buf.slice(o, o + 20);
		o += 20;
		const nTopics = buf[o];
		o += 1;
		const topics: Uint8Array[] = [];
		for (let j = 0; j < nTopics; j++) {
			topics.push(buf.slice(o, o + 32));
			o += 32;
		}
		const dataLen = dv.getUint32(o, true);
		o += 4;
		logs.push({address, topics, data: buf.slice(o, o + dataLen)});
		o += dataLen;
	}
	// CONDITIONAL. See the format note above.
	let logsBloom = ZERO_BLOOM;
	if (nLogs > 0) {
		logsBloom = buf.slice(o, o + 256);
		o += 256;
	}

	const nAcc = dv.getUint32(o, true);
	o += 4;
	const stateChanges: AccountChange[] = [];
	for (let i = 0; i < nAcc; i++) {
		const address = buf.slice(o, o + 20);
		o += 20;
		const flags = buf[o];
		o += 1;
		const balance = readBE(dv, o);
		o += 32;
		const nonce = dv.getBigUint64(o, true);
		o += 8;
		const codeHash = buf.slice(o, o + 32);
		o += 32;
		let code: Uint8Array | undefined;
		if (flags & 8) {
			const codeLen = dv.getUint32(o, true);
			o += 4;
			code = buf.slice(o, o + codeLen);
			o += codeLen;
		}
		const nSlots = dv.getUint32(o, true);
		o += 4;
		const storage: {slot: Uint8Array; value: Uint8Array}[] = [];
		for (let j = 0; j < nSlots; j++) {
			const slot = buf.slice(o, o + 32);
			o += 32;
			const value = buf.slice(o, o + 32);
			o += 32;
			storage.push({slot, value});
		}
		stateChanges.push({
			address,
			balance,
			nonce,
			codeHash,
			code,
			selfdestructed: (flags & 1) !== 0,
			touched: (flags & 2) !== 0,
			created: (flags & 4) !== 0,
			deleted: (flags & 16) !== 0,
			storage,
		});
	}

	let effectiveGasPrice = 0n;
	if (o + 16 <= buf.length) {
		effectiveGasPrice = (dv.getBigUint64(o) << 64n) | dv.getBigUint64(o + 8);
	}

	return {...base, effectiveGasPrice, logs, logsBloom, stateChanges};
}

function readBE(dv: DataView, offset: number): bigint {
	return (
		(dv.getBigUint64(offset) << 192n) |
		(dv.getBigUint64(offset + 8) << 128n) |
		(dv.getBigUint64(offset + 16) << 64n) |
		dv.getBigUint64(offset + 24)
	);
}
