// The worker's entry, loaded here as a worker loads it: it listens on `self`.
import '../../src/drawing/inpaint/inpaint.worker.js';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	answer,
	inpaintPixels,
	type InpaintReply,
	type InpaintRequest,
} from '../../src/drawing/inpaint/engine.js';
import { inpaint, type Pixels } from '../../src/drawing/inpaint/index.js';

/**
 * Content-aware fill's worker (docs/ARCHITECTURE.md §7, "Tools"): the page
 * posts copies of the picture and the mask with their buffers transferred,
 * settles on the answer, and terminates the worker once it has answered or
 * the signal aborts. jsdom has no `Worker`, so a fake stands in for one,
 * passing messages through `structuredClone` with their transfers as a real
 * one does, so a transferred buffer is detached here too.
 */

type Behavior = 'answer' | 'never' | 'fail' | 'refuse';

interface Fake {
	readonly url: string;
	readonly options: WorkerOptions | undefined;
	readonly posted: InpaintRequest[];
	readonly transferred: ArrayBuffer[];
	terminated: number;
}

const fakes: Fake[] = [];

/** A stand-in for `Worker` that runs the engine's `answer`, or does as `behavior` says. */
const fakeWorker = (behavior: Behavior) => {
	const make = (url: URL, options?: WorkerOptions) => {
		if (behavior === 'refuse') throw new Error('no workers here');
		const target = new EventTarget();
		const fake: Fake = { url: url.href, options, posted: [], transferred: [], terminated: 0 };
		fakes.push(fake);
		const reply = (data: InpaintReply) => {
			if (fake.terminated > 0) return;
			const transfer = 'data' in data ? [data.data] : [];
			target.dispatchEvent(
				new MessageEvent('message', { data: structuredClone(data, { transfer }) })
			);
		};
		return Object.assign(target, {
			postMessage: (message: InpaintRequest, transfer: ArrayBuffer[]) => {
				fake.transferred.push(...transfer);
				const request = structuredClone(message, { transfer });
				fake.posted.push(request);
				if (behavior === 'answer') void answer(request).then(reply);
				if (behavior === 'fail') {
					setTimeout(
						() =>
							target.dispatchEvent(
								new ErrorEvent('error', { message: 'out of memory' })
							),
						0
					);
				}
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

const scene = (): Readonly<{ image: Pixels; mask: Uint8Array }> => {
	const width = 48;
	const height = 40;
	const data = new Uint8ClampedArray(width * height * 4);
	const mask = new Uint8Array(width * height);
	for (let i = 0; i < width * height; i++) {
		const x = i % width;
		const y = Math.floor(i / width);
		data.set([x * 5, Math.floor(x / 4) % 2 === 0 ? 40 : 220, y * 6, 255], i * 4);
		mask[i] = Math.hypot(x - 24, y - 20) <= 8 ? 1 : 0;
	}
	return { image: { width, height, data }, mask };
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	fakes.length = 0;
});

describe('inpaint, in a worker', () => {
	it('posts copies with their buffers transferred, settles on the answer, and terminates the worker', async () => {
		vi.stubGlobal('Worker', fakeWorker('answer'));
		const { image, mask } = scene();
		const before = new Uint8ClampedArray(image.data);
		const out = await inpaint(image, mask);
		const expected = await inpaintPixels(image, mask, () => Promise.resolve());
		expect(out).toEqual(expected);
		expect(fakes).toHaveLength(1);
		const [fake] = fakes;
		expect(fake?.url).toMatch(/\/inpaint\.worker\.ts(\?|$)/);
		expect(fake?.options).toEqual({ type: 'module' });
		expect(fake?.terminated).toBe(1);
		// The page's copies went to the worker; the picture it was given did not.
		expect(fake?.transferred.map((buffer) => buffer.byteLength)).toEqual([0, 0]);
		expect(fake?.posted[0]).toMatchObject({ width: 48, height: 40 });
		expect(fake?.posted[0]?.data.byteLength).toBe(48 * 40 * 4);
		expect(image.data).toEqual(before);
	});

	it('terminates the worker and rejects with an AbortError when the signal aborts', async () => {
		vi.stubGlobal('Worker', fakeWorker('never'));
		const { image, mask } = scene();
		const controller = new AbortController();
		const fill = inpaint(image, mask, controller.signal);
		controller.abort();
		const error: unknown = await fill.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(DOMException);
		expect(error).toMatchObject({ name: 'AbortError' });
		expect(fakes[0]?.terminated).toBe(1);
	});

	it('rejects, and terminates the worker, when the worker fails', async () => {
		vi.stubGlobal('Worker', fakeWorker('fail'));
		const { image, mask } = scene();
		await expect(inpaint(image, mask)).rejects.toThrow('out of memory');
		expect(fakes[0]?.terminated).toBe(1);
	});

	it('runs on this thread where a worker cannot be started', async () => {
		vi.stubGlobal('Worker', fakeWorker('refuse'));
		const { image, mask } = scene();
		const out = await inpaint(image, mask);
		expect(out).toEqual(await inpaintPixels(image, mask, () => Promise.resolve()));
	});

	it('starts no worker when there is nothing to fill', async () => {
		vi.stubGlobal('Worker', fakeWorker('answer'));
		const { image } = scene();
		await inpaint(image, new Uint8Array(48 * 40));
		expect(fakes).toHaveLength(0);
	});
});

describe('the worker', () => {
	it('answers a request with the picture filled, its buffer transferred', async () => {
		const posted = vi.spyOn(self, 'postMessage').mockImplementation(() => undefined);
		const { image, mask } = scene();
		const request: InpaintRequest = {
			width: image.width,
			height: image.height,
			data: new Uint8ClampedArray(image.data).buffer,
			mask: new Uint8Array(mask).buffer,
		};
		self.dispatchEvent(new MessageEvent('message', { data: request }));
		await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
		const [reply, options] = posted.mock.calls[0] as unknown as [
			Readonly<{ data: ArrayBuffer }>,
			Readonly<{ transfer: readonly ArrayBuffer[] }>,
		];
		expect(options.transfer).toEqual([reply.data]);
		expect(new Uint8ClampedArray(reply.data)).toEqual(
			await inpaintPixels(image, mask, () => Promise.resolve())
		);
	});
});
