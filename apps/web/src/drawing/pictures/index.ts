import { type Cell, cell } from '@skysa/draw-core';

import { releaseCanvas } from '../tools/raster/area.js';
import {
	decodesInWorker,
	type PictureHello,
	type PictureReply,
	type PictureRequest,
} from './protocol.js';

/**
 * Picture work off the page's thread (docs/ARCHITECTURE.md §7, "The
 * editor"): the layers panel's stand-ins (`../panels/previewPictures.ts`)
 * and a raster layer's pixels encoded as PNG (`../tools/raster/surface.ts`),
 * done in one worker (`./pictures.worker.ts`), so a stroke on a picture of
 * millions of pixels does not hold the page while its PNG is made, nor while
 * its preview's is. The worker is started the first time it is asked for and
 * kept for the page; the requests to it are told apart by an id, so they
 * may be answered in any order.
 *
 * Where there is no worker to ask, each of these says so at once, by giving
 * back nothing, and the caller does the work on this thread as it always
 * did: a browser without `Worker`, `OffscreenCanvas` or `createImageBitmap`,
 * jsdom among them, a picture the worker cannot decode, or a worker that
 * failed before it listened, after which none is started again. One that
 * fails once it listened is dropped, what it was asked fails, and the next
 * request starts another. A failure comes back to the caller as one, for a
 * stand-in, and is made good here, for pixels: the snapshot taken when the
 * encoding was asked for is encoded on this thread instead.
 *
 * A worker that stops answering, with no error to say so, fails the same
 * way once a request has waited past its patience (`PATIENCE`): a raster
 * layer's writes land in turn, so one encoding that never settled would hold
 * every stroke after it out of the file. The patience grows with the work,
 * and is wide enough that a slow device's encoding is not cut short; a reply
 * that comes after it is not heard.
 */

/** A canvas's pixels as a PNG `data:` URL, on this thread. */
type EncodeHere = (canvas: HTMLCanvasElement) => Promise<string>;

type PictureWork = Readonly<{
	/** The picture's stand-in made in the worker; nothing where it cannot be. Rejects where the worker failed. */
	shrink: (href: string, most: number) => Promise<string> | undefined;
	/**
	 * The canvas's pixels as they are now, encoded as PNG in the worker, and by
	 * `here` from a copy of them where the worker fails; nothing where there is
	 * no worker to try, and the caller encodes them itself. Rejects only where
	 * `here` does.
	 */
	encode: (canvas: HTMLCanvasElement, here: EncodeHere) => Promise<string> | undefined;
}>;

/**
 * How long a request waits for its reply before the worker is taken to be
 * stuck: a floor for any request, which covers a worker's start, and more
 * for the size of the work. Measured in Chromium on a laptop, the worker
 * encodes a photo of 8.3 megapixels in 140 ms and 12 megapixels of noise,
 * which compresses worst, in 290 ms, some 17 and 24 ms a megapixel, and
 * makes the stand-in of a picture whose `href` is 15 MB in 70 ms. A second
 * a megapixel, or a megabyte, is forty times the slowest of those: a device
 * ten times slower still has four times the room, and a layer of 4000 by
 * 3000 is given 22 seconds.
 */
export const PATIENCE = {
	/** What any request is given, in milliseconds. */
	floorMs: 10_000,
	/** More for each megapixel encoded. */
	msPerMegapixel: 1_000,
	/** More for each million characters of the `href` a stand-in is made from. */
	msPerMegabyte: 1_000,
} as const;

/** How long an encoding of `pixels` pixels is waited for. */
export const encodePatience = (pixels: number): number =>
	PATIENCE.floorMs + (PATIENCE.msPerMegapixel * pixels) / 1_000_000;

/** How long a stand-in of a picture whose `href` is `length` characters is waited for. */
export const shrinkPatience = (length: number): number =>
	PATIENCE.floorMs + (PATIENCE.msPerMegabyte * length) / 1_000_000;

type Waiter = Readonly<{
	answer: (reply: PictureReply) => void;
	/** Fails the worker once the request has waited past its patience. */
	timer: ReturnType<typeof setTimeout>;
}>;

type Connection = Readonly<{
	worker: Worker;
	/** Settles once the worker listens, and never where it does not. */
	ready: Promise<void>;
	/** Whether it has said it listens. */
	listening: Cell<boolean>;
	/** What was asked and not answered, by the request's id. */
	waiting: Map<number, Waiter>;
}>;

/** Whether this browser could run the work in a worker at all; where `Worker` is missing, `start` gives nothing. */
const workable = (): boolean =>
	typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';

