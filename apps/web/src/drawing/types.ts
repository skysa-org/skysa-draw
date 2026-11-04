import type { Ref } from 'react';

import type { EditorDocument } from './document/model.js';
import type { Tool, ToolOptions } from './tools/types.js';

/**
 * The frame's contracts (docs/ARCHITECTURE.md §7, "The interface"): what the
 * viewport takes from the frame and what the frame may ask of it, so the two
 * are written against one shape.
 */

/** What the frame may ask of the viewport, through its ref. */
export interface ViewportHandle {
	readonly fit: () => void;
	readonly actualSize: () => void;
	readonly zoomIn: () => void;
	readonly zoomOut: () => void;
	/** Screen pixels per user unit. */
	readonly scale: number;
}

export interface ViewportProps {
	readonly document: EditorDocument;
	readonly tool: Tool;
	readonly options: ToolOptions;
	/** The active layer. */
	readonly layerId: string | undefined;
	/** The eyedropper set a colour. */
	readonly onColour: (which: 'fill' | 'stroke', value: string) => void;
	/** A line for the user, already in their words. */
	readonly onNotify: (message: string) => void;
	/** The zoom changed. */
	readonly onScale?: (scale: number) => void;
	readonly ref?: Ref<ViewportHandle>;
}
