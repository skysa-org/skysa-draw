import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
	COMPACT_MAX_WIDTH,
	LARGE_MIN_WIDTH,
	MEDIUM_MAX_WIDTH,
	SIZE_CLASSES,
	sizeClassFor,
	useMinWidth,
	useSizeClass,
} from '../../src/components/ui/sizeClass.js';

/**
 * The window's size class (docs/ARCHITECTURE.md §7, "The interface"):
 * Material's edges, read from `matchMedia` and kept current by its `change`
 * event, and `expanded` where there is no `matchMedia` at all, as in jsdom.
 */

type Stubbed = Readonly<{
	/** Every query the hooks asked, in order. */
	queries: string[];
	/** Every list handed out. */
	lists: MediaQueryList[];
	/** Each list's `removeEventListener`, watched, to see what is still listened to. */
	removals: Mock[];
	/** The window made `width` px wide: each list whose answer flips fires `change`. */
	resize: (width: number) => void;
}>;

/**
 * A `matchMedia` for a window `initial` px wide, answering the two forms the
 * hooks ask — `(width < Npx)` and `(width >= Npx)` — as a browser would, each
 * list an `EventTarget` whose `matches` is read live.
 */
const stubMatchMedia = (initial: number): Stubbed => {
	let width = initial;
	const queries: string[] = [];
	const lists: MediaQueryList[] = [];
	const removals: Mock[] = [];
	const matchMedia = (query: string): MediaQueryList => {
		queries.push(query);
		const less = /^\(width < (\d+)px\)$/.exec(query);
		const atLeast = /^\(width >= (\d+)px\)$/.exec(query);
		const edge = Number((less ?? atLeast)?.[1]);
		if (Number.isNaN(edge)) throw new Error(`a query the stub does not know: ${query}`);
		const list = new EventTarget() as MediaQueryList;
		Object.defineProperty(list, 'media', { value: query });
		Object.defineProperty(list, 'matches', {
			get: () => (less === null ? width >= edge : width < edge),
		});
		removals.push(vi.spyOn(list, 'removeEventListener'));
		lists.push(list);
		return list;
	};
	Object.defineProperty(window, 'matchMedia', {
		value: matchMedia,
		configurable: true,
		writable: true,
	});
	const resize = (next: number) => {
		const before = lists.map((list) => list.matches);
		width = next;
		act(() => {
			lists.forEach((list, at) => {
				if (list.matches !== before[at]) list.dispatchEvent(new Event('change'));
			});
		});
	};
	return { queries, lists, removals, resize };
};

afterEach(() => {
	Reflect.deleteProperty(window, 'matchMedia');
});

describe('sizeClassFor', () => {
	it("is Material's window size classes, edge by edge", () => {
		expect(COMPACT_MAX_WIDTH).toBe(600);
		expect(MEDIUM_MAX_WIDTH).toBe(840);
		expect(LARGE_MIN_WIDTH).toBe(1200);
		expect(SIZE_CLASSES).toEqual(['compact', 'medium', 'expanded']);
		expect(sizeClassFor(0)).toBe('compact');
		expect(sizeClassFor(599)).toBe('compact');
		expect(sizeClassFor(600)).toBe('medium');
		expect(sizeClassFor(839)).toBe('medium');
		expect(sizeClassFor(840)).toBe('expanded');
		expect(sizeClassFor(1920)).toBe('expanded');
	});
});

describe('useSizeClass', () => {
	it('asks matchMedia the two edges, and follows the window across each', () => {
		const media = stubMatchMedia(599);
		const { result } = renderHook(useSizeClass);
		expect(result.current).toBe('compact');
		expect(new Set(media.queries)).toEqual(new Set(['(width < 600px)', '(width < 840px)']));

		media.resize(600);
		expect(result.current).toBe('medium');
		media.resize(839);
		expect(result.current).toBe('medium');
		media.resize(840);
		expect(result.current).toBe('expanded');
		media.resize(599);
		expect(result.current).toBe('compact');
	});

	it('starts in the class the window is in', () => {
		stubMatchMedia(839);
		expect(renderHook(useSizeClass).result.current).toBe('medium');
		stubMatchMedia(840);
		expect(renderHook(useSizeClass).result.current).toBe('expanded');
	});

	it('stops listening once unmounted', () => {
		const media = stubMatchMedia(700);
		const { unmount } = renderHook(useSizeClass);
		unmount();
		expect(media.removals.length).toBeGreaterThan(0);
		media.removals.forEach((removed) => {
			expect(removed).toHaveBeenCalledWith('change', expect.any(Function));
		});
	});

	it('is expanded where there is no matchMedia', () => {
		expect(typeof window.matchMedia).toBe('undefined');
		expect(renderHook(useSizeClass).result.current).toBe('expanded');
	});
});

describe('useMinWidth', () => {
	it('says whether the window is at least so wide, as it changes', () => {
		const media = stubMatchMedia(LARGE_MIN_WIDTH - 1);
		const { result } = renderHook(() => useMinWidth(LARGE_MIN_WIDTH));
		expect(result.current).toBe(false);
		expect(media.queries).toContain('(width >= 1200px)');
		media.resize(LARGE_MIN_WIDTH);
		expect(result.current).toBe(true);
	});

	it('is true where there is no matchMedia, as an expanded window is wide', () => {
		expect(renderHook(() => useMinWidth(LARGE_MIN_WIDTH)).result.current).toBe(true);
	});
});
