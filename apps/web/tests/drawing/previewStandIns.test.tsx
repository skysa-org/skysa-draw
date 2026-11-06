import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { replaceRasterImage } from '../../src/drawing/document/commands.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { LayerPreview } from '../../src/drawing/panels/LayerPreview.js';
import { PREVIEW_DELAY_MS } from '../../src/drawing/panels/layerPreviewStore.js';
import type * as Pictures from '../../src/drawing/panels/previewPictures.js';

/**
 * A raster layer's preview drawn by its picture's stand-in
 * (`layerPreviewStore.ts`, `previewPictures.ts`): not shown until the
 * stand-in is made, the picture shown kept while the next one's is, and a
 * stand-in no preview draws let go of. The browser's shrink is held here, to
 * be let go by hand.
 */

const shrinking = vi.hoisted(() => ({
	asked: [] as { href: string; done: (small: string) => void }[],
}));

vi.mock('../../src/drawing/panels/previewPictures.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Pictures>();
	return {
		...actual,
		canShrink: () => true,
		browserShrink: (href: string) =>
			new Promise<string>((resolve) => {
				shrinking.asked.push({ href, done: resolve });
			}),
	};
});

const ROOT = `xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" viewBox="0 0 200 100" width="200" height="100"`;
const PIXELS = (fill: string): string => `data:image/png;base64,${fill.repeat(1200)}`;
const SMALL = (name: string): string => `data:image/png;base64,${name}`;

const open = (): EditorDocument => {
	const document = openDocument(
		`<svg ${ROOT}><g id="layer-1" draw:kind="raster"><image href="${PIXELS('A')}" x="0" y="0" width="200" height="100" preserveAspectRatio="none"/></g></svg>`
	);
	if (document === undefined) throw new Error('the drawing opens');
	return document;
};

const made: { url: string; blob: Blob }[] = [];
const revoked: string[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
		const url = `blob:preview/${String(made.length + 1)}`;
		made.push({ url, blob: blob as Blob });
		return url;
	});
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
		revoked.push(url);
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	made.length = 0;
	revoked.length = 0;
	shrinking.asked.length = 0;
});

/** The promises settled, the observer's records delivered, and then `ms` gone by. */
const pass = async (ms: number): Promise<void> => {
	await act(async () => {
		for (let step = 0; step < 12; step += 1) await Promise.resolve();
		vi.advanceTimersByTime(ms);
	});
};

const source = (container: HTMLElement): string | null =>
	container.querySelector('img')?.getAttribute('src') ?? null;

const textOf = (url: string | null): Promise<string> => {
	const blob = made.find((each) => each.url === url)?.blob;
	if (blob === undefined) throw new Error(`${String(url)} was made`);
	return blob.text();
};

const repaint = (fill: string) =>
	replaceRasterImage('layer-1', 'tools.brush', {
		href: PIXELS(fill),
		x: 0,
		y: 0,
		width: 200,
		height: 100,
	});

describe('a raster layer’s preview', () => {
	it('is shown once its picture’s stand-in is made, drawn by it', async () => {
		const document = open();
		const { container } = render(
			<LayerPreview document={document} target={{ layerId: 'layer-1' }} />
		);
		expect(source(container)).toBeNull();
		expect(shrinking.asked.map((each) => each.href)).toEqual([PIXELS('A')]);
		shrinking.asked[0]?.done(SMALL('a'));
		await pass(0);
		expect(source(container)).toBe('blob:preview/1');
		const text = await textOf('blob:preview/1');
		expect(text).toContain(`href="${SMALL('a')}"`);
		expect(text).not.toContain(PIXELS('A'));
	});

	it('keeps the picture shown while the next one’s stand-in is made, and lets the last one go', async () => {
		const document = open();
		const { container } = render(
			<LayerPreview document={document} target={{ layerId: 'layer-1' }} />
		);
		shrinking.asked[0]?.done(SMALL('a'));
		await pass(0);
		document.execute(repaint('B'));
		await pass(PREVIEW_DELAY_MS);
		expect(source(container)).toBe('blob:preview/1');
		expect(shrinking.asked.map((each) => each.href)).toEqual([PIXELS('A'), PIXELS('B')]);
		shrinking.asked[1]?.done(SMALL('b'));
		await pass(0);
		expect(source(container)).toBe('blob:preview/2');
		expect(revoked).toEqual(['blob:preview/1']);
		expect(await textOf('blob:preview/2')).toContain(`href="${SMALL('b')}"`);
		document.undo();
		await pass(PREVIEW_DELAY_MS);
		expect(shrinking.asked.map((each) => each.href)).toEqual([
			PIXELS('A'),
			PIXELS('B'),
			PIXELS('A'),
		]);
		expect(source(container)).toBe('blob:preview/2');
	});

	it('asks one stand-in for two previews of the same picture', async () => {
		const document = open();
		render(
			<>
				<LayerPreview document={document} target={{ layerId: 'layer-1' }} />
				<LayerPreview document={document} target={{ layerId: 'layer-1', position: 0 }} />
			</>
		);
		expect(shrinking.asked).toHaveLength(1);
		shrinking.asked[0]?.done(SMALL('a'));
		await pass(0);
		expect(made).toHaveLength(2);
	});

	it('finds its stand-in made when the panel is shown again', async () => {
		const document = open();
		const first = render(<LayerPreview document={document} target={{ layerId: 'layer-1' }} />);
		shrinking.asked[0]?.done(SMALL('a'));
		await pass(0);
		first.unmount();
		const again = render(<LayerPreview document={document} target={{ layerId: 'layer-1' }} />);
		expect(shrinking.asked).toHaveLength(1);
		expect(source(again.container)).toBe('blob:preview/2');
	});
});
