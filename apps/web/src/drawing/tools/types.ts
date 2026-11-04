import type { EditorDocument, LayerInfo } from '../document/model.js';

/**
 * What a tool is (docs/decisions/0004-the-interface.md; docs/ARCHITECTURE.md
 * §7, "The editor"): one tool is one tool, with one name, one key and one set
 * of options, and a behavior for each kind of layer it works on. The viewport
 * turns pointer events into samples in user units and hands them to the active
 * tool's behavior for the active layer's kind.
 */

/** The tools, by the names the catalog knows them by (`tools.*`). */
export const TOOL_IDS = [
	'select',
	'node',
	'hand',
	'zoom',
	'pencil',
	'brush',
	'eraser',
	'smudge',
	'fill',
	'eyedropper',
	'rectangle',
	'ellipse',
	'line',
	'pen',
	'text',
	'marquee',
	'lasso',
	'wand',
	'crop',
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

/** One pointer sample in user units, with what the device says of it. */
export interface PointerSample {
	readonly x: number;
	readonly y: number;
	/** 0 to 1; 0.5 from a device that does not say. */
	readonly pressure: number;
	readonly tiltX: number;
	readonly tiltY: number;
	readonly pointerType: 'mouse' | 'pen' | 'touch';
	/** `performance.now()` at the event. */
	readonly time: number;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	/** Ctrl, or ⌘ on a Mac. */
	readonly primaryKey: boolean;
}

/** The options the strip shows for the active tool, and every tool reads. */
export interface ToolOptions {
	/** A brush's or a pencil's width, in user units. */
	readonly size: number;
	/** 0 to 1. */
	readonly opacity: number;
	/** A raster brush's edge, 0 soft to 1 hard. */
	readonly hardness: number;
	/** How much a freehand stroke is smoothed, 0 to 1. */
	readonly smoothing: number;
	/** Whether pressure changes the width. */
	readonly pressure: boolean;
	/** A CSS color, or `'none'`. */
	readonly fill: string;
	/** A CSS color, or `'none'`. */
	readonly stroke: string;
	readonly strokeWidth: number;
	readonly cornerRadius: number;
	/** How far a color may be from the one under the pointer and still be filled, 0 to 1. */
	readonly tolerance: number;
	/** Shapes kept square or round, lines to 45°. */
	readonly constrain: boolean;
	/** A new text's size, in user units. */
	readonly fontSize: number;
	/** How far the smudge drags color, 0 to 1. */
	readonly strength: number;
	/** Whether the magic wand selects only the pixels joined to the one clicked, or every pixel of its color. */
	readonly contiguous: boolean;
	/**
	 * Whether a press with the move tool first makes the topmost layer with
	 * something under it the active one, as Photoshop's Auto-Select does in
	 * its Layer mode (`tools/common/autoSelect.ts`); Ctrl or ⌘ held at the
	 * press does the other.
	 */
	readonly autoSelect: boolean;
}

export type ToolOptionKey = keyof ToolOptions;

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
	size: 8,
	opacity: 1,
	hardness: 0.8,
	smoothing: 0.5,
	pressure: true,
	fill: '#111827',
	stroke: 'none',
	strokeWidth: 2,
	cornerRadius: 0,
	tolerance: 0.1,
	constrain: false,
	fontSize: 48,
	strength: 0.5,
	contiguous: true,
	autoSelect: false,
};

/** The viewport, as a tool may move it. */
export interface ViewportControl {
	/** Screen pixels per user unit. */
	readonly scale: number;
	/** About a point in user units. */
	readonly zoomBy: (factor: number, aboutX: number, aboutY: number) => void;
	/** In user units. */
	readonly panBy: (dx: number, dy: number) => void;
	readonly fit: () => void;
	readonly actualSize: () => void;
}

/** What is selected on a vector layer. */
export interface SelectionControl {
	readonly elements: readonly Element[];
	readonly set: (elements: readonly Element[]) => void;
	readonly clear: () => void;
}

/**
 * The area selection the marquee and the lasso make: a closed path in user
 * units, or none. It outlives the tool that made it, as in every editor, so
 * the raster tools paint inside it and Delete clears it, until it is dropped.
 */
export interface RegionControl {
	/** The area's outline, an SVG path's `d`, closed, in the drawing's user units; none when nothing is selected. */
	readonly path: string | undefined;
	/** The whole area: its outline, whether it is inverted, and its feather; none when nothing is selected. */
	readonly region: Region | undefined;
	/** A new area of this outline, neither inverted nor feathered; or, with none, the area dropped. */
	readonly set: (path: string | undefined) => void;
	/** The area there is, changed only in what `change` gives; nothing where there is none. */
	readonly update: (change: Partial<Region>) => void;
}

/**
 * An area selection (docs/decisions/0004-the-interface.md, "The context
 * menu"): its outline, and the two things done to it without redrawing it.
 */
