import type {AccountState, Address, Bytes32} from './types.js';

/**
 * The state interface the EVM is driven against.
 *
 * **This is an adapter over YOUR state, not a place state lives.** Nothing in
 * this package retains state between calls except through whatever you pass
 * here. `revm-wasm` ships one implementation ({@link MemoryStore}) because a
 * package with no runnable example is annoying, not because you are expected to
 * use it.
 *
 * ## Reads
 *
 * `getAccount`, `getStorage`, `getCode` and `getBlockHash` must be
 * **synchronous**. That is not a style preference: the EVM interpreter is a
 * synchronous loop inside wasm, and a state read happens in the middle of an
 * opcode. There is no suspension point to await at. A consumer whose state is
 * behind an async store must pre-load what a call needs (or run the whole thing
 * in a worker with a synchronous view of it).
 *
 * ## Writes
 *
 * The write methods are only ever called when an execution is committing, and
 * they are called with revm's own commit semantics already applied:
 * `SELFDESTRUCT` and EIP-161 empty-account clearing both arrive as
 * `clearStorage` followed by `removeAccount`; a created account arrives as
 * `clearStorage` first, so a fresh contract never inherits storage from a
 * previous life at its address. You do not re-derive any of that. A read-only
 * consumer may throw from all five.
 *
 * ## Cost
 *
 * One state access is exactly one wasm-to-JS crossing. The spike measured that
 * crossing at ~0.51 microseconds against a null host, and a `Map`-backed host at
 * ~1.30, so **roughly 60% of a state access is your JS-side key handling**, not
 * the boundary. If state access is hot for you, that is where the time is. See
 * {@link MemoryStore} for a key encoding that is measurably cheaper than hex.
 */
export interface StateStore {
	/**
	 * The account, or `undefined` if it does not exist.
	 *
	 * On the READ methods the `Address` and `Bytes32` you receive are **reused
	 * scratch buffers, valid only for the duration of the call**. That is what
	 * makes a read allocation-free. Copy them if you retain them; the built-in
	 * store turns them into keys immediately and never holds them. The WRITE
	 * methods always receive fresh arrays you may keep.
	 */
	getAccount(address: Address): AccountState | undefined;
	/**
	 * The 32-byte value at `slot`, or `undefined` for an unset slot (which the
	 * EVM treats as zero). The returned array is copied immediately and is not
	 * retained, so returning a view into your own storage is safe.
	 */
	getStorage(address: Address, slot: Bytes32): Bytes32 | undefined;
	/** The code with this hash, or `undefined`. */
	getCode(codeHash: Bytes32): Uint8Array | undefined;
	/** The hash of a past block. Return 32 zero bytes if you do not know it. */
	getBlockHash(blockNumber: bigint): Bytes32 | undefined;

	setAccount(address: Address, account: AccountState): void;
	setCode(codeHash: Bytes32, code: Uint8Array): void;
	setStorage(address: Address, slot: Bytes32, value: Bytes32): void;
	/** Drop every storage slot of one account. Must be O(that account). */
	clearStorage(address: Address): void;
	removeAccount(address: Address): void;
}

/**
 * The raw, pointer-level host interface: exactly the ten functions the wasm
 * module imports.
 *
 * Implementing this instead of {@link StateStore} skips the small amount of
 * marshalling {@link storeToHostFunctions} does (a `bigint` per account load, a
 * `subarray` per key). It is exported because the shape is a measured decision
 * and a consumer with a tight state layout should be able to reach it, not
 * because most consumers need it.
 *
 * Every argument is an offset into the instance's linear memory. Answers are
 * written directly into that memory. **Linear memory can grow between calls**,
 * which detaches any cached `ArrayBuffer` view, so re-read `memory.buffer` when
 * a cached view reports `byteLength === 0`.
 */
export interface HostFunctions {
	/** Write `[32] balance BE | [8] nonce LE | [32] codeHash` at `outPtr`. Return 1 if the account exists. */
	basic(addrPtr: number, outPtr: number): number;
	/** Write the 32-byte big-endian storage value at `outPtr`. */
	storage(addrPtr: number, keyPtr: number, outPtr: number): void;
	/** Byte length of the code with the hash at `hashPtr`. */
	code_len(hashPtr: number): number;
	/** Copy that code to `outPtr`. */
	code_copy(hashPtr: number, outPtr: number): void;
	/** Write the 32-byte block hash at `outPtr`. The number arrives as two halves to avoid a BigInt per call. */
	block_hash(numLo: number, numHi: number, outPtr: number): void;
	set_account(addrPtr: number, packedPtr: number): void;
	set_code(hashPtr: number, codePtr: number, len: number): void;
	set_storage(addrPtr: number, keyPtr: number, valPtr: number): void;
	clear_storage(addrPtr: number): void;
	remove_account(addrPtr: number): void;
}

/** Returns the instance's current linear memory. */
export type MemoryProvider = () => WebAssembly.Memory;

const ZERO32 = new Uint8Array(32);

