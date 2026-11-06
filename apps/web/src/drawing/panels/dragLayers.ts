import { canPlaceLayers } from '../document/arrange.js';
import { type DropTarget, dropTargetAt, type Indent, type MeasuredRow } from './layerDrop.js';
import type { Dragged } from './useLayerDrag.js';

/**
 * Layers dragged to another place in the layers panel, into and out of groups
 * (docs/ARCHITECTURE.md §7, "The interface"), by the panel's one drag
 * (`useLayerDrag`). What is dragged is the layers chosen where the row pressed
 * is one of them, else that row alone, made active and chosen alone as the
 * drag begins. Where it would land is `dropTargetAt` over the rows as they are
 * drawn; a place `canPlaceLayers` refuses shows nothing and drops nothing.
 */

/** The drag the panel draws: the layers dragged, and where they would land. */
export type LayersDrag = Readonly<{
	kind: 'layers';
	ids: readonly string[];
	target: DropTarget | undefined;
}>;

/** A layer's row as it is drawn, with the facts the drop is read from (`LayerRow`). */
const measureRow = (row: HTMLElement, id: string): MeasuredRow => {
	const box = row.getBoundingClientRect();
	return {
		id,
		depth: Number(row.dataset.depth ?? 0),
		parentId: row.dataset.parentId,
		group: row.dataset.group !== undefined,
		collapsed: row.dataset.collapsed !== undefined,
		topLayer: row.dataset.topLayer,
		top: box.top,
		bottom: box.bottom,
	};
};

/** Whether `row` is the last of its layer's items' rows, the one whose bottom is the layer's foot. */
const lastItemOf = (row: HTMLElement, layerId: string): boolean => {
	const next = row.nextElementSibling;
	return !(next instanceof HTMLElement) || next.dataset.itemOf !== layerId;
};

/**
 * The list's layers' rows as they are drawn. An item's row (`LayerItemRow`)
 * is no place for layers: it is under its layer, whose foot is the bottom of
 * the last of them (`MeasuredRow.foot`), the one item measured of a layer of
 * hundreds.
 */
const measureRows = (list: HTMLElement): readonly MeasuredRow[] =>
	[...list.children].reduce<readonly MeasuredRow[]>((rows, row) => {
		if (!(row instanceof HTMLElement)) return rows;
		const layer = rows.at(-1);
		const itemOf = row.dataset.itemOf;
		if (itemOf !== undefined) {
			return layer?.id === itemOf && lastItemOf(row, itemOf)
				? [...rows.slice(0, -1), { ...layer, foot: row.getBoundingClientRect().bottom }]
				: rows;
		}
		const id = row.dataset.layerId;
		return id === undefined ? rows : [...rows, measureRow(row, id)];
	}, []);

/** A CSS length in px, or nothing where it is not one, as in jsdom. */
const pxOf = (length: string): number | undefined => {
	const px = Number.parseFloat(length);
	return Number.isFinite(px) && px > 0 ? px : undefined;
};

/**
 * Where depth 0 begins and how far in each depth more is drawn: a nested
 * layer's row's own indent over its depth, or a rem, which is what the rows
 * are indented by (`--space-l`), where no layer's row is nested.
 */
const indentOf = (list: HTMLElement): Indent => {
	const nested = [...list.children].find(
		(row): row is HTMLElement => row instanceof HTMLElement && Number(row.dataset.depth) > 0
	);
	const measured =
		nested === undefined ? undefined : pxOf(getComputedStyle(nested).paddingInlineStart);
	const step =
		measured === undefined || nested === undefined
			? (pxOf(getComputedStyle(window.document.documentElement).fontSize) ?? 16)
			: measured / Number(nested.dataset.depth);
	return { left: list.getBoundingClientRect().left, step };
};

const sameTarget = (one: DropTarget | undefined, other: DropTarget | undefined): boolean =>
	one === other ||
	(one !== undefined &&
		other !== undefined &&
		one.kind === other.kind &&
		one.place.parentId === other.place.parentId &&
		one.place.aboveId === other.place.aboveId &&
		(one.kind === 'into' || (other.kind === 'gap' && one.before === other.before)));

/** The layers' drag as it shows `shown`, aimed anew from the rows as drawn. */
const layersDragged = (root: SVGSVGElement, shown: LayersDrag): Dragged<LayersDrag> => {
	const dragged: Dragged<LayersDrag> = {
		shown,
		aim: (list, point) => {
			const found = dropTargetAt(measureRows(list), point, indentOf(list));
			const target =
				found !== undefined && canPlaceLayers(root, shown.ids, found.place)
					? found
					: undefined;
			return sameTarget(target, shown.target)
				? dragged
				: layersDragged(root, { ...shown, target });
		},
	};
	return dragged;
};

/**
 * The drag a press on the layer `id`'s row begins: the layers `chosen`, top
 * first, where it is among them, or it alone, made active and chosen alone.
 */
export const beginLayerDrag =
	(root: SVGSVGElement, chosen: readonly string[], onActivate: (id: string) => void) =>
	(id: string) =>
	(): Dragged<LayersDrag> => {
		const among = chosen.includes(id);
		if (!among) onActivate(id);
		return layersDragged(root, {
			kind: 'layers',
			ids: among ? chosen : [id],
			target: undefined,
		});
	};
