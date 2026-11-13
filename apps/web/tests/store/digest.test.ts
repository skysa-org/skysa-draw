// The worker's entry, loaded here as a worker loads it: it listens on `self`.
import '../../src/store/digest.worker.js';

import { withDrawingId, withDrawingTitle } from '@skysa/draw-core';
import { contentHash } from '@skysa/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Digest from '../../src/store/digest.js';
import { answer, type DigestReply, type DigestRequest } from '../../src/store/digestAnswer.js';
import { createDrawing, getDrawing, renameDrawing, saveDrawing } from '../../src/store/drawings.js';
import { freshDatabase } from '../support/db.js';

/**
 * A drawing's digest off the page's thread (`store/digest.ts`): the same hash
 * as the kit's `contentHash` for every text, in the worker or here; the drawing's
 * id written in as `withDrawingId` writes it; and every way a worker can fail
 * ending in a digest here rather than in a lost save. jsdom has no `Worker`,
 * so a fake stands in for one where a test needs it, passing messages through
 * `structuredClone` as a real one does, and running the worker's own `answer`.
 */

type Behavior = 'answer' | 'reverse' | 'slow' | 'never' | 'fail' | 'garble' | 'cannot' | 'refuse';

/** How long a `slow` fake takes over each request, one after another. */
const SLOW_MS = 20_000;

/**
 * What a `slow` fake answers, by text, worked out before the test's clock is
 * faked: a digest is real work on a real thread, which fake time does not wait
 * for, so a fake that digested as it went would answer after the time it was
 * meant to answer by.
 */
const known = new Map<string, string>();

interface Fake {
	readonly url: string;
	readonly options: WorkerOptions | undefined;
	readonly posted: DigestRequest[];
	terminated: number;
}

const fakes: Fake[] = [];

/**
 * Every request any fake was sent, since the last test. A worker outlives the
 * test that started it where the module is not loaded afresh, as the store's
 * own is not, so its requests are counted here and not on its `Fake`.
 */
const sent: DigestRequest[] = [];

/** A stand-in for `Worker` that runs `answer`, or does as `behavior` says. */
const fakeWorker = (behavior: Behavior) => {
	const make = (url: URL, options?: WorkerOptions) => {
		if (behavior === 'refuse') throw new Error('no workers here');
		const target = new EventTarget();
		const fake: Fake = { url: url.href, options, posted: [], terminated: 0 };
		fakes.push(fake);
		const held: DigestReply[] = [];
		const queue: Promise<void>[] = [Promise.resolve()];
		const reply = (data: DigestReply) => {
			if (fake.terminated > 0) return;
			target.dispatchEvent(new MessageEvent('message', { data: structuredClone(data) }));
		};
		const later = (event: () => Event) =>
			setTimeout(() => {
				target.dispatchEvent(event());
			}, 0);
		return Object.assign(target, {
			postMessage: (message: DigestRequest) => {
				const request = structuredClone(message);
				fake.posted.push(request);
				sent.push(request);
				if (behavior === 'answer') void answer(request).then(reply);
				if (behavior === 'reverse') {
					// Held until two are waiting, then answered last first.
					void answer(request).then((done) => {
						held.push(done);
						if (held.length === 2) [...held].reverse().forEach(reply);
					});
				}
				if (behavior === 'slow') {
					const done = (queue.at(-1) ?? Promise.resolve())
						.then(() => new Promise((resolve) => setTimeout(resolve, SLOW_MS)))
						.then(() => {
							reply({ seq: request.seq, hash: known.get(request.text) ?? '' });
						});
					queue.push(done);
				}
				if (behavior === 'cannot') {
					queueMicrotask(() => reply({ seq: request.seq, error: 'no digest here' }));
				}
				if (behavior === 'fail') {
					later(() => new ErrorEvent('error', { message: 'out of memory' }));
				}
				if (behavior === 'garble') later(() => new MessageEvent('messageerror'));
			},
			terminate: () => {
				fake.terminated += 1;
			},
		});
	};
	// A class whose constructor returns the fake, since `new` needs a constructor.
	return class {
		// eslint-disable-next-line functional/prefer-tacit -- `new` needs a constructor, which cannot be passed point-free
		constructor(url: URL, options?: WorkerOptions) {
			return make(url, options);
		}
	};
};

