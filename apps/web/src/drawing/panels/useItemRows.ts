import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import type { MenuPoint } from '../../components/ui/ContextMenu.js';
import {
	arrangeElements,
	canArrange,
	isLayerHeld,
	moveElements,
	type PlacingCommand,
} from '../document/elements.js';
import type { EditorDocument, LayerInfo } from '../document/model.js';
import { choiceKeysOf } from '../layerSelection.js';
import { elementsAtPositions } from '../tools/vector/hit.js';
import { isMac } from '../viewport/pointer.js';
import { type ItemsDrag, itemsDragged } from './dragItems.js';
import { itemDropOnItem } from './itemDrop.js';
import { focusItem, type LayerItemRowProps } from './LayerItemRow.js';
import { heldNotice, layerElements, type LayerItem, pressedSelection } from './layerItems.js';
import { focusPick, isMenuKey, plainKey, ROW_STEPS, underButton } from './LayerRow.js';
import type { Entry } from './LayerTree.js';
import type { DragFrom, Dragged, PointerHandlers } from './useLayerDrag.js';

/**
 * The items' rows of the layers panel (`LayerItemRow`; docs/ARCHITECTURE.md
 * §7, "The interface"): what a press, a key, a right-click and a drag on one
 * do, and the walk of the arrows over every row shown, which steps onto the
 * items' rows as onto the layers'.
 *
 * A press selects the item on the canvas, as Illustrator's panel does: alone,
 * or with Shift, Ctrl or ⌘ added to what is selected on its layer or taken
 * out of it (`onSelectElements`). Its menu is the selection's actions, the
 * very list the canvas's menu shows, opened over the row once the item is
 * selected alone, unless it is among what is selected on its layer already,
 * as a layer's row is chosen alone first for the layer actions. It is dragged
 * by the panel's one drag (`useLayerDrag`, `dragItems.ts`), with what is
 * selected on its layer where it is among it, else alone, selected as the drag
 * begins; Alt with an arrow moves the same a step forward or backward among
 * the layer's elements (`arrangeElements`), the selection and the focus going
 * with them. After a move what it moved is selected where it went.
 *
 * The items of a held layer, locked or hidden, itself or by a group
 * (`isLayerHeld`), are out of reach, as the canvas's tools are of it: a press
 * selects nothing and says why, as a tool does (`heldNotice`), and they open
 * no menu, are not dragged, and are moved by no key. The arrows still walk
 * onto them, focusing without selecting.
 */

const MAC = isMac();

/** What the rows read of the panel's one drag (`useLayerDrag`). */
type ItemDragView = Readonly<{
	/** The items being dragged, and where they would land, while they are. */
	items: ItemsDrag | undefined;
	handlers: (begins: () => Dragged<ItemsDrag>, from: DragFrom) => PointerHandlers;
	spentClick: () => boolean;
}>;

type ItemAt = Readonly<{ layerId: string; position: number }>;

