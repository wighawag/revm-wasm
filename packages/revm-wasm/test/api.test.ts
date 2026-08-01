import {describe, expect, it} from 'vitest';
import {keccak_256} from '@noble/hashes/sha3.js';

import {createRevmSync} from '../src/instance.js';
import {MemoryStore, KECCAK_EMPTY} from '../src/memory-store.js';
import {decodeOutcome} from '../src/outcome.js';
import {encodeRequest, Flags} from '../src/request.js';
import {Spec} from '../src/spec.js';
import {
	freshEvm,
	fixtureBlockHash,
	tohex,
	unhex,
	wasmBytes,
} from './fixture-runner.js';

const addr = (hex: string): Uint8Array => {
	const out = new Uint8Array(20);
	const b = unhex(hex);
	out.set(b, 20 - b.length);
	return out;
};

const CALLER = addr('ca11e2');
const TARGET = addr('2000');

// PUSH1 0x42; PUSH1 0; MSTORE; PUSH1 0x20; PUSH1 0; RETURN
const RETURN_42 = unhex('604260005260206000f3');
// The init code that deploys RETURN_42.
const DEPLOY_RETURN_42 = unhex('600a600c600039600a6000f3604260005260206000f3');
// PUSH1 0; PUSH1 0; LOG0; STOP
const EMIT_LOG0 = unhex('60006000a000');
// PUSH1 1; PUSH1 0; SSTORE; STOP
const STORE_ONE = unhex('600160005500');
// BASEFEE; PUSH1 0; MSTORE; PUSH1 0x20; PUSH1 0; RETURN -- returns block.basefee
const RETURN_BASEFEE = unhex('4860005260206000f3');
// The same for PREVRANDAO (0x44), i.e. what a view function would read.
const RETURN_PREVRANDAO = unhex('4460005260206000f3');

/** The 32-byte big-endian return value of the two contracts above, as a bigint. */
const asWord = (b: Uint8Array): bigint =>
	b.length === 0 ? 0n : BigInt('0x' + tohex(b).slice(2).padStart(64, '0'));

function storeWith(
	entries: {address: Uint8Array; code?: Uint8Array; balance?: bigint}[],
): MemoryStore {
	const store = new MemoryStore({blockHash: fixtureBlockHash});
	for (const e of entries) {
		let codeHash = KECCAK_EMPTY;
		if (e.code && e.code.length > 0) {
			codeHash = keccak_256(e.code);
			store.setCode(codeHash, e.code);
		}
		store.setAccount(e.address, {
			balance: e.balance ?? 10n ** 20n,
			nonce: 0n,
			codeHash,
		});
	}
	return store;
}

function evmWith(entries: Parameters<typeof storeWith>[0]) {
	const state = storeWith(entries);
	return {
		state,
		evm: createRevmSync({wasm: wasmBytes(), state, spec: Spec.CANCUN}),
	};
}

describe('runtime version reporting', () => {
	it('exposes the revm version, its exact revision and the outcome format version', () => {
		const evm = freshEvm();
		expect(evm.revmVersion).toMatch(/^\d+\.\d+\.\d+$/);
		// A 40-character git sha, so a bug report can say exactly what ran.
		expect(evm.revmRevision).toMatch(/^[0-9a-f]{40}$/);
		expect(evm.outcomeFormatVersion).toBe(3);
		expect(evm.abiVersion).toBe(1);
		expect(evm.info.build).toContain('precompiles=all');
	});
});

