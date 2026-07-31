/**
 * `revm-wasm`: revm (bluealloy, MIT) compiled to WebAssembly, with a typed
 * JavaScript API.
 *
 * UNOFFICIAL. Not affiliated with the revm project.
 *
 * Deliberately not a general-purpose binding. The build configuration is fixed
 * (all precompiles, opt-level 3: see `docs/adr/0001-...`), the host interface
 * has one shape, and v1 ships no custom precompiles and no inspector.
 */

export {createRevm, createRevmSync, Revm} from './instance.js';
export type {
	BuildInfo,
	CreateOptions,
	RecoverSignerOptions,
	WasmSource,
} from './instance.js';

export {MemoryStore, KECCAK_EMPTY} from './memory-store.js';
export type {MemoryStoreOptions} from './memory-store.js';

export {storeToHostFunctions} from './host.js';
export type {HostFunctions, MemoryProvider, StateStore} from './host.js';

export {Spec} from './spec.js';
export type {SpecInput, SpecName} from './spec.js';

export {decodeOutcome, OUTCOME_FORMAT_VERSION} from './outcome.js';
export {encodeRequest, Flags} from './request.js';
export type {RequestDefaults} from './request.js';

export type {
	AccessListEntry,
	AccountChange,
	AccountState,
	Address,
	Authorization,
	BlockEnv,
	Bytes32,
	ExecuteOptions,
	ExecutionStatus,
	Log,
	Outcome,
} from './types.js';
