/**
 * The fixture corpus, with NO Node dependencies, so the identical code drives
 * both the vitest suite and the in-browser suite.
 *
 * Running the same corpus in more than one JavaScript engine is deliberate. A
 * wasm module behaves differently enough across V8 and JavaScriptCore that
 * measuring only one hid a material difference during evaluation, so a
 * Chromium-only test suite would be reporting on one engine and implying two.
 */
import {keccak_256} from '@noble/hashes/sha3.js';

import {createRevmSync} from '../src/instance.js';
import {MemoryStore, KECCAK_EMPTY} from '../src/memory-store.js';
import {encodeRequest, Flags} from '../src/request.js';
import type {
	AccessListEntry,
	Authorization,
	ExecuteOptions,
} from '../src/types.js';

export function unhex(s: string | undefined | null): Uint8Array {
	if (!s) return new Uint8Array(0);
	let h = s.startsWith('0x') ? s.slice(2) : s;
	if (h.length % 2) h = '0' + h;
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++)
		out[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
	return out;
}

export function tohex(u8: Uint8Array): string {
	let s = '';
	for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
	return s;
}

function padLeft(u8: Uint8Array, n: number): Uint8Array {
	if (u8.length === n) return u8;
	const out = new Uint8Array(n);
	out.set(u8.subarray(Math.max(0, u8.length - n)), Math.max(0, n - u8.length));
	return out;
}

function big(v: string | number | undefined | null): bigint {
	if (v === undefined || v === null || v === '') return 0n;
	return BigInt(v);
}

export interface FixtureCall {
	name: string;
	caller: string;
	to?: string;
	data?: string;
	gas_limit: number | string;
	value?: string;
	create?: boolean;
	commit?: boolean;
	check_nonce?: boolean;
	gas_price?: string;
	priority_fee?: string | null;
	tx_type?: number | null;
	nonce?: number;
	access_list?: {address: string; storage_keys?: string[]}[];
	blob_hashes?: string[];
	max_fee_per_blob_gas?: string;
	auth_list?: {
		chain_id: string;
		address: string;
		nonce?: number;
		v: number;
		r: string;
		s: string;
	}[];
}

export interface FixtureGroup {
	spec: number;
	chain_id?: number;
	block: {
		number: number | string;
		timestamp: number | string;
		gas_limit: number | string;
		coinbase: string;
		basefee?: string | number;
		excess_blob_gas?: number | null;
	};
	accounts: Record<
		string,
		{
			balance?: string;
			nonce?: number;
			code?: string;
			storage?: Record<string, string>;
		}
	>;
	calls: FixtureCall[];
}

/**
 * The block-hash stand-in the reference runner used: the block number
 * big-endian in the low 8 bytes. Deterministic on both sides, which is all a
 * differential needs. A real consumer answers this from their header store.
 */
