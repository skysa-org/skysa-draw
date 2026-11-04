import type { BlendMode, DrawingSize, LayerKind } from '@skysa/draw-core';

import type { LayerAdjustments } from './adjustments.js';

/**
 * The editor's document (docs/ARCHITECTURE.md §7, "The editor"): the drawing's
 * SVG, sanitized and live in the page, and the commands that change it. The
 * text stays the only source of truth; this is the view the tools and the
 * panels work through. The types are here, in a file of their own, so that the
 * tools, the panels and the model are written against one contract.
 */

/** One layer as the panel and the tools see it (docs/ARCHITECTURE.md §3, "Layers"). */
export interface LayerInfo {
	/**
	 * The element's `id`. Every layer has one in the model: one the file lacked
	 * is given on open, in the DOM only, and written with the first edit.
	 */
	readonly id: string;
	readonly kind: LayerKind;
	/** `draw:name`, else `inkscape:label`, else nothing: the panel then shows "Layer n". */
	readonly name: string | undefined;
	readonly hidden: boolean;
	readonly locked: boolean;
	/** 0 to 1. */
	readonly opacity: number;
	readonly blend: BlendMode;
	/** 0 at the root; one more inside each group. */
	readonly depth: number;
	readonly parentId: string | undefined;
	/** A graphics element at the root that is not a `<g>`: wrapped in one the first time it is edited. */
	readonly loose: boolean;
	/**
	 * `true` for a layer clipped to the one below it, the app's own clip
	 * (`document/clip.ts`); absent otherwise, a mask of the file's own included.
	 */
	readonly clipped?: boolean;
	/**
	 * The layer's filter: its adjustments, where it is the app's own
	 * (`document/adjustments.ts`), or one from another tool, which is left
	 * alone; absent where it has none.
	 */
	readonly adjustments?: LayerAdjustments;
}

/**
 * A change to the drawing, with its inverse. `apply` runs once when the
 * command is executed and again on redo; `revert` on undo. Both work on the
 * live root and nothing else, so a command never holds an element across an
 * undo that replaced it: it finds its layer by id each time.
 */
export interface Command {
	/** What it did, as a catalog key, for an undo menu: `'tools.brush'`, `'layers.rename'`. */
	readonly label: string;
	readonly apply: (root: SVGSVGElement) => void;
	readonly revert: (root: SVGSVGElement) => void;
	/** What it costs the history, in bytes of what it keeps. */
	readonly bytes: number;
}

/** What the React tree reads: immutable, new on every change. */
export interface DocumentSnapshot {
	/** Every layer in document order, bottom to top; a group's children follow it. */
	readonly layers: readonly LayerInfo[];
	readonly size: DrawingSize;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	readonly dirty: boolean;
	/** Bumps on every change. */
	readonly version: number;
}

export interface EditorDocument {
	/** The sanitized root, live in the page once the viewport mounts it. */
	readonly root: SVGSVGElement;
	/** Everything before the root tag in the file, kept in front of what is serialized. */
	readonly prolog: string;
	readonly size: DrawingSize;
	readonly snapshot: () => DocumentSnapshot;
	/** The file's text: the one opened until the first command, serialized after. */
	readonly text: () => string;
	readonly layer: (id: string) => SVGGraphicsElement | undefined;
	readonly execute: (command: Command) => void;
	readonly undo: () => void;
	readonly redo: () => void;
	readonly subscribe: (listener: () => void) => () => void;
	/** Work a save must wait for: a raster layer's encoding after a stroke. */
	readonly pending: (work: Promise<unknown>) => void;
	/** Resolves when nothing is pending. */
	readonly settle: () => Promise<void>;
}
