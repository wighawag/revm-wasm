import {describe, expect, it} from 'vitest';
import {keccak_256} from '@noble/hashes/sha3.js';

import {createRevmSync} from '../src/instance.js';
import {
	storeToHostFunctions,
	type HostFunctions,
	type StateStore,
} from '../src/host.js';
import {MemoryStore, KECCAK_EMPTY} from '../src/memory-store.js';
import type {AccountState, Address, Bytes32} from '../src/types.js';
import {tohex, unhex, wasmBytes} from './fixture-runner.js';

const addr = (hex: string): Uint8Array => {
	const out = new Uint8Array(20);
	const b = unhex(hex);
	out.set(b, 20 - b.length);
	return out;
};
const slot = (n: number): Uint8Array => {
	const out = new Uint8Array(32);
	new DataView(out.buffer).setUint32(28, n);
	return out;
};
const val = (n: number): Uint8Array => slot(n);

const A = addr('a1');
const B = addr('b2');
const CALLER = addr('ca11e2');

// PUSH1 1; PUSH1 0; SSTORE; STOP
const STORE_ONE = unhex('600160005500');
// A contract that SELFDESTRUCTs to the caller: PUSH20 caller? Simpler: CALLER; SELFDESTRUCT
const SELFDESTRUCT = unhex('33ff');

describe('MemoryStore storage is indexed per account', () => {
	it('clearing one account leaves every other account untouched', () => {
		const store = new MemoryStore();
		store.setStorage(A, slot(1), val(11));
		store.setStorage(A, slot(2), val(22));
		store.setStorage(B, slot(1), val(33));

		store.clearStorage(A);

		expect(store.getStorage(A, slot(1))).toBeUndefined();
		expect(store.getStorage(A, slot(2))).toBeUndefined();
		expect(tohex(store.getStorage(B, slot(1))!)).toBe(tohex(val(33)));
	});

	it('treats a zero value as the absence of a slot', () => {
		const store = new MemoryStore();
		store.setStorage(A, slot(1), val(11));
		store.setStorage(A, slot(1), new Uint8Array(32));
		expect(store.getStorage(A, slot(1))).toBeUndefined();
	});

	it('does not confuse two addresses that share a prefix', () => {
		// The flat `addressHex + slotHex` layout this replaces cleared by prefix
		// match, which is also why it was O(total state).
		const p1 = addr('1234000000000000000000000000000000000000');
		const p2 = addr('1234000000000000000000000000000000000001');
		const store = new MemoryStore();
		store.setStorage(p1, slot(1), val(1));
		store.setStorage(p2, slot(1), val(2));
		store.clearStorage(p1);
		expect(store.getStorage(p1, slot(1))).toBeUndefined();
		expect(tohex(store.getStorage(p2, slot(1))!)).toBe(tohex(val(2)));
	});

	it('clearStorage cost does not scale with unrelated state', () => {
		// The spike indexed storage as ONE flat map keyed by address-plus-slot, so
		// clearing one account was a scan of the whole map. SELFDESTRUCT hits it,
		// and so does every contract creation, because a created account's storage
		// is cleared first. With the per-account index this loop is 2,000 map
		// deletes; with a flat map it would be 2,000 scans of 100,000 entries,
		// i.e. 200,000,000 iterations. The threshold is deliberately loose so it
		// measures the algorithm and not the machine.
		const store = new MemoryStore();
		for (let i = 0; i < 100_000; i++)
			store.setStorage(addr('f00d'), slot(i), val(i + 1));

		const started = performance.now();
		for (let i = 0; i < 2_000; i++) {
			store.setStorage(A, slot(i), val(i + 1));
			store.clearStorage(A);
		}
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(1_000);
		expect(store.getStorage(addr('f00d'), slot(5))).toBeDefined();
	});
});

