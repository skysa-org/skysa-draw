import { conflictPath, readDrawingTitle, withDrawingId, withDrawingTitle } from '@skysa/draw-core';
import { basename, cell, conflictStamp, parentPath } from '@skysa/storage';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { t } from '../i18n/t.js';
import { useDb } from '../store/database.js';
import { type DrawDatabase, type DrawingRecord, drawingRef } from '../store/db.js';
import { createDrawing, deleteDrawing, saveDrawing } from '../store/drawings.js';
import { beforeClosing, inTime } from '../store/heldEdits.js';
import { useDrawing } from '../store/hooks.js';
import type { EditorDocument } from './document/model.js';
import { openDocument } from './document/openDocument.js';

/**
 * The drawing the editor has open (docs/ARCHITECTURE.md §7, "The editor"):
 * its row, read live from the store, and the document opened from the row's
 * text once, when the row first arrives. From then on the document is the
 * user's and the row follows it: every change is saved after a pause, the
 * text written into the row, and a row that changes under us is told apart
 * from our own save by the texts we wrote. A change from elsewhere under
 * unsaved edits follows the conflict rule (§7, "Conflict rule"): the other
 * change keeps the drawing, and the edits are kept beside it as a copy. A
 * delete from elsewhere under unsaved edits keeps them too, as a drawing in
 * its place that the editor moves to; the user's own delete goes through here
 * (`remove`), so that it is told from that one, and takes the edits with it.
 *
 * All of that lives in a session object with cells inside, started and
 * stopped by one effect and read through `useSyncExternalStore`, rather than
 * in React state set from effects: the opening, the saving and the row
 * watching are one piece of state machinery, and a test can drive it without
 * a component.
 */

/** How long after the last change a save waits for the next one. */
export const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * How long a run of changes may put the save off, at most. A stroke every
 * half-second for ten minutes is one drawing session, and nothing of it would
 * reach the store with the debounce alone.
 */
const AUTOSAVE_MAX_WAIT_MS = 5_000;

/**
 * How many of our own saved texts to keep for telling our saves from a change
 * elsewhere: the store answers a save with the row some time after it, and two
 * saves in a row may be answered in either order.
 */
const REMEMBERED_SAVES = 4;

/** What the top bar says of the drawing: nothing yet, a save under way, or saved. */
export type SavingState = 'idle' | 'saving' | 'saved';

/** The edits kept as a drawing of their own: its id and its title. */
type KeptCopy = Readonly<{ id: string; title: string }>;

/** The row as `useDrawing` answers for it. */
type Found = DrawingRecord | 'loading' | 'missing';

type Opened = Readonly<{
	document: EditorDocument | undefined;
	/** The text would not open as a drawing: shown as an image, never rewritten. */
	unreadable: boolean;
	saving: SavingState;
	/**
	 * The last copy the edits were kept in: the row changed under them, by
	 * sync or another tab, and the editor reopened on the row.
	 */
	keptCopy: KeptCopy | undefined;
	/**
	 * The drawing the edits were kept in when the row was deleted under them,
	 * elsewhere: there is no row left to reopen, so the editor moves to it.
	 */
	replacement: KeptCopy | undefined;
	/** The row was deleted, and nothing open here was left to keep: not found. */
	gone: boolean;
}>;

const NOTHING_OPEN: Opened = {
	document: undefined,
	unreadable: false,
	saving: 'idle',
	keptCopy: undefined,
	replacement: undefined,
	gone: false,
};

interface Session {
	/** The row as the store has it now; opens the document the first time it comes. */
	readonly offer: (row: Found) => void;
	readonly subscribe: (listener: () => void) => () => void;
	readonly getSnapshot: () => Opened;
	/** A pending save started now; resolves when it, or a save already running, is in the store. */
	readonly flush: () => Promise<void>;
	/** Listens for the page going away; returns the stop. */
	readonly start: () => () => void;
	/** The user's own delete of the drawing, unsaved edits and all. */
	readonly remove: () => Promise<void>;
}

