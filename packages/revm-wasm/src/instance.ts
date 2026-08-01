import {
	storeToHostFunctions,
	type HostFunctions,
	type MemoryProvider,
	type StateStore,
} from './host.js';
import {MemoryStore} from './memory-store.js';
import {decodeOutcome} from './outcome.js';
import {
	encodeRequest,
	Flags,
	simulationFlags,
	SIMULATION_FLAGS,
	type RequestDefaults,
} from './request.js';
import {Spec, specToByte, type SpecInput} from './spec.js';
import type {
	Address,
	BlockEnv,
	Bytes32,
	ExecuteOptions,
	Outcome,
} from './types.js';

/**
 * Where the `.wasm` comes from.
 *
 * A `URL` or a string is fetched (and streamed-compiled when the server sends
 * `application/wasm`). Bytes, a `Response` or an already-compiled
 * `WebAssembly.Module` are used as given. A `Module` is the one to prefer when
 * you create several instances: compilation is the expensive part and a module
 * can be instantiated many times.
 */
export type WasmSource =
	| Uint8Array
	| ArrayBuffer
	| WebAssembly.Module
	| URL
	| string
	| Response
	| Promise<Response>;

export interface CreateOptions {
	wasm: WasmSource;
	/**
	 * Your state. Defaults to a fresh {@link MemoryStore}, which is fine for
	 * tests and wrong for anything that owns state elsewhere.
	 */
	state?: StateStore;
	/**
	 * Bypass {@link StateStore} and supply the raw pointer-level host directly.
	 * Mutually exclusive with `state`. For consumers who want zero marshalling.
	 *
	 * A raw host needs the instance's linear memory, which does not exist until
	 * the imports are ready, so pass a **factory**: it is called with a
	 * `MemoryProvider` that becomes valid as soon as instantiation completes. A
	 * plain object is also accepted for a host that needs no memory access.
	 */
	host?: HostFunctions | ((memory: MemoryProvider) => HostFunctions);
	/** Default hardfork for calls that do not name one. Defaults to `CANCUN`. */
	spec?: SpecInput;
	/** Default chain id. Defaults to `1n`. */
	chainId?: bigint;
	/** Default block environment, merged under each call's own `block`. */
	block?: BlockEnv;
}

export interface RecoverSignerOptions {
	/** The 32-byte message hash that was signed. */
	hash: Bytes32;
	/** Recovery id. Accepts 27/28 as `v`, or 0/1 as `yParity`. */
	v?: number;
	yParity?: number;
	r: Bytes32;
	s: Bytes32;
}

/** What the artifact says about itself, for a bug report to quote verbatim. */
export interface BuildInfo {
	/** revm's crate version, for example `42.0.1`. */
	revm: string;
	/** The exact revm git revision this artifact was built from. */
	revmRev: string;
	/** The build configuration, for example `precompiles=all`. */
	build: string;
}

interface RawExports {
	memory: WebAssembly.Memory;
	revm_wasm_abi_version(): number;
	revm_wasm_outcome_format_version(): number;
	revm_wasm_info_ptr(): number;
	revm_wasm_info_len(): number;
	revm_wasm_request_buffer(len: number): number;
	revm_wasm_outcome_ptr(): number;
	revm_wasm_execute(len: number): number;
	revm_wasm_execute_light(len: number): number;
	revm_wasm_ecrecover(): number;
}

/** The ABI version this loader knows how to drive. */
const SUPPORTED_ABI_VERSION = 1;

/**
 * One EVM instance.
 *
 * Each instance owns its own `WebAssembly.Instance`, its own linear memory and
 * its own host bindings. Two instances in one page never see each other's state:
 * the host functions are supplied per instantiation rather than through a shared
 * module-level binding. That is deliberate. The spike, which used wasm-bindgen's
 * module-level glue, hit exactly the opposite: loading two builds in one process
 * silently made the second one's linear memory answer the first one's state
 * reads, and it produced plausible numbers with the wrong sign.
 */