export const useItemRows = ({
	document,
	layers,
	entries,
	selection,
	onActivate,
	onSelectElements,
	onNotify,
}: Readonly<{
	document: EditorDocument;
	/** The layers, in document order, as the snapshot has them. */
	layers: readonly LayerInfo[];
	/** Every row shown, top first, as the arrows walk them. */
	entries: readonly Entry[];
	/** The elements selected on the canvas, in paint order. */
	selection: readonly Element[];
	onActivate: (id: string) => void;
	onSelectElements: (layerId: string, elements: readonly Element[]) => void;
	onNotify: (message: string) => void;
}>) => {
	/** Where the item's menu is open over a row, or none. */
	const [menuAt, setMenuAt] = useState<MenuPoint | undefined>(undefined);
	/** The item whose row has the focus once a move of it has rendered. */
	const refocus = useRef<ItemAt | undefined>(undefined);
	const selected = new Set(selection);
	const held = (layerId: string): boolean => isLayerHeld(document.root, layerId);
	const elementsIn = (layerId: string) => layerElements(document.layer(layerId));

	useEffect(() => {
		const to = refocus.current;
		refocus.current = undefined;
		if (to !== undefined) focusItem(to.layerId, to.position);
	});

	/** The item selected alone, or with `toggle` added to what is selected on its layer or taken out. */
	const select = (layerId: string, position: number, toggle: boolean) => {
		const own = elementsIn(layerId);
		const item = own[position];
		if (item !== undefined)
			onSelectElements(layerId, pressedSelection(own, selection, item, toggle));
	};

	/** A press on an item's row: it selected, or on a held layer nothing, and why said. */
	const press = (layerId: string, position: number, toggle: boolean) => {
		if (!held(layerId)) {
			select(layerId, position, toggle);
			return;
		}
		const why = heldNotice(layers, layerId);
		if (why !== undefined) onNotify(why);
	};

	/**
	 * What a move from the item moves, by their positions, ascending: what is
	 * selected on its layer, where the item is among it, else the item alone.
	 */
	const movedWith = (layerId: string, position: number): readonly number[] => {
		const own = elementsIn(layerId);
		const item = own[position];
		return item !== undefined && selected.has(item)
			? own.flatMap((element, at) => (selected.has(element) ? [at] : []))
			: [position];
	};

	/** After a move: what it moved selected where it is now, and the focus on the row of the one at `nth` among them, where one shows. */
	const settle = (moved: PlacingCommand, nth: number) => {
		const now = elementsAtPositions(document.layer(moved.layerId), moved.positions);
		onSelectElements(moved.layerId, now);
		const position = moved.positions[nth];
		refocus.current = position === undefined ? undefined : { layerId: moved.layerId, position };
	};

	/** Alt with an arrow: what a move from the item moves, a step forward up the list or backward down it. */
	const arrange = (layerId: string, position: number, step: -1 | 1) => {
		if (held(layerId)) return;
		const positions = movedWith(layerId, position);
		const how = step < 0 ? 'forward' : 'backward';
		if (!canArrange(elementsIn(layerId).length, positions, how)) return;
		const done = arrangeElements(layerId, positions, how);
		document.execute(done);
		settle(done, positions.indexOf(position));
	};

	/** The item's menu at `at`, the item selected alone first unless it is among what is selected; none on a held layer. */
	const openMenu = (layerId: string, position: number, at: MenuPoint) => {
		const item = elementsIn(layerId)[position];
		if (held(layerId) || item === undefined) return;
		if (!selected.has(item)) onSelectElements(layerId, [item]);
		setMenuAt(at);
	};

	/** A layer's row, chosen alone, with the focus. Whether there is one. */
	const goToLayer = (id: string | undefined): boolean => {
		if (id === undefined) return false;
		onActivate(id);
		focusPick(id);
		return true;
	};

	/** A row, as a press reaches it, with the focus: a layer's chosen alone, an item's selected, but on a held layer only focused. */
	const goTo = (entry: Entry | undefined): boolean => {
		if (entry?.position === undefined) return goToLayer(entry?.layerId);
		if (!held(entry.layerId)) select(entry.layerId, entry.position, false);
		focusItem(entry.layerId, entry.position);
		return true;
	};

	/** The row `by` rows on from a layer's, or with `position` one of its items', reached as a press reaches it. Whether there is one. */
	const step = (layerId: string, position: number | undefined, by: number): boolean => {
		const at = entries.findIndex(
			(entry) => entry.layerId === layerId && entry.position === position
		);
		return at >= 0 && goTo(entries[at + by]);
	};

	/**
	 * The keys on an item's row: the arrows walk the rows, left goes to the
	 * layer's, Alt with an arrow moves the item, and none of them reaches the
	 * canvas, where the move tool would nudge what is selected; Shift F10 opens
	 * the item's menu. Delete and Ctrl or ⌘ A are the canvas's, as on any button
	 * outside it: what is selected deleted, every item of the layer selected.
	 */
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, { layerId, position }: ItemAt) => {
		if (isMenuKey(event)) {
			event.preventDefault();
			openMenu(layerId, position, underButton(event.currentTarget));
			return;
		}
		if (!event.key.startsWith('Arrow')) return;
		event.preventDefault();
		const by = ROW_STEPS[event.key];
		if (event.altKey && by !== undefined) arrange(layerId, position, by);
		if (!plainKey(event)) return;
		if (event.key === 'ArrowLeft') goToLayer(layerId);
		if (by !== undefined) step(layerId, position, by);
	};

	/** The drag a press on the item's row begins: the item, where it is not among what is selected, selected alone. */
	const beginDrag = (layerId: string, position: number) => (): Dragged<ItemsDrag> => {
		const item = elementsIn(layerId)[position];
		const positions = movedWith(layerId, position);
		if (item !== undefined && !selected.has(item)) onSelectElements(layerId, [item]);
		return itemsDragged(document.root, {
			kind: 'items',
			layerId,
			positions,
			pressed: position,
			target: undefined,
		});
	};

	/** A drag of items let go of: moved where it was aimed, if anywhere, and selected there. */
	const drop = ({ layerId, positions, pressed, target }: ItemsDrag) => {
		if (target === undefined) return;
		const moved = moveElements(document.root, layerId, positions, target.place);
		document.execute(moved);
		settle(moved, positions.indexOf(pressed));
	};

	/** What an item's row is given: the layer's `isHeld`, and `under`, the line of a drop of layers under the row. */
	const rowProps = (
		layer: LayerInfo,
		isHeld: boolean,
		item: LayerItem,
		under: LayerItemRowProps['drop'],
		drag: ItemDragView
	): LayerItemRowProps => {
		const at = { layerId: layer.id, position: item.position };
		const begins = isHeld ? undefined : beginDrag(layer.id, item.position);
		const moving = drag.items?.layerId === layer.id ? drag.items.positions : [];
		return {
			document,
			layerId: layer.id,
			item,
			depth: layer.depth,
			selected: selected.has(item.element),
			held: isHeld,
			dragged: moving.includes(item.position),
			drop:
				itemDropOnItem(drag.items?.target, layer.id, item.position, layer.depth + 1) ??
				under,
			onPick: (event) => {
				if (drag.spentClick()) return;
				press(layer.id, item.position, event.shiftKey || choiceKeysOf(event, MAC).toggle);
			},
			onKeyDown: (event) => onKeyDown(event, at),
			onMenu: (point) => openMenu(layer.id, item.position, point),
			pickDrag: begins && drag.handlers(begins, 'pick'),
			gripDrag: begins && drag.handlers(begins, 'grip'),
		};
	};

	return {
		menuAt,
		closeMenu: () => setMenuAt(undefined),
		goToLayer,
		step,
		rowProps,
		drop,
	};
};
