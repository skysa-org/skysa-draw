import { cell } from '@skysa/storage';
import {
	type RefObject,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from 'react';

import { observable } from '../viewport/observable.js';

/**
 * A long run of a vector layer's items' rows drawn as a window onto it
 * (`ItemRows`; docs/ARCHITECTURE.md §7, "The interface"): the rows the panel's
 * body shows, and a few either side, each a row and a preview, with the rest
 * stood for by space of their height, so a layer of a thousand strokes costs
 * what a screenful does to open, to scroll and to change. Every row is the
 * same height, the panel's target (`.layer-item` in `editor.css`), so where
 * each one is follows from where the first is.
 */

/** From this many items a layer's rows are a window; fewer are all drawn, as any list is. */
export const WINDOW_FROM = 60;

/** Rows drawn past either edge of what is seen, so a short scroll or a step of the arrows finds them drawn. */
const OVERSCAN = 6;

/** What is drawn before the rows are first measured: about a screenful. */
const FIRST_DRAWN = 24;

/** Rows by their index, top first: from `from`, up to and not including `to`. */
export type Run = Readonly<{ from: number; to: number }>;

/**
 * The rows of `count`, `height` px each, from `top` px down the scroller's
 * content, that a view from `viewTop` to `viewBottom` px sees, and `OVERSCAN`
 * more either side; every row where the height is not known.
 */
export const windowOf = (
	count: number,
	height: number,
	top: number,
	viewTop: number,
	viewBottom: number
): Run => {
	if (!(height > 0)) return { from: 0, to: count };
	const held = (index: number) => Math.min(count, Math.max(0, index));
	return {
		from: held(Math.floor((viewTop - top) / height) - OVERSCAN),
		to: held(Math.ceil((viewBottom - top) / height) + OVERSCAN),
	};
};

/**
 * The rows drawn, as runs top first: those of the window and each row `kept`
 * outside it, a run taking in one next to it; a row past the end is none.
 */
export const runsOf = (count: number, window: Run, kept: readonly number[]): readonly Run[] => {
	const inWindow = Array.from(
		{ length: Math.max(0, window.to - window.from) },
		(_, step) => window.from + step
	);
	const drawn = [...new Set([...inWindow, ...kept])]
		.filter((index) => Number.isInteger(index) && index >= 0 && index < count)
		.sort((one, other) => one - other);
	return drawn.reduce<readonly Run[]>((runs, index) => {
		const last = runs.at(-1);
		return last?.to === index
			? [...runs.slice(0, -1), { from: last.from, to: index + 1 }]
			: [...runs, { from: index, to: index + 1 }];
	}, []);
};

export type ItemWindow = Readonly<{
	window: Run;
	/** A row's height in CSS px, as drawn; 0 until a row is measured. */
	height: number;
}>;

const sameWindow = (one: ItemWindow, other: ItemWindow): boolean =>
	one.height === other.height &&
	one.window.from === other.window.from &&
	one.window.to === other.window.to;

/** A row's height where none is drawn to measure: the panel's target at a 16 px rem. */
const ROW_FALLBACK_PX = 44;

/**
 * The window onto the `count` rows that follow `anchor`, a row of no height
 * at their top, in the panel's body, which is what scrolls the list
 * (`Panel`): measured after each render, and after each scroll or resize of
 * the body, at most once a frame, and set only where it moved. Every row,
 * where the rows are not `windowed`, and where the body has no height to
 * measure: put away, or in jsdom.
 */
export const useItemWindow = (
	anchor: RefObject<HTMLElement | null>,
	count: number,
	windowed: boolean
): ItemWindow => {
	// Measured from a layout effect and from listeners on the body, so held
	// outside React and read through it, as the viewport's view is.
	const [store] = useState(() =>
		observable<ItemWindow>({
			window: { from: 0, to: windowed ? Math.min(count, FIRST_DRAWN) : count },
			height: 0,
		})
	);
	const view = useSyncExternalStore(store.subscribe, store.get);
	const show = (next: ItemWindow) => {
		if (!sameWindow(store.get(), next)) store.set(next);
	};

	const measure = useEffectEvent(() => {
		const top = anchor.current;
		const body = top?.closest('.panel-body');
		const all: ItemWindow = { window: { from: 0, to: count }, height: 0 };
		if (!windowed || top === null || !(body instanceof HTMLElement) || body.clientHeight <= 0) {
			show(all);
			return;
		}
		const row = top.nextElementSibling;
		const drawn = row instanceof HTMLElement ? row.getBoundingClientRect().height : 0;
		const known = store.get().height;
		const height = [drawn, known].find((each) => each > 0) ?? ROW_FALLBACK_PX;
		const blockTop =
			top.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
		const next: ItemWindow = {
			window: windowOf(
				count,
				height,
				blockTop,
				body.scrollTop,
				body.scrollTop + body.clientHeight
			),
			height,
		};
		show(next);
	});

	useLayoutEffect(() => {
		measure();
	});

	useEffect(() => {
		const body = anchor.current?.closest('.panel-body');
		if (!windowed || !(body instanceof HTMLElement)) return undefined;
		const frame = cell(0);
		const soon = () => {
			if (frame.current !== 0) return;
			frame.current = requestAnimationFrame(() => {
				frame.current = 0;
				measure();
			});
		};
		const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : undefined;
		resized?.observe(body);
		body.addEventListener('scroll', soon, { passive: true });
		return () => {
			body.removeEventListener('scroll', soon);
			resized?.disconnect();
			if (frame.current !== 0) cancelAnimationFrame(frame.current);
		};
	}, [anchor, windowed]);

	return view;
};

/**
 * The position of the layer `layerId`'s item whose row has the focus in the
 * list `anchor` is in, kept up to date by the focus moving in and out of it;
 * none where no row of its has the focus, and none looked for where the rows
 * are not `windowed`.
 */
export const useFocusedItem = (
	anchor: RefObject<HTMLElement | null>,
	layerId: string,
	windowed: boolean
): number | undefined => {
	const [focused, setFocused] = useState<number | undefined>(undefined);
	useEffect(() => {
		const list = anchor.current?.parentElement;
		if (!windowed || list === null || list === undefined) return undefined;
		const read = (target: EventTarget | null): number | undefined => {
			const row = target instanceof Element ? target.closest('li') : null;
			return row instanceof HTMLElement &&
				row.dataset.itemOf === layerId &&
				row.dataset.position !== undefined
				? Number(row.dataset.position)
				: undefined;
		};
		const onFocusIn = (event: FocusEvent) => {
			setFocused(read(event.target));
		};
		const onFocusOut = (event: FocusEvent) => {
			if (!(event.relatedTarget instanceof Node) || !list.contains(event.relatedTarget)) {
				setFocused(undefined);
			}
		};
		list.addEventListener('focusin', onFocusIn);
		list.addEventListener('focusout', onFocusOut);
		return () => {
			list.removeEventListener('focusin', onFocusIn);
			list.removeEventListener('focusout', onFocusOut);
		};
	}, [anchor, layerId, windowed]);
	return windowed ? focused : undefined;
};
