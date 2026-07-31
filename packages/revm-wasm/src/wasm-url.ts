/**
 * The URL of the prebuilt `.wasm` inside this package.
 *
 * ```ts
 * import {wasmUrl} from 'revm-wasm/wasm-url';
 * const evm = await createRevm({wasm: wasmUrl});
 * ```
 *
 * `new URL(..., import.meta.url)` is understood by Node's ESM loader and by
 * every bundler that handles asset URLs (Vite, webpack 5, Rollup with the asset
 * plugin, Parcel), so this works both when the package is resolved from
 * `node_modules` and when it is bundled for a browser.
 *
 * Kept in its own entry point so importing the main API does not pull an asset
 * reference into a bundle that does not want one.
 */
export const wasmUrl: URL = new URL('../wasm/revm.wasm', import.meta.url);