describe('call, transact, create', () => {
	it('call executes read-only and never commits, even when asked to', () => {
		const {evm, state} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		// `commit: true` is deliberately passed and must be ignored: a read-only
		// entry point that can be talked into writing is not read-only.
		const out = evm.call({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			commit: true,
		});
		expect(out.success).toBe(true);
		expect(state.getStorage(TARGET, new Uint8Array(32))).toBeUndefined();
		expect(out.stateChanges?.some((c) => c.storage.length > 0)).toBe(true);
	});

	it('transact commits through the store', () => {
		const {evm, state} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		const out = evm.transact({from: CALLER, to: TARGET, gasLimit: 100_000n});
		expect(out.success).toBe(true);
		const slot = state.getStorage(TARGET, new Uint8Array(32));
		expect(slot).toBeDefined();
		expect(slot![31]).toBe(1);
	});

	it('transact with commit:false keeps transaction semantics but writes nothing', () => {
		const {evm, state} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		const out = evm.transact({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			commit: false,
		});
		expect(out.success).toBe(true);
		expect(state.getStorage(TARGET, new Uint8Array(32))).toBeUndefined();
	});

	it('create deploys, returns the runtime, and the deployed contract is then callable', () => {
		const {evm, state} = evmWith([{address: CALLER}]);
		const created = evm.create({
			from: CALLER,
			data: DEPLOY_RETURN_42,
			gasLimit: 1_000_000n,
		});
		expect(created.success).toBe(true);
		expect(tohex(created.returnData)).toBe(tohex(RETURN_42));

		const newAccount = created.stateChanges!.find((c) => c.created);
		expect(newAccount).toBeDefined();
		// Code bytes arrive exactly when the code HASH changed.
		expect(newAccount!.code).toBeDefined();
		expect(tohex(newAccount!.code!)).toBe(tohex(RETURN_42));

		// It committed, so calling the new address works.
		expect(state.getAccount(newAccount!.address)).toBeDefined();
		const out = evm.call({
			from: CALLER,
			to: newAccount!.address,
			gasLimit: 100_000n,
		});
		expect(out.success).toBe(true);
		expect(out.returnData[31]).toBe(0x42);
	});

	it('transact defaults to checking the nonce, so a replay is rejected', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		const first = evm.transact({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			nonce: 0n,
		});
		expect(first.success).toBe(true);
		// The sender's nonce is now 1; replaying nonce 0 must be rejected. The raw
		// artifact defaults this check OFF; this layer defaults it ON, because a
		// silently replayable transaction is not a default worth shipping.
		const replay = evm.transact({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			nonce: 0n,
		});
		expect(replay.status).toBe('validation-error');
		expect(replay.error).toContain('NonceTooLow');
	});

	it('call ignores the nonce by default, which is eth_call semantics', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		const out = evm.call({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			nonce: 99n,
		});
		expect(out.success).toBe(true);
	});

	it('surfaces revm own rejection reason as text', () => {
		const {evm} = evmWith([{address: CALLER, balance: 1n}]);
		const out = evm.transact({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			gasPrice: 10n,
			value: 1000n,
		});
		expect(out.status).toBe('validation-error');
		expect(out.error).toContain('LackOfFundForMaxFee');
	});
});

