// Records the published size of the artifact, and what the published tarball
// actually weighs.
//
//   node scripts/measure-size.mjs
//
// Needs no Rust toolchain: it measures the committed `revm.wasm`.
//
// `gzip -9 -c <file>` is the exact invocation every size figure in this repo and
// in the spike reports uses. Two traps, each large enough to fake a 1% delta:
// Node's own zlib at level 9 lands ~0.6% higher than GNU gzip on these
// artifacts, and `gzip -c <file>` stores the filename in the header while
// `gzip -c < file` does not. One implementation, one invocation.
import {execFileSync} from 'node:child_process';
import {readFileSync, statSync, writeFileSync, mkdirSync} from 'node:fs';
import {brotliCompressSync, constants} from 'node:zlib';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WASM = join(ROOT, 'packages', 'revm-wasm', 'wasm', 'revm.wasm');

const gz = (p) =>
	execFileSync('gzip', ['-9', '-c', p], {maxBuffer: 1 << 28}).length;
const br = (b) =>
	brotliCompressSync(b, {
		params: {
			[constants.BROTLI_PARAM_QUALITY]: 11,
			[constants.BROTLI_PARAM_SIZE_HINT]: b.length,
		},
	}).length;

const bytes = readFileSync(WASM);
const row = {
	measuredAt: new Date().toISOString(),
	artifact: 'packages/revm-wasm/wasm/revm.wasm',
	raw: statSync(WASM).size,
	gzip: gz(WASM),
	brotli: br(bytes),
	// The spike shipped an equivalent artifact plus a wasm-bindgen JS glue file.
	// This package has no glue: the ABI is raw, so the wasm IS the artifact.
	// See docs/adr/0002-raw-abi-no-wasm-bindgen.md.
	spikeReference: {wasmGzip: 434009, glueGzip: 3327, totalGzip: 437336},
};
row.deltaVsSpikeWasm = row.gzip - row.spikeReference.wasmGzip;
row.deltaVsSpikeTotal = row.gzip - row.spikeReference.totalGzip;

mkdirSync(join(ROOT, 'measurements'), {recursive: true});
writeFileSync(
	join(ROOT, 'measurements', 'size.json'),
	JSON.stringify(row, null, 2) + '\n',
);

console.log(`raw    ${row.raw}`);
console.log(`gzip   ${row.gzip}`);
console.log(`brotli ${row.brotli}`);
console.log(
	`vs spike wasm (434,009 gz): ${row.deltaVsSpikeWasm >= 0 ? '+' : ''}${row.deltaVsSpikeWasm}`,
);
console.log(
	`vs spike total incl. glue (437,336 gz): ${row.deltaVsSpikeTotal >= 0 ? '+' : ''}${row.deltaVsSpikeTotal}`,
);
console.log('wrote measurements/size.json');