export class Revm {
	readonly #exports: RawExports;
	readonly #defaults: RequestDefaults;
	readonly #store: StateStore | undefined;
	/**
	 * Whether this artifact was built with revm's optional validation switches.
	 * The shipped one is; a custom build might not be, and then the switches are
	 * silently ignored down in wasm, so they are refused up here instead.
	 */
	readonly #hasValidationSwitches: boolean;

	/** What this artifact is. Quote it in a bug report. */
	readonly info: BuildInfo;
	/** revm's crate version. */
	readonly revmVersion: string;
	/** The exact revm revision the artifact was built from. */
	readonly revmRevision: string;
	/** Layout version of the outcome blob this artifact produces. */
	readonly outcomeFormatVersion: number;
	/** Version of the call ABI. */
	readonly abiVersion: number;

	#view: Uint8Array;

	constructor(
		exports: RawExports,
		defaults: RequestDefaults,
		store?: StateStore,
	) {
		this.#exports = exports;
		this.#defaults = defaults;
		this.#store = store;
		this.#view = new Uint8Array(exports.memory.buffer);

		this.abiVersion = exports.revm_wasm_abi_version();
		if (this.abiVersion !== SUPPORTED_ABI_VERSION) {
			throw new Error(
				`revm-wasm: artifact speaks call ABI v${this.abiVersion}, this loader speaks v${SUPPORTED_ABI_VERSION}. ` +
					'Use a matching revm-wasm version.',
			);
		}
		this.outcomeFormatVersion = exports.revm_wasm_outcome_format_version();

		const ptr = exports.revm_wasm_info_ptr();
		const len = exports.revm_wasm_info_len();
		this.info = JSON.parse(
			new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len)),
		) as BuildInfo;
		this.revmVersion = this.info.revm;
		this.revmRevision = this.info.revmRev;
		// Read from the artifact rather than assumed, because the loader and the
		// wasm can be from different builds: `createRevm({wasm})` takes any bytes.
		this.#hasValidationSwitches = this.info.build.includes(
			'+relaxed-validation',
		);
	}

	/** The store backing this instance, when one was used (rather than a raw host). */
	get state(): StateStore | undefined {
		return this.#store;
	}

	/** Linear memory, refreshed when a growth has detached the cached view. */
	#mem(): Uint8Array {
		if (this.#view.byteLength === 0)
			this.#view = new Uint8Array(this.#exports.memory.buffer);
		return this.#view;
	}

	/**
	 * Run a request blob and return the raw outcome blob.
	 *
	 * Public because a differential test needs to compare bytes, and because a
	 * consumer who wants to record and replay outcomes should not have to
	 * re-encode a decoded object. Ordinary use goes through {@link call},
	 * {@link transact} and {@link create}.
	 */
	executeRaw(request: Uint8Array, options: {light?: boolean} = {}): Uint8Array {
		const e = this.#exports;
		// Writing the request may grow memory, so the view is taken AFTER the
		// buffer is reserved, never before.
		const ptr = e.revm_wasm_request_buffer(request.length);
		this.#mem().set(request, ptr);
		const len = options.light
			? e.revm_wasm_execute_light(request.length)
			: e.revm_wasm_execute(request.length);
		const outPtr = e.revm_wasm_outcome_ptr();
		return this.#mem().slice(outPtr, outPtr + len);
	}

	#run(options: ExecuteOptions, flags: number): Outcome {
		const light = options.returnState === false;
		if (light && flags & Flags.COMMIT) {
			throw new Error(
				'revm-wasm: returnState:false cannot be combined with committing',
			);
		}
		if (flags & SIMULATION_FLAGS) {
			if (flags & Flags.COMMIT) {
				// Refused rather than honoured: these switches let through a
				// transaction the chain would reject, and disableBalanceCheck makes
				// revm raise the caller's balance to cover the value. Committing that
				// writes funds that never existed into the consumer's own state, and
				// it would do it silently.
				throw new Error(
					'revm-wasm: disableBaseFee / disableBalanceCheck / disableBlockGasLimit are ' +
						'simulation-only and cannot be combined with committing. Use call(), or ' +
						'transact({commit: false}) to simulate without writing.',
				);
			}
			if (!this.#hasValidationSwitches) {
				// Down in wasm an unknown capability is ignored, which here would mean
				// the very check the caller asked to skip rejecting the call. Said
				// plainly, once, instead of as a confusing GasPriceLessThanBasefee.
				throw new Error(
					`revm-wasm: this artifact (build "${this.info.build}") was built without ` +
						'`relaxed-validation`, so disableBaseFee / disableBalanceCheck / ' +
						'disableBlockGasLimit cannot be honoured. Use the shipped revm.wasm.',
				);
			}
		}
		const blob = this.executeRaw(
			encodeRequest(options, this.#defaults, flags),
			{light},
		);
		return decodeOutcome(blob);
	}

	/**
	 * Execute read-only. Never commits, whatever the options say.
	 *
	 * This is the `eth_call` / `eth_estimateGas` entry point. The nonce is not
	 * checked unless you ask for it, which is `eth_call` semantics.
	 *
	 * The fee and balance checks, however, are still ON unless you ask otherwise,
	 * because turning them off is not free of consequences and this package does
	 * not decide that for you. A node serving `eth_call` generally wants:
	 *
	 * ```ts
	 * evm.call({
	 *   from, to, data, gasLimit,
	 *   block: {...realBlock},      // the REAL base fee, not a zeroed one,
	 *   disableBaseFee: true,       // which these two make servable from an
	 *   disableBalanceCheck: true,  // address that holds no ether
	 * });
	 * ```
	 */
	call(options: ExecuteOptions = {}): Outcome {
		let flags = simulationFlags(options);
		if (options.checkNonce) flags |= Flags.CHECK_NONCE;
		return this.#run(options, flags);
	}

	/**
	 * Execute a transaction, committing the resulting state through the store.
	 *
	 * `checkNonce` defaults to `true` here, unlike the raw artifact where the
	 * flag is off unless set. A transaction executed without a nonce check is
	 * silently replayable, and defaulting a caller into that is not a trap this
	 * package is willing to ship.
	 *
	 * Pass `commit: false` to simulate a transaction with full transaction
	 * semantics (fees charged, nonce checked) while leaving state untouched.
	 */
	transact(options: ExecuteOptions = {}): Outcome {
		let flags = options.commit === false ? 0 : Flags.COMMIT;
		if (options.checkNonce !== false) flags |= Flags.CHECK_NONCE;
		flags |= simulationFlags(options);
		return this.#run(options, flags);
	}

	/**
	 * Execute a contract-creation transaction: `to` is ignored and `data` is the
	 * init code. Commits by default, exactly like {@link transact}.
	 *
	 * The created account's code arrives in the outcome's `stateChanges` with its
	 * `code` populated, and the deployed runtime is also the outcome's
	 * `returnData`.
	 */
	create(options: ExecuteOptions = {}): Outcome {
		let flags = Flags.CREATE;
		if (options.commit !== false) flags |= Flags.COMMIT;
		if (options.checkNonce !== false) flags |= Flags.CHECK_NONCE;
		flags |= simulationFlags(options);
		return this.#run(options, flags);
	}

	/**
	 * Recover the signer of `(hash, v, r, s)`.
	 *
	 * Returns the 20-byte address, or `undefined` when the signature does not
	 * recover. This is the same k256 code the `0x01` precompile runs, reached
	 * without a database, a gas limit, a block environment or a journal, so a
	 * transaction's sender can be recovered before there is any state to run it
	 * against.
	 *
	 * It is **not** a speedup over going through the precompile: measured at 1%
	 * to 4%, because a recovery is around 450 microseconds of k256 and the
	 * transaction machinery around it is around 4. It is roughly 4.3x faster than
	 * `@noble/curves` in Node, which is the comparison that justifies it.
	 */
	recoverSigner(options: RecoverSignerOptions): Address | undefined {
		const e = this.#exports;
		const buf = new Uint8Array(97);
		buf.set(options.hash.subarray(0, 32), 0);
		buf[32] = options.v ?? options.yParity ?? 0;
		buf.set(options.r.subarray(0, 32), 33);
		buf.set(options.s.subarray(0, 32), 65);
		const ptr = e.revm_wasm_request_buffer(97);
		this.#mem().set(buf, ptr);
		const len = e.revm_wasm_ecrecover();
		if (len !== 20) return undefined;
		const outPtr = e.revm_wasm_outcome_ptr();
		return this.#mem().slice(outPtr, outPtr + 20);
	}
}

