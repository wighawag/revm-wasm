import {describe, expect, it} from 'vitest';
import {keccak_256} from '@noble/hashes/sha3.js';

import {createRevmSync, Revm} from '../src/instance.js';
import {storeToHostFunctions} from '../src/host.js';
import {MemoryStore, KECCAK_EMPTY} from '../src/memory-store.js';
import {decodeOutcome} from '../src/outcome.js';
import {encodeRequest, Flags} from '../src/request.js';
import {Spec} from '../src/spec.js';
import type {ExecuteOptions, Outcome} from '../src/types.js';
import {fixtureBlockHash, tohex, unhex, wasmBytes} from './fixture-runner.js';

// The recorder (ADR 0007): input bytes of every call frame running one
// address's code, returned on the outcome, without changing anything else.

const addr = (hex: string): Uint8Array => {
	const out = new Uint8Array(20);
	const b = unhex(hex);
	out.set(b, 20 - b.length);
	return out;
};

/** Hardhat / forge-std console address: an EMPTY account on a real chain. */
const CONSOLE = addr('000000000000000000636f6e736f6c652e6c6f67');
const CALLER = addr('ca11e2');
const OUTER = addr('3000');
const INNER = addr('3001');
const OTHER = addr('3002');

// -- a tiny assembler, enough for the frames below ---------------------------

const hex = (n: number) => n.toString(16).padStart(2, '0');
const push1 = (n: number) => '60' + hex(n);
const push20 = (a: Uint8Array) => '73' + tohex(a);
const OP = {
	STOP: '00',
	MSTORE8: '53',
	SSTORE: '55',
	JUMPI: '57',
	GAS: '5a',
	JUMPDEST: '5b',
	LOG0: 'a0',
	CALL: 'f1',
	CALLCODE: 'f2',
	DELEGATECALL: 'f4',
	STATICCALL: 'fa',
	REVERT: 'fd',
	POP: '50',
	CALLDATASIZE: '36',
};

/** mem[0] = byte, then `op` to `to` with that one byte as input, result popped. */
function callWithByte(
	op: 'CALL' | 'CALLCODE' | 'DELEGATECALL' | 'STATICCALL',
	to: Uint8Array,
	byte: number,
): string {
	const withValue = op === 'CALL' || op === 'CALLCODE';
	return (
		push1(byte) +
		push1(0) +
		OP.MSTORE8 +
		push1(0) + // retSize
		push1(0) + // retOffset
		push1(1) + // argsSize
		push1(0) + // argsOffset
		(withValue ? push1(0) : '') +
		push20(to) +
		OP.GAS +
		OP[op] +
		OP.POP
	);
}

const REVERT_EMPTY = push1(0) + push1(0) + OP.REVERT;

/** Calls the console with 0xbb, then reverts: its frame's effects are undone. */
const INNER_CODE = unhex(
	callWithByte('STATICCALL', CONSOLE, 0xbb) + REVERT_EMPTY,
);

/**
 * Calls the console four ways around a reverting sub-call and some side
 * effects (a log, a storage write), then reverts as a whole iff it was given
 * any calldata.
 */
function outerCode(): Uint8Array {
	let body =
		callWithByte('STATICCALL', CONSOLE, 0xaa) +
		callWithByte('CALL', INNER, 0x01) +
		callWithByte('DELEGATECALL', CONSOLE, 0xcc) +
		callWithByte('STATICCALL', OTHER, 0xee) + // not the target: not recorded
		push1(0) +
		push1(0) +
		OP.LOG0 +
		push1(1) +
		push1(0) +
		OP.SSTORE +
		callWithByte('CALLCODE', CONSOLE, 0xdd);
	// CALLDATASIZE PUSH1 dest JUMPI STOP JUMPDEST <revert>
	const prefix = body + OP.CALLDATASIZE;
	const dest = prefix.length / 2 + 2 + 1 + 1;
	body = prefix + push1(dest) + OP.JUMPI + OP.STOP + OP.JUMPDEST + REVERT_EMPTY;
	return unhex(body);
}

const EXPECTED_ORDER = ['aa', 'bb', 'cc', 'dd'];

