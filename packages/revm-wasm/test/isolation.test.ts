import {describe, expect, it} from 'vitest';
import {keccak_256} from '@noble/hashes/sha3.js';

import {createRevmSync} from '../src/instance.js';
import {MemoryStore, KECCAK_EMPTY} from '../src/memory-store.js';
import {tohex, unhex, wasmBytes} from './fixture-runner.js';

const addr = (hex: string): Uint8Array => {
	const out = new Uint8Array(20);
	const b = unhex(hex);
	out.set(b, 20 - b.length);
	return out;
};

const CALLER = addr('ca11e2');
const TARGET = addr('2000');

/** PUSH1 n; PUSH1 0; MSTORE; PUSH1 0x20; PUSH1 0; RETURN */
const returns = (n: number): Uint8Array =>
	unhex(`60${n.toString(16).padStart(2, '0')}60005260206000f3`);

function evmReturning(n: number) {
	const state = new MemoryStore();
	const code = returns(n);
	const codeHash = keccak_256(code);
	state.setCode(codeHash, code);
	state.setAccount(TARGET, {balance: 0n, nonce: 0n, codeHash});
	state.setAccount(CALLER, {
		balance: 10n ** 18n,
		nonce: 0n,
		codeHash: KECCAK_EMPTY,
	});
	return {state, evm: createRevmSync({wasm: wasmBytes(), state})};
}

/**
 * The regression test for the single nastiest bug the spike hit.
 *
 * With wasm-bindgen's `--target web` glue, the instance's exports and the host
 * bindings both live in module-level variables, so two builds loaded in one
 * process shared them: the second instance's linear memory answered the first
 * instance's state reads. It produced plausible numbers with the wrong sign and
 * was invisible. The spike's workaround was a `?dist=` query string forcing a
 * separate module instance per build.
 *
 * This package binds the host per `WebAssembly.instantiate` instead, so the
 * hazard cannot exist. These tests exist so it cannot come back.
 */
describe('instances are isolated', () => {
	it('two instances in one process answer from their own state', () => {
		const one = evmReturning(0x11);
		const two = evmReturning(0x22);

		const a = one.evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n});
		const b = two.evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n});

		expect(a.returnData[31]).toBe(0x11);
		expect(b.returnData[31]).toBe(0x22);

		// And again interleaved, because a shared binding would only be wrong
		// after the second instance is created.
		expect(
			one.evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n})
				.returnData[31],
		).toBe(0x11);
		expect(
			two.evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n})
				.returnData[31],
		).toBe(0x22);
	});

	it('a commit in one instance is invisible to the other', () => {
		const one = evmReturning(0x11);
		const two = evmReturning(0x22);

		// PUSH1 7; PUSH1 3; SSTORE; STOP, deployed only in instance one.
		const writer = addr('3000');
		const code = unhex('600760035500');
		const codeHash = keccak_256(code);
		one.state.setCode(codeHash, code);
		one.state.setAccount(writer, {balance: 0n, nonce: 0n, codeHash});

		one.evm.transact({from: CALLER, to: writer, gasLimit: 100_000n, nonce: 0n});

		const key = new Uint8Array(32);
		key[31] = 3;
		expect(one.state.getStorage(writer, key)).toBeDefined();
		expect(two.state.getStorage(writer, key)).toBeUndefined();
		expect(two.state.getAccount(writer)).toBeUndefined();
	});

	it('instances share a compiled module without sharing state', () => {
		// Compiling is the expensive part, so sharing a Module is the right way to
		// make many instances. It must not leak state between them.
		const module = new WebAssembly.Module(wasmBytes());

		const build = (n: number) => {
			const state = new MemoryStore();
			const code = returns(n);
			const codeHash = keccak_256(code);
			state.setCode(codeHash, code);
			state.setAccount(TARGET, {balance: 0n, nonce: 0n, codeHash});
			state.setAccount(CALLER, {
				balance: 10n ** 18n,
				nonce: 0n,
				codeHash: KECCAK_EMPTY,
			});
			return createRevmSync({wasm: module, state});
		};

		const evms = [build(1), build(2), build(3)];
		const results = evms.map((e) =>
			e.call({from: CALLER, to: TARGET, gasLimit: 100_000n}),
		);
		expect(results.map((r) => r.returnData[31])).toEqual([1, 2, 3]);
	});

	it('reports the same versions from every instance', () => {
		const module = new WebAssembly.Module(wasmBytes());
		const a = createRevmSync({wasm: module, state: new MemoryStore()});
		const b = createRevmSync({wasm: module, state: new MemoryStore()});
		expect(a.revmRevision).toBe(b.revmRevision);
		expect(tohex(new Uint8Array([a.outcomeFormatVersion]))).toBe(
			tohex(new Uint8Array([b.outcomeFormatVersion])),
		);
	});
});
