import { describe, expect, it } from 'vitest';

import type { LayerInfo } from '../../src/drawing/document/model.js';
import {
	activeLayerIn,
	type EditorAction,
	editorReducer,
	initialEditorState,
	RECENT_COLOURS_MAX,
	setOption,
	SIZE_MAX,
	SIZE_MIN,
	steppedSize,
} from '../../src/drawing/editorState.js';

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
		expect(initialEditorState.recentColours).toEqual([]);
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

	it('writes a colour into the options, and remembers it once, newest first', () => {
		const state = after(
			{ type: 'setColour', which: 'fill', value: '#ff0000' },
			{ type: 'setColour', which: 'stroke', value: '#00ff00' },
			{ type: 'setColour', which: 'fill', value: '#ff0000' }
		);
		expect(state.options.fill).toBe('#ff0000');
		expect(state.options.stroke).toBe('#00ff00');
		expect(state.recentColours).toEqual(['#ff0000', '#00ff00']);
	});

	it('does not remember none as a colour, though it sets it', () => {
		const state = after({ type: 'setColour', which: 'stroke', value: 'none' });
		expect(state.options.stroke).toBe('none');
		expect(state.recentColours).toEqual([]);
	});

	it('remembers a colour by its #rrggbb, so the forms of one colour are one swatch', () => {
		const state = after(
			{ type: 'setColour', which: 'fill', value: '#F00' },
			{ type: 'setColour', which: 'fill', value: 'red' },
			{ type: 'setColour', which: 'stroke', value: 'rgb(0, 0, 255)' }
		);
		expect(state.options.fill).toBe('red');
		expect(state.recentColours).toEqual(['#0000ff', '#ff0000']);
	});

	it('remembers a colour set as an option too, and nothing for any other option', () => {
		const state = after(
			{ type: 'setOption', key: 'fill', value: '#123456' },
			{ type: 'setOption', key: 'stroke', value: 'none' },
			{ type: 'setOption', key: 'size', value: 3 }
		);
		expect(state.recentColours).toEqual(['#123456']);
	});

	it(`remembers at most ${RECENT_COLOURS_MAX} colours`, () => {
		const picks: EditorAction[] = Array.from({ length: RECENT_COLOURS_MAX + 3 }, (_, i) => ({
			type: 'setColour',
			which: 'fill',
			value: `#${String(i).padStart(6, '0')}`,
		}));
		const state = after(...picks);
		expect(state.recentColours).toHaveLength(RECENT_COLOURS_MAX);
		expect(state.recentColours[0]).toBe(`#${String(RECENT_COLOURS_MAX + 2).padStart(6, '0')}`);
	});

	it('swaps the two colours', () => {
		const state = after(
			{ type: 'setColour', which: 'fill', value: '#111111' },
			{ type: 'setColour', which: 'stroke', value: 'none' },
			{ type: 'swapColours' }
		);
		expect(state.options.fill).toBe('none');
		expect(state.options.stroke).toBe('#111111');
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
			after(
				{ type: 'togglePanel', panel: 'layers' },
				{ type: 'togglePanel', panel: 'colour' }
			).panel
		).toBe('colour');
		expect(
			after({ type: 'togglePanel', panel: 'colour' }, { type: 'closePanel' }).panel
		).toBeUndefined();
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
