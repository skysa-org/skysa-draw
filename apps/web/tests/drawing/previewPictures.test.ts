import { describe, expect, it, vi } from 'vitest';

import {
	createStandIns,
	type Shrink,
	STAND_IN_MOST,
} from '../../src/drawing/panels/previewPictures.js';

/**
 * The stand-ins for the pictures in a drawing's own bytes
 * (`previewPictures.ts`): each made once, by its `href`, kept while a preview
 * draws it, and a picture that will not shrink standing for itself.
 */

const BIG = `data:image/png;base64,${'A'.repeat(4000)}`;
const OTHER = `data:image/png;base64,${'B'.repeat(4000)}`;

/** A shrink whose every call waits to be let go, and says what it was asked. */
const held = () => {
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
		const { asked, shrink } = held();
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
		const { asked, shrink } = held();
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
		const { asked, shrink } = held();
		const standIns = createStandIns(shrink);
		const making = standIns.make([BIG]);
		standIns.keep(new Set());
		asked[0]?.done('data:small');
		await making;
		expect(standIns.get(BIG)).toBe('data:small');
	});
});
