import { cell, contentHash } from '@skysa/storage';

import { type DigestReply, type DigestRequest, fileOf } from './digestAnswer.js';

/**
 * A drawing's `contentHash`, worked out in a worker of its own rather than on
 * the page's thread (`./digestAnswer.ts` does the work). A drawing with a big
 * picture in it is a text of many megabytes, and every save digests it: a
 * 15 MB text is 20 to 30 ms of `TextEncoder` and `digest` here, and a few
 * to post there. The hash is the same either way, and where there is no
 * worker — under jsdom and Node, in a test — or it fails in any way, the text
 * is digested here, by core's `contentHash` itself.
 *
 * One worker, started on the first text big enough to need it and kept,
 * since a save comes every few seconds while the user draws; its requests are
 * matched to its replies by a sequence number. One that errors, cannot be
 * read back from, or answers nothing for `STUCK_AFTER_MS` while it has
 * requests is terminated and dropped, every request it had is digested here,
 * and the next text starts another, until `MAX_FAILURES` have failed and
 * every digest stays here.
 */

/**
 * Texts shorter than this are digested here. Posting a text costs the page a
 * copy of it, and the answer comes a task later; at 64 KB, digesting it here
 * costs as little as posting it, a tenth of a millisecond, and a pull of many
 * small drawings is not queued behind one worker.
 */
const OFF_THREAD_FROM = 64 * 1024;

/**
 * Longer than any text takes, by far: a worker with requests waiting that
 * has answered none of them for this long is stuck. Counted from its last
 * answer, so a long queue of texts it is getting through is not.
 */
const STUCK_AFTER_MS = 30_000;

/** Workers that may fail before every text is digested here for the rest of the session. */
const MAX_FAILURES = 3;

/** The file to store, perhaps held more compactly than the text it was made from, and its hash. */
interface Digested {
	readonly hash: string;
	readonly text: string;
}

interface Digester {
	readonly dropped: () => boolean;
	/** The worker's reply, or nothing where the worker is gone. */
	readonly ask: (request: Omit<DigestRequest, 'seq'>) => Promise<DigestReply | undefined>;
}

const failures = cell(0);
const running = cell<Digester | undefined>(undefined);

const startWorker = (): Worker | undefined => {
	try {
		return new Worker(new URL('./digest.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		return undefined;
	}
};

/** A worker, and the requests it has yet to answer. */
const digesterOf = (worker: Worker): Digester => {
	const waiting = new Map<number, (reply: DigestReply | undefined) => void>();
	const lastSeq = cell(0);
	const dropped = cell(false);
	const stuck = cell<ReturnType<typeof setTimeout> | undefined>(undefined);
	const drop = (): void => {
		if (dropped.current) return;
		dropped.current = true;
		failures.current += 1;
		clearTimeout(stuck.current);
		worker.terminate();
		waiting.forEach((settle) => {
			settle(undefined);
		});
		waiting.clear();
	};
	/** The watch for a stuck worker, from now, while anything is waiting. */
	const watch = (): void => {
		clearTimeout(stuck.current);
		stuck.current = waiting.size === 0 ? undefined : setTimeout(drop, STUCK_AFTER_MS);
	};
	worker.addEventListener('message', (event: MessageEvent<DigestReply>) => {
		const reply = event.data;
		const settle = waiting.get(reply.seq);
		waiting.delete(reply.seq);
		watch();
		settle?.(reply);
	});
	worker.addEventListener('error', drop);
	worker.addEventListener('messageerror', drop);
	return {
		dropped: () => dropped.current,
		ask: (asked) =>
			new Promise((resolve) => {
				if (dropped.current) {
					resolve(undefined);
					return;
				}
				lastSeq.current += 1;
				const seq = lastSeq.current;
				waiting.set(seq, resolve);
				// Watched from the first request; a later one does not put the
				// watch off, or a worker stuck on the first would never be seen.
				if (waiting.size === 1) watch();
				const request: DigestRequest = { ...asked, seq };
				try {
					worker.postMessage(request);
				} catch {
					drop();
				}
			}),
	};
};

/** The worker running, or one started now; nothing where there can be none. */
const digester = (): Digester | undefined => {
	if (running.current !== undefined && !running.current.dropped()) return running.current;
	if (typeof Worker === 'undefined' || failures.current >= MAX_FAILURES) return undefined;
	const worker = startWorker();
	if (worker === undefined) failures.current += 1;
	running.current = worker === undefined ? undefined : digesterOf(worker);
	return running.current;
};

const digest = async (asked: Omit<DigestRequest, 'seq'>): Promise<Digested> => {
	const { text, id } = asked;
	const reply = text.length < OFF_THREAD_FROM ? undefined : await digester()?.ask(asked);
	if (reply !== undefined && !('error' in reply)) {
		return { hash: reply.hash, text: reply.text ?? text };
	}
	// Here, as core has it: a text that is no drawing, or an id that is none,
	// throws here as it would have.
	const file = fileOf(text, id);
	return { hash: await contentHash(file), text: file };
};

/**
 * The file to store for a drawing's text, and its `contentHash`: the text
 * with `id` written in where one is given (`withDrawingId`), held one byte to
 * a character where it is ASCII throughout and was held in two
 * (`./digestAnswer.ts` says why that matters). What a writer that stores a
 * drawing's text digests it with.
 */
export const digestText = (text: string, id?: string): Promise<Digested> =>
	digest({ text, ...(id === undefined ? {} : { id }), compact: true });

/** `contentHash(text)`, for a text that is only being compared. */
export const hashText = async (text: string): Promise<string> =>
	(await digest({ text, compact: false })).hash;
