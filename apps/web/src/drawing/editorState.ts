import { isNone, toHex } from '../components/ui/color.js';
import type { LayerInfo } from './document/model.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type ToolId,
	type ToolOptionKey,
	type ToolOptions,
} from './tools/types.js';

/**
 * The frame's own state (docs/ARCHITECTURE.md §7, "The interface"): which tool
 * is in hand and with what options, which layer is active, which panel is
 * open, and the line the frame is showing the user. A reducer rather than a
 * handful of `useState`s so that every transition is a pure function a test
 * can call, and so the keys, the tool bar and the panels change the same state
 * the same way. The drawing itself is never here: it is the document's
 * (`document/model.ts`), and the text stays the only source of truth.
 */

/** What opens over the canvas: a sheet on compact, a drawer elsewhere. */
export type PanelId = 'layers' | 'color';

/** The two colors every tool draws with: `options.fill` and `options.stroke`. */
export type ColorSlot = 'fill' | 'stroke';

export type EditorState = Readonly<{
	toolId: ToolId;
	options: ToolOptions;
	/** The layer the tools act on; resolved against the document by `activeLayerIn`. */
	activeLayerId: string | undefined;
	panel: PanelId | undefined;
	/** The expanded window's dock, as the layers button left it; until then it follows the window. */
	dockOpen: boolean | undefined;
	libraryOpen: boolean;
	/**
	 * A line for the user, already in their words; cleared after a moment. A
	 * new object for every notice, the same words again included, so the
	 * moment starts again.
	 */
	notice: Readonly<{ message: string }> | undefined;
	/** The colors picked most recently, newest first, as `#rrggbb` where they have one. */
	recentColors: readonly string[];
	/** The color the color panel opens on, as the tool bar's pair last asked for it. */
	colorSlot: ColorSlot;
}>;

/** How many colors the swatches remember. */
export const RECENT_COLORS_MAX = 10;

/** `[` and `]` scale a brush by this, the step Photoshop and Procreate agree on. */
const SIZE_STEP = 1.25;
/** The range of a brush's size, in user units, for the keys and the slider alike. */
export const SIZE_MIN = 1;
export const SIZE_MAX = 200;

/** One action per option key, so `value` is typed by the key it goes with. */
type SetOption = {
	[K in ToolOptionKey]: Readonly<{ type: 'setOption'; key: K; value: ToolOptions[K] }>;
}[ToolOptionKey];

export type EditorAction =
	| Readonly<{ type: 'setTool'; toolId: ToolId }>
	| SetOption
	/** Options a tool set, not the user: an edited text's own size and fill, which are no colors picked. */
	| Readonly<{ type: 'setOptions'; change: Partial<ToolOptions> }>
	| Readonly<{ type: 'setColor'; which: ColorSlot; value: string }>
	| Readonly<{ type: 'swapColors' }>
	/** The fill and the stroke a new drawing starts with, put back: D, and the pair's reset. */
	| Readonly<{ type: 'resetColors' }>
	/** The color panel, on one of the two colors: a press on that color in the tool bar. */
	| Readonly<{ type: 'editColor'; which: ColorSlot }>
	| Readonly<{ type: 'setActiveLayer'; id: string | undefined }>
	| Readonly<{ type: 'togglePanel'; panel: PanelId }>
	| Readonly<{ type: 'closePanel' }>
	| Readonly<{ type: 'setDockOpen'; open: boolean }>
	| Readonly<{ type: 'setLibraryOpen'; open: boolean }>
	| Readonly<{ type: 'notify'; message: string }>
	| Readonly<{ type: 'clearNotice' }>
	| Readonly<{ type: 'adjustSize'; steps: number }>;

export const initialEditorState: EditorState = {
	toolId: 'select',
	options: DEFAULT_TOOL_OPTIONS,
	activeLayerId: undefined,
	panel: undefined,
	dockOpen: undefined,
	libraryOpen: false,
	notice: undefined,
	recentColors: [],
	colorSlot: 'fill',
};

/**
 * The action that sets one option, for a caller that holds the key as a type
 * parameter — the options strip's `onChange` — where TypeScript cannot pick the
 * union's member itself. The signature pairs the key with its value's type,
 * so the assertion only says what the parameters already did.
 */