export function fixtureBlockHash(n: bigint): Uint8Array {
	const out = new Uint8Array(32);
	let v = n;
	for (let i = 31; i >= 24; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

export function buildStore(group: FixtureGroup): MemoryStore {
	const store = new MemoryStore({blockHash: fixtureBlockHash});
	for (const [addrHex, acc] of Object.entries(group.accounts)) {
		const address = padLeft(unhex(addrHex), 20);
		const code = unhex(acc.code ?? '');
		let codeHash = KECCAK_EMPTY;
		if (code.length > 0) {
			codeHash = keccak_256(code);
			store.setCode(codeHash, code);
		}
		store.setAccount(address, {
			balance: big(acc.balance ?? '0x0'),
			nonce: BigInt(acc.nonce ?? 0),
			codeHash,
		});
		for (const [k, v] of Object.entries(acc.storage ?? {})) {
			store.setStorage(address, padLeft(unhex(k), 32), padLeft(unhex(v), 32));
		}
	}
	return store;
}

export function callToOptions(
	group: FixtureGroup,
	call: FixtureCall,
): ExecuteOptions {
	const accessList: AccessListEntry[] | undefined = call.access_list?.map(
		(e) => ({
			address: padLeft(unhex(e.address), 20),
			storageKeys: (e.storage_keys ?? []).map((k) => padLeft(unhex(k), 32)),
		}),
	);
	const authorizationList: Authorization[] | undefined = call.auth_list?.map(
		(a) => ({
			chainId: big(a.chain_id),
			address: padLeft(unhex(a.address), 20),
			nonce: BigInt(a.nonce ?? 0),
			yParity: a.v & 0xff,
			r: padLeft(unhex(a.r), 32),
			s: padLeft(unhex(a.s), 32),
		}),
	);

	return {
		from: padLeft(unhex(call.caller), 20),
		to: call.create ? undefined : padLeft(unhex(call.to ?? '0x'), 20),
		data: unhex(call.data ?? ''),
		gasLimit: BigInt(call.gas_limit),
		value: big(call.value ?? '0x0'),
		spec: group.spec,
		chainId: BigInt(group.chain_id ?? 1),
		block: {
			number: big(group.block.number as string),
			timestamp: big(group.block.timestamp as string),
			gasLimit: big(group.block.gas_limit as string),
			coinbase: padLeft(unhex(group.block.coinbase), 20),
			baseFeePerGas:
				group.block.basefee === undefined
					? undefined
					: big(group.block.basefee as string),
			excessBlobGas:
				group.block.excess_blob_gas === undefined ||
				group.block.excess_blob_gas === null
					? undefined
					: BigInt(group.block.excess_blob_gas),
		},
		// `undefined` and `0` are NOT interchangeable for these three: the
		// PRESENCE of a priority fee is what makes revm derive a 1559-family
		// transaction type, and the same goes for an explicit tx type and for
		// excessBlobGas.
		gasPrice: call.gas_price === undefined ? undefined : big(call.gas_price),
		maxPriorityFeePerGas:
			call.priority_fee === undefined || call.priority_fee === null
				? undefined
				: big(call.priority_fee),
		txType:
			call.tx_type === undefined || call.tx_type === null
				? undefined
				: call.tx_type,
		nonce: call.nonce === undefined ? undefined : BigInt(call.nonce),
		accessList,
		blobVersionedHashes: call.blob_hashes?.map((h) => padLeft(unhex(h), 32)),
		maxFeePerBlobGas:
			call.max_fee_per_blob_gas === undefined
				? undefined
				: big(call.max_fee_per_blob_gas),
		authorizationList,
	};
}

/**
 * Run every call of every group and return the RAW outcome blobs as hex, which
 * is what the recorded expectations hold. Driving the raw path means the
 * comparison covers the whole blob (the bloom, the effective gas price, every
 * balance, every slot) rather than only the fields the decoder surfaces.
 */
export function runGroups(
	wasm: Uint8Array | WebAssembly.Module,
	groups: FixtureGroup[],
): {name: string; outcome: string}[] {
	const results: {name: string; outcome: string}[] = [];
	for (const group of groups) {
		const state = buildStore(group);
		const chainId = BigInt(group.chain_id ?? 1);
		const evm = createRevmSync({wasm, state, spec: group.spec, chainId});
		for (const call of group.calls) {
			let flags = 0;
			if (call.create) flags |= Flags.CREATE;
			if (call.commit) flags |= Flags.COMMIT;
			if (call.check_nonce) flags |= Flags.CHECK_NONCE;
			const blob = evm.executeRaw(
				encodeRequest(
					callToOptions(group, call),
					{spec: group.spec, chainId, block: {}},
					flags,
				),
			);
			results.push({name: call.name, outcome: tohex(blob)});
		}
	}
	return results;
}

/** Compare a run against its recording, returning a list of human-readable diffs. */
export function compare(
	label: string,
	actual: {name: string; outcome: string}[],
	expected: {name: string; outcome: string}[],
): string[] {
	const problems: string[] = [];
	if (actual.length !== expected.length) {
		problems.push(
			`${label}: ran ${actual.length} calls, expected ${expected.length}`,
		);
		return problems;
	}
	for (let i = 0; i < expected.length; i++) {
		if (actual[i].name !== expected[i].name) {
			problems.push(
				`${label}[${i}]: name ${actual[i].name} != ${expected[i].name}`,
			);
		} else if (actual[i].outcome !== expected[i].outcome) {
			problems.push(`${label}/${expected[i].name}: outcome mismatch`);
		}
	}
	return problems;
}
