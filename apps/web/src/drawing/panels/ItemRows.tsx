import { Fragment, type ReactNode, useRef } from 'react';

import { runsOf, useFocusedItem, useItemWindow, WINDOW_FROM } from './itemWindow.js';
import type { LayerItem } from './layerItems.js';

/** The line of a drop of layers under the last of a layer's items' rows. */
type Under = Readonly<{ at: 'after'; depth: number }>;

/**
 * An expanded vector layer's items' rows, under its own (`LayersPanel`;
 * docs/ARCHITECTURE.md §7, "The interface"): every one, for a layer of fewer
 * than `WINDOW_FROM` items, and for more a window onto them (`itemWindow.ts`),
 * the rows not drawn stood for by space as tall as they would be, in rows of
 * their own that hold nothing and that the drag passes over (`dragItems.ts`).
 *
 * Whatever is scrolled, some rows are drawn: the first and the last, which
 * the arrows reach from the layers' rows either side and under which the line
 * of a drop of layers under the layer is drawn (`under`); the row with the
 * focus and the rows either side of it, so the arrows always find the next;
 * and each row `kept`, the one a drag holds the pointer by.
 */
export const ItemRows = ({
	layerId,
	items,
	kept,
	under,
	row,
}: Readonly<{
	layerId: string;
	/** The layer's items, top first. */
	items: readonly LayerItem[];
	/** The positions of items whose rows are drawn wherever they are. */
	kept: readonly number[];
	under: Under | undefined;
	/** An item's row, with the line under it where it is the last. */
	row: (item: LayerItem, under: Under | undefined) => ReactNode;
}>) => {
	const anchor = useRef<HTMLLIElement>(null);
	const count = items.length;
	const windowed = count >= WINDOW_FROM;
	const { window, height } = useItemWindow(anchor, count, windowed);
	const focused = useFocusedItem(anchor, layerId, windowed);
	const drawnRow = (item: LayerItem, nth: number) => (
		<Fragment key={item.position}>{row(item, nth === count - 1 ? under : undefined)}</Fragment>
	);
	if (!windowed) return items.map(drawnRow);
	const nthOf = new Map(items.map((item, nth) => [item.position, nth]));
	const near = focused === undefined ? [] : [focused - 1, focused, focused + 1];
	const keptRows = [
		0,
		count - 1,
		...[...kept, ...near].flatMap((position) => nthOf.get(position) ?? []),
	];
	const runs = runsOf(count, window, keptRows);
	const gap = (key: string, rows: number) => (
		<li
			key={key}
			ref={key === 'top' ? anchor : undefined}
			className="layer-item-gap"
			aria-hidden="true"
			data-item-of={layerId}
			data-gap=""
			style={{ blockSize: `${String(rows * height)}px` }}
		/>
	);
	// One list, the rows keyed by position and the gaps by their place among
	// the runs, so a scroll adds and takes away rows at the window's edges and
	// keeps the rest, and their previews, as they are. The first row is always
	// drawn, so the top gap, which the window is measured from, is of no height.
	return [
		gap('top', 0),
		...runs.flatMap((run, at) => [
			...(at > 0
				? [gap(`gap-${String(at)}`, run.from - (runs[at - 1]?.to ?? run.from))]
				: []),
			...items.slice(run.from, run.to).map((item, step) => drawnRow(item, run.from + step)),
		]),
	];
};
