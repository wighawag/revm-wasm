import {defineConfig, devices} from '@playwright/test';

/**
 * Two engines, deliberately.
 *
 * Chromium is V8 and WebKit is JavaScriptCore, and a wasm module behaves
 * differently enough across them that a Chromium-only suite reports on one
 * engine while implying two. That difference was material during the evaluation
 * this package came out of, so it is checked rather than assumed.
 *
 *   pnpm exec playwright install chromium webkit
 *   pnpm test:browser
 */
export default defineConfig({
	testDir: './test/browser',
	testMatch: /.*\.spec\.ts/,
	// Compiling and running a 1.2 MB wasm module in two engines is not fast.
	timeout: 120_000,
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	projects: [
		{name: 'chromium (V8)', use: {...devices['Desktop Chrome']}},
		{name: 'webkit (JavaScriptCore)', use: {...devices['Desktop Safari']}},
	],
});
