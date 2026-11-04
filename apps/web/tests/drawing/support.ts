/**
 * A window of a known width, for the frame's tests: jsdom has no
 * `matchMedia`, and the size class is read from one (docs/ARCHITECTURE.md §7,
 * "The interface"). The stub answers width queries against the width given,
 * in the forms a hook is likely to write them in, and `false` to anything
 * else (a `prefers-*`, a pointer).
 */

export type Width = 'compact' | 'medium' | 'expanded' | number;

/** A width well inside each class; expanded is past the 1200 px the dock opens at. */
const WIDTHS = { compact: 400, medium: 700, expanded: 1300 } as const;

const PX_PER_REM = 16;

const toPx = (value: string, unit: string | undefined): number =>
	Number(value) * (unit === 'em' || unit === 'rem' ? PX_PER_REM : 1);

const compare = (left: number, operator: string, right: number): boolean => {
	if (operator === '<') return left < right;
	if (operator === '<=') return left <= right;
	if (operator === '>') return left > right;
	return left >= right;
};

const LENGTH = '([\\d.]+)(px|r?em)?';

const clauseMatches = (clause: string, width: number): boolean => {
	const minWidth = new RegExp(`^min-width:\\s*${LENGTH}$`).exec(clause);
	if (minWidth) return width >= toPx(minWidth[1] ?? '0', minWidth[2]);
	const maxWidth = new RegExp(`^max-width:\\s*${LENGTH}$`).exec(clause);
	if (maxWidth) return width <= toPx(maxWidth[1] ?? '0', maxWidth[2]);
	const oneSided = new RegExp(`^width\\s*(<=|<|>=|>)\\s*${LENGTH}$`).exec(clause);
	if (oneSided) return compare(width, oneSided[1] ?? '>=', toPx(oneSided[2] ?? '0', oneSided[3]));
	const range = new RegExp(`^${LENGTH}\\s*(<=|<)\\s*width\\s*(<=|<)\\s*${LENGTH}$`).exec(clause);
	if (range) {
		const low = toPx(range[1] ?? '0', range[2]);
		const high = toPx(range[5] ?? '0', range[6]);
		return compare(low, range[3] ?? '<=', width) && compare(width, range[4] ?? '<', high);
	}
	return false;
};

const queryMatches = (query: string, width: number): boolean =>
	query
		.split(/\s+and\s+/i)
		.map((clause) =>
			clause
				.trim()
				.replace(/^\(|\)$/g, '')
				.trim()
		)
		.every((clause) => clauseMatches(clause, width));

/** Makes the window `width` wide for `matchMedia` and `innerWidth`, until the next call. */
export const stubWindowWidth = (width: Width): void => {
	const px = typeof width === 'number' ? width : WIDTHS[width];
	Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string): MediaQueryList =>
			({
				matches: queryMatches(query, px),
				media: query,
				onchange: null,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
				addListener: () => undefined,
				removeListener: () => undefined,
				dispatchEvent: () => false,
			}) as MediaQueryList,
	});
};
