import { describe, expect, it } from 'vitest';

import type { LayerInfo } from '../../src/drawing/document/model.js';
import {
	activeLayerIn,
	type EditorAction,
	editorReducer,
	initialEditorState,
	RECENT_COLORS_MAX,
	selectedLayersIn,
	setOption,
	SIZE_MAX,
	SIZE_MIN,
	steppedSize,
} from '../../src/drawing/editorState.js';
import { DEFAULT_TOOL_OPTIONS } from '../../src/drawing/tools/types.js';

/** The frame's state after each of `actions`, in order. */
const after = (...actions: EditorAction[]) => actions.reduce(editorReducer, initialEditorState);

const layer = (id: string, kind: LayerInfo['kind'] = 'vector'): LayerInfo => ({
	id,
	kind,
	name: undefined,
	hidden: false,
	locked: false,
	opacity: 1,
	blend: 'normal',
	depth: 0,
	parentId: undefined,
	loose: false,
});

describe('the editor state', () => {
	it('starts with the select tool, the default options and nothing open', () => {
		expect(initialEditorState.toolId).toBe('select');
		expect(initialEditorState.panel).toBeUndefined();
		expect(initialEditorState.dockOpen).toBeUndefined();
		expect(initialEditorState.libraryOpen).toBe(false);
		expect(initialEditorState.recentColors).toEqual([]);
	});

	it('sets a tool and an option', () => {
		const state = after(
			{ type: 'setTool', toolId: 'brush' },
			{ type: 'setOption', key: 'size', value: 12 },
			{ type: 'setOption', key: 'pressure', value: false }
		);
		expect(state.toolId).toBe('brush');
		expect(state.options.size).toBe(12);
		expect(state.options.pressure).toBe(false);
	});

	it('makes the same option action from a key held as a type parameter', () => {
		expect(setOption('size', 12)).toEqual({ type: 'setOption', key: 'size', value: 12 });
		expect(after(setOption('constrain', true)).options.constrain).toBe(true);
	});

	it('writes a color into the options, and remembers it once, newest first', () => {
		const state = after(
			{ type: 'setColor', which: 'fill', value: '#ff0000' },
			{ type: 'setColor', which: 'stroke', value: '#00ff00' },
			{ type: 'setColor', which: 'fill', value: '#ff0000' }
		);
		expect(state.options.fill).toBe('#ff0000');
		expect(state.options.stroke).toBe('#00ff00');
		expect(state.recentColors).toEqual(['#ff0000', '#00ff00']);
	});

	it('does not remember none as a color, though it sets it', () => {
		const state = after({ type: 'setColor', which: 'stroke', value: 'none' });
		expect(state.options.stroke).toBe('none');
		expect(state.recentColors).toEqual([]);
	});

	it('remembers a color by its #rrggbb, so the forms of one color are one swatch', () => {
		const state = after(
			{ type: 'setColor', which: 'fill', value: '#F00' },
			{ type: 'setColor', which: 'fill', value: 'red' },
			{ type: 'setColor', which: 'stroke', value: 'rgb(0, 0, 255)' }
		);
		expect(state.options.fill).toBe('red');
		expect(state.recentColors).toEqual(['#0000ff', '#ff0000']);
	});

	it('remembers a color set as an option too, and nothing for any other option', () => {
		const state = after(
			{ type: 'setOption', key: 'fill', value: '#123456' },
			{ type: 'setOption', key: 'stroke', value: 'none' },
			{ type: 'setOption', key: 'size', value: 3 }
		);
		expect(state.recentColors).toEqual(['#123456']);
	});

	it(`remembers at most ${RECENT_COLORS_MAX} colors`, () => {
		const picks: EditorAction[] = Array.from({ length: RECENT_COLORS_MAX + 3 }, (_, i) => ({
			type: 'setColor',
			which: 'fill',
			value: `#${String(i).padStart(6, '0')}`,
		}));
		const state = after(...picks);
		expect(state.recentColors).toHaveLength(RECENT_COLORS_MAX);
		expect(state.recentColors[0]).toBe(`#${String(RECENT_COLORS_MAX + 2).padStart(6, '0')}`);
	});

	it('swaps the two colors', () => {
		const state = after(
			{ type: 'setColor', which: 'fill', value: '#111111' },
			{ type: 'setColor', which: 'stroke', value: 'none' },
			{ type: 'swapColors' }
		);
		expect(state.options.fill).toBe('none');
		expect(state.options.stroke).toBe('#111111');
	});

	it('turns Snap off where it is on, on by default, and on again', () => {
		expect(initialEditorState.options.snap).toBe(true);
		const off = after({ type: 'toggleSnap' });
		expect(off.options.snap).toBe(false);
		expect(editorReducer(off, { type: 'toggleSnap' }).options.snap).toBe(true);
		// Nothing else of the options moves with it.
		expect({ ...off.options, snap: true }).toEqual(initialEditorState.options);
	});

	it('scales the size by steps and keeps it between the limits', () => {
		expect(after({ type: 'adjustSize', steps: 1 }).options.size).toBe(10);
		expect(after({ type: 'adjustSize', steps: -1 }).options.size).toBe(6);
		expect(
			after(
				{ type: 'setOption', key: 'size', value: SIZE_MAX },
				{ type: 'adjustSize', steps: 3 }
			).options.size
		).toBe(SIZE_MAX);
		expect(
			after(
				{ type: 'setOption', key: 'size', value: SIZE_MIN },
				{ type: 'adjustSize', steps: -3 }
			).options.size
		).toBe(SIZE_MIN);
	});

	it('moves a small size by at least one, so a step is never swallowed by rounding', () => {
		expect(steppedSize(1, 1)).toBe(2);
		expect(steppedSize(2, -1)).toBe(1);
		expect(steppedSize(100, 1)).toBe(125);
	});

	it('toggles a panel: opens it, closes it when asked again, swaps it for another, and closes any', () => {
		expect(after({ type: 'togglePanel', panel: 'layers' }).panel).toBe('layers');
		expect(
			after(
				{ type: 'togglePanel', panel: 'layers' },
				{ type: 'togglePanel', panel: 'layers' }
			).panel
		).toBeUndefined();
		expect(
			after({ type: 'togglePanel', panel: 'layers' }, { type: 'togglePanel', panel: 'color' })
				.panel
		).toBe('color');
		expect(
			after({ type: 'togglePanel', panel: 'color' }, { type: 'closePanel' }).panel
		).toBeUndefined();
	});

	it('opens the color panel from the tool bar’s colors and closes it on the next press, the colors as they were', () => {
		const opened = after(
			{ type: 'setColor', which: 'fill', value: '#ff0000' },
			{ type: 'togglePanel', panel: 'color' }
		);
		expect(opened.panel).toBe('color');
		expect(opened.options.fill).toBe('#ff0000');
		const closed = editorReducer(opened, { type: 'togglePanel', panel: 'color' });
		expect(closed.panel).toBeUndefined();
		expect(closed.options).toBe(opened.options);
		// The panel is not opened on either color: there is no color it remembers being opened on.
		expect(Object.keys(initialEditorState)).not.toContain('colorSlot');
	});

	it('puts back the default colors, which is no color picked', () => {
		const state = after(
			{ type: 'setColor', which: 'fill', value: '#ff0000' },
			{ type: 'setColor', which: 'stroke', value: '#00ff00' },
			{ type: 'resetColors' }
		);
		expect(state.options.fill).toBe(DEFAULT_TOOL_OPTIONS.fill);
		expect(state.options.stroke).toBe(DEFAULT_TOOL_OPTIONS.stroke);
		expect(state.recentColors).toEqual(['#00ff00', '#ff0000']);
	});

	it('keeps the dock as the layers button left it', () => {
		expect(after({ type: 'setDockOpen', open: false }).dockOpen).toBe(false);
		expect(
			after({ type: 'setDockOpen', open: false }, { type: 'setDockOpen', open: true })
				.dockOpen
		).toBe(true);
	});

	it('opens and closes the library, and sets the active layer', () => {
		expect(after({ type: 'setLibraryOpen', open: true }).libraryOpen).toBe(true);
		expect(
			after({ type: 'setLibraryOpen', open: true }, { type: 'setLibraryOpen', open: false })
				.libraryOpen
		).toBe(false);
		expect(after({ type: 'setActiveLayer', id: 'layer-2' }).activeLayerId).toBe('layer-2');
	});

	it('notes a notice, anew each time it is said, and clears it', () => {
		const once = after({ type: 'notify', message: 'Locked.' });
		expect(once.notice?.message).toBe('Locked.');
		// The same words again are a new notice, so the frame's timer starts again.
		expect(editorReducer(once, { type: 'notify', message: 'Locked.' }).notice).not.toBe(
			once.notice
		);
		expect(editorReducer(once, { type: 'clearNotice' }).notice).toBeUndefined();
	});
});

