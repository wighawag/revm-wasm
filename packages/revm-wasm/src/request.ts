import {specToByte, type SpecInput} from './spec.js';
import type {BlockEnv, ExecuteOptions} from './types.js';

/**
 * Per-call flag bits. These mirror `revm_wasm_core::flags` exactly.
 *
 * **Bits 8 and above are unallocated and reserved**, on purpose. A future
 * per-call capability (a trace, a build-variant switch, a custom-precompile
 * opt-in) can be enabled by setting a new bit, with no new argument and no
 * breaking change at any entry point. An artifact that does not know a bit
 * ignores it, so an older artifact with a newer caller degrades to "the
 * capability did not happen" rather than trapping.
 */
export const Flags = {
	COMMIT: 1 << 0,
	CREATE: 1 << 1,
	/** All three simulation switches at once. Predates the individual bits. */
	RELAX_VALIDATION: 1 << 2,
	CHECK_NONCE: 1 << 3,
	/** `disableBaseFee`: skip `gasPrice >= baseFee`. */
	DISABLE_BASE_FEE: 1 << 4,
	/** `disableBalanceCheck`: skip `balance >= gasLimit * gasPrice + value`. */
	DISABLE_BALANCE_CHECK: 1 << 5,
	/** `disableBlockGasLimit`: skip `gasLimit <= block gas limit`. */
	DISABLE_BLOCK_GAS_LIMIT: 1 << 6,
	/** `disableEip3607`: skip EIP-3607 (reject caller with code). */
	DISABLE_EIP3607: 1 << 7,
} as const;

/**
 * The bits that relax transaction validation, i.e. the ones that make an
 * execution a simulation rather than a transaction. Grouped because the entry
 * points have to refuse all of them on a committing path for the same reason.
 */
export const SIMULATION_FLAGS =
	Flags.RELAX_VALIDATION |
	Flags.DISABLE_BASE_FEE |
	Flags.DISABLE_BALANCE_CHECK |
	Flags.DISABLE_BLOCK_GAS_LIMIT |
	Flags.DISABLE_EIP3607;

/**
 * Resolve the simulation switches an options object asks for. Every one of them
 * defaults to off, so an options object that says nothing produces 0 and takes
 * exactly the path it took before these existed.
 */
export function simulationFlags(o: ExecuteOptions): number {
	let flags = 0;
	if (o.disableBaseFee) flags |= Flags.DISABLE_BASE_FEE;
	if (o.disableBalanceCheck) flags |= Flags.DISABLE_BALANCE_CHECK;
	if (o.disableBlockGasLimit) flags |= Flags.DISABLE_BLOCK_GAS_LIMIT;
	if (o.disableEip3607) flags |= Flags.DISABLE_EIP3607;
	return flags;
}

/** Fixed head of the request blob. Offsets 0..140 never move within version 1. */
const REQ_HEAD = 140;
const REQUEST_FORMAT_VERSION = 1;

const TX_EXTRAS_VERSION = 1;
const TX_EXTRAS_HEAD = 76;

const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

const EMPTY = new Uint8Array(0);

