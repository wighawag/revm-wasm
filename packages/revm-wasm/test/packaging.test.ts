import {describe, expect, it} from 'vitest';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createRevm} from '../src/instance.js';
import {WASM_PATH} from './fixture-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

/**
 * The packaging failure this guards against is quiet and expensive.
 *
 * The house template ships only `dist` and `src` in `files`. A `.wasm` left out
 * of that list produces a package that installs, resolves, type-checks and then
 * fails at RUNTIME in a consumer's browser, which is the worst place to find
 * out. There is no way to notice from inside this repository, where the file is
 * simply on disk, so it has to be asserted.
 */
describe('the published tarball', () => {
	it('includes the wasm artifact in files', () => {
		expect(pkg.files).toContain('wasm/revm.wasm');
	});

	it('has the artifact where files says it is', () => {
		expect(existsSync(WASM_PATH)).toBe(true);
		const bytes = readFileSync(WASM_PATH);
		// A wasm module starts with \0asm and version 1.
		expect([...bytes.subarray(0, 8)]).toEqual([
			0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		]);
		expect(bytes.length).toBeGreaterThan(500_000);
	});

	it('exposes the artifact through the exports map', () => {
		expect(pkg.exports['./revm.wasm']).toBe('./wasm/revm.wasm');
		expect(existsSync(join(pkgDir, pkg.exports['./revm.wasm']))).toBe(true);
	});

	it('ships a wasm-url entry that resolves to the artifact', async () => {
		// Imported from source here; after `tsc` the same relative step lands in
		// dist/, which is why the URL is '../wasm/revm.wasm' and not './'.
		const {wasmUrl} = await import('../src/wasm-url.js');
		expect(wasmUrl.pathname.endsWith('/wasm/revm.wasm')).toBe(true);
		expect(existsSync(fileURLToPath(wasmUrl))).toBe(true);
	});

	it('loads from a URL, which is the documented browser path', async () => {
		const {wasmUrl} = await import('../src/wasm-url.js');
		// Node's fetch handles file: URLs poorly, so this exercises the same code
		// path with a Response, which is what a browser hands over.
		const bytes = readFileSync(fileURLToPath(wasmUrl));
		const evm = await createRevm({
			wasm: new Response(bytes, {
				headers: {'content-type': 'application/wasm'},
			}),
		});
		expect(evm.abiVersion).toBe(1);
		expect(evm.revmVersion).toBe('42.0.1');
	});

	it('declares the licence that matches revm', () => {
		expect(pkg.license).toBe('MIT');
		expect(existsSync(join(pkgDir, 'LICENSE'))).toBe(true);
		expect(existsSync(join(pkgDir, 'NOTICE'))).toBe(true);
		expect(readFileSync(join(pkgDir, 'NOTICE'), 'utf8')).toContain(
			'bluealloy/revm',
		);
	});

	it('says plainly in its description that it is unofficial', () => {
		expect(pkg.description).toContain('UNOFFICIAL');
	});
});