describe('the simulation switches (eth_call semantics)', () => {
	// The situation a node actually serves: `eth_call` defaults `from` to the zero
	// address, callers simulate from addresses holding no ether, and real blocks
	// carry a non-zero base fee. Both checks below are right for a transaction and
	// wrong for a read.
	const UNFUNDED = addr('deadbeef');
	const REAL_BASEFEE = 20_000_000_000n;

	const readBasefeeEvm = () =>
		evmWith([
			{address: UNFUNDED, balance: 0n},
			{address: TARGET, code: RETURN_BASEFEE},
		]);

	it('rejects an unfunded zero-gas-price read against a real base fee, unless asked not to', () => {
		const {evm} = readBasefeeEvm();
		const options = {
			from: UNFUNDED,
			to: TARGET,
			gasLimit: 100_000n,
			block: {baseFeePerGas: REAL_BASEFEE},
		};

		// Default: unchanged, and this is the wall a node hits.
		const rejected = evm.call({...options, gasPrice: 1n});
		expect(rejected.status).toBe('validation-error');
		expect(rejected.error).toContain('GasPriceLessThanBasefee');

		// Paying the base fee instead just moves the rejection along.
		const broke = evm.call({...options, gasPrice: REAL_BASEFEE});
		expect(broke.status).toBe('validation-error');
		expect(broke.error).toContain('LackOfFundForMaxFee');

		const ok = evm.call({
			...options,
			disableBaseFee: true,
			disableBalanceCheck: true,
		});
		expect(ok.success).toBe(true);
	});

	it('lets a read keep the REAL base fee, which is the whole point', () => {
		const {evm} = readBasefeeEvm();

		// What a consumer had to do without the switches: zero the base fee so the
		// validation passes. It works, and a view function reading `block.basefee`
		// then sees a number the chain never had.
		const lied = evm.call({
			from: UNFUNDED,
			to: TARGET,
			gasLimit: 100_000n,
			block: {baseFeePerGas: 0n},
		});
		expect(lied.success).toBe(true);
		expect(asWord(lied.returnData)).toBe(0n);

		const truthful = evm.call({
			from: UNFUNDED,
			to: TARGET,
			gasLimit: 100_000n,
			block: {baseFeePerGas: REAL_BASEFEE},
			disableBaseFee: true,
			disableBalanceCheck: true,
		});
		expect(truthful.success).toBe(true);
		expect(asWord(truthful.returnData)).toBe(REAL_BASEFEE);

		// And it costs exactly the same gas: the charge is fee-independent, so a
		// consumer switching off the workaround must see no gas move at all.
		expect(truthful.gasUsed).toBe(lied.gasUsed);
		expect(truthful.totalGasSpent).toBe(lied.totalGasSpent);
		expect(truthful.gasRefunded).toBe(lied.gasRefunded);
	});

	it('applies on the light path too, since validation is a property of the request', () => {
		const {evm} = readBasefeeEvm();
		const out = evm.call({
			from: UNFUNDED,
			to: TARGET,
			gasLimit: 100_000n,
			block: {baseFeePerGas: REAL_BASEFEE},
			disableBaseFee: true,
			disableBalanceCheck: true,
			returnState: false,
		});
		expect(out.success).toBe(true);
		expect(asWord(out.returnData)).toBe(REAL_BASEFEE);
		expect(out.stateChanges).toBeUndefined();
	});

	it('does not leak a switch into the next call on the same instance', () => {
		// The executor is persistent, so a `CfgEnv` field set for one call and not
		// cleared would silently relax every call after it.
		const {evm} = readBasefeeEvm();
		const options = {
			from: UNFUNDED,
			to: TARGET,
			gasLimit: 100_000n,
			gasPrice: 1n,
			block: {baseFeePerGas: REAL_BASEFEE},
		};
		expect(
			evm.call({...options, disableBaseFee: true, disableBalanceCheck: true})
				.success,
		).toBe(true);
		const after = evm.call(options);
		expect(after.status).toBe('validation-error');
		expect(after.error).toContain('GasPriceLessThanBasefee');
	});

	it('disableBalanceCheck invents the funds, which is why it may not be committed', () => {
		// revm raises the caller's post-deduction balance to at least the value it
		// is sending, so a transfer from an account with nothing in it succeeds and
		// the recipient is credited out of thin air. Asserted rather than glossed
		// over: it is the reason these switches are refused on a committing path.
		const {evm} = evmWith([
			{address: UNFUNDED, balance: 0n},
			{address: TARGET, code: RETURN_42, balance: 0n},
		]);
		const out = evm.call({
			from: UNFUNDED,
			to: TARGET,
			value: 10n ** 18n,
			gasLimit: 100_000n,
			disableBalanceCheck: true,
		});
		expect(out.success).toBe(true);
		// The sender is back at zero, having sent an ether it never had ...
		const sender = out.stateChanges!.find(
			(c) => tohex(c.address) === tohex(UNFUNDED),
		);
		expect(sender!.balance).toBe(0n);
		// ... and the recipient is holding it. Harmless because this is discarded.
		const target = out.stateChanges!.find(
			(c) => tohex(c.address) === tohex(TARGET),
		);
		expect(target!.balance).toBe(10n ** 18n);
	});

	it('honours the legacy RELAX_VALIDATION bit as all three switches at once', () => {
		// Bit 2 predates the individual bits and keeps its meaning rather than being
		// reused (ADR 0004). Nothing in the typed API sets it, so it is exercised
		// here through the raw path, which is the only way a caller can reach it.
		const {evm} = evmWith([
			{address: UNFUNDED, balance: 0n},
			{address: TARGET, code: RETURN_BASEFEE},
		]);
		const options = {
			from: UNFUNDED,
			to: TARGET,
			gasLimit: 40_000_000n,
			gasPrice: 1n,
			block: {baseFeePerGas: REAL_BASEFEE, gasLimit: 30_000_000n},
		};
		const defaults = {spec: Spec.CANCUN, chainId: 1n, block: {}};
		const blob = evm.executeRaw(
			encodeRequest(options, defaults, Flags.RELAX_VALIDATION),
		);
		const out = decodeOutcome(blob);
		expect(out.success).toBe(true);
		expect(asWord(out.returnData)).toBe(REAL_BASEFEE);

		// Same three switches, spelled out: identical outcome.
		expect(
			evm.executeRaw(
				encodeRequest(
					options,
					defaults,
					Flags.DISABLE_BASE_FEE |
						Flags.DISABLE_BALANCE_CHECK |
						Flags.DISABLE_BLOCK_GAS_LIMIT,
				),
			),
		).toEqual(blob);
	});

	it('refuses to commit an execution that skipped validation', () => {
		const {evm, state} = evmWith([
			{address: UNFUNDED, balance: 0n},
			{address: TARGET, code: STORE_ONE},
		]);
		const options = {
			from: UNFUNDED,
			to: TARGET,
			gasLimit: 100_000n,
			disableBalanceCheck: true,
		};
		expect(() => evm.transact(options)).toThrow(/simulation-only/);
		expect(() => evm.create({...options, data: DEPLOY_RETURN_42})).toThrow(
			/simulation-only/,
		);
		expect(state.getAccount(TARGET)!.balance).toBe(10n ** 20n);

		// The explicitly non-committing simulation is allowed, and is the intended
		// way to simulate a transaction from an account that cannot pay for it.
		const simulated = evm.transact({...options, commit: false});
		expect(simulated.success).toBe(true);
	});

	it('survives a 1559 fee below the base fee, which only disableBaseFee makes reachable', () => {
		// Skipping the check hands revm's fee arithmetic a combination validation
		// normally guarantees cannot happen: max fee under the base fee, so the
		// coinbase's share is negative. revm saturates (`reward_beneficiary` does
		// `effective_gas_price.saturating_sub(basefee)`), and this pins that down,
		// because the failure mode if it ever stopped saturating is a wrapped
		// coinbase credit or a trapped wasm instance rather than a wrong boolean.
		const coinbase = addr('c01');
		const {evm} = evmWith([
			{address: UNFUNDED, balance: 0n},
			{address: TARGET, code: RETURN_42},
		]);
		const out = evm.call({
			from: UNFUNDED,
			to: TARGET,
			gasLimit: 100_000n,
			maxFeePerGas: 1_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			block: {baseFeePerGas: REAL_BASEFEE, coinbase},
			disableBaseFee: true,
			disableBalanceCheck: true,
		});
		expect(out.success).toBe(true);
		// min(maxFee, baseFee + tip) = min(1 gwei, 21 gwei), still revm's own.
		expect(out.effectiveGasPrice).toBe(1_000_000_000n);
		// The coinbase's share saturates to zero rather than wrapping, which leaves
		// it touched-and-empty and therefore deleted under EIP-161.
		const cb = out.stateChanges!.find(
			(c) => tohex(c.address) === tohex(coinbase),
		);
		expect(cb!.balance).toBe(0n);
		expect(cb!.deleted).toBe(true);
	});

	it('disableBlockGasLimit allows an estimate above the block gas limit', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: RETURN_42},
		]);
		const options = {
			from: CALLER,
			to: TARGET,
			gasLimit: 40_000_000n,
			block: {gasLimit: 30_000_000n},
		};
		const rejected = evm.call(options);
		expect(rejected.status).toBe('validation-error');
		expect(rejected.error).toContain('CallerGasLimitMoreThanBlock');
		expect(evm.call({...options, disableBlockGasLimit: true}).success).toBe(
			true,
		);
	});

	it('leaves every default exactly where it was', () => {
		// The switches are opt-in per call, so an options object that does not
		// mention them must produce a byte-identical request. This is what makes the
		// recorded corpus a valid non-regression control for the whole change.
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: RETURN_42},
		]);
		const options = {from: CALLER, to: TARGET, gasLimit: 100_000n};
		expect(evm.call({...options}).returnData).toEqual(
			evm.call({
				...options,
				disableBaseFee: false,
				disableBalanceCheck: false,
				disableBlockGasLimit: false,
			}).returnData,
		);
		expect(
			encodeRequest(options, {spec: Spec.CANCUN, chainId: 1n, block: {}}, 0),
		).toEqual(
			encodeRequest(
				{...options, disableBaseFee: false},
				{spec: Spec.CANCUN, chainId: 1n, block: {}},
				0,
			),
		);
	});
});

