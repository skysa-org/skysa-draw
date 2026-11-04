import { isNone, toHex } from '../components/ui/colour.js';
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
export type PanelId = 'layers' | 'colour';

/** The two colours every tool draws with: `options.fill` and `options.stroke`. */
export type ColourSlot = 'fill' | 'stroke';

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
	/** The colours picked most recently, newest first, as `#rrggbb` where they have one. */
	recentColours: readonly string[];
}>;

/** How many colours the swatches remember. */
export const RECENT_COLOURS_MAX = 10;

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
	| Readonly<{ type: 'setColour'; which: ColourSlot; value: string }>
	| Readonly<{ type: 'swapColours' }>
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
	recentColours: [],
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
 * `colour` at the front, once, and never `none`, which is not a colour to come
 * back to. Written as `#rrggbb` where it has that form, so `#F00` and `red`
 * are the one swatch they look like.
 */
const remembered = (recent: readonly string[], colour: string): readonly string[] => {
	if (isNone(colour)) return recent;
	const swatch = toHex(colour) ?? colour;
	return [swatch, ...recent.filter((each) => each !== swatch)].slice(0, RECENT_COLOURS_MAX);
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

export const editorReducer = (state: EditorState, action: EditorAction): EditorState => {
	switch (action.type) {
		case 'setTool':
			return { ...state, toolId: action.toolId };
		case 'setOption':
			return {
				...state,
				options: withOption(state.options, action.key, action.value),
				// A colour picked in the options strip is a colour picked.
				recentColours:
					action.key === 'fill' || action.key === 'stroke'
						? remembered(state.recentColours, action.value)
						: state.recentColours,
			};
		case 'setColour':
			return {
				...state,
				options: withOption(state.options, action.which, action.value),
				recentColours: remembered(state.recentColours, action.value),
			};
		case 'swapColours':
			return {
				...state,
				options: {
					...state.options,
					fill: state.options.stroke,
					stroke: state.options.fill,
				},
			};
		case 'setActiveLayer':
			return { ...state, activeLayerId: action.id };
		case 'togglePanel':
			return { ...state, panel: state.panel === action.panel ? undefined : action.panel };
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
