import { useMemo } from 'react';

import { t } from '../../i18n/t.js';
import { layerNameOf } from '../document/layers.js';
import type { DocumentSnapshot, EditorDocument } from '../document/model.js';
import { elementsOf } from '../tools/vector/hit.js';

/**
 * A vector layer's items in the layers panel (docs/ARCHITECTURE.md §7, "The
 * interface"): its elements (`elementsOf`), as Illustrator's layers panel
 * lists a layer's objects, each a row under the layer once it is expanded.
 * An item is known by where it is among the layer's elements, its position,
 * which is how a preview draws it and a command finds it again, since an undo
 * that rebuilt the layer leaves the elements read before it behind.
 *
 * An item is called by the name it was given, `draw:name` or Inkscape's
 * `inkscape:label` as a layer is (`layerNameOf`), or its `<title>`; a text
 * without one by its words, as Photoshop calls a type layer by them, cut
 * short where they run long; anything else by what it is, in the user's
 * words: a Rectangle, an Ellipse (a circle is one), a Path, a Clone for a
 * `<use>`.
 */

export type LayerItem = Readonly<{
	/** Where it is among the layer's elements, in paint order, from 0. */
	position: number;
	element: Element;
	/** What its row calls it, in the user's words. */
	name: string;
}>;

/** How many characters of a text's words name it before they are cut short. */
export const TEXT_NAME_MOST = 24;

/** What each kind of element is called, where it has no name of its own. */
const KIND_NAMES: Readonly<Record<string, () => string>> = {
	rect: () => t('layers.items.rectangle'),
	ellipse: () => t('layers.items.ellipse'),
	circle: () => t('layers.items.ellipse'),
	line: () => t('layers.items.line'),
	polyline: () => t('layers.items.polyline'),
	polygon: () => t('layers.items.polygon'),
	path: () => t('layers.items.path'),
	text: () => t('layers.items.text'),
	g: () => t('layers.items.group'),
	image: () => t('layers.items.image'),
	use: () => t('layers.items.clone'),
	svg: () => t('layers.items.drawing'),
};

/** Text with its runs of white space made one space, and none at either end. */
const squeezed = (text: string | null | undefined): string =>
	(text ?? '').replace(/\s+/g, ' ').trim();

/** The text of the element's own `<title>`, where it has one with words in it. */
const titleOf = (element: Element): string | undefined => {
	const title = [...element.children].find((child) => child.localName === 'title');
	const words = squeezed(title?.textContent);
	return words === '' ? undefined : words;
};

/**
 * Words cut to `TEXT_NAME_MOST` characters, with an ellipsis where they were
 * longer; by characters, not UTF-16 units, so no letter is split in two.
 */
export const cutWords = (words: string): string => {
	const characters = [...words];
	return characters.length <= TEXT_NAME_MOST
		? words
		: t('layers.items.cut', { text: characters.slice(0, TEXT_NAME_MOST).join('').trimEnd() });
};

/** What an element is called by its kind; a group for one that holds others, as `switch` does. */
const kindName = (localName: string): string => {
	const named = KIND_NAMES[localName];
	return named === undefined ? t('layers.items.group') : named();
};

/** What an item's row calls it (above). */
export const itemName = (element: Element): string => {
	const named = layerNameOf(element) ?? titleOf(element);
	if (named !== undefined) return named;
	const words = element.localName === 'text' ? squeezed(element.textContent) : '';
	return words === '' ? kindName(element.localName) : cutWords(words);
};

/** The layer's items, bottom first as its elements are painted; none for no layer. */
export const itemsOf = (layer: Element | undefined): readonly LayerItem[] =>
	layer === undefined
		? []
		: elementsOf(layer).map((element, position) => ({
				position,
				element,
				name: itemName(element),
			}));

/** The layer's elements, which a selection on it is made of: none for no layer. */
export const layerElements = (layer: Element | undefined): readonly Element[] =>
	layer === undefined ? [] : elementsOf(layer);

/** A vector layer has items to show while it holds two or more: one is the layer itself, as seen. */
export const ITEMS_LEAST = 2;

/**
 * What is selected on a layer after a press on one of its items: the item
 * alone, or with `toggle` (Shift, Ctrl or ⌘) what was selected of the layer's
 * own `elements` with the item added, or taken out where it was in. In paint
 * order, as every selection on a layer is (`combineElements`).
 */
export const pressedSelection = (
	elements: readonly Element[],
	selected: readonly Element[],
	item: Element,
	toggle: boolean
): readonly Element[] => {
	if (!toggle) return [item];
	const was = new Set(selected);
	const now = (element: Element) => (element === item ? !was.has(element) : was.has(element));
	return elements.filter(now);
};

export type LayerItems = Readonly<{
	/** How many items the vector layer `id` holds; 0 for a layer of another kind. */
	countOf: (id: string) => number;
	/** The items of the vector layer `id`, top first as the rows show them, where it is expanded and holds enough to be; none elsewhere. */
	shownOf: (id: string) => readonly LayerItem[];
}>;

/**
 * The vector layers' items as the panel shows them, read from the live
 * document anew with every snapshot, which is new with every change
 * (`DocumentSnapshot.version`): each one's count, which says whether it can
 * be expanded, and the items of those `expanded`, named. A layer of 300
 * strokes collapsed is counted, never named.
 */
export const useLayerItems = (
	document: EditorDocument,
	snapshot: DocumentSnapshot,
	expanded: readonly string[]
): LayerItems =>
	useMemo(() => {
		const vector = snapshot.layers.filter((layer) => layer.kind === 'vector');
		const elements = new Map(
			vector.map((layer) => [layer.id, layerElements(document.layer(layer.id))])
		);
		const shown = new Map(
			vector
				.filter((layer) => expanded.includes(layer.id))
				.map((layer) => [layer.id, [...itemsOf(document.layer(layer.id))].reverse()])
		);
		return {
			countOf: (id) => elements.get(id)?.length ?? 0,
			shownOf: (id) => {
				const items = shown.get(id) ?? [];
				return items.length < ITEMS_LEAST ? [] : items;
			},
		};
	}, [document, snapshot, expanded]);
