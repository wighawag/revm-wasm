/**
 * Hardfork identifiers, matching revm's `SpecId` discriminants exactly.
 *
 * Transcribed from `revm::primitives::hardfork::SpecId`, which is a plain
 * `#[repr(u8)]` enum with no gaps. Note that it does NOT include the non-EVM
 * forks (Frontier Thawing, DAO Fork, the ice-age delays), so CANCUN is 11 and
 * not 17. Guessing this table is how a whole corpus silently runs on the wrong
 * fork.
 *
 * The value crosses the boundary as a single byte. An unknown value is not an
 * error: the artifact falls back to `CANCUN` rather than trapping, so a newer
 * caller paired with an older artifact degrades instead of killing the instance.
 */
export const Spec = {
	FRONTIER: 0,
	HOMESTEAD: 1,
	TANGERINE: 2,
	SPURIOUS_DRAGON: 3,
	BYZANTIUM: 4,
	PETERSBURG: 5,
	ISTANBUL: 6,
	BERLIN: 7,
	LONDON: 8,
	MERGE: 9,
	SHANGHAI: 10,
	CANCUN: 11,
	PRAGUE: 12,
	OSAKA: 13,
	AMSTERDAM: 14,
} as const;

export type SpecName = keyof typeof Spec;

/**
 * A hardfork, given either by name or by revm's raw discriminant.
 *
 * The numeric form is accepted because a consumer driving a fixture corpus
 * already has the number, and translating it twice is a place for an off-by-one
 * to hide.
 */
export type SpecInput = SpecName | number;

export function specToByte(
	spec: SpecInput | undefined,
	fallback: number,
): number {
	if (spec === undefined) return fallback;
	if (typeof spec === 'number') return spec;
	const id = Spec[spec];
	if (id === undefined)
		throw new Error(`revm-wasm: unknown spec ${String(spec)}`);
	return id;
}