describe('activeLayerIn', () => {
	const layers = [layer('layer-1'), layer('layer-2', 'raster'), layer('layer-3', 'group')];

	it('keeps the chosen layer while the document has it', () => {
		expect(activeLayerIn(layers, 'layer-1')).toBe('layer-1');
	});

	it('falls back to the topmost layer that can be drawn on', () => {
		expect(activeLayerIn(layers, undefined)).toBe('layer-2');
		expect(activeLayerIn(layers, 'gone')).toBe('layer-2');
	});

	it('takes the topmost layer of all when every layer is a group, and nothing when there are none', () => {
		expect(activeLayerIn([layer('layer-1', 'group')], undefined)).toBe('layer-1');
		expect(activeLayerIn([], 'layer-1')).toBeUndefined();
	});
});

describe('the layers chosen', () => {
	it('is the active layer alone after it is set, and what the panel chose after a choice', () => {
		const chosen = after({
			type: 'selectLayers',
			selection: { active: 'b', selected: ['c', 'b', 'a'], anchor: 'a' },
		});
		expect(chosen.activeLayerId).toBe('b');
		expect(chosen.selectedLayerIds).toEqual(['c', 'b', 'a']);
		expect(chosen.layerAnchor).toBe('a');
		const one = editorReducer(chosen, { type: 'setActiveLayer', id: 'c' });
		expect(one.selectedLayerIds).toEqual(['c']);
		expect(one.layerAnchor).toBe('c');
		expect(
			editorReducer(chosen, { type: 'setActiveLayer', id: undefined }).selectedLayerIds
		).toEqual([]);
	});

	it('holds the groups shown collapsed, the whole set at a time', () => {
		const collapsed = after({ type: 'setCollapsedGroups', ids: ['layer-4', 'layer-7'] });
		expect(collapsed.collapsedGroupIds).toEqual(['layer-4', 'layer-7']);
		expect(
			editorReducer(collapsed, { type: 'setCollapsedGroups', ids: [] }).collapsedGroupIds
		).toEqual([]);
		expect(initialEditorState.collapsedGroupIds).toEqual([]);
	});

	it('holds the vector layers shown expanded, none to begin with, the whole set at a time', () => {
		expect(initialEditorState.expandedLayerIds).toEqual([]);
		const expanded = after({ type: 'setExpandedLayers', ids: ['layer-2', 'layer-5'] });
		expect(expanded.expandedLayerIds).toEqual(['layer-2', 'layer-5']);
		expect(
			editorReducer(expanded, { type: 'setExpandedLayers', ids: [] }).expandedLayerIds
		).toEqual([]);
		// Neither changes the other.
		expect(expanded.collapsedGroupIds).toEqual([]);
	});

	it('makes the layer of elements selected from the panel active alone, with the move tool unless a tool that selects is in hand', () => {
		const chosen = after(
			{ type: 'setTool', toolId: 'brush' },
			{ type: 'selectLayers', selection: { active: 'b', selected: ['c', 'b'], anchor: 'c' } }
		);
		const picked = editorReducer(chosen, { type: 'selectInLayer', id: 'a' });
		expect(picked.activeLayerId).toBe('a');
		expect(picked.selectedLayerIds).toEqual(['a']);
		expect(picked.layerAnchor).toBe('a');
		expect(picked.toolId).toBe('select');
		expect(
			editorReducer({ ...chosen, toolId: 'lasso' }, { type: 'selectInLayer', id: 'a' }).toolId
		).toBe('lasso');
		expect(
			editorReducer({ ...chosen, toolId: 'wand' }, { type: 'selectInLayer', id: 'a' }).toolId
		).toBe('wand');
	});

	it('keeps only layers the document has, and always the active one', () => {
		const layers = [layer('a'), layer('b'), layer('c')];
		expect(selectedLayersIn(layers, ['c', 'gone', 'a'], 'a')).toEqual(['c', 'a']);
		// The active layer fell back to one not chosen: that one alone.
		expect(selectedLayersIn(layers, ['gone'], 'c')).toEqual(['c']);
		expect(selectedLayersIn(layers, ['a', 'b'], 'c')).toEqual(['c']);
		expect(selectedLayersIn([], ['a'], undefined)).toEqual([]);
	});
});
