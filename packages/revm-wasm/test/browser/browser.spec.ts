import {test, expect} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, 'cut.ts');
const wasm = resolve(here, '..', '..', 'wasm', 'revm.wasm');

/**
 * The browser half of the suite.
 *
 * Playwright's `projects` in `playwright.config.ts` run this in Chromium (V8)
 * and WebKit (JavaScriptCore). Running two engines is not thoroughness for its
 * own sake: a wasm module behaves differently enough across the two that
 * measuring one and implying both is a real mistake, and it hid a material
 * difference during evaluation of this approach.
 */
test('the differential corpus passes in a real browser', async ({
	page,
}, testInfo) => {
	const harness = await mountHarness(page, {
		cut,
		// Pure-compute wasm: no SharedArrayBuffer, so cross-origin isolation is
		// pure overhead here and can complicate loading.
		coi: false,
		// Copies revm.wasm next to the bundle, which is what the page fetches.
		assets: [wasm],
	});

	const result = await harness.run({phase: 'once', params: {}});
	await harness.dispose();

	// eslint-disable-next-line no-console
	console.log(
		`[${testInfo.project.name}] ${JSON.stringify(result.results)} ` +
			result.timings.map((t) => `${t.label}=${t.ms.toFixed(1)}ms`).join(' '),
	);

	expect(result.errors).toEqual([]);
	expect(result.results.mismatches).toBe(0);
	// The whole hand-written corpus: 63 calls across nine fixtures.
	expect(result.results.calls).toBe(63);
	expect(result.results.recovered).toBe(64);
	expect(result.results.rejected).toBe(1);
	// Two instances in one page, each answering from its own state.
	expect(result.results.isolation).toEqual({a: 0x11, b: 0x22});
	// The artifact identifies itself the same way it does in Node.
	expect(result.results.outcomeFormatVersion).toBe(3);
	expect(result.results.abiVersion).toBe(1);
	expect(String(result.results.build)).toContain('precompiles=all');
	expect(String(result.results.revmRev)).toMatch(/^[0-9a-f]{40}$/);
});
