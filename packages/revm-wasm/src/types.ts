import type {SpecInput} from './spec.js';

/**
 * A 20-byte address. Always exactly 20 bytes; this package never accepts a
 * hex string on the hot path, because hex construction is measurably more
 * expensive than everything else a state access does (the spike measured JS-side
 * key building at ~0.8 microseconds against a ~0.51 microsecond wasm crossing).
 */
export type Address = Uint8Array;

/** A 32-byte value: a storage slot key, a storage value, a hash, a topic. */
export type Bytes32 = Uint8Array;

/** An Ethereum account, as this package hands it to and takes it from a store. */
export interface AccountState {
	balance: bigint;
	nonce: bigint;
	/** keccak256 of the account's code. `KECCAK_EMPTY` for an account with none. */
	codeHash: Bytes32;
}

/** One EIP-2930 access-list entry. */
export interface AccessListEntry {
	address: Address;
	storageKeys?: readonly Bytes32[];
}

/** One EIP-7702 authorization, already signed. */
export interface Authorization {
	chainId: bigint;
	address: Address;
	nonce: bigint;
	/** `yParity`, 0 or 1. */
	yParity: number;
	r: Bytes32;
	s: Bytes32;
}

/** The block environment a call executes against. */
export interface BlockEnv {
	number?: bigint;
	timestamp?: bigint;
	gasLimit?: bigint;
	coinbase?: Address;
	/** EIP-1559 base fee per gas. */
	baseFeePerGas?: bigint;
	/** EIP-4844 `excessBlobGas`. Omit to leave revm's default in place. */
	excessBlobGas?: bigint;
}

/**
 * Everything one execution needs. Every entry point takes an options object and
 * nothing positional, so a future capability can be added without changing a
 * signature.
 */
export interface ExecuteOptions {
	/** Sender. Defaults to the zero address. */
	from?: Address;
	/** Target. Ignored by `create`. Defaults to the zero address. */
	to?: Address;
	/** Calldata, or init code for `create`. */
	data?: Uint8Array;
	/** Wei to transfer. */
	value?: bigint;
	gasLimit?: bigint;

	/** Overrides the instance default. */
	spec?: SpecInput;
	/** Overrides the instance default. */
	chainId?: bigint;
	/** Merged over the instance default block. */
	block?: BlockEnv;

	/**
	 * Legacy / EIP-2930 gas price. revm keeps this and `maxFeePerGas` in one
	 * field, so supplying both is not meaningful; `maxFeePerGas` wins.
	 */
	gasPrice?: bigint;
	/** EIP-1559 `maxFeePerGas`. */
	maxFeePerGas?: bigint;
	/**
	 * EIP-1559 `maxPriorityFeePerGas`. Its *presence* is what makes revm derive a
	 * 1559-family transaction type, so leaving it undefined is not the same as
	 * setting it to 0.
	 */
	maxPriorityFeePerGas?: bigint;
	/** Sender nonce. Only enforced when `checkNonce` is on. */
	nonce?: bigint;
	/**
	 * Explicit EIP-2718 transaction type. Omit to let revm derive it from the
	 * fields, which is what an ordinary caller wants: the derivation is the part
	 * most easily got wrong by hand.
	 */
	txType?: number;
	accessList?: readonly AccessListEntry[];
	/** EIP-4844 versioned hashes. */
	blobVersionedHashes?: readonly Bytes32[];
	/** EIP-4844 `maxFeePerBlobGas`. */
	maxFeePerBlobGas?: bigint;
	/** EIP-7702 authorization list. */
	authorizationList?: readonly Authorization[];

	/**
	 * Enforce `nonce` against the sender's account nonce.
	 *
	 * Defaults to `false` for `call` (`eth_call` semantics) and `true` for
	 * `transact` and `create`. That default differs from the raw artifact's,
	 * where the flag is off unless set: a caller who forgets it on a transaction
	 * gets a silently replayable transaction, so this layer opts in for them.
	 */
	checkNonce?: boolean;

	/**
	 * Write the resulting state back through the store before returning.
	 * Defaults to `false` for `call` and `true` for `transact` and `create`.
	 * `call` cannot be made to commit.
	 */
	commit?: boolean;

	/**
	 * Decode logs and state changes. `true` by default.
	 *
	 * Setting it to `false` takes a lighter path in the artifact that never
	 * builds the state map, worth roughly 0.9 microseconds per call (22% to 33%
	 * of the empty-call floor). The outcome then has `logs`, `logsBloom` and
	 * `stateChanges` all `undefined`, so it only suits an `eth_call` whose caller
	 * genuinely wants nothing but the return value and the gas.
	 */
	returnState?: boolean;
}

/** One emitted log, in emission order. */
export interface Log {
	address: Address;
	topics: Bytes32[];
	data: Uint8Array;
}

/**
 * What one account looked like after execution, and what a host must do about
 * it. No flag bits and no byte offsets: those belong to the wire format, which
 * is this package's problem and not yours.
 */
export interface AccountChange {
	address: Address;
	balance: bigint;
	nonce: bigint;
	codeHash: Bytes32;
	/**
	 * Present exactly when the account's code hash CHANGED during execution, not
	 * merely whenever revm happened to load the code. revm populates
	 * `AccountInfo::code` for any contract that executes, so the naive rule would
	 * ship the full bytecode of every contract touched, on every call.
	 */
	code?: Uint8Array;
	selfdestructed: boolean;
	touched: boolean;
	created: boolean;
	/**
	 * The account must be REMOVED, with its storage, rather than updated. True
	 * for `SELFDESTRUCT` and for EIP-161 empty-account clearing.
	 *
	 * This is stated rather than derived so a host applying the changes itself
	 * never has to re-implement EIP-161 and get it subtly wrong. Expect it to be
	 * set on the coinbase constantly when the priority fee is zero: an unpaid
	 * coinbase stays touched-and-empty and is correctly deleted.
	 */
	deleted: boolean;
	storage: {slot: Bytes32; value: Bytes32}[];
}

export type ExecutionStatus =
	'success' | 'revert' | 'halt' | 'validation-error';

/** The result of one execution. */
export interface Outcome {
	status: ExecutionStatus;
	/** `status === 'success'`. */
	success: boolean;
	/** Gas charged to the transaction, net of refunds. */
	gasUsed: bigint;
	/** Gas spent before refunds were applied. */
	totalGasSpent: bigint;
	/** Gas refunded. */
	gasRefunded: bigint;
	/**
	 * What the sender actually paid per unit of gas: revm's own
	 * `Transaction::effective_gas_price`, not a second implementation of
	 * `min(maxFee, baseFee + tip)`. Use this for a receipt's `effectiveGasPrice`.
	 */
	effectiveGasPrice: bigint;
	/** Return data, or the revert data, or the deployed code for a creation. */
	returnData: Uint8Array;
	/**
	 * For `status === 'validation-error'`, revm's own `InvalidTransaction`
	 * variant rendered as text (for example `NonceTooHigh { tx: 99, state: 5 }`).
	 * Undefined otherwise.
	 */
	error?: string;
	/** Emission order. Logs from reverted frames are already excluded by revm. */
	logs?: Log[];
	/**
	 * The 256-byte receipts bloom over `logs`. Always 256 bytes here; the wire
	 * format omits it when there are no logs, and this layer materialises the
	 * all-zero bloom so a consumer never has to know that.
	 */
	logsBloom?: Uint8Array;
	/** Undefined when `returnState: false` was requested. */
	stateChanges?: AccountChange[];
}