/** The module afresh, so a test starts with no worker running and none failed. */
const fresh = (): Promise<typeof Digest> => import('../../src/store/digest.js');

/** Long enough to be digested in the worker: 64 KB and more. */
const PAD = 'A'.repeat(70 * 1024);

/** A drawing big enough for the worker, with `title` in it. */
const bigDrawing = (title: string): string =>
	`<svg xmlns="http://www.w3.org/2000/svg"><title>${title}</title><image href="data:image/png;base64,${PAD}"/></svg>\n`;

/** Texts whose UTF-8 is more than one byte a character, or is not their characters at all. */
const EDGES: Readonly<Record<string, string>> = {
	ascii: 'a drawing, plainly',
	nonAscii: 'café — naïve ’quoted’',
	astral: '🎨 𝒳 😀',
	loneHigh: 'a\uD800b',
	loneLow: '\uDC00',
	highAtEnd: 'x\uD83D',
	reversedPair: '\uDE00\uD83D',
	empty: '',
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	fakes.length = 0;
	sent.length = 0;
	known.clear();
});

describe('the worker’s answer', () => {
	it.each(Object.entries(EDGES))('is the kit’s contentHash for %s text', async (_, text) => {
		const reply = await answer({ seq: 1, text, compact: false });
		expect(reply).toEqual({ seq: 1, hash: await contentHash(text) });
	});

	it('sends an ASCII text back, the same text, where a compact copy is asked for', async () => {
		const text = bigDrawing('Plain');
		const reply = await answer({ seq: 2, text, compact: true });
		expect(reply).toEqual({ seq: 2, hash: await contentHash(text), text });
	});

	it('sends nothing back for a text that is not ASCII, which no copy would make smaller', async () => {
		const text = bigDrawing('Café ’s');
		expect(await answer({ seq: 3, text, compact: true })).toEqual({
			seq: 3,
			hash: await contentHash(text),
		});
	});

	it('writes the drawing’s id in first, and digests the file that makes', async () => {
		const text = bigDrawing('Café ’s');
		const file = withDrawingId(text, 'drawing-1');
		expect(await answer({ seq: 4, text, id: 'drawing-1', compact: true })).toEqual({
			seq: 4,
			hash: await contentHash(file),
			text: file,
		});
		// A text that has the id already is its own file, and is not sent back.
		expect(await answer({ seq: 5, text: file, id: 'drawing-1', compact: false })).toEqual({
			seq: 5,
			hash: await contentHash(file),
		});
	});

	it('says why it could not, for a text that is no drawing', async () => {
		const reply = await answer({
			seq: 6,
			text: 'not a drawing',
			id: 'drawing-1',
			compact: true,
		});
		expect(reply).toMatchObject({
			seq: 6,
			error: expect.stringContaining('RangeError') as unknown,
		});
	});
});

describe('the worker', () => {
	it('answers each request with the answer, by its seq', async () => {
		const posted = vi.spyOn(self, 'postMessage').mockImplementation(() => undefined);
		const request: DigestRequest = { seq: 7, text: bigDrawing('Sent'), compact: true };
		self.dispatchEvent(new MessageEvent('message', { data: request }));
		await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
		expect(posted.mock.calls[0]?.[0]).toEqual(await answer(request));
	});
});

describe('digesting where there is no worker', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('is the kit’s contentHash, for a text of any size', async () => {
		// jsdom has none, nor has Node: the premise of every test here.
		expect(typeof Worker).toBe('undefined');
		const { digestText, hashText } = await fresh();
		const texts = Object.values(EDGES).flatMap((edge) => [edge, `${PAD}${edge}${PAD}`]);
		for (const text of texts) {
			const hash = await contentHash(text);
			expect(await digestText(text)).toEqual({ hash, text });
			expect(await hashText(text)).toBe(hash);
		}
	});

	it('writes the drawing’s id in, as withDrawingId does, and refuses what it refuses', async () => {
		const { digestText } = await fresh();
		const file = withDrawingId(bigDrawing('Here'), 'drawing-1');
		expect(await digestText(bigDrawing('Here'), 'drawing-1')).toEqual({
			hash: await contentHash(file),
			text: file,
		});
		await expect(digestText('not a drawing', 'drawing-1')).rejects.toThrow(RangeError);
		await expect(digestText(bigDrawing('Here'), 'not an id!')).rejects.toThrow(RangeError);
	});
});