export const setOption = <K extends ToolOptionKey>(key: K, value: ToolOptions[K]): EditorAction =>
	({ type: 'setOption', key, value }) as SetOption;

const withOption = <K extends ToolOptionKey>(
	options: ToolOptions,
	key: K,
	value: ToolOptions[K]
): ToolOptions => ({ ...options, [key]: value });

/**
 * `color` at the front, once, and never `none`, which is not a color to come
 * back to. Written as `#rrggbb` where it has that form, so `#F00` and `red`
 * are the one swatch they look like.
 */
const remembered = (recent: readonly string[], color: string): readonly string[] => {
	if (isNone(color)) return recent;
	const swatch = toHex(color) ?? color;
	return [swatch, ...recent.filter((each) => each !== swatch)].slice(0, RECENT_COLORS_MAX);
};

/**
 * A size scaled by `SIZE_STEP` per step and kept whole, so the slider's number
 * stays readable; a step that rounding would swallow moves by one instead, so
 * a small brush still grows and shrinks.
 */
export const steppedSize = (size: number, steps: number): number => {
	const rounded = Math.round(size * SIZE_STEP ** steps);
	const moved = rounded === size ? size + Math.sign(steps) : rounded;
	return Math.min(SIZE_MAX, Math.max(SIZE_MIN, moved));
};

/**
 * The layer the tools act on: the one chosen, while the document still has it,
 * else the topmost layer that can be drawn on (a group cannot), else the
 * topmost there is. Derived on every render rather than fixed up by an
 * effect, so a layer deleted under the choice falls back at once.
 */
export const activeLayerIn = (
	layers: readonly LayerInfo[],
	wanted: string | undefined
): string | undefined => {
	if (wanted !== undefined && layers.some((layer) => layer.id === wanted)) return wanted;
	const fromTop = [...layers].reverse();
	return (fromTop.find((layer) => layer.kind !== 'group') ?? fromTop[0])?.id;
};

/** The color panel on `which`; asked again for the color it is open on, it closes, as a toggle does. */
const editingColor = (state: EditorState, which: ColorSlot): EditorState =>
	state.panel === 'color' && state.colorSlot === which
		? { ...state, panel: undefined }
		: { ...state, panel: 'color', colorSlot: which };

export const editorReducer = (state: EditorState, action: EditorAction): EditorState => {
	switch (action.type) {
		case 'setTool':
			return { ...state, toolId: action.toolId };
		case 'setOption':
			return {
				...state,
				options: withOption(state.options, action.key, action.value),
				// A color picked in the options strip is a color picked.
				recentColors:
					action.key === 'fill' || action.key === 'stroke'
						? remembered(state.recentColors, action.value)
						: state.recentColors,
			};
		case 'setOptions':
			return { ...state, options: { ...state.options, ...action.change } };
		case 'setColor':
			return {
				...state,
				options: withOption(state.options, action.which, action.value),
				recentColors: remembered(state.recentColors, action.value),
			};
		case 'swapColors':
			return {
				...state,
				options: {
					...state.options,
					fill: state.options.stroke,
					stroke: state.options.fill,
				},
			};
		case 'resetColors':
			// No color picked, as a swap is none: the recent colors stay as they were.
			return {
				...state,
				options: {
					...state.options,
					fill: DEFAULT_TOOL_OPTIONS.fill,
					stroke: DEFAULT_TOOL_OPTIONS.stroke,
				},
			};
		case 'setActiveLayer':
			return { ...state, activeLayerId: action.id };
		case 'togglePanel':
			return { ...state, panel: state.panel === action.panel ? undefined : action.panel };
		case 'editColor':
			return editingColor(state, action.which);
		case 'closePanel':
			return { ...state, panel: undefined };
		case 'setDockOpen':
			return { ...state, dockOpen: action.open };
		case 'setLibraryOpen':
			return { ...state, libraryOpen: action.open };
		case 'notify':
			return { ...state, notice: { message: action.message } };
		case 'clearNotice':
			return { ...state, notice: undefined };
		case 'adjustSize':
			return {
				...state,
				options: withOption(
					state.options,
					'size',
					steppedSize(state.options.size, action.steps)
				),
			};
	}
};
