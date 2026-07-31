/**
 * Node-side fixture loading. The actual corpus logic lives in `corpus.ts`, which
 * has no Node dependencies so the identical code also runs in the browser suite.
 *
 * The corpus and the `expected/` outcomes both came from the feasibility spike,
 * where every recorded outcome was produced by NATIVE revm and then checked byte
 * for byte against the wasm build over 127,170 calls. These files are therefore
 * not "what this package printed last time": they are what real revm says,
 * recorded independently of anything in this repository.
 *
 * No Rust toolchain is involved anywhere in this path. The artifact and the
 * expectations are both checked in, which is the property that lets a
 * contributor clone the repo and run `pnpm test`.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {createRevmSync, type Revm} from '../src/instance.js';
import {MemoryStore} from '../src/memory-store.js';
import {fixtureBlockHash, runGroups, type FixtureGroup} from './corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', 'fixtures');
export const WASM_PATH = join(here, '..', 'wasm', 'revm.wasm');

export const wasmBytes = (): Uint8Array =>
	new Uint8Array(readFileSync(WASM_PATH));

export {tohex, unhex, fixtureBlockHash} from './corpus.js';
export type {FixtureCall, FixtureGroup} from './corpus.js';

export function loadFixture(name: string): FixtureGroup[] {
	const raw = JSON.parse(
		readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'),
	);
	return Array.isArray(raw) ? raw : [raw];
}

export function loadExpected(name: string): {name: string; outcome: string}[] {
	return JSON.parse(
		readFileSync(join(FIXTURE_DIR, 'expected', `${name}.json`), 'utf8'),
	);
}

export function runFixture(
	name: string,
	options: {wasm?: Uint8Array | WebAssembly.Module} = {},
): {name: string; outcome: string}[] {
	return runGroups(options.wasm ?? wasmBytes(), loadFixture(name));
}

/** A ready-to-use instance over an empty store, for API-level tests. */
export function freshEvm(
	overrides: Partial<Parameters<typeof createRevmSync>[0]> = {},
): Revm {
	return createRevmSync({
		wasm: wasmBytes(),
		state: new MemoryStore({blockHash: fixtureBlockHash}),
		...overrides,
	});
}
