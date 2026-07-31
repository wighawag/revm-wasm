import {describe, expect, it} from 'vitest';
import {loadExpected, runFixture} from './fixture-runner.js';

/**
 * The load-bearing test.
 *
 * Every expectation here was recorded from NATIVE revm during the feasibility
 * spike, so a pass means "this package agrees with real revm", not "this package
 * agrees with its own last run". The comparison is the entire outcome blob as
 * one hex string, which covers status, gas used, total gas spent, refunds,
 * return data, every log, the receipts bloom, every account, every changed
 * storage slot, emitted code bytes, and the effective gas price.
 *
 * This is the acceptance check for any wasm rebuild. It has already caught a
 * real non-conformance, so it is the right bar. Byte-identity of the `.wasm` is
 * NOT checked and must not be: rustc, wasm-opt and revm all move those bytes.
 */
const FIXTURES = [
	// opcode edge cases, storage, revert rollback, OOG, invalid opcode, CREATE2,
	// environment opcodes, nested CALL/STATICCALL, value transfer, empty account
	'correctness',
	// 0x01..0x04
	'precompiles',
	// BLS12-381 (G1ADD, MAP_FP_TO_G1, G2ADD) and KZG
	'bls',
	// the shapes the throughput benchmarks use, run once for correctness
	'bench',
	// emission order, reverted sub-call filtering, LOG0..LOG4, the bloom
	'logs',
	// sender charge, coinbase credit, burn, refund at the effective price, and
	// all four rejection paths
	'fees',
	// EIP-2930 intrinsic cost and warming, both directions
	'accesslist',
	// type-3 blob hashes and a real signed type-4 authorization
	'typed',
	// committing execution: creation, selfdestruct, EIP-161, EIP-6780
	'commit',
] as const;

describe('differential against recorded native revm outcomes', () => {
	for (const name of FIXTURES) {
		it(`${name} matches byte for byte`, () => {
			const expected = loadExpected(name);
			const actual = runFixture(name);

			expect(actual.length).toBe(expected.length);
			for (let i = 0; i < expected.length; i++) {
				expect(actual[i].name).toBe(expected[i].name);
				// Named per call so a failure says WHICH call diverged rather than
				// dumping two multi-kilobyte hex strings side by side.
				expect(`${expected[i].name}:${actual[i].outcome}`).toBe(
					`${expected[i].name}:${expected[i].outcome}`,
				);
			}
		});
	}

	it('covers every fixture that ships with the package', async () => {
		const {readdirSync} = await import('node:fs');
		const {FIXTURE_DIR} = await import('./fixture-runner.js');
		const onDisk = readdirSync(`${FIXTURE_DIR}/expected`)
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.replace(/\.json$/, ''))
			.sort();
		// A fixture added without being listed above would otherwise sit there
		// never being run, which is the failure mode of a hand-maintained list.
		expect(onDisk).toEqual([...FIXTURES].sort());
	});
});