describe('digesting in a worker', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('posts a big text to one worker, started once and kept, and takes its answer', async () => {
		vi.stubGlobal('Worker', fakeWorker('answer'));
		const { digestText, hashText } = await fresh();
		for (const [name, edge] of Object.entries(EDGES)) {
			const text = `${PAD}${edge}${PAD}`;
			const hash = await contentHash(text);
			expect(await digestText(text), name).toEqual({ hash, text });
			expect(await hashText(text), name).toBe(hash);
		}
		expect(fakes).toHaveLength(1);
		expect(fakes[0]?.url).toMatch(/\/digest\.worker\.ts(\?|$)/);
		expect(fakes[0]?.options).toEqual({ type: 'module' });
		expect(fakes[0]?.posted).toHaveLength(Object.keys(EDGES).length * 2);
		// Only a text that is to be stored is offered back compacted.
		expect(fakes[0]?.posted.map((request) => request.compact).slice(0, 2)).toEqual([
			true,
			false,
		]);
		expect(fakes[0]?.terminated).toBe(0);
	});

	it('digests a small text here, starting no worker for it', async () => {
		vi.stubGlobal('Worker', fakeWorker('answer'));
		const { digestText } = await fresh();
		expect(await digestText('<svg xmlns="http://www.w3.org/2000/svg"/>')).toMatchObject({
			hash: await contentHash('<svg xmlns="http://www.w3.org/2000/svg"/>'),
		});
		expect(fakes).toHaveLength(0);
	});

	it('writes the drawing’s id in there, and stores the file it sends back', async () => {
		vi.stubGlobal('Worker', fakeWorker('answer'));
		const { digestText } = await fresh();
		const file = withDrawingId(bigDrawing('There'), 'drawing-1');
		expect(await digestText(bigDrawing('There'), 'drawing-1')).toEqual({
			hash: await contentHash(file),
			text: file,
		});
		expect(fakes[0]?.posted[0]).toMatchObject({ id: 'drawing-1', compact: true });
	});

	it('matches each answer to its request, in whatever order they come', async () => {
		vi.stubGlobal('Worker', fakeWorker('reverse'));
		const { hashText } = await fresh();
		const [one, two] = [`${PAD}one`, `${PAD}two`];
		expect(await Promise.all([hashText(one), hashText(two)])).toEqual([
			await contentHash(one),
			await contentHash(two),
		]);
		expect(fakes[0]?.posted.map((request) => request.seq)).toEqual([1, 2]);
	});

	it('digests here what a worker could not, and keeps the worker', async () => {
		vi.stubGlobal('Worker', fakeWorker('cannot'));
		const { hashText } = await fresh();
		expect(await hashText(`${PAD}one`)).toBe(await contentHash(`${PAD}one`));
		expect(await hashText(`${PAD}two`)).toBe(await contentHash(`${PAD}two`));
		expect(fakes).toHaveLength(1);
		expect(fakes[0]?.terminated).toBe(0);
	});

	it.each(['fail', 'garble'] as const)(
		'drops a worker that errors (%s), digests here what it had, and starts another',
		async (behavior) => {
			vi.stubGlobal('Worker', fakeWorker(behavior));
			const { digestText } = await fresh();
			const text = bigDrawing('Lost?');
			const waiting = [digestText(text), digestText(`${text} `)];
			expect(await Promise.all(waiting)).toEqual([
				{ hash: await contentHash(text), text },
				{ hash: await contentHash(`${text} `), text: `${text} ` },
			]);
			expect(fakes).toHaveLength(1);
			expect(fakes[0]?.terminated).toBe(1);
			await digestText(text);
			expect(fakes).toHaveLength(2);
		}
	);

	it('starts no more workers once three have failed', async () => {
		vi.stubGlobal('Worker', fakeWorker('fail'));
		const { hashText } = await fresh();
		for (const n of [1, 2, 3, 4, 5]) {
			expect(await hashText(`${PAD}${n}`)).toBe(await contentHash(`${PAD}${n}`));
		}
		expect(fakes).toHaveLength(3);
	});

	it('digests here where no worker can be started', async () => {
		vi.stubGlobal('Worker', fakeWorker('refuse'));
		const { hashText } = await fresh();
		for (const n of [1, 2, 3, 4]) {
			expect(await hashText(`${PAD}${n}`)).toBe(await contentHash(`${PAD}${n}`));
		}
		expect(fakes).toHaveLength(0);
	});

	it('drops a worker that never answers, after a while, and digests here', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('Worker', fakeWorker('never'));
		const { hashText } = await fresh();
		const settled = vi.fn();
		const waiting = hashText(`${PAD}stuck`).then((hash) => {
			settled();
			return hash;
		});
		await vi.advanceTimersByTimeAsync(29_000);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await waiting).toBe(await contentHash(`${PAD}stuck`));
		expect(fakes[0]?.terminated).toBe(1);
	});

	it('is not put off seeing a stuck worker by a request that comes after', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('Worker', fakeWorker('never'));
		const { hashText } = await fresh();
		const first = hashText(`${PAD}first`);
		await vi.advanceTimersByTimeAsync(20_000);
		const second = hashText(`${PAD}second`);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await Promise.all([first, second])).toEqual([
			await contentHash(`${PAD}first`),
			await contentHash(`${PAD}second`),
		]);
		expect(fakes[0]?.terminated).toBe(1);
	});

	it('keeps a worker that is slow but answering, however long its queue takes', async () => {
		const texts = [1, 2, 3].map((n) => `${PAD}${n}`);
		const hashes = await Promise.all(texts.map(contentHash));
		texts.forEach((text, at) => known.set(text, hashes[at] ?? ''));
		vi.useFakeTimers();
		vi.stubGlobal('Worker', fakeWorker('slow'));
		const { hashText } = await fresh();
		const waiting = Promise.all(texts.map(hashText));
		await vi.advanceTimersByTimeAsync(SLOW_MS * 3);
		expect(await waiting).toEqual(hashes);
		expect(fakes).toHaveLength(1);
		expect(fakes[0]?.terminated).toBe(0);
	});
});