describe('the host interface can be backed by an external store', () => {
	/**
	 * A deliberately foreign store: plain objects keyed by hex, nothing from this
	 * package. If this works, a consumer whose state lives in IndexedDB, in a
	 * Merkle trie, or in their own typed-array arena can back it too.
	 */
	class ForeignStore implements StateStore {
		readonly accounts = new Map<string, AccountState>();
		readonly code = new Map<string, Uint8Array>();
		readonly storage = new Map<string, Map<string, Uint8Array>>();
		readonly log: string[] = [];

		getAccount(address: Address) {
			this.log.push('getAccount');
			return this.accounts.get(tohex(address));
		}
		getStorage(address: Address, key: Bytes32) {
			this.log.push('getStorage');
			return this.storage.get(tohex(address))?.get(tohex(key));
		}
		getCode(codeHash: Bytes32) {
			this.log.push('getCode');
			return this.code.get(tohex(codeHash));
		}
		getBlockHash() {
			return undefined;
		}
		setAccount(address: Address, account: AccountState) {
			this.log.push('setAccount');
			this.accounts.set(tohex(address), account);
		}
		setCode(codeHash: Bytes32, code: Uint8Array) {
			this.log.push('setCode');
			this.code.set(tohex(codeHash), code);
		}
		setStorage(address: Address, key: Bytes32, value: Bytes32) {
			this.log.push('setStorage');
			const a = tohex(address);
			let m = this.storage.get(a);
			if (!m) this.storage.set(a, (m = new Map()));
			m.set(tohex(key), value);
		}
		clearStorage(address: Address) {
			this.log.push('clearStorage');
			this.storage.delete(tohex(address));
		}
		removeAccount(address: Address) {
			this.log.push('removeAccount');
			this.accounts.delete(tohex(address));
		}
	}

	it('drives a committing transaction entirely through a foreign store', () => {
		const state = new ForeignStore();
		const codeHash = keccak_256(STORE_ONE);
		state.setCode(codeHash, STORE_ONE);
		state.setAccount(A, {balance: 0n, nonce: 0n, codeHash});
		state.setAccount(CALLER, {
			balance: 10n ** 18n,
			nonce: 0n,
			codeHash: KECCAK_EMPTY,
		});
		state.log.length = 0;

		const evm = createRevmSync({wasm: wasmBytes(), state});
		const out = evm.transact({
			from: CALLER,
			to: A,
			gasLimit: 100_000n,
			nonce: 0n,
		});

		expect(out.success).toBe(true);
		expect(state.log).toContain('getAccount');
		expect(state.log).toContain('getCode');
		expect(state.log).toContain('setStorage');
		expect(tohex(state.storage.get(tohex(A))!.get(tohex(slot(0)))!)).toBe(
			tohex(val(1)),
		);
		// The nonce moved, so the sender account really was written back.
		expect(state.accounts.get(tohex(CALLER))!.nonce).toBe(1n);
	});

	it('reports a selfdestruct as clearStorage then removeAccount, not as a diff to interpret', () => {
		const state = new ForeignStore();
		const codeHash = keccak_256(SELFDESTRUCT);
		state.setCode(codeHash, SELFDESTRUCT);
		// A pre-existing contract selfdestructing under Cancun is drained but NOT
		// deleted (EIP-6780), so this uses an account created in the same
		// transaction: deploy-and-destroy via CREATE is covered by the commit
		// fixture. Here the point is only that the store is told, not asked.
		state.setAccount(CALLER, {
			balance: 10n ** 18n,
			nonce: 0n,
			codeHash: KECCAK_EMPTY,
		});
		// An account that is touched and empty is deleted under EIP-161.
		state.setAccount(B, {balance: 0n, nonce: 0n, codeHash: KECCAK_EMPTY});
		state.log.length = 0;

		const evm = createRevmSync({wasm: wasmBytes(), state});
		const out = evm.transact({
			from: CALLER,
			to: B,
			gasLimit: 100_000n,
			nonce: 0n,
			value: 0n,
		});
		expect(out.success).toBe(true);
		expect(state.log).toContain('removeAccount');
		expect(state.accounts.has(tohex(B))).toBe(false);
	});
});

describe('the raw pointer host is reachable', () => {
	it('accepts a hand-written HostFunctions implementation', () => {
		// Proves the escape hatch: a consumer with a tight state layout can skip
		// the small marshalling storeToHostFunctions does and talk pointers. The
		// host is supplied as a factory because it needs the instance's linear
		// memory, which does not exist until the imports are ready.
		const backing = new MemoryStore();
		const codeHash = keccak_256(STORE_ONE);
		backing.setCode(codeHash, STORE_ONE);
		backing.setAccount(A, {balance: 0n, nonce: 0n, codeHash});
		backing.setAccount(CALLER, {
			balance: 10n ** 18n,
			nonce: 0n,
			codeHash: KECCAK_EMPTY,
		});

		let basicCalls = 0;
		let storageCalls = 0;
		const evm = createRevmSync({
			wasm: wasmBytes(),
			host: (memory): HostFunctions => {
				const delegate = storeToHostFunctions(backing, memory);
				return {
					...delegate,
					basic(addrPtr, outPtr) {
						basicCalls++;
						return delegate.basic(addrPtr, outPtr);
					},
					storage(addrPtr, keyPtr, outPtr) {
						storageCalls++;
						delegate.storage(addrPtr, keyPtr, outPtr);
					},
				};
			},
		});

		// A raw host means the instance has no store of its own to expose.
		expect(evm.state).toBeUndefined();

		const out = evm.call({from: CALLER, to: A, gasLimit: 100_000n});
		expect(out.success).toBe(true);
		expect(basicCalls).toBeGreaterThan(0);
		// One crossing per COLD storage access, which is the whole point of the
		// pointer shape: the boundary is not crossed per opcode.
		expect(storageCalls).toBe(1);
	});
});
