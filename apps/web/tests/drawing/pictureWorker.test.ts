import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The worker's entry, loaded here as a worker loads it: it listens on `self`,
// and says it does through `self.postMessage`, which jsdom's window would
// refuse without a target origin, so that is caught before it loads.
const posted = vi.hoisted(() => {
	const calls: unknown[][] = [];
	Object.defineProperty(self, 'postMessage', {
		configurable: true,
		writable: true,
		value: (...args: unknown[]) => {
			calls.push(args);
		},
	});
	return calls;
});

import '../../src/drawing/pictures/pictures.worker.js';

import { answerPicture } from '../../src/drawing/pictures/answer.js';
import {
	createPictureWork,
	encodeInWorker,
	encodePatience,
	PATIENCE,
	shrinkInWorker,
	shrinkPatience,
} from '../../src/drawing/pictures/index.js';
import type { PictureReply, PictureRequest } from '../../src/drawing/pictures/protocol.js';

/**
 * Picture work off the page's thread (`src/drawing/pictures/`): the worker's
 * side, which decodes a picture from its own bytes, shrinks it and encodes
 * it, and encodes a layer's pixels, each as a PNG `data:` URL; and the page's
 * side, which starts one worker, posts once it listens, matches each reply to
 * its request by id, and says at once where there is no worker to ask, so
 * the work is done on the page's thread as before. jsdom has none of
 * `Worker`, `OffscreenCanvas`, `createImageBitmap` or `FileReaderSync`, so
 * fakes stand in for them: a bitmap is its size, and a PNG the size it was
 * encoded at.
 */

type FakeBitmap = { width: number; height: number; closed: number; close: () => void };

/** A bitmap of a size; closing it, or transferring it away, leaves it 0 × 0, as a real one is. */
const bitmapOf = (width: number, height: number): FakeBitmap => {
	const bitmap: FakeBitmap = {
		width,
		height,
		closed: 0,
		close: () => {
			bitmap.closed += 1;
			bitmap.width = 0;
			bitmap.height = 0;
		},
	};
	return bitmap;
};

/** A fake bitmap is an `ImageBitmap` by its shape: its size, and `close`. */
const asBitmap = (bitmap: FakeBitmap): ImageBitmap => bitmap;

type Made = { width: number; height: number; drawn: unknown[][]; types: (string | undefined)[] };

const offscreen = { made: [] as Made[], fails: false };

/** `OffscreenCanvas`: records what is drawn, and encodes a PNG of its size, or fails to when told. */
class FakeOffscreenCanvas {
	constructor(width: number, height: number) {
		const made: Made = { width, height, drawn: [], types: [] };
		offscreen.made.push(made);
		return {
			width,
			height,
			getContext: () => ({
				drawImage: (...args: unknown[]) => {
					made.drawn.push(args);
				},
			}),
			convertToBlob: (options?: ImageEncodeOptions) => {
				made.types.push(options?.type);
				return offscreen.fails
					? Promise.reject(new Error('out of memory'))
					: Promise.resolve(
							new Blob([`pixels ${String(width)}x${String(height)}`], {
								type: options?.type ?? '',
							})
						);
			},
		};
	}
}

/** `FileReaderSync`, reading a blob into a `data:` URL of its text. */
class FakeFileReaderSync {
	readonly readAsDataURL = (blob: Blob): string =>
		`data:${blob.type};base64,${btoa(String(blob.size))}`;
}

const pngOf = (width: number, height: number): string =>
	`data:image/png;base64,${btoa(String(`pixels ${String(width)}x${String(height)}`.length))}`;

/** What `createImageBitmap` decodes a picture's blob to, and what it was asked. */
const decoding = { size: { width: 4000, height: 3000 }, fails: false };

const createImageBitmapFake = vi.fn(
	(source: unknown, options?: ImageBitmapOptions): Promise<ImageBitmap> => {
		if (decoding.fails) return Promise.reject(new Error('not a picture'));
		if (options?.resizeWidth !== undefined && options.resizeHeight !== undefined) {
			return Promise.resolve(asBitmap(bitmapOf(options.resizeWidth, options.resizeHeight)));
		}
		if (source instanceof HTMLCanvasElement) {
			return Promise.resolve(asBitmap(bitmapOf(source.width, source.height)));
		}
		return Promise.resolve(asBitmap(bitmapOf(decoding.size.width, decoding.size.height)));
	}
);

