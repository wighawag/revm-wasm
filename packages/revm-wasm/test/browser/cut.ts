/**
 * The code under test, bundled into a real browser by
 * `playwright-browser-harness`.
 *
 * It runs the SAME corpus as the vitest suite, against the SAME recorded native
 * revm outcomes, so a browser result is directly comparable to a Node one. It
 * also reports which engine it ran on, because that is the point: V8 and
 * JavaScriptCore differ enough on wasm that measuring one and implying two is a
 * real mistake.
 */
import type {
	CodeUnderTest,
	RunResult,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {keccak_256} from '@noble/hashes/sha3.js';

import {createRevm, createRevmSync} from '../../src/instance.js';
import {MemoryStore, KECCAK_EMPTY} from '../../src/memory-store.js';
import {
	buildStore,
	callToOptions,
	compare,
	runGroups,
	tohex,
	unhex,
	type FixtureGroup,
} from '../corpus.js';

import correctness from '../../fixtures/correctness.json';
import precompiles from '../../fixtures/precompiles.json';
import bls from '../../fixtures/bls.json';
import bench from '../../fixtures/bench.json';
import logs from '../../fixtures/logs.json';
import fees from '../../fixtures/fees.json';
import accesslist from '../../fixtures/accesslist.json';
import typed from '../../fixtures/typed.json';
import commit from '../../fixtures/commit.json';

import expectedCorrectness from '../../fixtures/expected/correctness.json';
import expectedPrecompiles from '../../fixtures/expected/precompiles.json';
import expectedBls from '../../fixtures/expected/bls.json';
import expectedBench from '../../fixtures/expected/bench.json';
import expectedLogs from '../../fixtures/expected/logs.json';
import expectedFees from '../../fixtures/expected/fees.json';
import expectedAccesslist from '../../fixtures/expected/accesslist.json';
import expectedTyped from '../../fixtures/expected/typed.json';
import expectedCommit from '../../fixtures/expected/commit.json';

import sigs from '../../fixtures/sigs.json';

const asGroups = (raw: unknown): FixtureGroup[] =>
	(Array.isArray(raw) ? raw : [raw]) as FixtureGroup[];

const CORPUS: [string, FixtureGroup[], {name: string; outcome: string}[]][] = [
	['correctness', asGroups(correctness), expectedCorrectness],
	['precompiles', asGroups(precompiles), expectedPrecompiles],
	['bls', asGroups(bls), expectedBls],
	['bench', asGroups(bench), expectedBench],
	['logs', asGroups(logs), expectedLogs],
	['fees', asGroups(fees), expectedFees],
	['accesslist', asGroups(accesslist), expectedAccesslist],
	['typed', asGroups(typed), expectedTyped],
	['commit', asGroups(commit), expectedCommit],
];

const cut: CodeUnderTest = {
	name: 'revm-wasm',
	async run(): Promise<RunResult> {
		const errors: string[] = [];
		const timings: {label: string; ms: number}[] = [];

		// The documented browser path: fetch the .wasm by URL. `revm.wasm` is
		// copied next to the bundle by the harness's `assets` option.
		const t0 = performance.now();
		const evm = await createRevm({wasm: new URL('./revm.wasm', location.href)});
		timings.push({
			label: 'createRevm (fetch + compile + instantiate)',
			ms: performance.now() - t0,
		});

		// Bytes, so the byte path is exercised too, and so the corpus below can
		// build fresh instances synchronously.
		const wasmBytes = new Uint8Array(
			await (await fetch(new URL('./revm.wasm', location.href))).arrayBuffer(),
		);
		const module = await WebAssembly.compile(wasmBytes);

		let calls = 0;
		const t1 = performance.now();
		for (const [label, groups, expected] of CORPUS) {
			try {
				const actual = runGroups(module, groups);
				calls += actual.length;
				errors.push(...compare(label, actual, expected));
			} catch (e) {
				errors.push(`${label}: threw ${String(e)}`);
			}
		}
		timings.push({label: 'differential corpus', ms: performance.now() - t1});

		// Signature recovery, including the deliberately unrecoverable entry.
		let recovered = 0;
		let rejected = 0;
		const t2 = performance.now();
		for (const sig of sigs as {
			name: string;
			hash: string;
			v: number;
			r: string;
			s: string;
			address: string;
		}[]) {
			const out = evm.recoverSigner({
				hash: unhex(sig.hash),
				v: sig.v,
				r: unhex(sig.r),
				s: unhex(sig.s),
			});
			if (sig.address === '') {
				if (out !== undefined) errors.push(`${sig.name}: expected no recovery`);
				else rejected++;
			} else if (
				out === undefined ||
				tohex(out) !== tohex(unhex(sig.address))
			) {
				errors.push(`${sig.name}: wrong recovery`);
			} else {
				recovered++;
			}
		}
		timings.push({label: 'ecrecover x65', ms: performance.now() - t2});

		// Two instances in one page must not see each other's state. This is the
		// browser half of the isolation regression test.
		const isolation = (() => {
			const build = (n: number) => {
				const state = new MemoryStore();
				// PUSH1 n; PUSH1 0; MSTORE; PUSH1 0x20; PUSH1 0; RETURN
				const code = unhex(
					`60${n.toString(16).padStart(2, '0')}60005260206000f3`,
				);
				// keccak of that code, computed by the corpus helper path.
				const codeHash = keccakOf(code);
				state.setCode(codeHash, code);
				const target = addr20('2000');
				state.setAccount(target, {balance: 0n, nonce: 0n, codeHash});
				state.setAccount(addr20('ca11e2'), {
					balance: 10n ** 18n,
					nonce: 0n,
					codeHash: KECCAK_EMPTY,
				});
				return createRevmSync({wasm: module, state});
			};
			const a = build(0x11);
			const b = build(0x22);
			const ra = a.call({
				from: addr20('ca11e2'),
				to: addr20('2000'),
				gasLimit: 100_000n,
			});
			const rb = b.call({
				from: addr20('ca11e2'),
				to: addr20('2000'),
				gasLimit: 100_000n,
			});
			return {a: ra.returnData[31], b: rb.returnData[31]};
		})();
		if (isolation.a !== 0x11 || isolation.b !== 0x22) {
			errors.push(`instances leaked state: ${JSON.stringify(isolation)}`);
		}

		// A small throughput sample, so a per-engine difference is visible rather
		// than assumed. Not a benchmark: one shape, one round.
		const throughput = measureThroughput(module);
		timings.push({label: 'arith loop', ms: throughput.ms});

		return {
			results: {
				calls,
				recovered,
				rejected,
				mismatches: errors.length,
				revm: evm.revmVersion,
				revmRev: evm.revmRevision,
				outcomeFormatVersion: evm.outcomeFormatVersion,
				abiVersion: evm.abiVersion,
				build: evm.info.build,
				isolation,
				mgasPerSecond: throughput.mgas,
			},
			timings,
			errors,
			env: captureEnv(),
		};
	},
};

function addr20(hex: string): Uint8Array {
	const out = new Uint8Array(20);
	const b = unhex(hex);
	out.set(b, 20 - b.length);
	return out;
}

function keccakOf(b: Uint8Array): Uint8Array {
	return keccak_256(b);
}

function measureThroughput(module: WebAssembly.Module): {
	ms: number;
	mgas: number;
} {
	// The `bench` fixture's arithmetic loop shape, kept short so this is a smoke
	// measurement rather than a benchmark that fails on a loaded CI machine.
	const group = asGroups(bench)[0];
	const state = buildStore(group);
	const evm = createRevmSync({wasm: module, state, spec: group.spec});
	// Reuses the corpus translation rather than a second one: the bench shapes use
	// a 500,000,000 gas limit against a 100,000,000,000 block gas limit, and a
	// hand-rolled options object that forgets the block gas limit turns every
	// iteration into an instant validation error and reports 0 MGas/s.
	const opts = {
		...callToOptions(group, group.calls[0]),
		returnState: false as const,
	};
	// Warm up, then measure.
	for (let i = 0; i < 3; i++) evm.call(opts);
	const t = performance.now();
	let gas = 0n;
	const reps = 20;
	for (let i = 0; i < reps; i++) gas += evm.call(opts).gasUsed;
	const ms = performance.now() - t;
	return {ms, mgas: Number(gas) / 1e6 / (ms / 1000)};
}

export default cut;
