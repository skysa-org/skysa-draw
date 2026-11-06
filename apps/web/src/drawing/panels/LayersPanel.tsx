import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from 'react';

import { Panel } from '../../components/ui/Panel.js';
import { t } from '../../i18n/t.js';
import { canPlaceLayers, placeLayers, removeLayers } from '../document/arrange.js';
import type { DocumentSnapshot, EditorDocument, LayerInfo } from '../document/model.js';
import { selectedLayersIn } from '../editorState.js';
import {
	choiceKeysOf,
	clickSelection,
	everyLayer,
	type LayerSelection,
	stepSelection,
} from '../layerSelection.js';
import { isMac } from '../viewport/pointer.js';
import { LayerActions } from './LayerActions.js';
import { type DropTarget, nextPlace } from './layerDrop.js';
import { LayerProperties } from './LayerProperties.js';
import { type Disclosure, focusPick, LayerRow, type RowDrop } from './LayerRow.js';
import {
	ancestorsOf,
	dropRowsOf,
	groupsInside,
	inOrder,
	type Row,
	rowsUnder,
	shutAncestor,
	topLayerOf,
} from './LayerTree.js';
import { useLayerDrag } from './useLayerDrag.js';

/**
 * The layers panel (docs/ARCHITECTURE.md §3, "Layers"; §7, "The interface"):
 * the layers top first, as every layers panel shows them, each with its eye
 * and its lock, a group's layers under it and a clipped layer marked, and the
 * actions on the layers chosen, the rarer of them in a menu (`LayerMenu`).
 * Every change is a command on the document, so it is undone the same way as
 * a stroke; the panel reads the snapshot the frame gives it and re-renders
 * through it.
 *
 * Layers are chosen with the keys users know (`layerSelection.ts`), over the
 * rows shown: a click chooses one, Ctrl or ⌘ adds or takes out, Shift takes
 * a range, and on a row Shift with an arrow grows the range and Ctrl or ⌘ A
 * chooses every row shown. The chosen are moved up and down, deleted,
 * duplicated and grouped together, and dragged together to another place,
 * into or out of a group (`useLayerDrag`, `layerDrop.ts`); Alt with an arrow
 * moves them as a drag to the next gap would, for the keyboard.
 *
 * A group collapses, as a folder does, by its disclosure or by the arrows
 * across, as in a tree view; which groups are collapsed is the editor's, never
 * the file's, so it survives the panel being put away and never makes the
 * drawing dirty. Collapsing changes nothing that is chosen: the active layer
 * may be inside a collapsed group, as in Photoshop, and a layer chosen there
 * stays chosen through Ctrl, which adds to the rows shown or takes from them.
 *
 * A row is a list item of buttons — the eye, the layer itself, the lock —
 * rather than a listbox's option, whose content a screen reader is not told
 * of: the eye and the lock would be lost in it.
 */

const MAC = isMac();

/** The arrow keys walk the rows as they are shown: down the list is down the drawing. */
const ROW_STEPS: Readonly<Record<string, -1 | 1>> = { ArrowDown: 1, ArrowUp: -1 };

/** What the row at `at` shows of a drop: the line over it, the line under the last row, or itself lit. */
const dropOn = (
	target: DropTarget | undefined,
	row: Row,
	at: number,
	count: number
): RowDrop | undefined => {
	if (target === undefined) return undefined;
	if (target.kind === 'into') return target.id === row.layer.id ? { at: 'into' } : undefined;
	if (target.before === at) return { at: 'before', depth: target.depth };
	return target.before === count && at === count - 1
		? { at: 'after', depth: target.depth }
		: undefined;
};

/** The layer whose row holds the focus, if a row of `list` does. */
const focusedRow = (list: HTMLElement | null): string | undefined => {
	const focused = window.document.activeElement;
	const row = focused === null || list?.contains(focused) !== true ? null : focused.closest('li');
	return row instanceof HTMLElement ? row.dataset.layerId : undefined;
};

