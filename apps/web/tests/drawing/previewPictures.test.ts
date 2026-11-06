import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	browserShrink,
	createStandIns,
	type Shrink,
	STAND_IN_MOST,
} from '../../src/drawing/panels/previewPictures.js';
import type * as Pictures from '../../src/drawing/pictures/index.js';
import type * as Surface from '../../src/drawing/tools/raster/surface.js';

/**
 * The stand-ins for the pictures in a drawing's own bytes
 * (`previewPictures.ts`): each made once, by its `href`, kept while a preview
 * draws it, and a picture that will not shrink standing for itself; made in
 * the pictures worker where there is one, and on the page's thread where
 * there is none or it fails. The worker's side is held here, to answer by
 * hand, and the page's decoding gives a picture of a size the test says.
 */

const held = vi.hoisted(() => ({
	worker: undefined as ((href: string, most: number) => Promise<string> | undefined) | undefined,
	decoded: [] as string[],
	size: { width: 200, height: 100 },
}));

vi.mock('../../src/drawing/pictures/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Pictures>();
	return {
		...actual,
		shrinkInWorker: (href: string, most: number) =>
			(held.worker ?? actual.shrinkInWorker)(href, most),
	};
});

vi.mock('../../src/drawing/tools/raster/surface.js', async (importOriginal) => ({
	...(await importOriginal<typeof Surface>()),
	decodePicture: (href: string) => {
		held.decoded.push(href);
		return Promise.resolve({
			naturalWidth: held.size.width,
			naturalHeight: held.size.height,
		} as HTMLImageElement);
	},
}));

afterEach(() => {
	held.worker = undefined;
	held.decoded.length = 0;
	vi.unstubAllGlobals();
});

const BIG = `data:image/png;base64,${'A'.repeat(4000)}`;
const OTHER = `data:image/png;base64,${'B'.repeat(4000)}`;

/** A shrink whose every call waits to be let go, and says what it was asked. */
const holding = () => {
	const asked: { href: string; most: number; done: (small: string) => void; fail: () => void }[] =
		[];
	const shrink: Shrink = (href, most) =>
		new Promise<string>((resolve, reject) => {
			asked.push({ href, most, done: resolve, fail: () => reject(new Error('undecodable')) });
		});
	return { asked, shrink };
};

describe('stand-ins', () => {
	it('are the pictures themselves where nothing shrinks, made at once', async () => {
		const standIns = createStandIns(undefined);
		expect(standIns.get(BIG)).toBe(BIG);
		await standIns.make([BIG]);
		expect(standIns.get(BIG)).toBe(BIG);
	});

	it('are made once each, at the stand-in size, however often and however many times they are asked for', async () => {
		const { asked, shrink } = holding();
		const standIns = createStandIns(shrink);
		expect(standIns.get(BIG)).toBeUndefined();
		const first = standIns.make([BIG, BIG, OTHER]);
		const second = standIns.make([BIG]);
		expect(asked.map((each) => [each.href === BIG, each.most])).toEqual([
			[true, STAND_IN_MOST],
			[false, STAND_IN_MOST],
		]);
		asked[0]?.done('data:small-big');
		await second;
		expect(standIns.get(BIG)).toBe('data:small-big');
		expect(standIns.get(OTHER)).toBeUndefined();
		asked[1]?.done('data:small-other');
		await first;
		expect(standIns.get(OTHER)).toBe('data:small-other');
		await standIns.make([BIG, OTHER]);
		expect(asked).toHaveLength(2);
	});

	it('let a picture that will not shrink stand for itself', async () => {
		const { asked, shrink } = holding();
		const standIns = createStandIns(shrink);
		const making = standIns.make([BIG]);
		asked[0]?.fail();
		await making;
		expect(standIns.get(BIG)).toBe(BIG);
	});

	it('are let go of once no preview draws their picture, and made again if one does', async () => {
		const shrink = vi.fn<Shrink>((href) => Promise.resolve(`small:${String(href.length)}`));
		const standIns = createStandIns(shrink);
		await standIns.make([BIG, OTHER]);
		standIns.keep(new Set([OTHER]));
		expect(standIns.get(BIG)).toBeUndefined();
		expect(standIns.get(OTHER)).toBe('small:4022');
		await standIns.make([BIG]);
		expect(shrink).toHaveBeenCalledTimes(3);
	});

	it('keep one under way when it is made, though the round before let go of what it stood for', async () => {
		const { asked, shrink } = holding();
		const standIns = createStandIns(shrink);
		const making = standIns.make([BIG]);
		standIns.keep(new Set());
		asked[0]?.done('data:small');
		await making;
		expect(standIns.get(BIG)).toBe('data:small');
	});
});

describe('the browser’s shrink', () => {
	const PHOTO = `data:image/jpeg;base64,${btoa('a photo')}`;

	it('works on the page’s thread where the browser has no worker, as jsdom has none', async () => {
		await expect(browserShrink(PHOTO, STAND_IN_MOST)).resolves.toBe(PHOTO);
		expect(held.decoded).toEqual([PHOTO]);
	});

	it('works on the page’s thread for a picture the worker cannot decode, an SVG', async () => {
		vi.stubGlobal('OffscreenCanvas', class {});
		vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('never asked')));
		const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
		await expect(browserShrink(svg, STAND_IN_MOST)).resolves.toBe(svg);
		expect(held.decoded).toEqual([svg]);
	});

	it('is the worker’s where it makes one, and nothing is decoded on the page’s thread', async () => {
		const asked: [string, number][] = [];
		held.worker = (href, most) => {
			asked.push([href, most]);
			return Promise.resolve('data:small');
		};
		await expect(browserShrink(PHOTO, STAND_IN_MOST)).resolves.toBe('data:small');
		expect(asked).toEqual([[PHOTO, STAND_IN_MOST]]);
		expect(held.decoded).toEqual([]);
	});

	it('works on the page’s thread where the worker fails', async () => {
		held.worker = () => Promise.reject(new Error('the worker failed'));
		await expect(browserShrink(PHOTO, STAND_IN_MOST)).resolves.toBe(PHOTO);
		expect(held.decoded).toEqual([PHOTO]);
	});
});
