import {
	Fragment,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';

import { ContextMenu, type MenuPoint } from '../../components/ui/ContextMenu.js';
import type { MenuItem } from '../../components/ui/MenuList.js';
import { Panel } from '../../components/ui/Panel.js';
import { t } from '../../i18n/t.js';
import { canPlaceLayers, placeLayers, removeLayers } from '../document/arrange.js';
import { isLayerHeld } from '../document/elements.js';
import type { DocumentSnapshot, EditorDocument, LayerInfo } from '../document/model.js';
import { selectedLayersIn } from '../editorState.js';
import {
	choiceKeysOf,
	clickSelection,
	everyLayer,
	type LayerSelection,
	stepSelection,
} from '../layerSelection.js';
import type { Observable } from '../viewport/observable.js';
import { isMac } from '../viewport/pointer.js';
import type { ItemsDrag } from './dragItems.js';
import { beginLayerDrag, type LayersDrag } from './dragLayers.js';
import { itemDropOnLayer } from './itemDrop.js';
import { ItemRows } from './ItemRows.js';
import { LayerActions } from './LayerActions.js';
import { type DropTarget, nextPlace } from './layerDrop.js';
import { LayerItemRow } from './LayerItemRow.js';
import { ITEMS_LEAST, useLayerItems } from './layerItems.js';
import { LayerProperties } from './LayerProperties.js';
import {
	type Disclosure,
	focusPick,
	isMenuKey,
	LayerRow,
	plainKey,
	ROW_STEPS,
	type RowDrop,
	underButton,
} from './LayerRow.js';
import {
	ancestorsOf,
	dropRowsOf,
	entriesOf,
	groupsInside,
	inOrder,
	type Row,
	rowsUnder,
	shutAncestor,
	topLayerOf,
} from './LayerTree.js';
import { useItemRows } from './useItemRows.js';
import { useLayerDrag } from './useLayerDrag.js';

/**
 * The layers panel (docs/ARCHITECTURE.md §3, "Layers"; §7, "The interface"):
 * the layers top first, as every layers panel shows them, each with its eye
 * and its lock, a group's layers under it and a clipped layer marked, and the
 * actions on the layers chosen, the rarer of them in a menu (`layerMenu.ts`).
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
 * A vector layer of two or more items expands the same way, by its preview,
 * a row for each of its items under it (`LayerItemRow`, `layerItems.ts`),
 * and starts collapsed, the other way round from a group, so a layer of 300
 * strokes does not flood the panel; which are expanded is the editor's too. A
 * press on an item's row selects it on the canvas, as Illustrator's panel
 * does: its layer made active and chosen alone, the move tool taken up
 * unless a tool that selects is in hand, and the item selected alone, or
 * with Shift, Ctrl or ⌘ added to what is selected on the layer or taken out
 * of it (`onSelectElements`). An item's row is tinted while its element is
 * selected, whatever selected it, the canvas, a marquee or the panel. Its
 * menu is the selection's actions (`elementActions`), and it is dragged, or
 * moved a step with Alt and an arrow, among its layer's elements or into
 * another vector layer; a held layer's items are shown and walked, but out of
 * reach of all of it (`useItemRows`).
 *
 * The arrows up and down walk every row shown, the items' too, choosing each
 * as a press does; right opens a collapsed group or vector layer and on an
 * open one goes to its first row, and left shuts it, and on a layer inside a
 * group or an item goes to the group's or the layer's row, as a tree view's.
 *
 * A row is a list item of buttons — the eye, the layer itself, the lock —
 * rather than a listbox's option, whose content a screen reader is not told
 * of: the eye and the lock would be lost in it.
 */

const MAC = isMac();

/** What the panel's one drag moves: layers, or a vector layer's items. */
type PanelDrag = LayersDrag | ItemsDrag;

/** The depth of the line under the last row, where the drop is there: under the last layer, or its items. */
const dropUnderAll = (
	target: DropTarget | undefined,
	at: number,
	count: number
): number | undefined =>
	target?.kind === 'gap' && target.before === count && at === count - 1
		? target.depth
		: undefined;

/**
 * What the row at `at` shows of a drop: the line over it, the line under the
 * last row unless its items' rows are under it, or itself lit.
 */
const dropOn = (
	target: DropTarget | undefined,
	row: Row,
	at: number,
	count: number,
	withItems: boolean
): RowDrop | undefined => {
	if (target === undefined) return undefined;
	if (target.kind === 'into') return target.id === row.layer.id ? { at: 'into' } : undefined;
	if (target.before === at) return { at: 'before', depth: target.depth };
	const under = withItems ? undefined : dropUnderAll(target, at, count);
	return under === undefined ? undefined : { at: 'after', depth: under };
};

/** The layer whose row, or one of whose items' rows, holds the focus, if a row of `list` does. */
const focusedRow = (list: HTMLElement | null): string | undefined => {
	const focused = window.document.activeElement;
	const row = focused === null || list?.contains(focused) !== true ? null : focused.closest('li');
	return row instanceof HTMLElement ? (row.dataset.layerId ?? row.dataset.itemOf) : undefined;
};

export const LayersPanel = ({
	document,
	snapshot,
	activeLayerId,
	selectedLayerIds,
	layerAnchor,
	collapsedGroupIds,
	expandedLayerIds,
	selectedElements,
	onActivate,
	onSelectLayers,
	onCollapseGroups,
	onExpandLayers,
	onSelectElements,
	elementActions,
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
	/** The vector layers shown expanded, a row for each of their items; the editor's, never the file's. */
	expandedLayerIds: readonly string[];
	/** The elements selected on the canvas, which the items' rows show (`ViewportSelection.elements`). */
	selectedElements: Observable<readonly Element[]>;
	/** One layer made active and chosen alone: a new layer, a group just made. */
	onActivate: (id: string) => void;
	onSelectLayers: (selection: LayerSelection) => void;
	/** The groups to show collapsed from now on, the whole set. */
	onCollapseGroups: (ids: readonly string[]) => void;
	/** The vector layers to show expanded from now on, the whole set. */
	onExpandLayers: (ids: readonly string[]) => void;
	/**
	 * Elements of the layer `layerId` selected from its items' rows, the whole
	 * selection, in paint order: the layer made active and chosen alone, and a
	 * tool that selects taken up where none is in hand.
	 */
	onSelectElements: (layerId: string, elements: readonly Element[]) => void;
	/** The selection's actions, the list the canvas's menu shows: an item's menu, once a press on it selected it. */
	elementActions: readonly MenuItem[];
	/** The active layer's properties under the list: in the sheet and the drawer, where there is no properties panel. */
	withProperties: boolean;
	onClose?: () => void;
	/** A line to the user, already in their words: why a merge or a clip did nothing, or an item was not selected. */
	onNotify?: (message: string) => void;
}>) => {
	const [renaming, setRenaming] = useState<string | undefined>(undefined);
	/** Where the layer actions menu is open over a row, or none. */
	const [menuAt, setMenuAt] = useState<MenuPoint | undefined>(undefined);
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
	const expanded = new Set(expandedLayerIds);
	const items = useLayerItems(document, snapshot, expandedLayerIds);
	const entries = entriesOf(rows, items.shownOf);
	const selection = useSyncExternalStore(selectedElements.subscribe, selectedElements.get);
	const itemRows = useItemRows({
		document,
		layers,
		entries,
		selection,
		onActivate,
		onSelectElements,
		onNotify,
	});
	/** Whether the layer is a vector layer of enough items to show them. */
	const expandable = (layer: LayerInfo): boolean =>
		layer.kind === 'vector' && items.countOf(layer.id) >= ITEMS_LEAST;

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

	/** A vector layer's items shown, or hidden, from now on: of the drawing's vector layers alone. */
	const toggleItems = (id: string) => {
		const vector = new Set(
			layers.filter((layer) => layer.kind === 'vector').map((layer) => layer.id)
		);
		const kept = expandedLayerIds.filter((each) => each !== id && vector.has(each));
		onExpandLayers(expanded.has(id) ? kept : [...kept, id]);
	};

	/** Groups just made shown expanded, where an id taken before left one collapsed. */
	const showGroups = (ids: readonly string[]) => {
		if (ids.some((id) => collapsed.has(id))) {
			collapse(collapsedGroupIds.filter((each) => !ids.includes(each)));
		}
	};

	/**
	 * The layer actions menu over a row, for the layers chosen: the row's among
	 * them, or the row's alone where it was not, as a file manager does it.
	 */
	const openMenu = (id: string, at: MenuPoint) => {
		if (!chosen.includes(id)) onActivate(id);
		setMenuAt(at);
	};

	/** The same layers chosen, top first again in the order a move left them in. */
	const keepChosen = (ids: readonly string[]) => {
		const after = document.snapshot().layers;
		const top = rowsUnder(after, undefined).map((row) => row.layer.id);
		onSelectLayers({ ...current, selected: inOrder(top, ids) });
		// A drop into a collapsed group hides the row the press gave the focus to.
		keepFocusShown(after, collapsed);
	};

	/** A drag let go of: the layers or the items put where it was aimed, if anywhere. */
	const onDrop = (shown: PanelDrag) => {
		if (shown.kind === 'items') {
			itemRows.drop(shown);
			return;
		}
		if (shown.target === undefined) return;
		document.execute(placeLayers(document.root, shown.ids, shown.target.place));
		keepChosen(shown.ids);
	};

	const drag = useLayerDrag<PanelDrag>({ list, onDrop });
	const dragging = drag.drag;
	const layersDrag = dragging?.kind === 'layers' ? dragging : undefined;
	const itemDrag = {
		items: dragging?.kind === 'items' ? dragging : undefined,
		handlers: drag.handlers,
		spentClick: drag.spentClick,
	};
	const layerDrag = beginLayerDrag(document.root, chosen, onActivate);

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
	 * The arrows across, as a tree view's: right opens a collapsed group or an
	 * expandable vector layer, and on an open one goes to its first row; left
	 * shuts an open one, and on a layer inside a group goes to the group's
	 * row, each chosen as a plain arrow up or down chooses. Whether it did
	 * anything.
	 */
	const across = (at: number, right: boolean): boolean => {
		const layer = rows[at]?.layer;
		if (layer === undefined) return false;
		const group = layer.kind === 'group';
		const holds = group ? holding.has(layer.id) : expandable(layer);
		const open = holds && (group ? !collapsed.has(layer.id) : expanded.has(layer.id));
		if (holds && right !== open) {
			if (group) toggleGroup(layer.id, false);
			else toggleItems(layer.id);
			return true;
		}
		if (right) return open && itemRows.step(layer.id, undefined, 1);
		return itemRows.goToLayer(layer.parentId);
	};

	/** Shift with an arrow: the range from the anchor grown or shrunk a row, the focus with it. */
	const growRange = (id: string, step: -1 | 1) => {
		const next = stepSelection({ ...current, active: id }, order, step, true);
		if (next.active === id) return;
		onSelectLayers(next);
		focusPick(next.active);
	};

	/** A plain arrow up or down: the next row shown, an item's too, chosen alone, with the focus. Whether there is one. */
	const walk = (at: number, step: -1 | 1): boolean => {
		const id = rows[at]?.layer.id;
		return id !== undefined && itemRows.step(id, undefined, step);
	};

	/** The arrow keys on a row; whether one of them did anything. */
	const arrowKey = (event: KeyboardEvent<HTMLButtonElement>, at: number): boolean => {
		const id = rows[at]?.layer.id;
		if (id === undefined) return false;
		if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
			return plainKey(event) && across(at, event.key === 'ArrowRight');
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
		if (isMenuKey(event)) {
			event.preventDefault();
			openMenu(id, underButton(event.currentTarget));
			return;
		}
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
		if (expandable(layer)) {
			return {
				expanded: expanded.has(layer.id),
				onToggle: () => toggleItems(layer.id),
				topLayer: undefined,
			};
		}
		if (layer.kind !== 'group') return 'none';
		if (!holding.has(layer.id)) return 'empty';
		const open = !collapsed.has(layer.id);
		return {
			expanded: open,
			onToggle: (deep) => toggleGroup(layer.id, deep),
			topLayer: open ? undefined : topLayerOf(layers, layer.id),
		};
	};

	const moving = new Set(
		layersDrag === undefined
			? []
			: layers
					.filter((layer) =>
						[layer.id, ...ancestorsOf(layers, layer.id)].some((id) =>
							layersDrag.ids.includes(id)
						)
					)
					.map((layer) => layer.id)
	);

	/** The line of a drop of layers under the last of the layer's items' rows, where a drag of layers is aimed there. */
	const underAll = (at: number) => {
		const depth = dropUnderAll(layersDrag?.target, at, rows.length);
		return depth === undefined ? undefined : ({ at: 'after', depth } as const);
	};

	/** What a layer's row shows of the drag: of layers, a line or itself lit; of items, itself lit for on top of its elements. */
	const rowDrop = (row: Row, at: number, withItems: boolean): RowDrop | undefined =>
		dragging?.kind === 'items'
			? itemDropOnLayer(dragging.target, row.layer.id)
			: dropOn(layersDrag?.target, row, at, rows.length, withItems);

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
					menuAt={menuAt}
					onMenuClosed={() => setMenuAt(undefined)}
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
				{rows.map((row, at) => {
					const { layer } = row;
					const shown = items.shownOf(layer.id);
					const held = layer.kind === 'vector' && isLayerHeld(document.root, layer.id);
					const takesItems = layer.kind === 'vector' && !layer.loose && !held;
					return (
						<Fragment key={layer.id}>
							<LayerRow
								document={document}
								row={row}
								isActive={layer.id === activeLayerId}
								isChosen={chosen.includes(layer.id)}
								sayChosen={chosen.length > 1}
								renaming={renaming === layer.id}
								dragged={moving.has(layer.id)}
								drop={rowDrop(row, at, shown.length > 0)}
								disclosure={disclosureOf(row)}
								elementCount={takesItems ? items.countOf(layer.id) : undefined}
								onPick={(event) => onPick(event, layer.id)}
								onRename={() => setRenaming(layer.id)}
								onRenamed={() => setRenaming(undefined)}
								onKeyDown={(event) => onRowKeyDown(event, at)}
								onMenu={(point) => openMenu(layer.id, point)}
								pickDrag={drag.handlers(layerDrag(layer.id), 'pick')}
								gripDrag={drag.handlers(layerDrag(layer.id), 'grip')}
							/>
							<ItemRows
								layerId={layer.id}
								items={shown}
								kept={
									itemDrag.items?.layerId === layer.id
										? [itemDrag.items.pressed]
										: []
								}
								under={underAll(at)}
								row={(item, under) => (
									<LayerItemRow
										key={item.position}
										{...itemRows.rowProps(layer, held, item, under, itemDrag)}
									/>
								)}
							/>
						</Fragment>
					);
				})}
			</ul>
			<ContextMenu
				label={t('layers.items.actions')}
				items={elementActions}
				at={itemRows.menuAt}
				onClose={itemRows.closeMenu}
			/>
			{withProperties && active !== undefined && (
				<LayerProperties document={document} layer={active} indexFromBottom={activeIndex} />
			)}
		</Panel>
	);
};