export const LayersPanel = ({
	document,
	snapshot,
	activeLayerId,
	selectedLayerIds,
	layerAnchor,
	collapsedGroupIds,
	onActivate,
	onSelectLayers,
	onCollapseGroups,
	withProperties,
	onClose,
	onNotify = () => undefined,
}: Readonly<{
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	activeLayerId: string | undefined;
	/** The layers chosen, top first, the active one among them. */
	selectedLayerIds: readonly string[];
	/** Where a Shift-click's range starts. */
	layerAnchor: string | undefined;
	/** The groups shown collapsed, their layers' rows hidden; the editor's, never the file's. */
	collapsedGroupIds: readonly string[];
	/** One layer made active and chosen alone: a new layer, a group just made. */
	onActivate: (id: string) => void;
	onSelectLayers: (selection: LayerSelection) => void;
	/** The groups to show collapsed from now on, the whole set. */
	onCollapseGroups: (ids: readonly string[]) => void;
	/** The active layer's properties under the list: in the sheet and the drawer, where there is no properties panel. */
	withProperties: boolean;
	onClose?: () => void;
	/** A line to the user, already in their words: why a merge or a clip did nothing. */
	onNotify?: (message: string) => void;
}>) => {
	const [renaming, setRenaming] = useState<string | undefined>(undefined);
	const list = useRef<HTMLUListElement>(null);
	/** The row whose button has the focus back once a change has rendered. */
	const refocus = useRef<string | undefined>(undefined);
	const layers = snapshot.layers;
	const activeIndex = layers.findIndex((layer) => layer.id === activeLayerId);
	const active = layers[activeIndex];
	const collapsed = new Set(collapsedGroupIds);
	const rows = rowsUnder(layers, undefined, collapsed);
	const order = rows.map((row) => row.layer.id);
	const everyId = rowsUnder(layers, undefined).map((row) => row.layer.id);
	const chosen = inOrder(everyId, selectedLayersIn(layers, selectedLayerIds, activeLayerId));
	const current: LayerSelection = {
		active: activeLayerId,
		selected: chosen,
		anchor: layerAnchor,
	};
	const holding = new Set(layers.flatMap((layer) => layer.parentId ?? []));

	useEffect(() => {
		const id = refocus.current;
		refocus.current = undefined;
		focusPick(id);
	});

	/** A row with the focus that `shut` hides in `after` gives it to the group's row that hides it. */
	const keepFocusShown = (after: readonly LayerInfo[], shut: ReadonlySet<string>) => {
		const focused = focusedRow(list.current);
		const hider = focused === undefined ? undefined : shutAncestor(after, focused, shut);
		if (hider !== undefined) refocus.current = hider;
	};

	/** The groups shown collapsed from now on, groups of the drawing alone. */
	const collapse = (ids: readonly string[]) => {
		const shut = new Set(ids);
		keepFocusShown(layers, shut);
		onCollapseGroups(
			layers
				.filter((layer) => layer.kind === 'group' && shut.has(layer.id))
				.map((each) => each.id)
		);
	};

	/** A group opened or shut, and with `deep` every group inside it the same way. */
	const toggleGroup = (id: string, deep: boolean) => {
		const affected = deep ? [id, ...groupsInside(layers, id)] : [id];
		collapse(
			collapsed.has(id)
				? collapsedGroupIds.filter((each) => !affected.includes(each))
				: [...collapsedGroupIds, ...affected]
		);
	};

	/** Groups just made shown expanded, where an id taken before left one collapsed. */
	const showGroups = (ids: readonly string[]) => {
		if (ids.some((id) => collapsed.has(id))) {
			collapse(collapsedGroupIds.filter((each) => !ids.includes(each)));
		}
	};

	/** The same layers chosen, top first again in the order a move left them in. */
	const keepChosen = (ids: readonly string[]) => {
		const after = document.snapshot().layers;
		const top = rowsUnder(after, undefined).map((row) => row.layer.id);
		onSelectLayers({ ...current, selected: inOrder(top, ids) });
		// A drop into a collapsed group hides the row the press gave the focus to.
		keepFocusShown(after, collapsed);
	};

	const drag = useLayerDrag({ document, list, chosen, onActivate, onDropped: keepChosen });
	const dragging = drag.drag;

	/** Alt with an arrow: the chosen, or the row alone, to the next place a drag would take them. */
	const moveByKey = (id: string, step: -1 | 1) => {
		const ids = chosen.includes(id) ? chosen : [id];
		const place = nextPlace(
			dropRowsOf(rows, layers, collapsed),
			ids,
			step < 0 ? 'up' : 'down',
			(each) => canPlaceLayers(document.root, ids, each)
		);
		if (place === undefined) return;
		document.execute(placeLayers(document.root, ids, place));
		refocus.current = id;
		if (chosen.includes(id)) keepChosen(ids);
		else onActivate(id);
	};

	/**
	 * The arrows across, as a tree view's: right opens a collapsed group, and
	 * on an open one goes to its first layer; left shuts an open group, and on
	 * a layer inside a group goes to the group's row, each chosen alone as a
	 * plain arrow up or down chooses. Whether it did anything.
	 */
	const across = (at: number, right: boolean): boolean => {
		const layer = rows[at]?.layer;
		if (layer === undefined) return false;
		const holds = layer.kind === 'group' && holding.has(layer.id);
		const open = holds && !collapsed.has(layer.id);
		const goTo = (id: string | undefined) => {
			if (id === undefined) return false;
			onActivate(id);
			focusPick(id);
			return true;
		};
		if (holds && right !== open) {
			toggleGroup(layer.id, false);
			return true;
		}
		if (right) return open && goTo(rows[at + 1]?.layer.id);
		return goTo(layer.parentId);
	};

	/** Shift with an arrow: the range from the anchor grown or shrunk a row, the focus with it. */
	const growRange = (id: string, step: -1 | 1) => {
		const next = stepSelection({ ...current, active: id }, order, step, true);
		if (next.active === id) return;
		onSelectLayers(next);
		focusPick(next.active);
	};

	/** A plain arrow up or down: the next row shown, chosen alone, with the focus. Whether there is one. */
	const walk = (at: number, step: -1 | 1): boolean => {
		const neighbor = rows[at + step]?.layer.id;
		if (neighbor === undefined) return false;
		onActivate(neighbor);
		focusPick(neighbor);
		return true;
	};

	/** The arrow keys on a row; whether one of them did anything. */
	const arrowKey = (event: KeyboardEvent<HTMLButtonElement>, at: number): boolean => {
		const id = rows[at]?.layer.id;
		if (id === undefined) return false;
		if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
			const plain = !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;
			return plain && across(at, event.key === 'ArrowRight');
		}
		const step = ROW_STEPS[event.key];
		if (step === undefined) return false;
		if (event.altKey) moveByKey(id, step);
		if (!event.altKey && event.shiftKey) growRange(id, step);
		return event.altKey || event.shiftKey || walk(at, step);
	};

	/**
	 * Ctrl or ⌘ A: every row shown, a collapsed group chosen as its row, which
	 * every action takes whole, and an active layer inside one kept active.
	 */
	const chooseAll = () => {
		const hidden = activeLayerId !== undefined && !order.includes(activeLayerId);
		const all = hidden ? inOrder(everyId, [...order, activeLayerId]) : order;
		onSelectLayers(everyLayer(all, activeLayerId));
	};

	/** The keys of a list of layers, on the row that has the focus. */
	const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
		const id = rows[at]?.layer.id;
		if (id === undefined) return;
		if (arrowKey(event, at)) {
			event.preventDefault();
			return;
		}
		const all =
			choiceKeysOf(event, MAC).toggle &&
			!event.shiftKey &&
			!event.altKey &&
			event.key.toLowerCase() === 'a';
		const remove = event.key === 'Delete' || event.key === 'Backspace';
		if (!all && !remove && event.key !== 'F2') return;
		event.preventDefault();
		if (all) chooseAll();
		if (event.key === 'F2') setRenaming(id);
		if (remove) {
			document.execute(removeLayers(document.root, chosen.includes(id) ? chosen : [id]));
		}
	};

	const onPick = (event: MouseEvent<HTMLButtonElement>, id: string) => {
		if (drag.spentClick()) return;
		const keys = choiceKeysOf(event, MAC);
		const next = clickSelection(current, order, id, keys);
		// A click is over the rows shown; what is chosen inside a collapsed
		// group stays chosen through Ctrl, which adds to the choice or takes
		// from it, and goes with a plain click or a Shift range, which replace it.
		const unseen = keys.toggle ? chosen.filter((each) => !order.includes(each)) : [];
		onSelectLayers({ ...next, selected: inOrder(everyId, [...next.selected, ...unseen]) });
	};

	const disclosureOf = ({ layer }: Row): Disclosure => {
		if (layer.kind !== 'group') return 'none';
		const expanded = !collapsed.has(layer.id);
		return {
			expanded,
			onToggle: (deep) => toggleGroup(layer.id, deep),
			topLayer: expanded ? undefined : topLayerOf(layers, layer.id),
		};
	};

	const moving = new Set(
		dragging === undefined
			? []
			: layers
					.filter((layer) =>
						[layer.id, ...ancestorsOf(layers, layer.id)].some((id) =>
							dragging.ids.includes(id)
						)
					)
					.map((layer) => layer.id)
	);

	return (
		<Panel
			title={t('layers.title')}
			actions={
				<LayerActions
					document={document}
					snapshot={snapshot}
					active={active}
					chosen={chosen}
					order={everyId}
					onActivate={onActivate}
					onSelectLayers={onSelectLayers}
					onShowGroups={showGroups}
					onNotify={onNotify}
				/>
			}
			onClose={onClose}
			className="layers-panel"
		>
			<ul
				ref={list}
				className="layer-list"
				aria-label={t('layers.title')}
				data-dragging={dragging === undefined ? undefined : ''}
			>
				{rows.map((row, at) => (
					<LayerRow
						key={row.layer.id}
						document={document}
						row={row}
						isActive={row.layer.id === activeLayerId}
						isChosen={chosen.includes(row.layer.id)}
						sayChosen={chosen.length > 1}
						renaming={renaming === row.layer.id}
						dragged={moving.has(row.layer.id)}
						drop={dropOn(dragging?.target, row, at, rows.length)}
						disclosure={disclosureOf(row)}
						onPick={(event) => onPick(event, row.layer.id)}
						onRename={() => setRenaming(row.layer.id)}
						onRenamed={() => setRenaming(undefined)}
						onKeyDown={(event) => onRowKeyDown(event, at)}
						pickDrag={drag.handlers(row.layer.id, 'pick')}
						gripDrag={drag.handlers(row.layer.id, 'grip')}
					/>
				))}
			</ul>
			{withProperties && active !== undefined && (
				<LayerProperties document={document} layer={active} indexFromBottom={activeIndex} />
			)}
		</Panel>
	);
};
