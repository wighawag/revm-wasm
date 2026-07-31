/**
 * How much does the JS-side key representation cost?
 *
 * The spike measured a `Map`-backed host at ~1.30 microseconds per state access
 * against ~0.51 for the wasm crossing alone, so roughly 60% of a state access
 * was JS-side hex key construction: more than the boundary crossing it existed
 * to serve. This compares the spike's key encoding (two hex characters per byte,
 * built with a lookup table and string concatenation, address and slot
 * concatenated into ONE flat map key) against this package's (two bytes packed
 * per UTF-16 code unit, storage indexed per account).
 *
 *   pnpm bench:keys
 *
 * Not a vitest test: it is a measurement, and a threshold on it would be a
 * flaky test that fails on a loaded machine rather than a useful signal.
 */
import {MemoryStore} from '../src/memory-store.js';

const HEX = new Array<string>(256);
for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, '0');

/** The spike's `keyOf`, verbatim in spirit. */
function hexKey(u8: Uint8Array, len: number): string {
	let s = '';
	for (let i = 0; i < len; i++) s += HEX[u8[i]];
	return s;
}

function packedKey20(a: Uint8Array): string {
	return String.fromCharCode(
		(a[0] << 8) | a[1],
		(a[2] << 8) | a[3],
		(a[4] << 8) | a[5],
		(a[6] << 8) | a[7],
		(a[8] << 8) | a[9],
		(a[10] << 8) | a[11],
		(a[12] << 8) | a[13],
		(a[14] << 8) | a[15],
		(a[16] << 8) | a[17],
		(a[18] << 8) | a[19],
	);
}

function packedKey32(a: Uint8Array): string {
	return String.fromCharCode(
		(a[0] << 8) | a[1],
		(a[2] << 8) | a[3],
		(a[4] << 8) | a[5],
		(a[6] << 8) | a[7],
		(a[8] << 8) | a[9],
		(a[10] << 8) | a[11],
		(a[12] << 8) | a[13],
		(a[14] << 8) | a[15],
		(a[16] << 8) | a[17],
		(a[18] << 8) | a[19],
		(a[20] << 8) | a[21],
		(a[22] << 8) | a[23],
		(a[24] << 8) | a[25],
		(a[26] << 8) | a[27],
		(a[28] << 8) | a[29],
		(a[30] << 8) | a[31],
	);
}

const N = 200_000;
const addresses: Uint8Array[] = [];
const slots: Uint8Array[] = [];
for (let i = 0; i < 64; i++) {
	const a = new Uint8Array(20);
	crypto.getRandomValues(a);
	addresses.push(a);
}
for (let i = 0; i < N; i++) {
	const s = new Uint8Array(32);
	new DataView(s.buffer).setUint32(28, i);
	slots.push(s);
}

function best(label: string, fn: () => void, rounds = 5): number {
	let bestMs = Infinity;
	for (let r = 0; r < rounds; r++) {
		const t = performance.now();
		fn();
		bestMs = Math.min(bestMs, performance.now() - t);
	}
	console.log(
		`${label.padEnd(46)} ${((bestMs * 1000) / N).toFixed(4)} us/access`,
	);
	return bestMs;
}

console.log(`\nkey construction + Map lookup, ${N} storage reads, best of 5\n`);

// --- the spike's shape: one flat map, hex keys ---
const flat = new Map<string, Uint8Array>();
for (let i = 0; i < N; i++) {
	flat.set(hexKey(addresses[i % 64], 20) + hexKey(slots[i], 32), slots[i]);
}
const hexMs = best('flat map, hex keys (the spike)', () => {
	let seen = 0;
	for (let i = 0; i < N; i++) {
		const v = flat.get(hexKey(addresses[i % 64], 20) + hexKey(slots[i], 32));
		if (v !== undefined) seen++;
	}
	if (seen !== N) throw new Error('miss');
});

// --- this package: per-account index, packed keys ---
const nested = new Map<string, Map<string, Uint8Array>>();
for (let i = 0; i < N; i++) {
	const a = packedKey20(addresses[i % 64]);
	let m = nested.get(a);
	if (!m) nested.set(a, (m = new Map()));
	m.set(packedKey32(slots[i]), slots[i]);
}
const packedMs = best('per-account index, packed keys (this package)', () => {
	let seen = 0;
	for (let i = 0; i < N; i++) {
		const v = nested
			.get(packedKey20(addresses[i % 64]))
			?.get(packedKey32(slots[i]));
		if (v !== undefined) seen++;
	}
	if (seen !== N) throw new Error('miss');
});

console.log(`\nspeedup on key handling: ${(hexMs / packedMs).toFixed(2)}x\n`);

// --- clearStorage, the thing the spike knowingly left broken ---
console.log('clearStorage with 200,000 unrelated slots resident:\n');

const flatClearStart = performance.now();
{
	// The spike's implementation: a prefix scan of the WHOLE map.
	const prefix = hexKey(addresses[0], 20);
	let removed = 0;
	for (const k of flat.keys()) {
		if (k.startsWith(prefix)) {
			flat.delete(k);
			removed++;
		}
	}
	console.log(
		`  flat map prefix scan   ${(performance.now() - flatClearStart).toFixed(3)} ms (removed ${removed})`,
	);
}

const store = new MemoryStore();
for (let i = 0; i < N; i++)
	store.setStorage(addresses[i % 64], slots[i], slots[i]);
const nestedClearStart = performance.now();
store.clearStorage(addresses[0]);
console.log(
	`  per-account delete     ${(performance.now() - nestedClearStart).toFixed(3)} ms`,
);
console.log(
	'\nSELFDESTRUCT and every contract creation hit clearStorage, so the left-hand\n' +
		'column is paid per creation on a state of that size.\n',
);