const createSession = (db: DrawDatabase, id: string): Session => {
	const state = cell<Opened>(NOTHING_OPEN);
	const listeners = new Set<() => void>();
	const openedText = cell<string | undefined>(undefined);
	/** The row as the store had it last; nothing once it is deleted. */
	const latest = cell<DrawingRecord | undefined>(undefined);
	/** The row as it was last seen, deleted or not: what the edits are named by. */
	const known = cell<DrawingRecord | undefined>(undefined);
	/**
	 * A copy is being kept, or has been in place of the deleted row: nothing is
	 * saved into the row, and no row is opened.
	 */
	const keeping = cell(false);
	/** A copy being kept, or a drawing in place of the row: nothing once it is in, or refused. */
	const kept = cell<Promise<void> | undefined>(undefined);
	/** The user is deleting the drawing: what is unsaved goes with it. */
	const deleting = cell(false);
	const saved = cell<readonly string[]>([]);
	/**
	 * The text of a save still on its way, which the store may yet refuse
	 * (`expected`): until it lands, it is not saved.
	 */
	const sending = cell<string | undefined>(undefined);
	const timer = cell<ReturnType<typeof setTimeout> | undefined>(undefined);
	const firstChangeAt = cell<number | undefined>(undefined);
	const inFlight = cell<Promise<void> | undefined>(undefined);

	const set = (patch: Partial<Opened>) => {
		state.current = { ...state.current, ...patch };
		listeners.forEach((listener) => listener());
	};

	/**
	 * `saveDrawing` writes the text with the drawing's id in it, and that is
	 * what comes back in the row, so that is what is remembered.
	 */
	const save = (document: EditorDocument): Promise<void> => {
		timer.current = undefined;
		firstChangeAt.current = undefined;
		set({ saving: 'saving' });
		const work = (async () => {
			await document.settle();
			// Reopened meanwhile: this document's text is no longer the drawing's.
			if (state.current.document !== document) return;
			const text = withDrawingId(document.text(), id);
			// What this session last had in the row: a row that is none of it
			// was changed from elsewhere since, and is not written over.
			const expected = [
				...(openedText.current === undefined ? [] : [openedText.current]),
				...saved.current,
			];
			saved.current = [...saved.current, text].slice(-REMEMBERED_SAVES);
			sending.current = text;
			const outcome = await saveDrawing(db, id, text, { expected })
				.catch((error: unknown) => {
					// Not in the store, so not saved: a delete that beat it still
					// finds these edits unsaved (`keepDeleted`).
					saved.current = saved.current.filter((each) => each !== text);
					throw error;
				})
				.finally(() => {
					if (sending.current === text) sending.current = undefined;
				});
			if (outcome === 'changed') {
				// Nothing was written. The change, as it arrives or already has,
				// finds these edits unsaved and keeps them as a copy beside it
				// (`keepCopy`), by the conflict rule.
				saved.current = saved.current.filter((each) => each !== text);
				if (state.current.document === document) set({ saving: 'idle' });
				return;
			}
			if (state.current.document === document) set({ saving: 'saved' });
		})().catch(() => {
			// The one failure this increment knows is the drawing deleted under a
			// pending save, whose edits `keepDeleted` keeps, or the user's own
			// delete takes; a store that refuses for another reason is a notice
			// still to be built (§10).
			if (state.current.document === document) set({ saving: 'idle' });
		});
		inFlight.current = work;
		return work;
	};

	const stopTimer = () => {
		if (timer.current !== undefined) clearTimeout(timer.current);
		timer.current = undefined;
		firstChangeAt.current = undefined;
	};

	const schedule = (document: EditorDocument) => {
		// An edit made while a copy is kept goes into the copy (`keepCopy`), and
		// one made while the user deletes the drawing goes with it.
		if (keeping.current || deleting.current) return;
		const now = Date.now();
		const since = firstChangeAt.current ?? now;
		firstChangeAt.current = since;
		if (timer.current !== undefined) clearTimeout(timer.current);
		const wait = Math.max(
			0,
			Math.min(AUTOSAVE_DEBOUNCE_MS, since + AUTOSAVE_MAX_WAIT_MS - now)
		);
		timer.current = setTimeout(() => {
			void save(document);
		}, wait);
	};

	const open = (text: string) => {
		// Only ever called with nothing unsaved in the document being replaced,
		// or with its edits kept as a copy, so a save it still had pending has
		// nothing to add.
		stopTimer();
		openedText.current = text;
		const document = openDocument(text);
		// Every save is scheduled, whatever the change was: the store ignores a
		// save of the same text, and an undo back past the last save has to
		// reach the row too.
		if (document !== undefined) document.subscribe(() => schedule(document));
		set({ document, unreadable: document === undefined, saving: 'idle' });
	};

	const hasUnsavedEdits = (): boolean => {
		const document = state.current.document;
		if (document === undefined || !document.snapshot().dirty) return false;
		const text = withDrawingId(document.text(), id);
		return text === sending.current || !saved.current.includes(text);
	};

	/**
	 * The copy's text brought up to what the document holds, for an edit made
	 * while the copy was being written, until the two agree. A settled
	 * document's text is read in the same task as the reopen that follows, so
	 * no edit falls between.
	 */
	const keepUp = async (
		document: EditorDocument,
		copyId: string,
		copyText: (text: string) => string,
		written: string
	): Promise<void> => {
		await document.settle();
		const text = document.text();
		if (text === written) return;
		await saveDrawing(db, copyId, copyText(text));
		await keepUp(document, copyId, copyText, text);
	};

	/**
	 * The row changed elsewhere under unsaved edits: the conflict rule
	 * (docs/ARCHITECTURE.md §7, "Conflict rule"), here rather than at a push.
	 * The other change keeps the drawing. The editor's text becomes a drawing
	 * of its own beside it, named as a conflict copy and given a new id, with
	 * a title that says what it is; then the editor reopens on the row. Nothing
	 * is saved into the row meanwhile.
	 */
	const keepCopy = async (document: EditorDocument, row: DrawingRecord): Promise<void> => {
		keeping.current = true;
		stopTimer();
		try {
			await document.settle();
			const text = document.text();
			const at = new Date();
			const copyId = crypto.randomUUID();
			const title = t('editor.conflictTitle', {
				title: readDrawingTitle(text) ?? row.title,
				stamp: conflictStamp(at),
			});
			const copyText = (from: string) => withDrawingId(withDrawingTitle(from, title), copyId);
			await createDrawing(db, {
				id: copyId,
				title,
				text: copyText(text),
				folderPath: parentPath(row.path),
				connectionId: row.connectionId,
				filename: (taken) => basename(conflictPath(row.path, at, taken)),
			});
			await keepUp(document, copyId, copyText, text);
			const current = latest.current;
			if (current === undefined) {
				// Deleted while the copy was written: the copy is all there is
				// of the drawing now, and the editor moves to it, unless the
				// delete was the user's own.
				set(deleting.current ? { gone: true } : { replacement: { id: copyId, title } });
				return;
			}
			keeping.current = false;
			open(current.text);
			set({ keptCopy: { id: copyId, title } });
		} catch {
			// The store would not take the copy. The edits stay open, unsaved,
			// and the next one is saved as before: a store that refuses a new
			// row is one that will refuse that save too (§10).
			keeping.current = false;
		}
	};

	/**
	 * The row deleted elsewhere, by another tab or a pull, under unsaved edits.
	 * There is no drawing left for them to be kept beside, so they become one
	 * in its place: in its folder and connection, under its title, named by the
	 * folder's usual rule, and with a new id, since the old one now means
	 * deleted to whatever deleted it and sync must not bring that back. The
	 * editor then moves to it. A save under way may be one the delete beat, and
	 * raster work still pending can make a clean document dirty, so both are
	 * waited for before the edits are asked about.
	 */
	const keepDeleted = async (document: EditorDocument, row: DrawingRecord): Promise<void> => {
		keeping.current = true;
		stopTimer();
		try {
			await inFlight.current;
			await document.settle();
			if (deleting.current || !hasUnsavedEdits()) {
				keeping.current = false;
				set({ gone: true });
				return;
			}
			const text = document.text();
			const keptId = crypto.randomUUID();
			const title = readDrawingTitle(text) ?? row.title;
			const keptText = (from: string) => withDrawingId(from, keptId);
			await createDrawing(db, {
				id: keptId,
				title,
				text: keptText(text),
				folderPath: parentPath(row.path),
				connectionId: row.connectionId,
			});
			await keepUp(document, keptId, keptText, text);
			set({ replacement: { id: keptId, title } });
		} catch {
			// The store would not take the new drawing. The edits stay open,
			// with no row to save them into: a store that refuses a new row is
			// a notice still to be built (§10).
			keeping.current = false;
		}
	};

	/** Work that keeps the edits as a drawing of their own, until it is done. */
	const keep = (work: Promise<void>) => {
		kept.current = work;
		void work.then(() => {
			if (kept.current === work) kept.current = undefined;
		});
	};

	/**
	 * Every keep under way, and one it set off: `keepCopy` and `keepDeleted`
	 * catch what they meet, so this never rejects.
	 */
	const keepsDone = async (): Promise<void> => {
		const work = kept.current;
		if (work === undefined) return;
		await work;
		await keepsDone();
	};

	/**
	 * The row gone from the store. Nothing is kept where nothing was opened, or
	 * where what was is only shown and never edited; a copy being kept takes
	 * the edits with it (`keepCopy`); the user's own delete takes them away.
	 */
	const vanish = () => {
		const row = latest.current;
		latest.current = undefined;
		const document = state.current.document;
		if (row === undefined || document === undefined || keeping.current) return;
		if (deleting.current) {
			set({ gone: true });
			return;
		}
		keep(keepDeleted(document, row));
	};

	const offer = (row: Found) => {
		if (row === 'loading') return;
		if (row === 'missing') {
			vanish();
			return;
		}
		if (row.id !== id) return;
		latest.current = row;
		known.current = row;
		// Back after all, as a pull could bring it.
		if (state.current.gone) set({ gone: false });
		// The copy, once kept, opens the latest row there is.
		if (keeping.current) return;
		if (openedText.current === undefined) {
			open(row.text);
			return;
		}
		if (row.text === openedText.current || saved.current.includes(row.text)) return;
		const document = state.current.document;
		if (document !== undefined && hasUnsavedEdits()) {
			keep(keepCopy(document, row));
			return;
		}
		open(row.text);
	};

	const flush = (): Promise<void> => {
		const document = state.current.document;
		if (timer.current !== undefined && document !== undefined) {
			clearTimeout(timer.current);
			return save(document);
		}
		return inFlight.current ?? Promise.resolve();
	};

	/**
	 * What `settleEditors` asks of an open editor (`store/heldEdits.ts`): what
	 * it holds written now, and this drawing named, by `drawingRef`, if the
	 * store still has not taken it. Raster work still pending goes first, since
	 * a stroke is an edit only once its encoding lands, as `keepDeleted` waits
	 * for it too; then the pending save; then a copy being kept, since the
	 * edits are its: one under way already, which has stopped the save's
	 * timer, or one the save set off by finding the row changed, once the
	 * change has reached the editor. Edits a save before it left behind — the
	 * store refused it — are tried once more, since nothing else would try
	 * them until the next change, and a copy that sets off meanwhile is waited
	 * for in turn. Kept in a drawing of their own, or going with the user's
	 * delete, the edits are not this drawing's to name; anything else not in
	 * the store is, an edit made while it settles among it.
	 *
	 * Edits held for a row deleted elsewhere, whose new drawing in its place
	 * the store refused (`keepDeleted`), are named by the row as it was, so
	 * that its source, and only its source, counts them as held.
	 */
	const settle = async (): Promise<readonly string[]> => {
		/** Edits the store has not taken, which no copy and no delete of the user's has. */
		const held = (): boolean => !keeping.current && !deleting.current && hasUnsavedEdits();
		await state.current.document?.settle();
		await flush();
		await keepsDone();
		const document = state.current.document;
		if (document === undefined || !held()) return [];
		// A save of an edit made since is this one.
		stopTimer();
		await save(document);
		await keepsDone();
		const row = known.current;
		return row !== undefined && held() ? [drawingRef(row)] : [];
	};

	/**
	 * Said before the row goes, so that its going is not taken for a delete
	 * from elsewhere, whose edits would be kept as a drawing of their own.
	 */
	const remove = async (): Promise<void> => {
		deleting.current = true;
		stopTimer();
		try {
			await deleteDrawing(db, id);
		} catch (error) {
			// The drawing is still here, and so are the edits: saved as before.
			deleting.current = false;
			const document = state.current.document;
			if (document !== undefined && hasUnsavedEdits()) schedule(document);
			throw error;
		}
	};

	const start = () => {
		// A newer build closing the database, a source let go, an export: each
		// has the editor write what it holds first, and hears what it could not.
		// A function of its own each start, since the registry is a set and
		// React starts a session twice in development.
		const withdraw = beforeClosing(settle.bind(undefined));
		// The save is asynchronous, but IndexedDB finishes a transaction that
		// was started before the page went, so starting it is enough.
		const onPageHide = () => {
			void flush();
		};
		const onVisibility = () => {
			if (window.document.visibilityState === 'hidden') void flush();
		};
		window.addEventListener('pagehide', onPageHide);
		window.document.addEventListener('visibilitychange', onVisibility);
		return () => {
			window.removeEventListener('pagehide', onPageHide);
			window.document.removeEventListener('visibilitychange', onVisibility);
			// Settled as it closes, raster work and a refused save's retry with
			// it, and withdrawn only then, however that went, or once
			// `FLUSH_WAIT_MS` has gone by, so that settling meanwhile waits for
			// it. What the store still refuses goes with the editor: nothing
			// could open what it held again (§10).
			void inTime(settle(), []).then(withdraw);
		};
	};

	return {
		offer,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => state.current,
		flush,
		start,
		remove,
	};
};

type OpenDrawing = Opened &
	Readonly<{
		row: DrawingRecord | undefined;
		/** The store has answered that there is no such drawing: never was, or not any more. */
		missing: boolean;
		/** A pending save started now, for an action that reads the row after it: a rename. */
		flush: () => Promise<void>;
		/** The user's own delete: the edits not yet saved go with the drawing. */
		remove: () => Promise<void>;
	}>;

export const useOpenDrawing = (id: string): OpenDrawing => {
	const db = useDb();
	const found = useDrawing(id);
	const session = useMemo(() => createSession(db, id), [db, id]);
	useEffect(() => session.start(), [session]);
	useEffect(() => {
		session.offer(found);
	}, [session, found]);
	const opened = useSyncExternalStore(session.subscribe, session.getSnapshot);
	return {
		row: typeof found === 'string' ? undefined : found,
		// With a document open, the session says whether the row's going left
		// anything to keep: until it has, the drawing is not yet missing.
		missing: found === 'missing' && (opened.document === undefined || opened.gone),
		...opened,
		flush: session.flush,
		remove: session.remove,
	};
};