const stubBrowser = (): void => {
	vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
	vi.stubGlobal('FileReaderSync', FakeFileReaderSync);
	vi.stubGlobal('createImageBitmap', createImageBitmapFake);
};

const PHOTO = `data:image/jpeg;base64,${btoa('a photo')}`;

beforeEach(() => {
	offscreen.made.length = 0;
	offscreen.fails = false;
	decoding.size = { width: 4000, height: 3000 };
	decoding.fails = false;
	createImageBitmapFake.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('the worker’s answers', () => {
	beforeEach(stubBrowser);

	it('make a stand-in of a picture from its own bytes, at the stand-in size, at the best smoothing', async () => {
		const { reply, transfer } = await answerPicture({
			id: 7,
			kind: 'shrink',
			href: PHOTO,
			most: 256,
		});
		expect(reply).toEqual({ id: 7, href: pngOf(256, 192) });
		expect(transfer).toEqual([]);
		const [decoded, resized] = createImageBitmapFake.mock.calls;
		expect(decoded?.[0]).toBeInstanceOf(Blob);
		const blob = decoded?.[0] as Blob;
		expect(blob.type).toBe('image/jpeg');
		expect(await blob.text()).toBe('a photo');
		expect(resized?.[1]).toEqual({
			resizeWidth: 256,
			resizeHeight: 192,
			resizeQuality: 'high',
		});
		expect(offscreen.made).toEqual([
			{ width: 256, height: 192, drawn: [[expect.anything(), 0, 0]], types: ['image/png'] },
		]);
		// Both bitmaps let go of: the whole picture and its stand-in.
		const bitmaps = await Promise.all(
			createImageBitmapFake.mock.results.map((result) => result.value as Promise<FakeBitmap>)
		);
		expect(bitmaps.map((bitmap) => bitmap.closed)).toEqual([1, 1]);
	});

	it('let a picture no larger than the stand-in stand for itself', async () => {
		decoding.size = { width: 200, height: 256 };
		const { reply } = await answerPicture({ id: 1, kind: 'shrink', href: PHOTO, most: 256 });
		expect(reply).toEqual({ id: 1, href: PHOTO });
		expect(offscreen.made).toEqual([]);
	});

	it('say why where a picture is not one they can read or decode', async () => {
		const svg = await answerPicture({
			id: 2,
			kind: 'shrink',
			href: 'data:image/svg+xml,%3Csvg%2F%3E',
			most: 256,
		});
		expect(svg.reply.id).toBe(2);
		expect(svg.reply).toHaveProperty('error');
		expect(createImageBitmapFake).not.toHaveBeenCalled();
		decoding.fails = true;
		const broken = await answerPicture({ id: 3, kind: 'shrink', href: PHOTO, most: 256 });
		expect(broken.reply).toEqual({ id: 3, error: 'not a picture' });
	});

	it('encode pixels as they are, at their size, and let the bitmap go', async () => {
		const bitmap = bitmapOf(4000, 3000);
		const { reply, transfer } = await answerPicture({
			id: 4,
			kind: 'encode',
			bitmap: asBitmap(bitmap),
		});
		expect(reply).toEqual({ id: 4, href: pngOf(4000, 3000) });
		expect(transfer).toEqual([]);
		expect(offscreen.made).toEqual([
			{ width: 4000, height: 3000, drawn: [[bitmap, 0, 0]], types: ['image/png'] },
		]);
		expect(bitmap.closed).toBe(1);
	});

	it('give the pixels back where they could not be encoded', async () => {
		offscreen.fails = true;
		const bitmap = bitmapOf(40, 30);
		const { reply, transfer } = await answerPicture({
			id: 5,
			kind: 'encode',
			bitmap: asBitmap(bitmap),
		});
		expect(reply).toEqual({ id: 5, error: 'out of memory', bitmap });
		expect(transfer).toEqual([bitmap]);
		expect(bitmap.closed).toBe(0);
	});
});

describe('the worker', () => {
	beforeEach(stubBrowser);

	it('says it listens as it starts, answers a request by its id, and lets anything else be', async () => {
		expect(posted[0]).toEqual([{ ready: true }]);
		const before = posted.length;
		self.dispatchEvent(new MessageEvent('message', { data: { ready: true } }));
		self.dispatchEvent(
			new MessageEvent('message', {
				data: { id: 9, kind: 'encode', bitmap: bitmapOf(10, 10) },
			})
		);
		await vi.waitFor(() => expect(posted).toHaveLength(before + 1));
		expect(posted.at(-1)).toEqual([{ id: 9, href: pngOf(10, 10) }, { transfer: [] }]);
	});
});

type Posted = Readonly<{ message: PictureRequest; transfer: readonly unknown[] }>;

type FakeWorker = EventTarget & {
	posted: Posted[];
	terminated: number;
	postMessage: (message: PictureRequest, transfer: readonly unknown[]) => void;
	terminate: () => void;
};

/** A worker that posts nothing until it is told to; a transferred bitmap is left 0 × 0 here. */
const fakeWorker = (): FakeWorker => {
	const worker: FakeWorker = Object.assign(new EventTarget(), {
		posted: [] as Posted[],
		terminated: 0,
		postMessage: (message: PictureRequest, transfer: readonly unknown[]) => {
			worker.posted.push({ message, transfer });
			transfer.forEach((each) => {
				Object.assign(each as FakeBitmap, { width: 0, height: 0 });
			});
		},
		terminate: () => {
			worker.terminated += 1;
		},
	});
	return worker;
};

const hello = (worker: FakeWorker): void => {
	worker.dispatchEvent(new MessageEvent('message', { data: { ready: true } }));
};

const reply = (worker: FakeWorker, data: PictureReply): void => {
	worker.dispatchEvent(new MessageEvent('message', { data }));
};

const fail = (worker: FakeWorker, message: string): void => {
	worker.dispatchEvent(new ErrorEvent('error', { message }));
};

/** Picture work over fake workers, each one kept to be driven by hand. */
const workOver = () => {
	const workers: FakeWorker[] = [];
	const start = vi.fn(() => {
		const worker = fakeWorker();
		workers.push(worker);
		return worker as unknown as Worker;
	});
	return { workers, start, work: createPictureWork(start) };
};

const canvasOf = (width: number, height: number): HTMLCanvasElement => {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
};

/** An encoding on this thread, which says what it was given. */
const hereFake = () =>
	vi.fn((canvas: HTMLCanvasElement) =>
		Promise.resolve(`here:${String(canvas.width)}x${String(canvas.height)}`)
	);

describe('the page’s side', () => {
	it('says at once there is no worker where the browser cannot run the work in one', () => {
		const { start, work } = workOver();
		expect(work.shrink(PHOTO, 256)).toBeUndefined();
		expect(work.encode(canvasOf(4, 4), hereFake())).toBeUndefined();
		expect(start).not.toHaveBeenCalled();
		// jsdom, as the app runs in it: no `Worker`, so every caller works on its own thread.
		stubBrowser();
		expect(shrinkInWorker(PHOTO, 256)).toBeUndefined();
		expect(encodeInWorker(canvasOf(4, 4), hereFake())).toBeUndefined();
	});

	it('tries no worker again where one cannot be started', () => {
		stubBrowser();
		const start = vi.fn(() => undefined);
		const work = createPictureWork(start);
		expect(work.encode(canvasOf(4, 4), hereFake())).toBeUndefined();
		expect(work.shrink(PHOTO, 256)).toBeUndefined();
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('asks nothing of the worker for a picture it cannot decode', () => {
		stubBrowser();
		const { start, work } = workOver();
		expect(work.shrink('data:image/svg+xml;base64,PHN2Zy8+', 256)).toBeUndefined();
		expect(work.shrink('data:image/png,PNG', 256)).toBeUndefined();
		expect(work.shrink('https://example.test/photo.png', 256)).toBeUndefined();
		expect(start).not.toHaveBeenCalled();
	});

	it('posts once the worker listens, and gives each request its own reply, in whatever order they come', async () => {
		stubBrowser();
		const { workers, start, work } = workOver();
		const first = work.shrink(PHOTO, 256);
		const other = `data:image/png;base64,${btoa('another')}`;
		const second = work.shrink(other, 64);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		await Promise.resolve();
		expect(worker.posted).toEqual([]);
		hello(worker);
		await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
		expect(worker.posted.map(({ message }) => message)).toEqual([
			{ id: 1, kind: 'shrink', href: PHOTO, most: 256 },
			{ id: 2, kind: 'shrink', href: other, most: 64 },
		]);
		reply(worker, { id: 2, href: 'data:small-other' });
		reply(worker, { id: 1, href: 'data:small-photo' });
		await expect(second).resolves.toBe('data:small-other');
		await expect(first).resolves.toBe('data:small-photo');
		reply(worker, { id: 1, href: 'data:again' });
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('rejects a stand-in the worker could not make', async () => {
		stubBrowser();
		const { workers, work } = workOver();
		const asked = work.shrink(PHOTO, 256);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		hello(worker);
		await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
		reply(worker, { id: 1, error: 'not a picture' });
		await expect(asked).rejects.toThrow('not a picture');
	});

	it('encodes a snapshot taken when asked, transferred to the worker', async () => {
		stubBrowser();
		const { workers, work } = workOver();
		const canvas = canvasOf(40, 30);
		const here = hereFake();
		const encoding = work.encode(canvas, here);
		expect(createImageBitmapFake).toHaveBeenCalledWith(canvas);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		hello(worker);
		await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
		const [request] = worker.posted;
		expect(request?.message).toMatchObject({ id: 1, kind: 'encode' });
		expect(request?.transfer).toEqual([(request?.message as { bitmap: unknown }).bitmap]);
		reply(worker, { id: 1, href: 'data:image/png;base64,UE5H' });
		await expect(encoding).resolves.toBe('data:image/png;base64,UE5H');
		expect(here).not.toHaveBeenCalled();
	});

	it('encodes the snapshot here where the worker gives it back', async () => {
		stubBrowser();
		const drawn: unknown[][] = [];
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
			() =>
				({
					drawImage: (...args: unknown[]) => {
						drawn.push(args);
					},
				}) as never
		);
		const { workers, work } = workOver();
		const here = hereFake();
		const encoding = work.encode(canvasOf(40, 30), here);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		hello(worker);
		await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
		const back = bitmapOf(40, 30);
		reply(worker, { id: 1, error: 'out of memory', bitmap: asBitmap(back) });
		await expect(encoding).resolves.toBe('here:40x30');
		expect(drawn).toEqual([[back, 0, 0]]);
		expect(back.closed).toBe(1);
		// The canvas it was drawn on is let go of once it is encoded.
		expect(here.mock.calls[0]?.[0].width).toBe(0);
	});

	it('does what was asked here where the worker fails before it listens, and tries none again', async () => {
		stubBrowser();
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
			() => ({ drawImage: () => undefined }) as never
		);
		const { workers, start, work } = workOver();
		const here = hereFake();
		const encoding = work.encode(canvasOf(40, 30), here);
		const shrinking = work.shrink(PHOTO, 256);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		await Promise.resolve();
		fail(worker, 'blocked');
		await expect(shrinking).rejects.toThrow('blocked');
		await expect(encoding).resolves.toBe('here:40x30');
		expect(worker.posted).toEqual([]);
		expect(worker.terminated).toBe(1);
		expect(work.shrink(PHOTO, 256)).toBeUndefined();
		expect(work.encode(canvasOf(4, 4), here)).toBeUndefined();
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('drops a worker that fails once it listened, and starts another for the next request', async () => {
		stubBrowser();
		const { workers, start, work } = workOver();
		const canvas = canvasOf(40, 30);
		const here = hereFake();
		const encoding = work.encode(canvas, here);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		hello(worker);
		await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
		fail(worker, 'crashed');
		// The snapshot went with the worker: the canvas as it is now is encoded instead.
		await expect(encoding).resolves.toBe('here:40x30');
		expect(here).toHaveBeenCalledWith(canvas);
		expect(worker.terminated).toBe(1);
		const again = work.shrink(PHOTO, 256);
		expect(start).toHaveBeenCalledTimes(2);
		const next = workers[1];
		if (next === undefined) throw new Error('another worker starts');
		hello(next);
		await vi.waitFor(() => expect(next.posted).toHaveLength(1));
		expect(next.posted[0]?.message).toMatchObject({ id: 2, kind: 'shrink' });
		reply(next, { id: 2, href: 'data:small' });
		await expect(again).resolves.toBe('data:small');
	});

	it('encodes the canvas here where no snapshot of it can be taken', async () => {
		stubBrowser();
		const { work } = workOver();
		createImageBitmapFake.mockImplementationOnce(() =>
			Promise.reject(new DOMException('empty', 'InvalidStateError'))
		);
		const canvas = canvasOf(0, 0);
		const here = hereFake();
		await expect(work.encode(canvas, here)).resolves.toBe('here:0x0');
		expect(here).toHaveBeenCalledWith(canvas);
	});
});

describe('a worker that stops answering', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		stubBrowser();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('is waited for ten seconds and more, a second for each megapixel or megabyte of work', () => {
		expect(PATIENCE).toEqual({ floorMs: 10_000, msPerMegapixel: 1_000, msPerMegabyte: 1_000 });
		expect(encodePatience(0)).toBe(10_000);
		expect(encodePatience(4000 * 3000)).toBe(22_000);
		expect(shrinkPatience(15_000_000)).toBe(25_000);
	});

	it('is dropped once a request waits past its patience, what it was asked fails, and a late reply is not heard', async () => {
		const { workers, start, work } = workOver();
		const shrinking = work.shrink(PHOTO, 256);
		const settled = vi.fn();
		void shrinking?.then(settled, settled);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		hello(worker);
		await vi.advanceTimersByTimeAsync(0);
		expect(worker.posted).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(shrinkPatience(PHOTO.length) - 1);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await expect(shrinking).rejects.toThrow('did not answer');
		expect(worker.terminated).toBe(1);
		reply(worker, { id: 1, href: 'data:too-late' });
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toHaveBeenCalledTimes(1);
		// The next request starts a fresh worker, which answers.
		const again = work.shrink(PHOTO, 256);
		expect(start).toHaveBeenCalledTimes(2);
		const next = workers[1];
		if (next === undefined) throw new Error('another worker starts');
		hello(next);
		await vi.advanceTimersByTimeAsync(0);
		expect(next.posted[0]?.message).toMatchObject({ id: 2, kind: 'shrink' });
		reply(next, { id: 2, href: 'data:small' });
		await expect(again).resolves.toBe('data:small');
	});

	it('encodes here what it held: the canvas as it is now, the snapshot having gone with it', async () => {
		const { workers, work } = workOver();
		const canvas = canvasOf(40, 30);
		const here = hereFake();
		const encoding = work.encode(canvas, here);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		hello(worker);
		await vi.advanceTimersByTimeAsync(0);
		expect(worker.posted).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(encodePatience(40 * 30));
		await expect(encoding).resolves.toBe('here:40x30');
		expect(here).toHaveBeenCalledWith(canvas);
		expect(worker.terminated).toBe(1);
	});

	it('is not cut short on a large encoding that takes a while', async () => {
		const { workers, work } = workOver();
		const here = hereFake();
		const encoding = work.encode(canvasOf(10_000, 10_000), here);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		hello(worker);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(worker.terminated).toBe(0);
		reply(worker, { id: 1, href: 'data:image/png;base64,QklH' });
		await expect(encoding).resolves.toBe('data:image/png;base64,QklH');
		expect(here).not.toHaveBeenCalled();
	});

	it('encodes each snapshot here where it never said it listens, and none is started again', async () => {
		const drawn: unknown[][] = [];
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
			() =>
				({
					drawImage: (...args: unknown[]) => {
						drawn.push(args);
					},
				}) as never
		);
		const { workers, start, work } = workOver();
		const here = hereFake();
		const first = work.encode(canvasOf(40, 30), here);
		const second = work.encode(canvasOf(20, 10), here);
		const [worker] = workers;
		if (worker === undefined) throw new Error('a worker starts');
		await vi.advanceTimersByTimeAsync(encodePatience(40 * 30));
		await expect(first).resolves.toBe('here:40x30');
		await expect(second).resolves.toBe('here:20x10');
		// Drawn from the snapshots, which were never posted.
		expect(drawn.map(([bitmap]) => (bitmap as FakeBitmap).closed)).toEqual([1, 1]);
		expect(worker.posted).toEqual([]);
		expect(worker.terminated).toBe(1);
		hello(worker);
		await vi.advanceTimersByTimeAsync(0);
		expect(worker.posted).toEqual([]);
		expect(work.encode(canvasOf(4, 4), here)).toBeUndefined();
		expect(start).toHaveBeenCalledTimes(1);
	});
});
