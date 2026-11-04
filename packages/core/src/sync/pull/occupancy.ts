import { foldName } from '../../names/fold.js';
import { basename, isWithin, parentPath } from '../../paths.js';
import type { EngineContext } from '../context.js';
import { drawingIdOf, pathOf, type PullChange, type SyncDrawing } from '../store.js';
import { madeInBatch } from './batch.js';
import { placements } from './replay.js';

/**
 * Who is where once a batch's decisions so far are applied: the drawings that
 * end up in a folder (`drawingsEndingIn`) or under it (`drawingsUnderNow`), and the
 * names a copy or a displacement there must not take (`takenIn`). The store's
 * rows a change is asked about are read once per change (`storeReads`).
 * Moved out of `engine.ts` as they were (#446).
 */

/** A drawing, and where in the folder asked about it lands. */
export type Placed = Readonly<{ drawing: SyncDrawing; path: string }>;

export const createOccupancy = ({ store }: EngineContext) => {
	/**
	 * What the store said when a decision was first asked about, kept with the
	 * decision, which lives no longer than its batch. Nothing the batch decides
	 * is applied until every decision is in, and the rest of the batch is
	 * reached against those same rows. The user can still edit while a pull is
	 * deciding, which no decision here ever saw either: the store checks
	 * whether a drawing is dirty again as it applies. Asked again for every entry
	 * after it, a round of a thousand imported drawings is a million reads of
	 * IndexedDB.
	 *
	 * One cache for each read a change is asked about, so each holds the type
	 * its read gives: the rows under a folder a change moves, and the row of the
	 * drawing a change names. No change is both.
	 */
	const storeReads = {
		drawingsUnder: new WeakMap<PullChange, Promise<SyncDrawing[]>>(),
		drawingById: new WeakMap<PullChange, Promise<SyncDrawing | undefined>>(),
	};

	const storeRead = <T>(
		reads: WeakMap<PullChange, Promise<T>>,
		change: PullChange,
		read: () => Promise<T>
	): Promise<T> => {
		const known = reads.get(change);
		if (known !== undefined) return known;
		const reading = read();
		reads.set(change, reading);
		return reading;
	};

	/**
	 * Every drawing that could possibly end up in or under `folder` once this
	 * batch is applied: the ones the store has there now, the ones under any
	 * folder this batch is moving (which could be carried in), and the ones the
	 * batch has made from nothing. Where each actually lands is `whereNow`'s
	 * question, and the two callers below ask it differently.
	 */
	const drawingsTouching = async (
		folder: string,
		decided: readonly PullChange[]
	): Promise<SyncDrawing[]> => {
		const sources = decided.flatMap((change) =>
			change.kind === 'move-folder'
				? [
						storeRead(storeReads.drawingsUnder, change, () =>
							store.drawingsUnder(change.from)
						),
					]
				: []
		);
		const groups = await Promise.all([store.drawingsUnder(folder), ...sources]);
		// And every drawing an earlier decision has put somewhere by name. A folder
		// is not the only thing that carries a drawing into this one: a `move-drawing`
		// brings a single file in from anywhere at all, and its row is still at
		// the old path in the store, so neither query above can see it. Missing
		// it means nothing is displaced when a second file lands on the same
		// name — two rows at one path, which the sidebar shows twice and which
		// the next push has overwrite each other.
		const named = decided.flatMap((change) => {
			if (change.kind === 'conflict') {
				const { drawingId } = change.resolution;
				return [
					storeRead(storeReads.drawingById, change, () => store.drawingById(drawingId)),
				];
			}
			const id = drawingIdOf(change);
			if (id === undefined || pathOf(change) === undefined) return [];
			return [storeRead(storeReads.drawingById, change, () => store.drawingById(id))];
		});
		const rows = await Promise.all(named);
		// The batch's own first, so a row the store also holds wins: `whereNow`
		// replays the decisions from the pre-batch position, which is the one to
		// start from wherever there is one. The store's two sources overlap with
		// each other when a folder moves within itself.
		const candidates = new Map(
			[...madeInBatch(decided), ...groups.flat(), ...rows.flatMap((row) => row ?? [])].map(
				(drawing) => [drawing.id, drawing]
			)
		);
		return [...candidates.values()];
	};

	/**
	 * Every drawing that is in `folder` once the decisions so far have been
	 * applied, with where in it each one lands.
	 *
	 * Two sources, because the store alone answers neither question. Drawings
	 * already under the folder may be about to move out of it or be taken away,
	 * and drawings under a folder this batch is *moving here* arrive without ever
	 * being mentioned: a rename re-lists no children, so the entry for the
	 * folder is the only thing in the batch that says where they went.
	 */
	const drawingsEndingIn = async (
		folder: string,
		decided: readonly PullChange[]
	): Promise<Placed[]> => {
		const candidates = await drawingsTouching(folder, decided);
		const placed = placements(decided);
		return candidates.flatMap((drawing) => {
			const { at } = placed(drawing);
			return at === undefined || parentPath(at) !== folder ? [] : [{ drawing, path: at }];
		});
	};

	/** The same question asked of a whole subtree, for a folder about to move. */
	const drawingsUnderNow = async (
		folder: string,
		decided: readonly PullChange[]
	): Promise<Placed[]> => {
		const candidates = await drawingsTouching(folder, decided);
		const placed = placements(decided);
		return candidates.flatMap((drawing) => {
			const { at } = placed(drawing);
			return at === undefined || !isWithin(at, folder) ? [] : [{ drawing, path: at }];
		});
	};

	/**
	 * Names a conflict copy or a displacement in this folder must not take:
	 * what is already there, what this batch is bringing in (`claimed` — the
	 * copy another device made a minute ago arrives as an ordinary entry), and
	 * what this batch has already chosen.
	 */
	const takenIn = async (
		folder: string,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[]
	): Promise<string[]> => {
		const paths = [
			...(await drawingsEndingIn(folder, decided)).map((entry) => entry.path),
			...claimed,
			// And every name this batch has already put a drawing at. One entry can
			// need two of these — a drawing moved *and* edited remotely onto a path
			// we have something at wants a displacement and a conflict copy, both
			// named from the same path — and they would otherwise get the same one.
			...decided.flatMap((change) => {
				if (change.kind === 'displace-drawing') return [change.path];
				return change.kind === 'conflict' ? [change.resolution.copyPath] : [];
			}),
		];
		// Folded, because `conflictName` folds: a name dropped from this list for
		// being spelled `Archive` where the folder says `archive` is a name the
		// copy is then free to land on, and that copy is the only place the
		// user's losing edit exists.
		//
		// Reaches `claimed` and the batch's own choices, and **not** the store's
		// rows: `drawingsEndingIn` above filters by parent byte-exactly, and its
		// candidates come from `store.drawingsUnder`, which is `isWithin` and also
		// byte-exact. So a sibling the store holds under `Cafe\u0301/` is gone
		// before this fold runs, and a copy for `Caf\u00e9/a.svg` can still land
		// on it. Closing that means folding `isWithin` — and `rebasePath` with
		// it, since a folded check over a byte-exact rewriter is this bug again
		// one level down. Tracked as its own change rather than widened here.
		const at = foldName(folder);
		return paths.filter((path) => foldName(parentPath(path)) === at).map(basename);
	};

	return { drawingsEndingIn, drawingsUnderNow, takenIn };
};

/** What the pull's other parts are handed of it. */
export type Occupancy = ReturnType<typeof createOccupancy>;
