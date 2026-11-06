import type { Dispatch, RefObject } from 'react';
import { useEffect } from 'react';

import type { EditorDocument } from './document/model.js';
import type { EditorAction } from './editorState.js';
import { type EditAction, editActionFor, isTyping, toolFor } from './keys.js';
import { toolById } from './tools/index.js';
import type { ToolId } from './tools/types.js';
import type { ViewportHandle } from './types.js';
import { isMac } from './viewport/pointer.js';

/**
 * The frame's keys (docs/ARCHITECTURE.md §7, "The interface"): what each
 * editing key of `keys.ts` does in the frame, and the window's listener that
 * hears them, out of `Editor.tsx` so the frame stays one screen of layout.
 */

const MAC = isMac();

/** What a key reaches of the frame: the document, the viewport and the state. */
type KeyContext = Readonly<{
	document: EditorDocument | undefined;
	viewport: ViewportHandle | null;
	dispatch: Dispatch<EditorAction>;
}>;

const withDocument = (
	document: EditorDocument | undefined,
	act: (document: EditorDocument) => void
): boolean => {
	if (document === undefined) return false;
	act(document);
	return true;
};

const withViewport = (
	viewport: ViewportHandle | null,
	act: (viewport: ViewportHandle) => void
): boolean => {
	if (viewport === null) return false;
	act(viewport);
	return true;
};

const always = (act: () => void): boolean => {
	act();
	return true;
};

/**
 * The editing keys (`keys.ts`), each saying whether it did anything, so only a
 * handled key is kept from the browser. Escape is not the frame's: what a tool
 * has begun is the viewport's to cancel, and a sheet or a drawer closes itself
 * (`PanelHost`). Delete and the selection's keys are the viewport's, as the
 * selection and the area are, and J with them, which is layer via copy while
 * something is selected; a new layer is asked of it too, as its context menu
 * asks, so the two are one.
 */
const EDIT_ACTIONS: Readonly<Record<EditAction, (context: KeyContext) => boolean>> = {
	undo: ({ document }) => withDocument(document, (open) => open.undo()),
	redo: ({ document }) => withDocument(document, (open) => open.redo()),
	fit: ({ viewport }) => withViewport(viewport, (view) => view.fit()),
	actualSize: ({ viewport }) => withViewport(viewport, (view) => view.actualSize()),
	zoomIn: ({ viewport }) => withViewport(viewport, (view) => view.zoomIn()),
	zoomOut: ({ viewport }) => withViewport(viewport, (view) => view.zoomOut()),
	delete: () => false,
	escape: () => false,
	// The viewport's, which applies a transform of the area under way.
	commit: () => false,
	// The selection's, which the viewport works.
	selectAll: () => false,
	deselect: () => false,
	selectInverse: () => false,
	feather: () => false,
	layerViaCut: () => false,
	fillArea: () => false,
	fillAreaStroke: () => false,
	fillDialog: () => false,
	duplicate: () => false,
	sizeUp: ({ dispatch }) => always(() => dispatch({ type: 'adjustSize', steps: 1 })),
	sizeDown: ({ dispatch }) => always(() => dispatch({ type: 'adjustSize', steps: -1 })),
	swapColors: ({ dispatch }) => always(() => dispatch({ type: 'swapColors' })),
	resetColors: ({ dispatch }) => always(() => dispatch({ type: 'resetColors' })),
	newLayer: ({ viewport }) => viewport?.perform('newLayer') ?? false,
};

/**
 * Keys on every size (docs/decisions/0004-the-interface.md): a letter per
 * tool, and the editing keys, from the one map in `keys.ts`. A key something
 * else has handled already — a sheet's Escape, a layer row's Delete — is left
 * alone, and so is one typed into a field.
 */
export const useEditorKeys = (
	document: EditorDocument | undefined,
	viewport: RefObject<ViewportHandle | null>,
	dispatch: Dispatch<EditorAction>,
	/** The tool in hand, which a letter shared by a group keeps, and Shift with it moves on from. */
	toolId: ToolId
) => {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || isTyping(event.target)) return;
			const nextTool = toolFor(event, MAC, toolId);
			if (nextTool !== undefined) {
				// A key for a tool not built yet does nothing, rather than leaving
				// the frame holding a tool the viewport has no behavior for.
				if (toolById(nextTool) === undefined) return;
				event.preventDefault();
				dispatch({ type: 'setTool', toolId: nextTool });
				return;
			}
			const action = editActionFor(event, MAC);
			if (action === undefined) return;
			const context = { document, viewport: viewport.current, dispatch };
			if (EDIT_ACTIONS[action](context)) event.preventDefault();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [document, viewport, dispatch, toolId]);
};
