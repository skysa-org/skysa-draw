import { useMemo } from 'react';

import type { MenuItem } from '../components/ui/Menu.js';
import { t } from '../i18n/t.js';
import type { LayerInfo } from './document/model.js';
import { type EditAction, shortcutFor } from './keys.js';
import type { Region, ToolId } from './tools/types.js';

/**
 * The selection's actions (docs/decisions/0004-the-interface.md, "The context
 * menu"): one list, built from what is selected, the active layer and the
 * history, which the canvas's context menu and the options strip's selection
 * bar both show, so the two cannot drift. Each item has its name in the
 * user's words, the key that does the same from the one map (`keys.ts`), and
 * whether it can be done here: an action that cannot is shown disabled rather
 * than hidden, so the menu keeps its shape and says what there is. What each
 * does is the viewport's (`viewport/selectionCommands.ts`), reached by its id,
 * since the viewport holds the selection and the tools' context.
 *
 * Fill… opens the frame's dialog, which asks what the area is filled with
 * and how (`panels/FillDialog.tsx`). The two fills Photoshop does at once
 * from a key, with the fill color and with the stroke color, are actions
 * too, so a key reaches them by id as it reaches the rest, but no list shows
 * them: the menu has Fill…, as Photoshop's Edit menu does.
 */

export const SELECTION_ACTIONS = [
	'deselect',
	'selectInverse',
	'feather',
	'layerViaCopy',
	'layerViaCut',
	'fillDialog',
	'fill',
	'fillWithStroke',
	'clear',
	'crop',
	'delete',
	'selectAll',
	'undo',
	'redo',
	'newLayer',
	'duplicateLayer',
] as const;

export type SelectionActionId = (typeof SELECTION_ACTIONS)[number];

/** The tools that work on a selection: picking one keeps it, and the options strip shows its actions. */
export const SELECTION_TOOLS: ReadonlySet<ToolId> = new Set(['select', 'marquee', 'lasso', 'wand']);

/** What the list is built from. */
export type SelectionFacts = Readonly<{
	/** The area selection, or none. */
	region: Region | undefined;
	/** How many elements are selected on the active layer. */
	elements: number;
	layer: LayerInfo | undefined;
	canUndo: boolean;
	canRedo: boolean;
}>;

/**
 * Which list there is: the elements' where some are selected on a vector
 * layer, which is what the user picked last there, else the area's where there
 * is one, else the one for nothing selected.
 */
export type SelectionMode = 'elements' | 'area' | 'nothing';

export const selectionModeOf = (facts: SelectionFacts): SelectionMode => {
	if (facts.elements > 0 && facts.layer?.kind === 'vector') return 'elements';
	return facts.region === undefined ? 'nothing' : 'area';
};

/** Whether a layer's pixels may be read: a raster layer that is not hidden, locked or not. */
const readable = (layer: LayerInfo | undefined): boolean =>
	layer?.kind === 'raster' && !layer.hidden;

/** Whether a layer's pixels may be changed: a readable one that is not locked. */
const paintable = (layer: LayerInfo | undefined): boolean =>
	readable(layer) && layer?.locked !== true;

/** Whether a layer's elements may be changed. */
const editable = (layer: LayerInfo | undefined): boolean =>
	layer !== undefined && !layer.locked && !layer.hidden;

/**
 * The key each action shares with the map; layer via copy is J, as the
 * layer's duplicate is. Fill… is Shift F5, Photoshop's, and Shift Backspace
 * too; Alt Backspace fills with the fill color and Ctrl or ⌘ Backspace with
 * the stroke color, as Photoshop's fill with the foreground and the
 * background.
 */
const KEYS: Readonly<Partial<Record<SelectionActionId, EditAction>>> = {
	deselect: 'deselect',
	selectInverse: 'selectInverse',
	feather: 'feather',
	layerViaCopy: 'duplicate',
	layerViaCut: 'layerViaCut',
	fillDialog: 'fillDialog',
	fill: 'fillArea',
	fillWithStroke: 'fillAreaStroke',
	clear: 'delete',
	delete: 'delete',
	selectAll: 'selectAll',
	undo: 'undo',
	redo: 'redo',
	newLayer: 'newLayer',
	duplicateLayer: 'duplicate',
};

type Entry = Readonly<{ id: SelectionActionId; enabled: boolean; separatorBefore?: boolean }>;

/**
 * With an area: the area itself, then the pixels it takes to a layer of their
 * own, then what it does to them, then the canvas. Only a raster layer has
 * pixels, and a copy only reads them, which a locked layer allows; crop is to
 * the box around the outline, which an inverted area has none of its own.
 */
const areaEntries = (facts: SelectionFacts, region: Region): readonly Entry[] => {
	const pixels = paintable(facts.layer);
	return [
		{ id: 'deselect', enabled: true },
		{ id: 'selectInverse', enabled: true },
		{ id: 'feather', enabled: true },
		{ id: 'layerViaCopy', enabled: readable(facts.layer), separatorBefore: true },
		{ id: 'layerViaCut', enabled: pixels },
		{ id: 'fillDialog', enabled: pixels, separatorBefore: true },
		{ id: 'clear', enabled: pixels },
		{ id: 'crop', enabled: !region.inverted, separatorBefore: true },
	];
};

/** With elements selected on a vector layer: the selection, a layer of their own, and away with them. */
const elementEntries = (facts: SelectionFacts): readonly Entry[] => {
	const changeable = editable(facts.layer);
	return [
		{ id: 'deselect', enabled: true },
		{ id: 'selectInverse', enabled: true },
		{ id: 'layerViaCopy', enabled: changeable, separatorBefore: true },
		{ id: 'layerViaCut', enabled: changeable },
		{ id: 'delete', enabled: changeable, separatorBefore: true },
	];
};

/** With nothing selected: a way to select, the history, and the layers. */
const nothingEntries = (facts: SelectionFacts): readonly Entry[] => [
	{ id: 'selectAll', enabled: true },
	{ id: 'undo', enabled: facts.canUndo, separatorBefore: true },
	{ id: 'redo', enabled: facts.canRedo },
	{ id: 'newLayer', enabled: true, separatorBefore: true },
	{ id: 'duplicateLayer', enabled: facts.layer !== undefined },
];

const entriesFor = (facts: SelectionFacts): readonly Entry[] => {
	const mode = selectionModeOf(facts);
	if (mode === 'elements') return elementEntries(facts);
	if (mode === 'area' && facts.region !== undefined) return areaEntries(facts, facts.region);
	return nothingEntries(facts);
};

/**
 * The actions for what is selected, as menu items: `run` is told the id of
 * the one chosen. The same list for the context menu and the selection bar.
 */
export const selectionActions = (
	facts: SelectionFacts,
	run: (action: SelectionActionId) => void,
	isMac: boolean
): readonly MenuItem[] =>
	entriesFor(facts).map(({ id, enabled, separatorBefore }) => ({
		id,
		label: t(`selection.actions.${id}`),
		onSelect: () => run(id),
		disabled: !enabled,
		shortcut: shortcutFor(KEYS[id], isMac),
		separatorBefore: separatorBefore === true,
	}));

/**
 * The list as a component holds it: made again only when what it is made of
 * changes, and a hook, so that `run` may reach the viewport through a ref,
 * which it reads only when an item is chosen.
 */
export const useSelectionActions = (
	facts: SelectionFacts,
	run: (action: SelectionActionId) => void,
	isMac: boolean
): readonly MenuItem[] => useMemo(() => selectionActions(facts, run, isMac), [facts, run, isMac]);