/**
 * Adapt a {@link StateStore} to the raw {@link HostFunctions} the wasm module
 * imports.
 *
 * The account layout, the endianness and the pointer arithmetic all live here
 * and nowhere else. A consumer implementing `StateStore` never sees any of it.
 */
export function storeToHostFunctions(
	store: StateStore,
	memory: MemoryProvider,
): HostFunctions {
	// Growing wasm memory detaches the old ArrayBuffer, which zeroes byteLength
	// on any cached view. Refresh lazily on that signal rather than allocating a
	// fresh view per access, which would dominate the cost of an access.
	// Starts empty rather than eager: the instance does not exist yet when this
	// is built, because the imports have to be ready before instantiation.
	let view = new Uint8Array(0);
	const mem = (): Uint8Array => {
		if (view.byteLength === 0) view = new Uint8Array(memory().buffer);
		return view;
	};

	// Scratch, reused: an address and a slot key are handed to the store as
	// views over these, so a read allocates nothing.
	const addrBuf = new Uint8Array(20);
	const keyBuf = new Uint8Array(32);
	const packed = new Uint8Array(72);
	const packedView = new DataView(packed.buffer);

	const readAddr = (u8: Uint8Array, ptr: number): Uint8Array => {
		addrBuf.set(u8.subarray(ptr, ptr + 20));
		return addrBuf;
	};
	const readKey = (u8: Uint8Array, ptr: number): Uint8Array => {
		keyBuf.set(u8.subarray(ptr, ptr + 32));
		return keyBuf;
	};

	return {
		basic(addrPtr, outPtr) {
			const u8 = mem();
			const acc = store.getAccount(readAddr(u8, addrPtr));
			if (acc === undefined) return 0;
			// balance: 32 bytes big-endian, written as four 64-bit limbs.
			let b = acc.balance;
			packedView.setBigUint64(24, b & 0xffffffffffffffffn);
			packedView.setBigUint64(16, (b >>= 64n) & 0xffffffffffffffffn);
			packedView.setBigUint64(8, (b >>= 64n) & 0xffffffffffffffffn);
			packedView.setBigUint64(0, (b >> 64n) & 0xffffffffffffffffn);
			packedView.setBigUint64(32, acc.nonce, true);
			packed.set(acc.codeHash, 40);
			u8.set(packed, outPtr);
			return 1;
		},
		storage(addrPtr, keyPtr, outPtr) {
			const u8 = mem();
			const v = store.getStorage(readAddr(u8, addrPtr), readKey(u8, keyPtr));
			u8.set(v === undefined ? ZERO32 : v, outPtr);
		},
		code_len(hashPtr) {
			const u8 = mem();
			const c = store.getCode(readKey(u8, hashPtr));
			return c === undefined ? 0 : c.length;
		},
		code_copy(hashPtr, outPtr) {
			const u8 = mem();
			const c = store.getCode(readKey(u8, hashPtr));
			if (c !== undefined) u8.set(c, outPtr);
		},
		block_hash(numLo, numHi, outPtr) {
			const u8 = mem();
			// Reassembled here rather than crossing as a BigInt, which is the
			// point of splitting it: BLOCKHASH is rare, a BigInt per call is not.
			const n = (BigInt(numHi >>> 0) << 32n) | BigInt(numLo >>> 0);
			const h = store.getBlockHash(n);
			u8.set(h === undefined ? ZERO32 : h, outPtr);
		},
		set_account(addrPtr, packedPtr) {
			const u8 = mem();
			// Writes are not the hot path, so they hand over fresh arrays a store
			// may retain, rather than the scratch buffers the reads use.
			const addr = u8.slice(addrPtr, addrPtr + 20);
			const dv = new DataView(u8.buffer, u8.byteOffset + packedPtr, 72);
			const balance =
				(dv.getBigUint64(0) << 192n) |
				(dv.getBigUint64(8) << 128n) |
				(dv.getBigUint64(16) << 64n) |
				dv.getBigUint64(24);
			store.setAccount(addr, {
				balance,
				nonce: dv.getBigUint64(32, true),
				codeHash: u8.slice(packedPtr + 40, packedPtr + 72),
			});
		},
		set_code(hashPtr, codePtr, len) {
			const u8 = mem();
			store.setCode(
				u8.slice(hashPtr, hashPtr + 32),
				u8.slice(codePtr, codePtr + len),
			);
		},
		set_storage(addrPtr, keyPtr, valPtr) {
			const u8 = mem();
			store.setStorage(
				u8.slice(addrPtr, addrPtr + 20),
				u8.slice(keyPtr, keyPtr + 32),
				u8.slice(valPtr, valPtr + 32),
			);
		},
		clear_storage(addrPtr) {
			const u8 = mem();
			store.clearStorage(u8.slice(addrPtr, addrPtr + 20));
		},
		remove_account(addrPtr) {
			const u8 = mem();
			store.removeAccount(u8.slice(addrPtr, addrPtr + 20));
		},
	};
}