async function toModule(source: WasmSource): Promise<WebAssembly.Module> {
	if (source instanceof WebAssembly.Module) return source;
	if (source instanceof Uint8Array)
		return WebAssembly.compile(source as unknown as BufferSource);
	if (source instanceof ArrayBuffer) return WebAssembly.compile(source);
	if (typeof Response !== 'undefined' && source instanceof Response) {
		return compileResponse(source);
	}
	if (source instanceof URL || typeof source === 'string') {
		return compileResponse(fetch(source));
	}
	// A promise of a Response, i.e. `fetch(...)` passed through unawaited.
	return compileResponse(source as Promise<Response>);
}

async function compileResponse(
	res: Response | Promise<Response>,
): Promise<WebAssembly.Module> {
	if (typeof WebAssembly.compileStreaming === 'function') {
		try {
			return await WebAssembly.compileStreaming(res);
		} catch {
			// Falls through: a server that does not send `application/wasm` makes
			// compileStreaming throw, and that is a server configuration problem
			// the consumer should not have to fix before anything works at all.
		}
	}
	const resolved = await res;
	return WebAssembly.compile(await resolved.arrayBuffer());
}

function buildDefaults(options: CreateOptions): RequestDefaults {
	return {
		spec: specToByte(options.spec, Spec.CANCUN),
		chainId: options.chainId ?? 1n,
		block: options.block ?? {},
	};
}

