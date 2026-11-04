import { describe, expect, it, vi } from 'vitest';

import type { LayerInfo } from '../../src/drawing/document/model.js';
import {
	SELECTION_ACTIONS,
	type SelectionActionId,
	selectionActions,
	type SelectionFacts,
	selectionModeOf,
} from '../../src/drawing/selectionActions.js';
import type { Region } from '../../src/drawing/tools/types.js';
import { messageAt, t } from '../../src/i18n/t.js';

/**
 * The selection's actions (docs/decisions/0004-the-interface.md, "The context
 * menu"): the one list the context menu and the selection bar both show, by
 * what is selected, the active layer and the history.
 */

const layer = (overrides: Partial<LayerInfo> = {}): LayerInfo => ({
	id: 'layer-1',
	kind: 'raster',
	name: undefined,
	hidden: false,
	locked: false,
	opacity: 1,
	blend: 'normal',
	depth: 0,
	parentId: undefined,
	loose: false,
	...overrides,
});

const AREA: Region = { path: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', inverted: false, feather: 0 };

const facts = (overrides: Partial<SelectionFacts> = {}): SelectionFacts => ({
	region: undefined,
	elements: 0,
	layer: layer(),
	canUndo: true,
	canRedo: true,
	...overrides,
});

const items = (given: SelectionFacts, isMac = false) => selectionActions(given, vi.fn(), isMac);

const ids = (given: SelectionFacts) => items(given).map((item) => item.id);

const enabled = (given: SelectionFacts) =>
	items(given)
		.filter((item) => item.disabled !== true)
		.map((item) => item.id);

/** The ids with a rule before them: where each group after the first begins. */
const groups = (given: SelectionFacts) =>
	items(given)
		.filter((item) => item.separatorBefore === true)
		.map((item) => item.id);

describe('the selection’s actions', () => {
	it('names every action in the catalog', () => {
		SELECTION_ACTIONS.forEach((id) => {
			expect(messageAt(`selection.actions.${id}`)).not.toBe(`selection.actions.${id}`);
		});
	});

	it('with an area: the area, a layer of its own, its pixels, the canvas', () => {
		const given = facts({ region: AREA });
		expect(selectionModeOf(given)).toBe('area');
		expect(ids(given)).toEqual([
			'deselect',
			'selectInverse',
			'feather',
			'layerViaCopy',
			'layerViaCut',
			'fillDialog',
			'clear',
			'crop',
		]);
		expect(groups(given)).toEqual(['layerViaCopy', 'fillDialog', 'crop']);
		expect(enabled(given)).toEqual(ids(given));
		expect(items(given).map((item) => item.label)).toEqual([
			'Deselect',
			'Select inverse',
			'Feather…',
			'Layer via copy',
			'Layer via cut',
			'Fill…',
			'Clear',
			'Crop to selection',
		]);
	});

	it('reaches the two fills a key does at once by id, and lists neither', () => {
		expect(SELECTION_ACTIONS).toContain('fill');
		expect(SELECTION_ACTIONS).toContain('fillWithStroke');
		[
			facts({ region: AREA }),
			facts({ elements: 2, layer: layer({ kind: 'vector' }) }),
			facts(),
		].forEach((given) => {
			expect(ids(given)).not.toContain('fill');
			expect(ids(given)).not.toContain('fillWithStroke');
		});
		expect(t('selection.actions.fill')).toBe('Fill with the fill color');
		expect(t('selection.actions.fillWithStroke')).toBe('Fill with the stroke color');
	});

	it.each([
		['a vector layer', layer({ kind: 'vector' })],
		['a hidden layer', layer({ hidden: true })],
		['no layer', undefined],
	])('shows the pixels’ actions disabled, not hidden, on %s', (_name, active) => {
		const given = facts({ region: AREA, layer: active });
		expect(ids(given)).toHaveLength(8);
		expect(enabled(given)).toEqual(['deselect', 'selectInverse', 'feather', 'crop']);
	});

	it('copies from a locked raster layer, which only reads it, and changes nothing there', () => {
		const given = facts({ region: AREA, layer: layer({ locked: true }) });
		expect(enabled(given)).toEqual([
			'deselect',
			'selectInverse',
			'feather',
			'layerViaCopy',
			'crop',
		]);
	});

	it('does not crop to an inverted area, which has no box of its own', () => {
		expect(enabled(facts({ region: { ...AREA, inverted: true } }))).not.toContain('crop');
	});

	it('with elements selected on a vector layer: the selection, a layer of their own, delete', () => {
		const given = facts({ elements: 2, layer: layer({ kind: 'vector' }), region: AREA });
		expect(selectionModeOf(given)).toBe('elements');
		expect(ids(given)).toEqual([
			'deselect',
			'selectInverse',
			'layerViaCopy',
			'layerViaCut',
			'delete',
		]);
		expect(groups(given)).toEqual(['layerViaCopy', 'delete']);
		expect(enabled(given)).toEqual(ids(given));
		const locked = facts({ elements: 2, layer: layer({ kind: 'vector', locked: true }) });
		expect(enabled(locked)).toEqual(['deselect', 'selectInverse']);
	});

	it('with nothing selected: select all, the history, the layers', () => {
		const given = facts();
		expect(selectionModeOf(given)).toBe('nothing');
		expect(ids(given)).toEqual(['selectAll', 'undo', 'redo', 'newLayer', 'duplicateLayer']);
		expect(groups(given)).toEqual(['undo', 'newLayer']);
		expect(enabled(given)).toEqual(ids(given));
		expect(enabled(facts({ canUndo: false, canRedo: false, layer: undefined }))).toEqual([
			'selectAll',
			'newLayer',
		]);
		// Elements are only a vector layer's to hold.
		expect(selectionModeOf(facts({ elements: 1 }))).toBe('nothing');
	});

	it('shows the key each does from the one map, as the platform writes it', () => {
		const shortcuts = (given: SelectionFacts, isMac: boolean) =>
			Object.fromEntries(items(given, isMac).map((item) => [item.id, item.shortcut]));
		expect(shortcuts(facts({ region: AREA }), false)).toEqual({
			deselect: 'Ctrl+D',
			selectInverse: 'Ctrl+Shift+I',
			feather: 'Shift+F6',
			layerViaCopy: 'Ctrl+J',
			layerViaCut: 'Ctrl+Shift+J',
			fillDialog: 'Shift+F5',
			clear: 'Delete',
			crop: undefined,
		});
		expect(shortcuts(facts({ region: AREA }), true)).toMatchObject({ fillDialog: '⇧F5' });
		expect(shortcuts(facts(), true)).toEqual({
			selectAll: '⌘A',
			undo: '⌘Z',
			redo: '⇧⌘Z',
			newLayer: undefined,
			duplicateLayer: '⌘J',
		});
	});

	it('tells `run` which was chosen', () => {
		const run = vi.fn<(action: SelectionActionId) => void>();
		selectionActions(facts({ region: AREA }), run, false)
			.find((item) => item.id === 'feather')
			?.onSelect();
		expect(run).toHaveBeenCalledWith('feather');
		expect(t('selection.menu')).toBe('Canvas actions');
	});
});