function freshState(): MemoryStore {
	const store = new MemoryStore({blockHash: fixtureBlockHash});
	const put = (a: Uint8Array, code?: Uint8Array) => {
		let codeHash = KECCAK_EMPTY;
		if (code) {
			codeHash = keccak_256(code);
			store.setCode(codeHash, code);
		}
		store.setAccount(a, {balance: 10n ** 20n, nonce: 0n, codeHash});
	};
	put(CALLER);
	put(OUTER, outerCode());
	put(INNER, INNER_CODE);
	return store;
}

function freshEvm(state = freshState()): {evm: Revm; state: MemoryStore} {
	return {
		evm: createRevmSync({wasm: wasmBytes(), state, spec: Spec.CANCUN}),
		state,
	};
}

/** Everything a store holds, as comparable plain data. */
function dumpState(s: MemoryStore) {
	const sorted = <V>(m: Map<string, V>) =>
		[...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
	return {
		accounts: sorted(s.accounts),
		code: sorted(s.code).map(([k, v]) => [k, tohex(v)]),
		storage: sorted(s.storage).map(([k, m]) => [
			k,
			sorted(m).map(([sk, v]) => [sk, tohex(v)]),
		]),
	};
}

type Entry = 'call' | 'transact' | 'create';

function run(entry: Entry, options: ExecuteOptions, record: boolean) {
	const {evm, state} = freshEvm();
	const o = record ? {...options, recordCallsTo: CONSOLE} : options;
	const out: Outcome =
		entry === 'call'
			? evm.call(o)
			: entry === 'transact'
				? evm.transact(o)
				: evm.create(o);
	return {out, state: dumpState(state)};
}

/** The outcome with the recorder's own field removed. */
function withoutRecorded(o: Outcome): Outcome {
	const {recordedCalls: _ignored, ...rest} = o;
	return rest;
}

const base = {from: CALLER, to: OUTER, gasLimit: 1_000_000n};

const SCENARIOS: {
	name: string;
	entry: Entry;
	options: ExecuteOptions;
	status: Outcome['status'];
}[] = [
	{name: 'call, full outcome', entry: 'call', options: base, status: 'success'},
	{
		name: 'call, returnState:false (light path)',
		entry: 'call',
		options: {...base, returnState: false},
		status: 'success',
	},
	{
		name: 'call that reverts as a whole',
		entry: 'call',
		options: {...base, data: unhex('01')},
		status: 'revert',
	},
	{
		name: 'call, light path, reverting',
		entry: 'call',
		options: {...base, data: unhex('01'), returnState: false},
		status: 'revert',
	},
	{
		name: 'transact, committing',
		entry: 'transact',
		options: base,
		status: 'success',
	},
	{
		name: 'transact, committing, reverting',
		entry: 'transact',
		options: {...base, data: unhex('01')},
		status: 'revert',
	},
	{
		name: 'transact, commit:false',
		entry: 'transact',
		options: {...base, commit: false},
		status: 'success',
	},
	{
		name: 'create whose init code calls the console',
		entry: 'create',
		options: {from: CALLER, gasLimit: 1_000_000n, data: outerCode()},
		status: 'success',
	},
	{
		name: 'validation error (nonce too high)',
		entry: 'transact',
		options: {...base, nonce: 99n},
		status: 'validation-error',
	},
];

describe('recordCallsTo: observing changes nothing', () => {
	for (const s of SCENARIOS) {
		it(`${s.name}: same outcome and same committed state, on vs off`, () => {
			const off = run(s.entry, s.options, false);
			const on = run(s.entry, s.options, true);
			expect(off.out.status).toBe(s.status);
			if (s.status === 'success' && s.options.returnState !== false) {
				// Not a vacuous comparison: there are logs and a storage write.
				expect(off.out.logs!.length).toBeGreaterThan(0);
				expect(off.out.stateChanges!.some((c) => c.storage.length > 0)).toBe(
					true,
				);
			}
			expect(off.out.recordedCalls).toBeUndefined();
			expect(on.out.recordedCalls).toBeDefined();
			// The FULL decoded outcome: status, gas, refunds, return data, logs,
			// bloom, state changes, effective and blob gas prices, error.
			expect(withoutRecorded(on.out)).toEqual(off.out);
			// And what was written through the store.
			expect(on.state).toEqual(off.state);
		});
	}

	it('on the wire, the v5 blob is the v4 blob plus the appended section', () => {
		for (const light of [false, true]) {
			const offEvm = freshEvm().evm;
			const onEvm = freshEvm().evm;
			const defaults = {spec: Spec.CANCUN, chainId: 1n, block: {}};
			const off = offEvm.executeRaw(encodeRequest(base, defaults, 0), {light});
			const on = onEvm.executeRaw(
				encodeRequest(
					{...base, recordCallsTo: CONSOLE},
					defaults,
					Flags.RECORD_CALLS,
				),
				{light},
			);
			expect(tohex(on.subarray(0, off.length))).toBe(tohex(off));
			expect(on.length).toBeGreaterThan(off.length);
			const decoded = decodeOutcome(on, {recordedCalls: true});
			expect(decoded.recordedCalls!.map(tohex)).toEqual(EXPECTED_ORDER);
		}
	});
});

describe('recordCallsTo: what is recorded', () => {
	it('records every frame running the code, in entry order, through reverts', () => {
		for (const s of SCENARIOS.filter((x) => x.entry !== 'create')) {
			if (s.name.startsWith('validation')) continue;
			const {out} = run(s.entry, s.options, true);
			// 0xbb is inside a sub-call that reverts; the reverting scenarios
			// revert the whole transaction after all four. CALL, STATICCALL,
			// DELEGATECALL and CALLCODE are all matched on the code address. The
			// STATICCALL to a different address (0xee) is not recorded.
			expect(out.recordedCalls!.map(tohex), s.name).toEqual(EXPECTED_ORDER);
		}
	});

	it('records frames of init code too', () => {
		const {out} = run('create', SCENARIOS[7].options, true);
		expect(out.success).toBe(true);
		expect(out.recordedCalls!.map(tohex)).toEqual(EXPECTED_ORDER);
	});

	it('is empty, not absent, when nothing calls the address or validation fails', () => {
		const {evm} = freshEvm();
		const none = evm.call({...base, recordCallsTo: addr('dead')});
		expect(none.success).toBe(true);
		expect(none.recordedCalls).toEqual([]);
		const rejected = evm.transact({
			...base,
			nonce: 99n,
			recordCallsTo: CONSOLE,
		});
		expect(rejected.status).toBe('validation-error');
		expect(rejected.recordedCalls).toEqual([]);
	});

	it('records the top-level frame when the transaction targets the address', () => {
		const {evm} = freshEvm();
		const data = unhex('0102030405');
		const out = evm.call({
			from: CALLER,
			to: CONSOLE,
			data,
			gasLimit: 100_000n,
			recordCallsTo: CONSOLE,
		});
		expect(out.success).toBe(true);
		expect(out.recordedCalls!.map(tohex)).toEqual([tohex(data)]);
	});

	it('is reset per call: the persistent executor does not leak a recording', () => {
		const {evm} = freshEvm();
		const first = evm.call({...base, recordCallsTo: CONSOLE});
		expect(first.recordedCalls).toHaveLength(4);
		const second = evm.call(base);
		expect(second.recordedCalls).toBeUndefined();
		const third = evm.call({...base, recordCallsTo: CONSOLE});
		expect(third.recordedCalls!.map(tohex)).toEqual(EXPECTED_ORDER);
		// And a non-recording call after a recording one is byte-identical to one
		// on a fresh instance.
		const defaults = {spec: Spec.CANCUN, chainId: 1n, block: {}};
		const req = encodeRequest(base, defaults, 0);
		const after = evm.executeRaw(req);
		const fresh = freshEvm().evm.executeRaw(req);
		expect(tohex(after)).toBe(tohex(fresh));
	});
});

describe('recordCallsTo: the target stays a cold, empty account', () => {
	// Each contract's FIRST touch of the address is the recorded call. CALLER and
	// the contracts are in different slots so they cannot pre-warm anything.
	const EMPTY_ELSEWHERE = addr('e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0');
	const ONE_CALL = addr('4000');
	const CONTROL = addr('4001');
	const REVERTING_SUB = addr('4002');
	const SUB_CALLER = addr('4003');

	function gasOf(to: Uint8Array, record: boolean) {
		const state = new MemoryStore({blockHash: fixtureBlockHash});
		const put = (a: Uint8Array, code?: Uint8Array) => {
			let codeHash = KECCAK_EMPTY;
			if (code) {
				codeHash = keccak_256(code);
				state.setCode(codeHash, code);
			}
			state.setAccount(a, {balance: 10n ** 20n, nonce: 0n, codeHash});
		};
		put(CALLER);
		put(ONE_CALL, unhex(callWithByte('STATICCALL', CONSOLE, 0xaa) + OP.STOP));
		put(
			CONTROL,
			unhex(callWithByte('STATICCALL', EMPTY_ELSEWHERE, 0xaa) + OP.STOP),
		);
		put(
			REVERTING_SUB,
			unhex(callWithByte('STATICCALL', CONSOLE, 0xbb) + REVERT_EMPTY),
		);
		put(SUB_CALLER, unhex(callWithByte('CALL', REVERTING_SUB, 0x01) + OP.STOP));
		const evm = createRevmSync({wasm: wasmBytes(), state, spec: Spec.CANCUN});
		return evm.transact({
			from: CALLER,
			to,
			gasLimit: 1_000_000n,
			...(record ? {recordCallsTo: CONSOLE} : {}),
		});
	}

	it('a first-touch recorded call is charged cold (2,600), exactly as with the recorder off', () => {
		const off = gasOf(ONE_CALL, false);
		const on = gasOf(ONE_CALL, true);
		expect(on.success).toBe(true);
		expect(on.recordedCalls!.map(tohex)).toEqual(['aa']);
		expect(on.gasUsed).toBe(off.gasUsed);
		// And in absolute terms: identical to the same bytecode calling some
		// other empty, cold address. Had the target been pre-warmed (as a
		// precompile would be), this would be 2,500 gas cheaper.
		expect(on.gasUsed).toBe(gasOf(CONTROL, false).gasUsed);
	});

	it('a first-touch recorded call inside a reverting sub-call: same gas, still recorded', () => {
		const off = gasOf(SUB_CALLER, false);
		const on = gasOf(SUB_CALLER, true);
		expect(on.success).toBe(true);
		expect(on.recordedCalls!.map(tohex)).toEqual(['bb']);
		expect(withoutRecorded(on)).toEqual(off);
	});
});

describe('recordCallsTo: a malformed request still carries the section', () => {
	const defaults = {spec: Spec.CANCUN, chainId: 1n, block: {}};
	const request = () =>
		encodeRequest(
			{...base, recordCallsTo: CONSOLE},
			defaults,
			Flags.RECORD_CALLS,
		);

	it('bad version', () => {
		const req = request();
		req[0] = 0xff;
		const out = decodeOutcome(freshEvm().evm.executeRaw(req), {
			recordedCalls: true,
		});
		expect(out.status).toBe('validation-error');
		expect(out.error).toMatch(/RequestBadVersion/);
		expect(out.recordedCalls).toEqual([]);
	});

	it('target missing (truncated)', () => {
		const req = request();
		const out = decodeOutcome(
			freshEvm().evm.executeRaw(req.subarray(0, req.length - 20)),
			{recordedCalls: true},
		);
		expect(out.status).toBe('validation-error');
		expect(out.error).toMatch(/RequestTruncated/);
		expect(out.recordedCalls).toEqual([]);
	});

	it('the decoder rejects a corrupt section instead of running off the end', () => {
		const ok = freshEvm().evm.executeRaw(request());
		const bad = ok.slice();
		const dv = new DataView(bad.buffer);
		const sectionLen = dv.getUint32(bad.length - 4, true);
		// Corrupt the count.
		dv.setUint32(bad.length - 4 - sectionLen, 0xffffffff, true);
		expect(() => decodeOutcome(bad, {recordedCalls: true})).toThrow(
			/malformed recorded-calls/,
		);
	});
});

describe('recordCallsTo: degradation', () => {
	it('refuses an artifact that predates outcome format v5', () => {
		const state = new MemoryStore();
		let instance: WebAssembly.Instance | undefined;
		const host = storeToHostFunctions(
			state,
			() => instance!.exports.memory as WebAssembly.Memory,
		);
		instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes()), {
			revm_wasm_host: host as unknown as WebAssembly.ModuleImports,
		});
		// The same artifact, claiming to be v4.
		const old = {
			...(instance.exports as Record<string, unknown>),
			revm_wasm_outcome_format_version: () => 4,
		};
		const evm = new Revm(
			old as unknown as ConstructorParameters<typeof Revm>[0],
			{spec: Spec.CANCUN, chainId: 1n, block: {}},
			state,
		);
		expect(() => evm.call({...base, recordCallsTo: CONSOLE})).toThrow(
			/predates recordCallsTo/,
		);
		// Without the option, nothing changes.
		expect(evm.call(base).status).toBeDefined();
	});
});
