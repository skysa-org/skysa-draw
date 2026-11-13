import { type Cell, cell } from '@skysa/storage';

import { isLayerElement } from '../document/layers.js';
import type { EditorDocument } from '../document/model.js';
import {
	buildPreview,
	type PreviewContext,
	previewContext,
	type PreviewFit,
	type PreviewTarget,
	topLevelOf,
} from './layerPreviews.js';
import { browserShrink, canShrink, createStandIns, type StandIns } from './previewPictures.js';

/**
 * The layers panel's pictures of one document, kept up to date by one watch
 * on its root, shared by every preview shown (`LayerPreview`). A picture is
 * built when its first preview mounts, and its object URL revoked when its
 * last one unmounts or a new picture takes its place; the watch starts with
 * the first picture and stops with the last, so a document whose panel is
 * not shown costs nothing.
 *
 * One `MutationObserver` sees every change to the root: a command, an undo
 * or a redo, and a live preview, a slider being dragged. Each change is
 * traced to the layer at the root it is in, and a change to anything else,
 * the `<defs>`, a `<style>`, the root's own `viewBox`, marks every picture.
 * The pictures are built again once the changes stop for
 * `PREVIEW_DELAY_MS`, all in one round: those of the layers marked, and
 * those that copied a definition from one of them. A layer is found by its
 * id each round, so an undo that put a copy of it in its place is the same
 * layer, and a picture whose text came out the same keeps its URL, so
 * showing or hiding a layer, or changing its opacity, does nothing to its
 * picture.
 *
 * A picture in the file's own bytes is drawn by its stand-in
 * (`previewPictures.ts`), made once for each picture the first time a
 * picture needs it. While one is being made, the picture shown stays as it
 * was, or the box empty for a picture not shown yet, and the picture is built
 * again as soon as it is made; after each round, the stand-ins of pictures no
 * preview draws any more are let go of. They are the document's, not the
 * watch's, so a panel put away and shown again, as a phone's layers sheet
 * is all the time, finds them made.
 */

/** How long the pictures wait for the changes to stop: past a drag's end and a stroke's landing, and too short to be seen waiting. */
export const PREVIEW_DELAY_MS = 250;

/** What a preview shows: a `blob:` URL of the picture's SVG, and the canvas's size in the box. */
export type PreviewPicture = Readonly<{ url: string; fit: PreviewFit }>;

type Shown = Readonly<{
	picture: PreviewPicture;
	parts: readonly string[];
	sources: ReadonlySet<string>;
	/** The pictures in the file's own bytes it draws by their stand-ins. */
	pictures: readonly string[];
}>;

type Entry = Readonly<{
	target: PreviewTarget;
	listeners: Set<() => void>;
	shown: Cell<Shown | undefined>;
}>;

type Watch = Readonly<{
	document: EditorDocument;
	entries: Map<string, Entry>;
	/** The ids of the layers at the root changed since the last round. */
	dirty: Set<string>;
	/** Whether something not in a layer changed, which any picture may show. */
	everything: Cell<boolean>;
	timer: Cell<ReturnType<typeof setTimeout> | undefined>;
	observer: MutationObserver;
	standIns: StandIns;
	/** The entries, by key, whose stand-ins were made since they were built. */
	again: Set<string>;
}>;

const watches = new WeakMap<EditorDocument, Watch>();

const standIns = new WeakMap<EditorDocument, StandIns>();

/** The document's stand-ins, made with its first watch and kept through every watch after. */
const standInsOf = (document: EditorDocument): StandIns => {
	const known = standIns.get(document) ?? createStandIns(canShrink() ? browserShrink : undefined);
	standIns.set(document, known);
	return known;
};

/** jsdom has no object URLs, and a browser without them shows the box empty. */
const canPreview = (): boolean =>
	typeof URL.createObjectURL === 'function' && typeof MutationObserver === 'function';

const keyOf = (target: PreviewTarget): string =>
	JSON.stringify([target.layerId, target.position ?? null]);

const idOf = (element: Element): string => element.getAttribute('id') ?? '';

const sameParts = (one: readonly string[], other: readonly string[]): boolean =>
	one.length === other.length && one.every((part, index) => part === other[index]);

const release = (shown: Shown | undefined): void => {
	if (shown !== undefined) URL.revokeObjectURL(shown.picture.url);
};

/** The context of a round of builds, with the watch's stand-ins. */
const contextOf = (watch: Watch): PreviewContext =>
	previewContext(watch.document.root, watch.document.size, undefined, watch.standIns.get);

/**
 * The entry's picture built again; whether what it shows changed. A text the
 * same as the last keeps its URL, and nothing is made for it. One waiting on
 * stand-ins keeps what it shows until they are made, and is built again then.
 */
const rebuild = (watch: Watch, context: PreviewContext, key: string, entry: Entry): boolean => {
	const built = buildPreview(context, entry.target);
	const was = entry.shown.current;
	if (built === undefined) {
		entry.shown.current = undefined;
		release(was);
		return was !== undefined;
	}
	if (built.wanted.length > 0) {
		void watch.standIns.make(built.wanted).then(() => {
			watch.again.add(key);
			schedule(watch, 0);
		});
		return false;
	}
	const shown = { parts: built.parts, sources: built.sources, pictures: built.pictures };
	if (was !== undefined && sameParts(was.parts, built.parts)) {
		entry.shown.current = { ...shown, picture: was.picture };
		return false;
	}
	const url = URL.createObjectURL(new Blob([...built.parts], { type: 'image/svg+xml' }));
	entry.shown.current = { ...shown, picture: { url, fit: built.fit } };
	release(was);
	return true;
};