describe('the block environment', () => {
	const PREV_RANDAO = unhex(
		'0xfeed0000000000000000000000000000000000000000000000000000000000ff',
	);

	it('PREVRANDAO reads what the block environment says, and zero when it says nothing', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: RETURN_PREVRANDAO},
		]);
		const set = evm.call({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			block: {prevRandao: PREV_RANDAO},
		});
		expect(set.success).toBe(true);
		expect(tohex(set.returnData)).toBe(tohex(PREV_RANDAO));

		// Absent means zero, which is revm's own default and was the only value
		// reachable before this option existed.
		const unset = evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n});
		expect(asWord(unset.returnData)).toBe(0n);
	});

	it('does not carry a block field over into the next call on the same instance', () => {
		// One EVM instance serves many calls, so any block field written only when
		// the caller supplies it inherits the previous call's value instead.
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: RETURN_PREVRANDAO},
		]);
		evm.call({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			block: {prevRandao: PREV_RANDAO},
		});
		const next = evm.call({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			block: {number: 2n},
		});
		expect(asWord(next.returnData)).toBe(0n);
	});

	it('takes prevRandao as a default on the instance, overridable per call', () => {
		const state = storeWith([
			{address: CALLER},
			{address: TARGET, code: RETURN_PREVRANDAO},
		]);
		const evm = createRevmSync({
			wasm: wasmBytes(),
			state,
			block: {prevRandao: PREV_RANDAO},
		});
		expect(
			tohex(
				evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n}).returnData,
			),
		).toBe(tohex(PREV_RANDAO));
		expect(
			asWord(
				evm.call({
					from: CALLER,
					to: TARGET,
					gasLimit: 100_000n,
					block: {prevRandao: new Uint8Array(32)},
				}).returnData,
			),
		).toBe(0n);
	});
});

