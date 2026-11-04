import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * The window's size class (docs/ARCHITECTURE.md §7, "The interface"), read
 * here and nowhere else: a component never asks how wide the window is; the
 * frame reads the class once and places each piece, and the piece fits its
 * container.
 *
 * The classes and their edges are Material's window size classes
 * (https://m3.material.io/foundations/layout/applying-layout/window-size-classes):
 * compact under 600 px, medium from 600 to 839, expanded from 840.
 */
export const SIZE_CLASSES = ['compact', 'medium', 'expanded'] as const;

export type SizeClass = (typeof SIZE_CLASSES)[number];

/** A window narrower than this is compact. */
export const COMPACT_MAX_WIDTH = 600;

/** A window narrower than this, and not compact, is medium. */
export const MEDIUM_MAX_WIDTH = 840;

/** From this width the dock shows both of its columns (docs/decisions/0004-the-interface.md). */
export const LARGE_MIN_WIDTH = 1200;

/** The class of a window `width` CSS px wide. */
export const sizeClassFor = (width: number): SizeClass => {
	if (width < COMPACT_MAX_WIDTH) return 'compact';
	if (width < MEDIUM_MAX_WIDTH) return 'medium';
	return 'expanded';
};

/** `matchMedia`, where the window has one: jsdom does not, and a test runs there. */
const mediaQuery = (query: string): MediaQueryList | undefined =>
	typeof window.matchMedia === 'function' ? window.matchMedia(query) : undefined;

const unsubscribed = () => undefined;

/**
 * Whether `query` matches, kept current through the list's `change` event.
 * One list per query while the component is mounted, so the list subscribed
 * to is the list read. Where there is no `matchMedia` the answer is
 * `fallback`, and nothing is subscribed to.
 */
const useMediaQuery = (query: string, fallback: boolean): boolean => {
	const media = useMemo(() => mediaQuery(query), [query]);
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (media === undefined) return unsubscribed;
			media.addEventListener('change', onChange);
			return () => media.removeEventListener('change', onChange);
		},
		[media]
	);
	const read = useCallback(() => media?.matches ?? fallback, [media, fallback]);
	return useSyncExternalStore(subscribe, read);
};

/**
 * The window's size class now. Without `matchMedia` it is `expanded`, the
 * class a test's window is taken to have.
 */
export const useSizeClass = (): SizeClass => {
	const compact = useMediaQuery(`(width < ${COMPACT_MAX_WIDTH}px)`, false);
	const medium = useMediaQuery(`(width < ${MEDIUM_MAX_WIDTH}px)`, false);
	if (compact) return 'compact';
	if (medium) return 'medium';
	return 'expanded';
};

/**
 * Whether the window is at least `px` wide, for a threshold the size classes
 * do not have: the dock opens both its columns from `LARGE_MIN_WIDTH`.
 * Without `matchMedia` it is true, as a window taken to be expanded is wide.
 */
export const useMinWidth = (px: number): boolean => useMediaQuery(`(width >= ${px}px)`, true);
