import type { Ref } from 'react';

import type { EditorDocument } from './document/model.js';
import type { SelectionActionId } from './selectionActions.js';
import type { FillSpec } from './tools/raster/areaFill.js';
import type { AreaModify } from './tools/raster/areaOps.js';
import type { Tool, ToolId, ToolOptions } from './tools/types.js';
import type { ViewportSelection } from './viewport/selectionState.js';

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
	/**
	 * One of the selection's actions (`selectionActions.ts`), as the context
	 * menu does it: for the frame's selection bar and its keys. Whether it did
	 * anything.
	 */
	readonly perform: (action: SelectionActionId) => boolean;
	/** Fill…'s Apply: the area filled as the dialog says (`fillAreaWith`). Whether it was the area's to do. */
	readonly fillArea: (spec: FillSpec) => boolean;
	/**
	 * The top bar's Undo and Redo, while Transform selection is on: a step of
	 * the transform's own, as Ctrl or ⌘ Z is then. Whether it was the
	 * transform's, so the frame steps the drawing's history when it was not.
	 */
	readonly undo: () => boolean;
	readonly redo: () => boolean;
}

export interface ViewportProps {
	readonly document: EditorDocument;
	readonly tool: Tool;
	readonly options: ToolOptions;
	/** The active layer. */
	readonly layerId: string | undefined;
	/**
	 * The area and the element selection, held by the frame so that its
	 * selection bar can show them; a viewport given none keeps its own.
	 */
	readonly selection?: ViewportSelection;
	/** The eyedropper set a color. */
	readonly onColor: (which: 'fill' | 'stroke', value: string) => void;
	/** A line for the user, already in their words. */
	readonly onNotify: (message: string) => void;
	/** The zoom changed. */
	readonly onScale?: (scale: number) => void;
	/**
	 * A layer the user now works on: one made by layer via copy or cut, or the
	 * context menu's new or duplicated layer; or one the move tool's
	 * Auto-Select picked under a press (`Tool.pick`), or gave back when that
	 * press was canceled.
	 */
	readonly onActivateLayer?: (id: string) => void;
	/**
	 * Fill… was asked for, by the context menu, the selection bar, Shift+F5 or
	 * Shift+Backspace, on a layer it may fill: the frame opens its dialog. A
	 * viewport given none does nothing for Fill….
	 */
	readonly onFill?: () => void;
	/**
	 * Modify… was asked for, by the context menu or the selection bar, with an
	 * area selected, or Feather by Shift+F6, which is `way`: the frame opens
	 * its dialog, at that way where there is one. A viewport given none does
	 * nothing for Modify… or Feather.
	 */
	readonly onModify?: (way?: AreaModify) => void;
	/**
	 * A tool asked for another to be in hand (`ToolContext.useTool`): the
	 * select tool's double press on a text or a path. The frame puts it in
	 * hand, so the tool bar shows it; a viewport given none asks for nothing.
	 */
	readonly onTool?: (id: ToolId) => void;
	/** A tool set options (`ToolContext.setOptions`): the text tool, an edited text's size and fill. */
	readonly onOptions?: (change: Partial<ToolOptions>) => void;
	readonly ref?: Ref<ViewportHandle>;
}