describe('the outcome decoder', () => {
	it('handles a call with NO logs, where the 256-byte bloom is absent from the wire', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		const out = evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n});
		expect(out.logs).toEqual([]);
		// Materialised here so a consumer never has to know the bloom is
		// conditional on the wire. A decoder that always skips 256 bytes passes
		// the logging test and desynchronises on exactly this one.
		expect(out.logsBloom).toHaveLength(256);
		expect(out.logsBloom!.every((b) => b === 0)).toBe(true);
		expect(out.stateChanges!.length).toBeGreaterThan(0);
	});

	it('handles a call WITH logs, where the bloom is present and non-zero', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: EMIT_LOG0},
		]);
		const out = evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n});
		expect(out.logs).toHaveLength(1);
		expect(tohex(out.logs![0].address)).toBe(tohex(TARGET));
		expect(out.logs![0].topics).toEqual([]);
		expect(out.logsBloom).toHaveLength(256);
		expect(out.logsBloom!.some((b) => b !== 0)).toBe(true);
	});

	it('does NOT re-emit the code of a contract that merely executed', () => {
		// revm populates `AccountInfo::code` for any contract that executes, so
		// the naive "emit when code is populated" rule would ship the full
		// bytecode of every contract touched, on every call.
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		const out = evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n});
		const target = out.stateChanges!.find(
			(c) => tohex(c.address) === tohex(TARGET),
		);
		expect(target).toBeDefined();
		expect(target!.code).toBeUndefined();
	});

	it('reports deletion explicitly rather than making the host re-derive EIP-161', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		const coinbase = addr('c01');
		const out = evm.call({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			block: {coinbase},
		});
		// With no fee to collect the coinbase stays touched-and-empty and is
		// correctly deleted under EIP-161. It looks alarming the first time and it
		// is right; @ethereumjs/vm does the same.
		const cb = out.stateChanges!.find(
			(c) => tohex(c.address) === tohex(coinbase),
		);
		expect(cb?.deleted).toBe(true);
	});

	it('returnState:false takes the light path and reports no logs or state', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: EMIT_LOG0},
		]);
		const full = evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n});
		const light = evm.call({
			from: CALLER,
			to: TARGET,
			gasLimit: 100_000n,
			returnState: false,
		});
		// Same execution, same gas: only the reporting differs.
		expect(light.gasUsed).toBe(full.gasUsed);
		expect(light.success).toBe(true);
		expect(light.logs).toBeUndefined();
		expect(light.stateChanges).toBeUndefined();
	});

	it('refuses to combine returnState:false with committing', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: STORE_ONE},
		]);
		expect(() =>
			evm.transact({from: CALLER, to: TARGET, returnState: false}),
		).toThrow(/cannot be combined/);
	});

	it('exposes no byte offsets, flag bits or packed layouts in the outcome', () => {
		const {evm} = evmWith([
			{address: CALLER},
			{address: TARGET, code: EMIT_LOG0},
		]);
		const out = evm.call({from: CALLER, to: TARGET, gasLimit: 100_000n});
		const change = out.stateChanges![0];
		// Named booleans, named fields, typed values. No `flags`, no `packed`.
		expect(Object.keys(change).sort()).toEqual(
			[
				'address',
				'balance',
				'code',
				'codeHash',
				'created',
				'deleted',
				'nonce',
				'selfdestructed',
				'storage',
				'touched',
			].sort(),
		);
		expect(typeof change.balance).toBe('bigint');
	});
});

