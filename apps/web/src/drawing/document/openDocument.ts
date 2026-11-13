import {
	DEFAULT_DRAWING_SIZE,
	type DrawingSize,
	readDrawingProlog,
	readDrawingSize,
} from '@skysa/draw-core';
import { cell } from '@skysa/storage';

import { canvasBoxOf } from './crop.js';
import { describeLayers } from './describe.js';
import { createHistory } from './history.js';
import { giveLayerIds, layerById } from './layers.js';
import type { Command, DocumentSnapshot, EditorDocument } from './model.js';
import { parseDrawing, sanitizeDrawing } from './sanitize.js';
import { serializeDrawing } from './serialize.js';

/**
 * A drawing's text, opened for the editor (docs/ARCHITECTURE.md §7, "The
 * editor"): parsed as XML, sanitized in place before any of it can reach the
 * page, every layer given an id, and wrapped in the commands and the history
 * that change it. `undefined` for text that will not open: not well-formed,
 * not an SVG, or one the sanitizer refuses to work on in place. Such a drawing
 * is shown as an image and never rewritten.
 *
 * The root starts out in the XML document `DOMParser` made. The viewport's
 * `appendChild` puts it in the page, which adopts it into the page's document;
 * nothing here holds on to the first one, and the commands make new elements
 * with whatever `root.ownerDocument` is when they run.
 *
 * The text stays the source of truth: until the first command, and again
 * whenever every command is undone, `text()` is the string that was opened,
 * byte for byte, and the drawing is not dirty, so a drawing opened and closed
 * is never re-serialized (CLAUDE.md, "a drawing becomes dirty only on a user's
 * edit").
 */
export const openDocument = (
	text: string,
	/** Told of work a save must wait for, as it starts (`pending`). */
	onPending?: (work: Promise<unknown>) => void
): EditorDocument | undefined => {
	const parsed = parseDrawing(text);
	if (parsed === undefined) return undefined;
	try {
		sanitizeDrawing(parsed);
	} catch {
		// DOMPurify refuses a root it cannot sanitize in place, a prefixed
		// `svg:svg`, and strips it bare rather than return it half done.
		return undefined;
	}
	const root = parsed.documentElement as unknown as SVGSVGElement;
	giveLayerIds(root);
	const size = readDrawingSize(text) ?? DEFAULT_DRAWING_SIZE;
	const prolog = readDrawingProlog(text) ?? '';

	const history = createHistory();
	const version = cell(0);
	const listeners = new Set<() => void>();
	const work = new Set<Promise<unknown>>();
	const snapshotMemo = cell<DocumentSnapshot | undefined>(undefined);
	const textMemo = cell<Readonly<{ version: number; text: string }> | undefined>(undefined);

	// The canvas's size as it is now: a crop changes the `viewBox`
	// (`document/crop.ts`), and the tools that size a new raster layer by the
	// canvas read it here.
	const currentSize = (): DrawingSize => {
		const box = canvasBoxOf(root, size);
		return box.width === size.width && box.height === size.height
			? size
			: { width: box.width, height: box.height };
	};

	const changed = (): void => {
		version.current += 1;
		listeners.forEach((listener) => listener());
	};

	// New only when the version moves, as `useSyncExternalStore` needs.
	const snapshot = (): DocumentSnapshot => {
		const known = snapshotMemo.current;
		if (known?.version === version.current) return known;
		const made: DocumentSnapshot = {
			layers: describeLayers(root),
			size: currentSize(),
			canUndo: history.canUndo(),
			canRedo: history.canRedo(),
			dirty: !history.atOrigin(),
			version: version.current,
		};
		snapshotMemo.current = made;
		return made;
	};

	const currentText = (): string => {
		if (history.atOrigin()) return text;
		const known = textMemo.current;
		if (known?.version === version.current) return known.text;
		const serialized = serializeDrawing(root, prolog);
		textMemo.current = { version: version.current, text: serialized };
		return serialized;
	};

	const execute = (command: Command): void => {
		command.apply(root);
		// A command that found nothing to do says so by costing nothing, and
		// is no step to undo: a move past the end, a layer already gone.
		if (command.bytes === 0) return;
		history.push(command);
		changed();
	};

	const undo = (): void => {
		const command = history.undo();
		if (command === undefined) return;
		command.revert(root);
		changed();
	};

	const redo = (): void => {
		const command = history.redo();
		if (command === undefined) return;
		command.apply(root);
		changed();
	};

	const pending = (job: Promise<unknown>): void => {
		work.add(job);
		const forget = (): void => {
			work.delete(job);
		};
		// Both ways, so a job that fails is forgotten too, and its failure is
		// left to whoever started it.
		void job.then(forget, forget);
		// Told once the job is sure to be forgotten, whatever the telling does.
		onPending?.(job);
	};

	// Work started while a save waits is waited for too: a stroke's encoding
	// can start another.
	const settle = async (): Promise<void> => {
		if (work.size === 0) return;
		await Promise.allSettled([...work]);
		return settle();
	};

	return {
		root,
		prolog,
		get size() {
			return currentSize();
		},
		snapshot,
		text: currentText,
		layer: (id) => layerById(root, id),
		execute,
		undo,
		redo,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		pending,
		settle,
	};
};