/** A snapshot of the canvas's pixels, taken now, as `createImageBitmap` takes it when it is called. */
const snapshotOf = (canvas: HTMLCanvasElement): Promise<ImageBitmap> => {
	try {
		return createImageBitmap(canvas);
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
};

/** The bitmap's pixels encoded by `here` on a canvas of their own, let go of once they are. */
const encodeBitmapHere = (bitmap: ImageBitmap, here: EncodeHere): Promise<string> => {
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
	bitmap.close();
	return here(canvas).finally(() => {
		releaseCanvas(canvas);
	});
};

/** The picture work, done in workers `start` makes, one at a time. */
export const createPictureWork = (start: () => Worker | undefined): PictureWork => {
	const connection = cell<Connection | undefined>(undefined);
	const refused = cell(false);
	const lastId = cell(0);

	/** The worker let go of, and what it was asked answered with `error`; a reply after this is not heard. */
	const drop = (link: Connection, error: string): void => {
		link.worker.terminate();
		if (connection.current === link) connection.current = undefined;
		const waiting = [...link.waiting];
		link.waiting.clear();
		waiting.forEach(([id, waiter]) => {
			clearTimeout(waiter.timer);
			waiter.answer({ id, error });
		});
	};

	/** The worker dropped; one that never listened will not, and no other is tried. */
	const fail = (link: Connection, error: string): void => {
		if (!link.listening.current) refused.current = true;
		drop(link, error);
	};

	const connect = (): Connection | undefined => {
		if (refused.current || !workable()) return undefined;
		const worker = start();
		if (worker === undefined) {
			refused.current = true;
			return undefined;
		}
		const listening = cell(false);
		const waiting = new Map<number, Waiter>();
		const ready = new Promise<void>((resolve) => {
			worker.addEventListener(
				'message',
				(event: MessageEvent<PictureReply | PictureHello>) => {
					const message = event.data;
					if ('ready' in message) {
						listening.current = true;
						resolve();
						return;
					}
					// One no request waits for, as one that came after its patience, is let be.
					const waiter = waiting.get(message.id);
					if (waiter === undefined) return;
					waiting.delete(message.id);
					clearTimeout(waiter.timer);
					waiter.answer(message);
				}
			);
		});
		const link: Connection = { worker, ready, listening, waiting };
		worker.addEventListener('error', (event) => {
			fail(link, event.message || 'the pictures worker failed');
		});
		worker.addEventListener('messageerror', () => {
			fail(link, 'a reply from the pictures worker could not be read');
		});
		connection.current = link;
		return link;
	};

	/**
	 * The worker's reply to the request `make` gives the next id; nothing where
	 * there is no worker. Posted once the worker listens, and answered with an
	 * error, never a rejection, where it fails, does not answer within
	 * `patience` milliseconds, or the request cannot be posted.
	 */
	const ask = (
		make: (id: number) => PictureRequest,
		transfer: readonly Transferable[],
		patience: number
	): Promise<PictureReply> | undefined => {
		const link = connection.current ?? connect();
		if (link === undefined) return undefined;
		lastId.current += 1;
		const id = lastId.current;
		return new Promise<PictureReply>((resolve) => {
			const timer = setTimeout(() => {
				fail(
					link,
					`the pictures worker did not answer in ${String(Math.round(patience))} ms`
				);
			}, patience);
			link.waiting.set(id, { answer: resolve, timer });
			void link.ready.then(() => {
				if (!link.waiting.has(id)) return;
				try {
					link.worker.postMessage(make(id), [...transfer]);
				} catch (error) {
					link.waiting.delete(id);
					clearTimeout(timer);
					resolve({ id, error: error instanceof Error ? error.message : String(error) });
				}
			});
		});
	};

	const shrink: PictureWork['shrink'] = (href, most) => {
		if (!decodesInWorker(href)) return undefined;
		return ask(
			(id) => ({ id, kind: 'shrink', href, most }),
			[],
			shrinkPatience(href.length)
		)?.then((reply) => ('href' in reply ? reply.href : Promise.reject(new Error(reply.error))));
	};

	/**
	 * The encoding's `href`; where the worker failed, the pixels encoded here
	 * from the snapshot, given back or never posted, and from the canvas as it
	 * is now only where the snapshot went with a worker that is gone.
	 */
	const landed = (
		reply: PictureReply,
		snapshot: ImageBitmap,
		canvas: HTMLCanvasElement,
		here: EncodeHere
	): Promise<string> => {
		if ('href' in reply) return Promise.resolve(reply.href);
		const pixels = reply.bitmap ?? snapshot;
		return pixels.width > 0 ? encodeBitmapHere(pixels, here) : here(canvas);
	};

	const encode: PictureWork['encode'] = (canvas, here) => {
		// Started now, where it is not yet, so a browser that cannot start one is known at once.
		if ((connection.current ?? connect()) === undefined) return undefined;
		return snapshotOf(canvas).then(
			(snapshot) =>
				ask(
					(id) => ({ id, kind: 'encode', bitmap: snapshot }),
					[snapshot],
					encodePatience(snapshot.width * snapshot.height)
				)?.then((reply) => landed(reply, snapshot, canvas, here)) ??
				encodeBitmapHere(snapshot, here),
			() => here(canvas)
		);
	};

	return { shrink, encode };
};

/** The page's worker, or none where one cannot be started, as under jsdom. */
const startWorker = (): Worker | undefined => {
	if (typeof Worker === 'undefined') return undefined;
	try {
		return new Worker(new URL('./pictures.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		return undefined;
	}
};

const pictureWork = createPictureWork(startWorker);

/** The picture's stand-in made off the page's thread (`PictureWork['shrink']`). */
export const shrinkInWorker = pictureWork.shrink;

/** The canvas's pixels encoded as PNG off the page's thread (`PictureWork['encode']`). */
export const encodeInWorker = pictureWork.encode;
