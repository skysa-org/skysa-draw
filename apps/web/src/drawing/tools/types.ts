import type { EditorDocument, LayerInfo } from '../document/model.js';

/**
 * What a tool is (docs/decisions/0004-the-interface.md; docs/ARCHITECTURE.md
 * §7, "The editor"): one tool is one tool, with one name, one key and one set
 * of options, and a behaviour for each kind of layer it works on. The viewport
 * turns pointer events into samples in user units and hands them to the active
 * tool's behaviour for the active layer's kind.
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
	/** A CSS colour, or `'none'`. */
	readonly fill: string;
	/** A CSS colour, or `'none'`. */
	readonly stroke: string;
	readonly strokeWidth: number;
	readonly cornerRadius: number;
	/** How far a colour may be from the one under the pointer and still be filled, 0 to 1. */
	readonly tolerance: number;
	/** Shapes kept square or round, lines to 45°. */
	readonly constrain: boolean;
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
	 * emptied when the tool changes or a stroke is cancelled. A size that should
	 * stay the same on screen is divided by `viewport.scale`.
	 */
	readonly overlay: SVGSVGElement;
	readonly screen: ScreenCanvas;
	readonly viewport: ViewportControl;
	readonly selection: SelectionControl;
	/** The eyedropper's way of setting a colour. */
	readonly setColour: (which: 'fill' | 'stroke', value: string) => void;
	/** A line to the user: a locked layer, a tool that does not apply here. Already in the user's words. */
	readonly notify: (message: string) => void;
}

/** What a tool does on one kind of layer. */
export interface ToolBehaviour {
	readonly begin: (context: ToolContext, sample: PointerSample) => void;
	readonly move: (context: ToolContext, sample: PointerSample) => void;
	readonly end: (context: ToolContext, sample: PointerSample) => void;
	/** The stroke is abandoned (Escape, a second finger, the tool changed): nothing is executed. */
	readonly cancel: (context: ToolContext) => void;
	/** The pointer moved with nothing down: a hover preview. */
	readonly hover?: (context: ToolContext, sample: PointerSample) => void;
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
	readonly behaviours: Readonly<{
		vector?: ToolBehaviour;
		raster?: ToolBehaviour;
		group?: ToolBehaviour;
		any?: ToolBehaviour;
	}>;
	/** A CSS cursor over the canvas. */
	readonly cursor?: string;
}

/** What `tools/vector` and `tools/raster` each export: a behaviour per tool they implement. */
export type Behaviours = Partial<Record<ToolId, ToolBehaviour>>;