function instantiate(module: WebAssembly.Module, options: CreateOptions): Revm {
	if (options.host && options.state) {
		throw new Error('revm-wasm: pass either `state` or `host`, not both');
	}
	const store = options.host ? undefined : (options.state ?? new MemoryStore());

	// The host needs the instance's memory and the instance needs the host, so
	// the memory is reached through a closure rather than a value. This is the
	// whole reason instances are isolated: the binding is per instantiation, not
	// per module.
	let instance: WebAssembly.Instance | undefined;
	const memory = (): WebAssembly.Memory => {
		if (!instance)
			throw new Error('revm-wasm: host called before instantiation completed');
		return instance.exports.memory as WebAssembly.Memory;
	};
	const host =
		typeof options.host === 'function'
			? options.host(memory)
			: (options.host ?? storeToHostFunctions(store!, memory));

	instance = new WebAssembly.Instance(module, {
		revm_wasm_host: host as unknown as WebAssembly.ModuleImports,
	});
	return new Revm(
		instance.exports as unknown as RawExports,
		buildDefaults(options),
		store,
	);
}

/**
 * Create an EVM instance.
 *
 * ```ts
 * const evm = await createRevm({wasm: new URL('revm.wasm', import.meta.url), state: myStore});
 * const out = evm.call({to: addr, data, gasLimit: 100_000n});
 * ```
 */
export async function createRevm(options: CreateOptions): Promise<Revm> {
	return instantiate(await toModule(options.wasm), options);
}

/**
 * Create an EVM instance without awaiting, when the wasm is already bytes or an
 * already-compiled module. Useful in Node, in a worker, and in tests.
 */
export function createRevmSync(
	options: CreateOptions & {
		wasm: Uint8Array | ArrayBuffer | WebAssembly.Module;
	},
): Revm {
	const module =
		options.wasm instanceof WebAssembly.Module
			? options.wasm
			: new WebAssembly.Module(options.wasm as BufferSource);
	return instantiate(module, options);
}
