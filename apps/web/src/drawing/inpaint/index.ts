import type { InpaintReply, InpaintRequest } from './engine.js';
import type { Pixels } from './level.js';

/**
 * Content-aware fill (docs/ARCHITECTURE.md §7, "Tools"): the pixels under a
 * mask made again from the rest of the picture, as Photoshop's Edit > Fill >
 * Content-Aware does. The engine is `./engine.ts`; it runs in a worker of its
 * own (`./inpaint.worker.ts`), so the page never waits on it.
 */

export type { Pixels } from './level.js';

/** What a fill that was aborted rejects with, whatever reason the signal gave. */
const aborted = (): DOMException => new DOMException('The fill was aborted.', 'AbortError');

/**
 * The fill on this thread, where there is no `Worker` (a test, under jsdom or
 * Node): the same engine, loaded only then, yielding to the event loop
 * between its steps so an abort is heard.
 */
const onThisThread = (
	image: Pixels,
	mask: Uint8Array,
	signal: AbortSignal | undefined
): Promise<Uint8ClampedArray> =>
	import('./engine.js').then(({ inpaintPixels }) =>
		inpaintPixels(
			image,
			mask,
			() =>
				new Promise<void>((resolve, reject) => {
					setTimeout(() => {
						if (signal?.aborted === true) reject(aborted());
						else resolve();
					}, 0);
				})
		)
	);

/** A worker running the engine, or undefined where one cannot be started. */
const startWorker = (): Worker | undefined => {
	try {
		return new Worker(new URL('./inpaint.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		return undefined;
	}
};

/**
 * The fill in a worker of its own: copies of the picture and the mask are
 * posted with their buffers transferred, the answer comes back the same way,
 * and the worker is terminated once it has answered, or as soon as `signal`
 * aborts, which stops the work where it is.
 */
const inWorker = (
	worker: Worker,
	image: Pixels,
	mask: Uint8Array,
	signal: AbortSignal | undefined
): Promise<Uint8ClampedArray> =>
	new Promise((resolve, reject) => {
		const stop = (): void => {
			worker.terminate();
			signal?.removeEventListener('abort', onAbort);
		};
		const onAbort = (): void => {
			stop();
			reject(aborted());
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		worker.addEventListener('message', (event: MessageEvent<InpaintReply>) => {
			stop();
			const reply = event.data;
			if ('error' in reply) reject(new Error(reply.error));
			else resolve(new Uint8ClampedArray(reply.data));
		});
		worker.addEventListener('error', (event) => {
			stop();
			reject(new Error(event.message));
		});
		worker.addEventListener('messageerror', () => {
			stop();
			reject(new Error('The fill could not be read back from its worker.'));
		});
		const data = new Uint8ClampedArray(image.data);
		const holes = new Uint8Array(mask);
		const request: InpaintRequest = {
			width: image.width,
			height: image.height,
			data: data.buffer,
			mask: holes.buffer,
		};
		worker.postMessage(request, [data.buffer, holes.buffer]);
	});

/**
 * The picture `image` with the pixels under `mask` (one byte a pixel, row by
 * row, the image's size: 0 kept, anything else made again) filled from the
 * rest of it. Settles on a new array of the whole picture's pixels, `image`
 * untouched; rejects with a `DOMException` named `AbortError` when `signal`
 * aborts. A mask that keeps nothing has nothing to fill from, and settles on
 * the picture as it was.
 *
 * Alpha is a channel like the others, so a hole on transparent pixels fills
 * transparent. The same picture and mask give the same bytes every time.
 * Rejects with a `RangeError` where the mask or the pixels are not the
 * picture's size.
 */
export const inpaint = (
	image: Pixels,
	mask: Uint8Array,
	signal?: AbortSignal
): Promise<Uint8ClampedArray> => {
	if (signal?.aborted === true) return Promise.reject(aborted());
	const count = image.width * image.height;
	if (mask.length !== count || image.data.length !== count * 4) {
		return Promise.reject(
			new RangeError('The mask and the pixels must be the picture’s size.')
		);
	}
	// Nothing to make again, or nothing to make it from: no worker is needed.
	if (!mask.includes(0) || !mask.some((value) => value !== 0)) {
		return Promise.resolve(new Uint8ClampedArray(image.data));
	}
	const worker = typeof Worker === 'undefined' ? undefined : startWorker();
	return worker === undefined
		? onThisThread(image, mask, signal)
		: inWorker(worker, image, mask, signal);
};