function writeBE(
	out: Uint8Array,
	offset: number,
	value: bigint,
	bytes: number,
): void {
	// Saturate rather than truncate. A silently truncated fee would surface as a
	// wrong gas number a long way from its cause.
	const max = (1n << BigInt(bytes * 8)) - 1n;
	let v = value < 0n ? 0n : value > max ? max : value;
	for (let i = offset + bytes - 1; i >= offset && v > 0n; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
}

function writeU64LE(out: Uint8Array, offset: number, value: bigint): void {
	let v = value < 0n ? 0n : value > U64_MAX ? U64_MAX : value;
	for (let i = 0; i < 8; i++) {
		out[offset + i] = Number(v & 0xffn);
		v >>= 8n;
	}
}

function writeU32LE(out: Uint8Array, offset: number, value: number): void {
	out[offset] = value & 0xff;
	out[offset + 1] = (value >>> 8) & 0xff;
	out[offset + 2] = (value >>> 16) & 0xff;
	out[offset + 3] = (value >>> 24) & 0xff;
}

function copyRight(
	out: Uint8Array,
	offset: number,
	width: number,
	src?: Uint8Array,
): void {
	if (src === undefined || src.length === 0) return;
	if (src.length > width)
		throw new Error(
			`revm-wasm: value is ${src.length} bytes, expected at most ${width}`,
		);
	out.set(src, offset + width - src.length);
}

export interface RequestDefaults {
	spec: number;
	chainId: bigint;
	block: BlockEnv;
}

/**
 * Does this call carry anything the fee/typed-transaction section needs to say?
 *
 * When nothing does, the section is omitted entirely and the artifact takes the
 * same path a zero-fee call takes. That is what keeps a zero-fee corpus usable
 * as a non-regression control: this code merely existing cannot perturb it.
 */
function needsExtras(o: ExecuteOptions, block: BlockEnv): boolean {
	return (
		o.gasPrice !== undefined ||
		o.maxFeePerGas !== undefined ||
		o.maxPriorityFeePerGas !== undefined ||
		o.txType !== undefined ||
		(o.nonce !== undefined && o.nonce !== 0n) ||
		(o.accessList !== undefined && o.accessList.length > 0) ||
		(o.blobVersionedHashes !== undefined && o.blobVersionedHashes.length > 0) ||
		o.maxFeePerBlobGas !== undefined ||
		(o.authorizationList !== undefined && o.authorizationList.length > 0) ||
		(block.baseFeePerGas !== undefined && block.baseFeePerGas !== 0n) ||
		block.excessBlobGas !== undefined ||
		block.prevRandao !== undefined
	);
}

function encodeExtras(o: ExecuteOptions, block: BlockEnv): Uint8Array {
	const accessList = o.accessList ?? [];
	const blobHashes = o.blobVersionedHashes ?? [];
	const auths = o.authorizationList ?? [];

	const prevRandao = block.prevRandao;

	let size = TX_EXTRAS_HEAD + 4;
	for (const e of accessList)
		size += 20 + 4 + 32 * (e.storageKeys?.length ?? 0);
	size += 4 + 32 * blobHashes.length;
	size += 4 + 125 * auths.length;
	// Appended after the variable-length sections, never inserted into the head:
	// an artifact that predates it reads the sections it knows, ignores the
	// `present` bit it does not, and stops. Same discipline as the outcome format.
	if (prevRandao !== undefined) size += 32;

	const out = new Uint8Array(size);
	let present = 0;
	if (o.maxPriorityFeePerGas !== undefined) present |= 1;
	if (o.txType !== undefined) present |= 2;
	if (block.excessBlobGas !== undefined) present |= 4;
	if (prevRandao !== undefined) present |= 8;

	out[0] = TX_EXTRAS_VERSION;
	out[1] = present;
	out[2] = o.txType ?? 0;
	out[3] = 0;
	// revm keeps legacy `gasPrice` and 1559 `maxFeePerGas` in ONE field and reads
	// it through `Transaction::max_fee_per_gas`, so this is not a bug: it is
	// revm's own model, and duplicating the distinction here would mean
	// reimplementing the fee market, which is exactly what must not happen.
	writeBE(out, 4, o.maxFeePerGas ?? o.gasPrice ?? 0n, 16);
	writeBE(out, 20, o.maxPriorityFeePerGas ?? 0n, 16);
	writeBE(out, 36, o.maxFeePerBlobGas ?? 0n, 16);
	writeU64LE(out, 52, block.baseFeePerGas ?? 0n);
	writeU64LE(out, 60, o.nonce ?? 0n);
	writeU64LE(out, 68, block.excessBlobGas ?? 0n);

	let p = TX_EXTRAS_HEAD;
	writeU32LE(out, p, accessList.length);
	p += 4;
	for (const e of accessList) {
		copyRight(out, p, 20, e.address);
		p += 20;
		const keys = e.storageKeys ?? [];
		writeU32LE(out, p, keys.length);
		p += 4;
		for (const k of keys) {
			copyRight(out, p, 32, k);
			p += 32;
		}
	}
	writeU32LE(out, p, blobHashes.length);
	p += 4;
	for (const h of blobHashes) {
		copyRight(out, p, 32, h);
		p += 32;
	}
	writeU32LE(out, p, auths.length);
	p += 4;
	for (const a of auths) {
		writeBE(out, p, a.chainId, 32);
		p += 32;
		copyRight(out, p, 20, a.address);
		p += 20;
		writeU64LE(out, p, a.nonce);
		p += 8;
		out[p] = a.yParity & 0xff;
		p += 1;
		copyRight(out, p, 32, a.r);
		p += 32;
		copyRight(out, p, 32, a.s);
		p += 32;
	}
	if (prevRandao !== undefined) {
		copyRight(out, p, 32, prevRandao);
		p += 32;
	}
	if (p !== size) throw new Error('revm-wasm: extras encoder length mismatch');
	return out;
}

/**
 * Encode one execution request.
 *
 * The head is fixed at offsets 0..140 for the life of request format version 1;
 * the calldata and the fee/typed section follow it and are length-prefixed, so a
 * future section is appended rather than inserted. Same discipline as the
 * outcome format, for the same reason.
 */
export function encodeRequest(
	o: ExecuteOptions,
	defaults: RequestDefaults,
	flags: number,
	specOverride?: SpecInput,
): Uint8Array {
	const block: BlockEnv = {...defaults.block, ...o.block};
	const data = o.data ?? EMPTY;
	const extras = needsExtras(o, block) ? encodeExtras(o, block) : EMPTY;

	const out = new Uint8Array(REQ_HEAD + 4 + data.length + 4 + extras.length);
	out[0] = REQUEST_FORMAT_VERSION;
	out[1] = specToByte(specOverride ?? o.spec, defaults.spec);
	writeU32LE(out, 4, flags);
	writeU64LE(out, 8, o.gasLimit ?? 30_000_000n);
	writeU64LE(out, 16, o.chainId ?? defaults.chainId);
	writeU64LE(out, 24, block.number ?? 0n);
	writeU64LE(out, 32, block.timestamp ?? 0n);
	writeU64LE(out, 40, block.gasLimit ?? 30_000_000n);
	copyRight(out, 48, 20, o.from);
	copyRight(out, 68, 20, o.to);
	copyRight(out, 88, 20, block.coinbase);
	writeBE(out, 108, o.value ?? 0n, 32);

	writeU32LE(out, REQ_HEAD, data.length);
	out.set(data, REQ_HEAD + 4);
	const extrasAt = REQ_HEAD + 4 + data.length;
	writeU32LE(out, extrasAt, extras.length);
	if (extras.length > 0) out.set(extras, extrasAt + 4);
	return out;
}

export {U128_MAX};