/** Whether a change since the last round may show in the entry's picture. */
const touches = (context: PreviewContext, entry: Entry, dirty: ReadonlySet<string>): boolean => {
	const layer = context.layer(entry.target.layerId);
	if (layer === undefined) return true;
	const top = topLevelOf(context.root, layer);
	const own = top instanceof Element && dirty.has(idOf(top));
	return own || [...(entry.shown.current?.sources ?? [])].some((id) => dirty.has(id));
};

const notify = (entry: Entry): void => {
	entry.listeners.forEach((listener) => {
		listener();
	});
};

/** The stand-ins of the pictures no preview draws any more let go of. */
const keepShown = (watch: Watch): void => {
	watch.standIns.keep(
		new Set([...watch.entries.values()].flatMap((entry) => entry.shown.current?.pictures ?? []))
	);
};

const flush = (watch: Watch): void => {
	watch.timer.current = undefined;
	const everything = watch.everything.current;
	const dirty: ReadonlySet<string> = new Set(watch.dirty);
	const again: ReadonlySet<string> = new Set(watch.again);
	watch.everything.current = false;
	watch.dirty.clear();
	watch.again.clear();
	const context = contextOf(watch);
	[...watch.entries]
		.filter(([key, entry]) => everything || again.has(key) || touches(context, entry, dirty))
		.filter(([key, entry]) => rebuild(watch, context, key, entry))
		.forEach(([, entry]) => {
			notify(entry);
		});
	keepShown(watch);
};

/**
 * Marks what the change may show in; whether it marked anything. A change to
 * a node no longer in the tree marks nothing: where the node went in again,
 * or went out, is a change of its own, to a node that is.
 */
const mark = (watch: Watch, record: MutationRecord): boolean => {
	const root = watch.document.root;
	const top = topLevelOf(root, record.target);
	if (top === undefined) return false;
	if (top !== root) {
		if (isLayerElement(top)) watch.dirty.add(idOf(top));
		else watch.everything.current = true;
		return true;
	}
	if (record.type === 'characterData') return false;
	if (record.type === 'attributes') {
		watch.everything.current = true;
		return true;
	}
	const elements = [...record.addedNodes, ...record.removedNodes].filter(
		(node): node is Element => node instanceof Element
	);
	if (elements.some((element) => !isLayerElement(element))) watch.everything.current = true;
	elements.filter(isLayerElement).forEach((layer) => watch.dirty.add(idOf(layer)));
	return elements.length > 0;
};

/** A round of builds `delay` from now, in place of one already waiting; at once for stand-ins just made. */
const schedule = (watch: Watch, delay = PREVIEW_DELAY_MS): void => {
	if (watch.timer.current !== undefined) clearTimeout(watch.timer.current);
	watch.timer.current = setTimeout(() => {
		flush(watch);
	}, delay);
};

const startWatch = (document: EditorDocument): Watch => {
	const watch: Watch = {
		document,
		entries: new Map(),
		dirty: new Set(),
		everything: cell(false),
		timer: cell(undefined),
		standIns: standInsOf(document),
		again: new Set(),
		observer: new MutationObserver((records) => {
			const marked = records.map((record) => mark(watch, record)).some(Boolean);
			if (marked) schedule(watch);
		}),
	};
	watch.observer.observe(document.root, {
		subtree: true,
		attributes: true,
		childList: true,
		characterData: true,
	});
	watches.set(document, watch);
	return watch;
};

const stopWatch = (watch: Watch): void => {
	watch.observer.disconnect();
	if (watch.timer.current !== undefined) clearTimeout(watch.timer.current);
	watch.timer.current = undefined;
	watches.delete(watch.document);
};

const addEntry = (watch: Watch, key: string, target: PreviewTarget): Entry => {
	const entry: Entry = { target, listeners: new Set(), shown: cell(undefined) };
	watch.entries.set(key, entry);
	rebuild(watch, contextOf(watch), key, entry);
	return entry;
};

const dropEntry = (watch: Watch, key: string, entry: Entry): void => {
	watch.entries.delete(key);
	release(entry.shown.current);
	entry.shown.current = undefined;
	if (watch.entries.size === 0) stopWatch(watch);
};

/**
 * Shows the target's picture to `listener` from now on, built now where no
 * preview shows it yet; the function given back stops, and the last to stop
 * lets the picture go.
 */
export const subscribePreview = (
	document: EditorDocument,
	target: PreviewTarget,
	listener: () => void
): (() => void) => {
	if (!canPreview()) return () => undefined;
	const watch = watches.get(document) ?? startWatch(document);
	const key = keyOf(target);
	const entry = watch.entries.get(key) ?? addEntry(watch, key, target);
	entry.listeners.add(listener);
	return () => {
		entry.listeners.delete(listener);
		if (entry.listeners.size === 0 && watch.entries.get(key) === entry) {
			dropEntry(watch, key, entry);
		}
	};
};

/** The target's picture as it is now, the same object until it changes; nothing while none is built. */
export const previewPicture = (
	document: EditorDocument,
	target: PreviewTarget
): PreviewPicture | undefined =>
	watches.get(document)?.entries.get(keyOf(target))?.shown.current?.picture;
