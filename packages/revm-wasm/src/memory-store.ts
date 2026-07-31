import type {StateStore} from './host.js';
import type {AccountState, Address, Bytes32} from './types.js';

/**
 * keccak256 of the empty byte string, i.e. the code hash of an account with no
 * code. Exported because a store implementation needs it and computing it
 * requires a keccak, which this package deliberately does not ship.
 */
export const KECCAK_EMPTY: Bytes32 = new Uint8Array([
	0xc5, 0xd2, 0x46, 0x01, 0x86, 0xf7, 0x23, 0x3c, 0x92, 0x7e, 0x7d, 0xb2, 0xdc,
	0xc7, 0x03, 0xc0, 0xe5, 0x00, 0xb6, 0x53, 0xca, 0x82, 0x27, 0x3b, 0x7b, 0xfa,
	0xd8, 0x04, 0x5d, 0x85, 0xa4, 0x70,
]);

/**
 * Map key for a 20-byte address: ten UTF-16 code units rather than forty hex
 * characters.
 *
 * This is not micro-optimisation for its own sake. The spike measured a
 * `Map`-backed host at ~1.30 microseconds per state access against ~0.51 for
 * the wasm crossing alone, so **about 60% of a state access was JS-side hex key
 * construction**, more than the boundary crossing it was there to serve.
 * Packing two bytes per code unit is one `String.fromCharCode` call and a
 * quarter of the characters.
 *
 * Lone surrogates in the D800-DFFF range are produced and that is fine: a JS
 * string is a sequence of code units, `Map` compares them by value, and nothing
 * here ever encodes one to UTF-8.
 */
function addrKey(a: Uint8Array): string {
	return String.fromCharCode(
		(a[0] << 8) | a[1],
		(a[2] << 8) | a[3],
		(a[4] << 8) | a[5],
		(a[6] << 8) | a[7],
		(a[8] << 8) | a[9],
		(a[10] << 8) | a[11],
		(a[12] << 8) | a[13],
		(a[14] << 8) | a[15],
		(a[16] << 8) | a[17],
		(a[18] << 8) | a[19],
	);
}

/** Map key for a 32-byte value: sixteen code units. Same reasoning as {@link addrKey}. */
function key32(a: Uint8Array): string {
	return String.fromCharCode(
		(a[0] << 8) | a[1],
		(a[2] << 8) | a[3],
		(a[4] << 8) | a[5],
		(a[6] << 8) | a[7],
		(a[8] << 8) | a[9],
		(a[10] << 8) | a[11],
		(a[12] << 8) | a[13],
		(a[14] << 8) | a[15],
		(a[16] << 8) | a[17],
		(a[18] << 8) | a[19],
		(a[20] << 8) | a[21],
		(a[22] << 8) | a[23],
		(a[24] << 8) | a[25],
		(a[26] << 8) | a[27],
		(a[28] << 8) | a[29],
		(a[30] << 8) | a[31],
	);
}

export interface MemoryStoreOptions {
	/**
	 * Answers `BLOCKHASH`. Defaults to 32 zero bytes for every block, which is
	 * what an engine with no header history can honestly say.
	 */
	blockHash?: (blockNumber: bigint) => Bytes32 | undefined;
}

/**
 * A plain in-memory {@link StateStore}.
 *
 * Provided so the package is runnable and testable out of the box. A real
 * consumer keeps state authoritative on their own side and implements
 * `StateStore` over it; nothing in this package requires this class.
 *
 * ## Storage is indexed PER ACCOUNT
 *
 * The obvious layout is one flat map keyed by address-plus-slot. The spike used
 * it and knowingly shipped it broken: `clearStorage` then has to scan the whole
 * map looking for a prefix, so clearing one account's storage costs O(total
 * state) instead of O(that account). `SELFDESTRUCT` hits it, and so does every
 * contract creation, because a created account's storage is cleared first so it
 * cannot inherit storage from a previous life at the same address. On a state
 * of any size that is a per-creation full scan.
 *
 * Here `storage` is `Map<account, Map<slot, value>>`, so `clearStorage` is one
 * `delete` and the cost is proportional to that account. If you implement your
 * own store, do the same.
 */
export class MemoryStore implements StateStore {
	/** address key -> account. */
	readonly accounts = new Map<string, AccountState>();
	/** code hash key -> code bytes. */
	readonly code = new Map<string, Uint8Array>();
	/** address key -> (slot key -> 32-byte value). Per account, deliberately. */
	readonly storage = new Map<string, Map<string, Bytes32>>();

	private readonly blockHashFn?: (blockNumber: bigint) => Bytes32 | undefined;

	constructor(options: MemoryStoreOptions = {}) {
		this.blockHashFn = options.blockHash;
	}

	getAccount(address: Address): AccountState | undefined {
		return this.accounts.get(addrKey(address));
	}

	getStorage(address: Address, slot: Bytes32): Bytes32 | undefined {
		return this.storage.get(addrKey(address))?.get(key32(slot));
	}

	getCode(codeHash: Bytes32): Uint8Array | undefined {
		return this.code.get(key32(codeHash));
	}

	getBlockHash(blockNumber: bigint): Bytes32 | undefined {
		return this.blockHashFn?.(blockNumber);
	}

	setAccount(address: Address, account: AccountState): void {
		this.accounts.set(addrKey(address), account);
	}

	setCode(codeHash: Bytes32, code: Uint8Array): void {
		this.code.set(key32(codeHash), code);
	}

	setStorage(address: Address, slot: Bytes32, value: Bytes32): void {
		const a = addrKey(address);
		// A zero value IS the absence of a slot in the EVM. Storing explicit
		// zeros would make two states that the EVM considers equal look different
		// here, which is the kind of drift that is painful to debug much later.
		let zero = true;
		for (let i = 0; i < 32; i++) {
			if (value[i] !== 0) {
				zero = false;
				break;
			}
		}
		if (zero) {
			this.storage.get(a)?.delete(key32(slot));
			return;
		}
		let slots = this.storage.get(a);
		if (slots === undefined) {
			slots = new Map();
			this.storage.set(a, slots);
		}
		slots.set(key32(slot), value);
	}

	/** O(one account), not O(total state). See the class doc. */
	clearStorage(address: Address): void {
		this.storage.delete(addrKey(address));
	}

	removeAccount(address: Address): void {
		this.accounts.delete(addrKey(address));
	}

	/** Number of accounts held, for tests and for sanity checks. */
	get accountCount(): number {
		return this.accounts.size;
	}
}
