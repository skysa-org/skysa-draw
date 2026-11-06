import type { LayerInfo } from '../document/model.js';
import type { DropRow } from './layerDrop.js';

/**
 * The layers as the panel's tree of rows (docs/ARCHITECTURE.md §7, "The
 * interface"): top first, a group above what it holds, as a folder is, and a
 * collapsed group's layers without rows. Which groups are collapsed is the
 * editor's, never the file's, so collapsing changes nothing in the drawing.
 */

export type Row = Readonly<{
	layer: LayerInfo;
	/** Its place in document order, from the bottom: what an unnamed layer from elsewhere is called by. */
	index: number;
}>;

const NONE: ReadonlySet<string> = new Set();

/**
 * The rows top first: the layers under `parentId` in reverse document order,
 * each group followed by what it holds, except a group in `collapsed`, whose
 * layers have no rows.
 */
export const rowsUnder = (
	layers: readonly LayerInfo[],
	parentId: string | undefined,
	collapsed: ReadonlySet<string> = NONE
): readonly Row[] =>
	[...layers.map((layer, index) => ({ layer, index }))]
		.filter(({ layer }) => layer.parentId === parentId)
		.reverse()
		.flatMap((row) => [
			row,
			...(collapsed.has(row.layer.id) ? [] : rowsUnder(layers, row.layer.id, collapsed)),
		]);

/** The ids among `ids` in `order`'s order, once each. */
export const inOrder = (order: readonly string[], ids: readonly string[]): readonly string[] =>
	order.filter((id) => ids.includes(id));

/** The groups holding the layer `id`, nearest first. */
export const ancestorsOf = (layers: readonly LayerInfo[], id: string): readonly string[] => {
	const parent = layers.find((each) => each.id === id)?.parentId;
	return parent === undefined ? [] : [parent, ...ancestorsOf(layers, parent)];
};

/** Every group inside the group `id`, at any depth. */
export const groupsInside = (layers: readonly LayerInfo[], id: string): readonly string[] =>
	layers
		.filter((layer) => layer.kind === 'group' && ancestorsOf(layers, layer.id).includes(id))
		.map((layer) => layer.id);

/** The outermost group in `collapsed` holding the layer `id`, whose row shows where its own does not. */
export const shutAncestor = (
	layers: readonly LayerInfo[],
	id: string,
	collapsed: ReadonlySet<string>
): string | undefined =>
	ancestorsOf(layers, id)
		.filter((each) => collapsed.has(each))
		.at(-1);

/** The group's top layer, the last of its layers in document order. */
export const topLayerOf = (layers: readonly LayerInfo[], id: string): string | undefined =>
	layers.filter((layer) => layer.parentId === id).at(-1)?.id;

/**
 * A row of the panel as the arrows walk them: a layer's, or, by its position
 * among the layer's elements, one of an expanded vector layer's items'.
 */
export type Entry = Readonly<{ layerId: string; position?: number }>;

/** Every row shown, top first: each layer's, followed by its items' rows where it shows them, top first. */
export const entriesOf = (
	rows: readonly Row[],
	shownOf: (id: string) => readonly Readonly<{ position: number }>[]
): readonly Entry[] =>
	rows.flatMap(({ layer }) => [
		{ layerId: layer.id },
		...shownOf(layer.id).map(({ position }) => ({ layerId: layer.id, position })),
	]);

/** The rows as the drop model reads them (`layerDrop.ts`). */
export const dropRowsOf = (
	rows: readonly Row[],
	layers: readonly LayerInfo[],
	collapsed: ReadonlySet<string>
): readonly DropRow[] =>
	rows.map(({ layer }) => {
		const shut = layer.kind === 'group' && collapsed.has(layer.id);
		return {
			id: layer.id,
			depth: layer.depth,
			parentId: layer.parentId,
			group: layer.kind === 'group',
			collapsed: shut,
			topLayer: shut ? topLayerOf(layers, layer.id) : undefined,
		};
	});