describe('the fee market is revm own, not reimplemented here', () => {
	it('charges the sender, credits the coinbase the tip, and burns the base fee', () => {
		const coinbase = addr('c01');
		const recipient = addr('dead');
		const start = 10n ** 18n;
		const state = storeWith([
			{address: CALLER, balance: start},
			{address: recipient, balance: 0n},
		]);
		const evm = createRevmSync({wasm: wasmBytes(), state, spec: Spec.CANCUN});

		const out = evm.transact({
			from: CALLER,
			to: recipient,
			value: 1000n,
			gasLimit: 100_000n,
			maxFeePerGas: 100n,
			maxPriorityFeePerGas: 3n,
			nonce: 0n,
			block: {coinbase, baseFeePerGas: 7n},
		});

		expect(out.success).toBe(true);
		// min(maxFee, baseFee + tip) = min(100, 10) = 10, straight from revm.
		expect(out.effectiveGasPrice).toBe(10n);
		expect(out.gasUsed).toBe(21_000n);

		const sender = state.getAccount(CALLER)!;
		expect(sender.balance).toBe(
			start - 1000n - out.gasUsed * out.effectiveGasPrice,
		);
		// The coinbase receives only the priority portion; the base fee is burnt.
		expect(state.getAccount(coinbase)!.balance).toBe(
			out.gasUsed * (out.effectiveGasPrice - 7n),
		);
		expect(state.getAccount(recipient)!.balance).toBe(1000n);
	});
});

describe('signer recovery', () => {
	it('recovers the signer of every recorded signature, and rejects a bad one', async () => {
		const {readFileSync} = await import('node:fs');
		const {join} = await import('node:path');
		const {FIXTURE_DIR} = await import('./fixture-runner.js');
		const sigs = JSON.parse(
			readFileSync(join(FIXTURE_DIR, 'sigs.json'), 'utf8'),
		) as {
			name: string;
			hash: string;
			v: number;
			r: string;
			s: string;
			/** Empty for the deliberately unrecoverable entry. */
			address: string;
		}[];
		const evm = freshEvm();

		// 64 signatures generated with @noble/curves plus one deliberately
		// unrecoverable entry, so the negative case is part of the corpus rather
		// than an afterthought.
		expect(sigs.length).toBe(65);
		let recoveredCount = 0;
		let rejectedCount = 0;
		for (const sig of sigs) {
			const recovered = evm.recoverSigner({
				hash: unhex(sig.hash),
				v: sig.v,
				r: unhex(sig.r),
				s: unhex(sig.s),
			});
			if (sig.address === '') {
				expect(recovered).toBeUndefined();
				rejectedCount++;
				continue;
			}
			expect(recovered, sig.name).toBeDefined();
			expect(tohex(recovered!), sig.name).toBe(tohex(unhex(sig.address)));
			recoveredCount++;
		}
		expect(recoveredCount).toBe(64);
		expect(rejectedCount).toBe(1);
	});
});