export type Region = Readonly<{
	/** An SVG path's `d`, closed, in the drawing's user units: subpaths wound so `nonzero` is their union. */
	path: string;
	/** Select inverse: the area is the canvas outside the outline. */
	inverted: boolean;
	/** Feather: how far either side of the outline its edge fades, in user units; 0 is a hard edge. */
	feather: number;
}>;

/** A canvas over the viewport, in device pixels, for a live raster stroke. */
export interface ScreenCanvas {
	readonly canvas: HTMLCanvasElement;
	/** User units to this canvas's pixels. */
	readonly toScreen: (x: number, y: number) => readonly [number, number];
	readonly pixelRatio: number;
}

/** What the viewport gives a tool. The same object for a stroke, begin to end. */
export interface ToolContext {
	readonly document: EditorDocument;
	/** The active layer, or none. */
	readonly layer: LayerInfo | undefined;
	readonly options: ToolOptions;
	/**
	 * An SVG over the drawing in the same user units, for previews and handles;
	 * emptied when the tool changes or a stroke is canceled. A size that should
	 * stay the same on screen is divided by `viewport.scale`.
	 */
	readonly overlay: SVGSVGElement;
	readonly screen: ScreenCanvas;
	readonly viewport: ViewportControl;
	readonly selection: SelectionControl;
	readonly region: RegionControl;
	/**
	 * The viewport's own element, for a tool that needs HTML over the canvas:
	 * the text tool's field. What a tool adds here it removes when it ends.
	 */
	readonly host: HTMLElement;
	/** The eyedropper's way of setting a color. */
	readonly setColor: (which: 'fill' | 'stroke', value: string) => void;
	/** A line to the user: a locked layer, a tool that does not apply here. Already in the user's words. */
	readonly notify: (message: string) => void;
	/**
	 * Puts this tool down and `id` in hand, as its button in the tool bar
	 * would, and once it is in hand gives it `handover` to edit (its `edit`):
	 * the select tool's double press on a text or a path. None where the
	 * viewport has no frame to ask for a tool.
	 */
	readonly useTool?: (id: ToolId, handover?: Handover) => void;
	/**
	 * Sets options as the strip would, with no color remembered as picked:
	 * the text tool showing an edited text's own size and fill there. None
	 * where the viewport has no frame to tell.
	 */
	readonly setOptions?: (change: Partial<ToolOptions>) => void;
}

/**
 * An element one tool hands another to edit (`ToolContext.useTool`), and
 * where the press that asked for it was, in the drawing's user units: the
 * text tool puts its caret there.
 */
export type Handover = Readonly<{ element: Element; at: Readonly<{ x: number; y: number }> }>;

/** What a tool does on one kind of layer. */
export interface ToolBehavior {
	readonly begin: (context: ToolContext, sample: PointerSample) => void;
	readonly move: (context: ToolContext, sample: PointerSample) => void;
	readonly end: (context: ToolContext, sample: PointerSample) => void;
	/** The stroke is abandoned (Escape, a second finger, the tool changed): nothing is executed. */
	readonly cancel: (context: ToolContext) => void;
	/** The pointer moved with nothing down: a hover preview. */
	readonly hover?: (context: ToolContext, sample: PointerSample) => void;
	/**
	 * The options changed while this tool is in hand, and `context` has the
	 * new ones: what the tool has open after its stroke (the text tool's
	 * field) takes them up, and its preview follows.
	 */
	readonly optionsChanged?: (context: ToolContext) => void;
	/** Another tool handed this one an element to edit (`ToolContext.useTool`), now that this one is in hand. */
	readonly edit?: (context: ToolContext, handover: Handover) => void;
}

/** One tool, by the name and the key users know it by. */
export interface Tool {
	readonly id: ToolId;
	/** Which options the strip shows for it. */
	readonly options: readonly ToolOptionKey[];
	/**
	 * By the active layer's kind; `any` for a tool that needs no layer, and for
	 * every kind not named. A kind with neither is "not on this layer".
	 */
	readonly behaviors: Readonly<{
		vector?: ToolBehavior;
		raster?: ToolBehavior;
		group?: ToolBehavior;
		any?: ToolBehavior;
	}>;
	/** A CSS cursor over the canvas. */
	readonly cursor?: string;
	/**
	 * The layer a press acts on where it may be other than the active one:
	 * the move tool's Auto-Select, the topmost layer with something under the
	 * press (`tools/common/autoSelect.ts`). The viewport makes it the active
	 * layer, through the frame, and gives the press a context of that layer
	 * from its first sample, with the behavior for its kind; none keeps the
	 * active layer. A viewport with no frame to tell asks for none.
	 */
	readonly pick?: (context: ToolContext, sample: PointerSample) => LayerInfo | undefined;
}

/** What `tools/vector` and `tools/raster` each export: a behavior per tool they implement. */
export type Behaviors = Partial<Record<ToolId, ToolBehavior>>;
