import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		// `test/browser` is Playwright's, not vitest's: it needs a real browser and
		// the harness's bundler. Without this exclusion vitest would pick the spec
		// up by its `.spec.ts` suffix and fail on an import it cannot resolve.
		exclude: ['**/node_modules/**', '**/dist/**', 'test/browser/**'],
	},
});