describe('a drawing saved through the worker', () => {
	beforeEach(() => {
		vi.stubGlobal('Worker', fakeWorker('answer'));
	});

	it.each([
		['ASCII', 'Plain'],
		['not ASCII', 'Café ’s 🎨'],
	])(
		'is stored as the file, %s, under the kit’s hash, and the same text again is unchanged',
		async (_, title) => {
			const db = freshDatabase();
			const made = await createDrawing(db, { text: bigDrawing(title) });
			expect(made.text).toBe(withDrawingId(bigDrawing(title), made.id));
			expect(made.contentHash).toBe(await contentHash(made.text));

			const edited = bigDrawing(`${title}, edited`);
			expect(await saveDrawing(db, made.id, edited)).toBe('saved');
			const saved = await getDrawing(db, made.id);
			expect(saved?.text).toBe(withDrawingId(edited, made.id));
			expect(saved?.contentHash).toBe(await contentHash(withDrawingId(edited, made.id)));

			// Pushed, say: clean. The same text again writes nothing and leaves it clean.
			await db.drawings.update([made.connectionId, made.id], { dirty: 0 });
			expect(await saveDrawing(db, made.id, edited)).toBe('unchanged');
			expect(await saveDrawing(db, made.id, withDrawingId(edited, made.id))).toBe(
				'unchanged'
			);
			expect((await getDrawing(db, made.id))?.dirty).toBe(0);
			// Each of them through the worker, the drawing's id with it.
			expect(sent.map((request) => request.id)).toEqual([made.id, made.id, made.id, made.id]);
		}
	);

	it('is renamed under the hash of the file the new title makes', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { text: bigDrawing('Before') });
		const renamed = await renameDrawing(db, made.id, 'Après');
		expect(renamed?.text).toBe(withDrawingTitle(made.text, 'Après'));
		expect(renamed?.contentHash).toBe(await contentHash(withDrawingTitle(made.text, 'Après')));
		expect((await getDrawing(db, made.id))?.contentHash).toBe(renamed?.contentHash);
	});
});
