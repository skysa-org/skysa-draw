import { conflictPath, readDrawingTitle, withDrawingId, withDrawingTitle } from '@skysa/draw-core';
import { basename, cell, conflictStamp, parentPath } from '@skysa/storage';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { t } from '../i18n/t.js';
import { useDb } from '../store/database.js';
import { type DrawDatabase, type DrawingRecord, drawingRef } from '../store/db.js';
import { createDrawing, deleteDrawing, getDrawing, saveDrawing } from '../store/drawings.js';
import { beforeClosing, inTime } from '../store/heldEdits.js';
import { useDrawing } from '../store/hooks.js';
import { holdLeaving, releaseLeaving } from '../store/leaving.js';
import { foundOf } from '../store/rowStates.js';
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
	/** The row as the store has it now; opens the document the first time it comes, and while the editor is open. */
	readonly offer: (row: Found) => void;
	readonly subscribe: (listener: () => void) => () => void;
	readonly getSnapshot: () => Opened;
	/** Raster work still pending landed, then the pending save, and any it set off, in the store. */
	readonly written: () => Promise<void>;
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
	/**
	 * The row as it was last seen, deleted or not, by `drawingRef`: what the
	 * edits are named by. The name alone, not the row, whose text a deleted
	 * row's would otherwise keep in memory beside the document.
	 */
	const known = cell<string | undefined>(undefined);
	/**
	 * A copy is being kept, or has been in place of the deleted row, or a
	 * change from elsewhere waits on raster work that may yet be an edit:
	 * nothing is saved into the row, and no row is opened.
	 */
	const keeping = cell(false);
	/** A copy being kept, or a drawing in place of the row: nothing once it is in, or refused. */
	const kept = cell<Promise<void> | undefined>(undefined);
	/** The user is deleting the drawing: what is unsaved goes with it. */
	const deleting = cell(false);
	/**
	 * The user's delete is in, as the live query may not yet have said, nor
	 * ever will where the editor closes on it.
	 */
	const deleted = cell(false);
	/** The user's delete on its way, for a keep to wait on before it reads `deleted`. */
	const removal = cell<Promise<unknown> | undefined>(undefined);
	const saved = cell<readonly string[]>([]);
	/**
	 * The text of a save still on its way, which the store may yet refuse
	 * (`expected`): until it lands, it is not saved.
	 */
	const sending = cell<string | undefined>(undefined);
	/**
	 * Saves started and not over: from the pause's end, past raster work it
	 * waits for and the store, to a copy it sets off (`offerStored`).
	 */
	const saves = cell(0);
	const timer = cell<ReturnType<typeof setTimeout> | undefined>(undefined);
	/** Stops the document opened last telling of its edits: called as another opens in its place. */
	const unsubscribe = cell<(() => void) | undefined>(undefined);
	const firstChangeAt = cell<number | undefined>(undefined);
	const inFlight = cell<Promise<void> | undefined>(undefined);
	/**
	 * The page's leave prompt (`store/leaving.ts`), held from an edit, a save,
	 * raster work, or a keep, until nothing would be lost (`letGo`); whether
	 * the page asks is `losing`'s, as it goes.
	 */
	const leaving = Symbol(id);
	/** Raster work started and not landed yet: strokes that are edits only once they do. */
	const encoding = cell(0);
	/**
	 * Starts whose close has not settled: none, and what the store still
	 * refuses went with the editor (§10). A count, since React starts a session
	 * twice in development, and the first start's close lands after the second.
	 */
	const starts = cell(0);
	/** Closed, as the editor is, though its settle may still be going. */
	const closed = cell(false);

	const set = (patch: Partial<Opened>) => {
		state.current = { ...state.current, ...patch };
		listeners.forEach((listener) => listener());
	};

	/**
	 * Whether a page going now would lose anything: work still going that
	 * saves or keeps the edits — the pause, a save, a copy being kept, raster
	 * work pending — or an edit the store has not taken, a refused save's
	 * among them. Not while the user is deleting the drawing, which takes the
	 * edits with it; and once the editor has closed, only the work, which a
	 * stroke landing then, or a settle that ran out of time, leaves going: what
	 * the store refused went with the editor (§10). Work that never settles
	 * goes on asking, as what it holds would be lost. The cheap answers first,
	 * since telling unsaved edits reads the text.
	 */
	const losing = (): boolean => {
		if (deleting.current) return false;
		if (
			timer.current !== undefined ||
			saves.current > 0 ||
			kept.current !== undefined ||
			encoding.current > 0
		) {
			return true;
		}
		if (starts.current === 0) return false;
		try {
			return hasUnsavedEdits();
		} catch {
			// Text that will not take the drawing's id, which no save could
			// write either: held, as a refused save's edits are.
			return true;
		}
	};

	/** Taken early, from anything that may leave edits out of the store: `losing` decides. */
	const hold = (): void => {
		holdLeaving(leaving, losing);
	};

	/** Let go once things go quiet: after a save, a keep, raster work, opening, the user's delete or closing. */
	const letGo = (): void => {
		if (!losing()) releaseLeaving(leaving);
	};

	/** Raster work started: a stroke whose edit, once it lands, sets off the pause. */
	const onPending = (work: Promise<unknown>): void => {
		encoding.current += 1;
		hold();
		const landed = () => {
			encoding.current -= 1;
			letGo();
		};
		void work.then(landed, landed);
	};

	/**
	 * `saveDrawing` writes the text with the drawing's id in it, and that is
	 * what comes back in the row, so that is what is remembered.
	 */
	const save = (document: EditorDocument): Promise<void> => {
		timer.current = undefined;
		firstChangeAt.current = undefined;
		saves.current += 1;
		// Held here too: a settle's retry of a refused save can come once the
		// editor has closed, and has let go of what the store refused.
		hold();
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
			// Not in the store, so not saved, and out of `saved` before `sending`
			// lets go of it, so that it never counts as saved between the two: a
			// delete that beat it still finds these edits unsaved (`keepDeleted`),
			// and the page still asks before it goes (`losing`).
			const unwritten = () => {
				saved.current = saved.current.filter((each) => each !== text);
			};
			const outcome = await saveDrawing(db, id, text, { expected })
				.then(
					(answer) => {
						if (answer === 'changed') unwritten();
						return answer;
					},
					(): 'refused' => {
						unwritten();
						return 'refused';
					}
				)
				.finally(() => {
					if (sending.current === text) sending.current = undefined;
				});
			if (outcome === 'changed' || outcome === 'refused') {
				// Nothing was written. The row as the store has it is handed to
				// `offer`, as the live query would hand it (`offerStored`):
				// changed from elsewhere, or deleted under the save, whose edits
				// `keepDeleted` keeps, or the user's own delete takes. A store
				// that refuses for another reason is a notice still to be built
				// (§10).
				if (state.current.document === document) set({ saving: 'idle' });
				await offerStored();
				return;
			}
			if (state.current.document === document) set({ saving: 'saved' });
		})()
			.catch(() => {
				// The document would not settle, or the row could not be read.
				if (state.current.document === document) set({ saving: 'idle' });
			})
			.finally(() => {
				saves.current -= 1;
			});
		inFlight.current = work;
		void work.then(letGo);
		return work;
	};

	const stopTimer = () => {
		if (timer.current !== undefined) clearTimeout(timer.current);
		timer.current = undefined;
		firstChangeAt.current = undefined;
	};

	const schedule = (document: EditorDocument) => {
		// An edit made while a copy is kept goes into the copy (`keepCopy`),
		// which holds the leave prompt itself (`keep`), and one made while the
		// user deletes the drawing goes with it.
		if (keeping.current || deleting.current) return;
		hold();
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
		// Only ever called with nothing unsaved or pending in the document being
		// replaced, or with its edits kept as a copy once it settled, so a save
		// it still had pending has nothing to add; a stroke still under way on
		// it goes with it (§10).
		stopTimer();
		openedText.current = text;
		// None for a closed session, which nothing shows: the drawing's whole
		// text parsed for it would cost the main thread as the user moves on.
		// The one it replaces goes all the same, so that a settle still going
		// finds nothing left to write, its edits kept or none (#18).
		const document = closed.current ? undefined : openDocument(text, onPending);
		// Every save is scheduled, whatever the change was: the store ignores a
		// save of the same text, and an undo back past the last save has to
		// reach the row too. The document it replaces is heard no more: a
		// stroke under way on it, landing only now, would otherwise stop the
		// pause of an edit made on this one and set off a save of the old one,
		// which writes nothing (#18).
		unsubscribe.current?.();
		unsubscribe.current = document?.subscribe(() => schedule(document));
		set({ document, unreadable: document === undefined, saving: 'idle' });
		letGo();
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
	 * The row as it was last seen, opened where the editor does not show it
	 * already, or, deleted meanwhile, gone. What it shows is the text it
	 * opened, as the row had it, until an edit; then its own, as saved.
	 */
	const openLatest = (document: EditorDocument): void => {
		const current = latest.current;
		if (current === undefined) {
			set({ gone: true });
			return;
		}
		const shown = document.snapshot().dirty
			? withDrawingId(document.text(), id)
			: openedText.current;
		if (current.text !== shown) open(current.text);
	};

	/**
	 * The row changed elsewhere under unsaved edits, or raster work still
	 * pending, which may yet be one: the conflict rule (docs/ARCHITECTURE.md
	 * §7, "Conflict rule"), here rather than at a push. The other change keeps
	 * the drawing. The editor's text becomes a drawing of its own beside it,
	 * named as a conflict copy and given a new id, with a title that says what
	 * it is; then the editor reopens on the row, where it is still open (`open`). Nothing is saved into the row
	 * meanwhile.
	 */
	const keepCopy = async (document: EditorDocument, row: DrawingRecord): Promise<void> => {
		keeping.current = true;
		stopTimer();
		try {
			await document.settle();
			// The user's own delete, once it is in, takes the edits with it; one
			// on its way is waited for, since one the store refuses leaves them
			// open (`remove`).
			await Promise.allSettled([removal.current]);
			if (deleted.current) {
				keeping.current = false;
				set({ gone: true });
				return;
			}
			// Kept for raster work still pending, which landed as nothing: nothing
			// to keep, and the change opens as it would have.
			if (!hasUnsavedEdits()) {
				keeping.current = false;
				openLatest(document);
				return;
			}
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

	/** The drawing, by `drawingRef`, as it was last seen: nothing before its row came. */
	const named = (): readonly string[] => (known.current === undefined ? [] : [known.current]);

	/** Work that keeps the edits as a drawing of their own, until it is done. */
	const keep = (work: Promise<void>) => {
		hold();
		kept.current = work;
		void work.then(() => {
			if (kept.current === work) kept.current = undefined;
			letGo();
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
		known.current = drawingRef(row);
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
		// Raster work still pending is a stroke that is an edit only once it
		// lands: the change waits for it, and it is kept as edits are (`keepCopy`).
		if (document !== undefined && (encoding.current > 0 || hasUnsavedEdits())) {
			keep(keepCopy(document, row));
			return;
		}
		open(row.text);
	};

	/**
	 * A save wrote nothing, the row changed or deleted from elsewhere under it:
	 * the row as the store has it is offered as the live query offers it, so
	 * that the edits are kept by the conflict rule, or in the row's place,
	 * though the change has not reached the editor yet, and as it closes never
	 * will. Offered twice, they are kept once.
	 */
	const offerStored = async (): Promise<void> => {
		offer(foundOf(await getDrawing(db, id)));
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
	 * The pending save made and in, and any save an edit's pause set off while
	 * it was on its way: settling, finding that one's text not in yet, would
	 * otherwise send the same text again beside it.
	 */
	const flushed = async (): Promise<void> => {
		const work = flush();
		await work;
		if ((inFlight.current ?? work) !== work) await flushed();
	};

	/**
	 * Raster work still pending landed, since a stroke is an edit only once
	 * its encoding does, and then the pending save made and in (`flushed`).
	 * Neither rejects.
	 */
	const written = async (): Promise<void> => {
		await state.current.document?.settle();
		await flushed();
	};

	/**
	 * What `settleEditors` asks of an open editor (`store/heldEdits.ts`): what
	 * it holds written now, and this drawing named, by `drawingRef`, if the
	 * store still has not taken it. Raster work still pending goes first, since
	 * a stroke is an edit only once its encoding lands, as `keepDeleted` waits
	 * for it too; then the pending save; then a copy being kept, since the
	 * edits are its: one under way already, which has stopped the save's
	 * timer, or one a save that wrote nothing set off (`offerStored`): a copy
	 * beside a change, or the edits in the place of a row deleted under it.
	 * Edits a save before it left behind — the
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
	const settleOnce = async (): Promise<readonly string[]> => {
		/** Edits the store has not taken, which no copy and no delete of the user's has. */
		const held = (): boolean => !keeping.current && !deleting.current && hasUnsavedEdits();
		await written();
		await keepsDone();
		const document = state.current.document;
		if (document === undefined || !held()) return [];
		// A save of an edit made since is this one.
		stopTimer();
		await save(document);
		await keepsDone();
		return held() ? named() : [];
	};

	const settling = cell<Promise<readonly string[]> | undefined>(undefined);

	/**
	 * `settleOnce`, or the one already going: a settle asked for meanwhile — a
	 * second caller's, or the editor's own as it closes — joins it, so that the
	 * two do not each send the same text again.
	 */
	const settle = (): Promise<readonly string[]> => {
		const going =
			settling.current ??
			settleOnce().finally(() => {
				settling.current = undefined;
			});
		settling.current = going;
		return going;
	};

	/**
	 * Said before the row goes, so that its going is not taken for a delete
	 * from elsewhere, whose edits would be kept as a drawing of their own.
	 */
	const remove = async (): Promise<void> => {
		deleting.current = true;
		stopTimer();
		const work = deleteDrawing(db, id);
		removal.current = work;
		try {
			await work;
			deleted.current = true;
			letGo();
		} catch (error) {
			// The drawing is still here, and so are the edits: saved as before,
			// and asked about as before.
			deleting.current = false;
			hold();
			letGo();
			const document = state.current.document;
			if (document !== undefined && hasUnsavedEdits()) schedule(document);
			throw error;
		}
	};

	const start = () => {
		// A newer build closing the database, a source let go, an export: each
		// has the editor write what it holds first, and hears what it could not.
		// A function of its own each start, since the registry is a set and
		// React starts a session twice in development. Not answered by
		// `FLUSH_WAIT_MS`, it is taken to hold its drawing all the same
		// (`named`), so that a source let go meanwhile keeps its rows: settling
		// is not over, and the edits may yet need them.
		const withdraw = beforeClosing(settle.bind(undefined), named);
		starts.current += 1;
		closed.current = false;
		// A page going, or hidden, which a phone may freeze or end with no
		// `pagehide`, starts the pending save once raster work still pending has
		// landed, as every save waits for it, the stroke it makes among the
		// edits, rather than leaving it to the pause. Not a settle, which every
		// settle asked later would join, taking its answer: one that comes after
		// the user is back, and drawing, is a settle of its own. A hidden page
		// runs on for a moment; one going is gone before the save has opened its
		// transaction (#16).
		const onPageHide = () => {
			void written();
		};
		const onVisibility = () => {
			if (window.document.visibilityState === 'hidden') onPageHide();
		};
		window.addEventListener('pagehide', onPageHide);
		window.document.addEventListener('visibilitychange', onVisibility);
		return () => {
			closed.current = true;
			window.removeEventListener('pagehide', onPageHide);
			window.document.removeEventListener('visibilitychange', onVisibility);
			// Settled as it closes, raster work and a refused save's retry with
			// it, and withdrawn only then, however that went, or once
			// `FLUSH_WAIT_MS` has gone by, so that settling meanwhile waits for
			// it. What the store still refuses goes with the editor: nothing
			// could open what it held again (§10).
			void inTime(settle(), []).then(() => {
				starts.current -= 1;
				letGo();
				withdraw();
			});
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
		written,
		start,
		remove,
	};
};

type OpenDrawing = Opened &
	Readonly<{
		row: DrawingRecord | undefined;
		/** The store has answered that there is no such drawing: never was, or not any more. */
		missing: boolean;
		/**
		 * Raster work still pending landed, and the pending save in, for an
		 * action that reads the row after it: a rename, which would otherwise
		 * meet a stroke landing after it as an edit under a change (#18).
		 */
		written: () => Promise<void>;
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
		written: session.written,
		remove: session.remove,
	};
};
