import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newAdjustment, setAdjustments } from '../../src/drawing/document/adjustments.js';
import {
	editLayer,
	removeLayer,
	replaceRasterImage,
	setLayerBlend,
	setLayerHidden,
	setLayerOpacity,
} from '../../src/drawing/document/commands.js';
import { cropCanvas } from '../../src/drawing/document/crop.js';
import { groupLayer } from '../../src/drawing/document/groups.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { LayerPreview, type PreviewTarget } from '../../src/drawing/panels/LayerPreview.js';
import { PREVIEW_DELAY_MS } from '../../src/drawing/panels/layerPreviewStore.js';

/**
 * The layers panel's pictures over a live document (`layerPreviewStore.ts`):
 * one watch on the root, a picture built again only where a change may show,
 * once the changes stop, and every object URL revoked once it is shown no
 * more. jsdom makes no object URLs, so they are counted here, with the blob
 * each was made of.
 */

const ROOT = `xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" viewBox="0 0 200 100" width="200" height="100"`;

const PIXELS = (fill: string): string => `data:image/png;base64,${fill.repeat(1200)}`;

const open = (body: string): EditorDocument => {
	const document = openDocument(`<svg ${ROOT}>${body}</svg>`);
	if (document === undefined) throw new Error('the drawing opens');
	return document;
};

const TWO_LAYERS =
	'<g id="layer-1"><rect width="50" height="50"/></g><g id="layer-2"><circle r="20"/></g>';

const made: { url: string; blob: Blob }[] = [];
const revoked: string[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
		const url = `blob:preview/${made.length + 1}`;
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
});

const Previews = ({
	document,
	targets,
}: Readonly<{ document: EditorDocument; targets: readonly PreviewTarget[] }>) => (
	<ul>
		{targets.map((target) => (
			<li key={`${target.layerId}/${String(target.position)}`}>
				<LayerPreview document={document} target={target} />
			</li>
		))}
	</ul>
);

const show = (document: EditorDocument, ...targets: PreviewTarget[]) =>
	render(<Previews document={document} targets={targets} />);

const sources = (container: HTMLElement): readonly (string | null)[] =>
	[...container.querySelectorAll('li')].map(
		(item) => item.querySelector('img')?.getAttribute('src') ?? null
	);

/** The observer's records delivered, which is a microtask after the change, and then `ms` gone by. */
const pass = async (ms: number): Promise<void> => {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(ms);
	});
};

const settle = (): Promise<void> => pass(PREVIEW_DELAY_MS);

const textOf = (url: string | null): Promise<string> => {
	const blob = made.find((each) => each.url === url)?.blob;
	if (blob === undefined) throw new Error(`${String(url)} was made`);
	return blob.text();
};

const recolor = (id: string, fill: string) =>
	editLayer(id, 'tools.fill', (layer) => {
		layer.setAttribute('fill', fill);
	});

describe('a preview', () => {
	it('shows the picture through a blob: URL, decorative, sized to the canvas, under the row’s marks', async () => {
		const document = open(TWO_LAYERS);
		const { container } = render(
			<LayerPreview document={document} target={{ layerId: 'layer-1' }} className="small">
				<span className="mark" />
			</LayerPreview>
		);
		const box = container.firstElementChild;
		expect(box?.className).toBe('layer-preview small');
		const img = box?.querySelector('img');
		expect(img?.getAttribute('src')).toBe('blob:preview/1');
		expect(img?.getAttribute('alt')).toBe('');
		expect(img?.getAttribute('aria-hidden')).toBe('true');
		expect(img?.getAttribute('draggable')).toBe('false');
		expect(img?.style.inlineSize).toBe('calc(var(--layer-preview-room-width) * 1)');
		expect(img?.style.blockSize).toBe(
			'calc(var(--layer-preview-room-height) * 0.6538461538461539)'
		);
		expect(box?.lastElementChild?.className).toBe('mark');
		expect(made[0]?.blob.type).toBe('image/svg+xml');
		const text = await textOf('blob:preview/1');
		expect(text).toContain('id="layer-1"');
		expect(text).not.toContain('id="layer-2"');
	});

	it('is an empty box where the browser makes no object URLs', () => {
		const make = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
		Object.assign(URL, { createObjectURL: undefined });
		try {
			const { container } = show(open(TWO_LAYERS), { layerId: 'layer-1' });
			expect(container.querySelector('.layer-preview')).not.toBeNull();
			expect(container.querySelector('img')).toBeNull();
		} finally {
			Object.assign(URL, { createObjectURL: make?.value as unknown });
		}
	});

	it('shows one item of a vector layer', async () => {
		const document = open('<g id="layer-1"><rect width="5" height="5"/><circle r="5"/></g>');
		const { container } = show(document, { layerId: 'layer-1', position: 1 });
		const text = await textOf(sources(container)[0] ?? null);
		expect(text).toContain('<circle');
		expect(text).not.toContain('<rect');
	});

	it('shares one picture between two previews of it, until the last goes', () => {
		const document = open(TWO_LAYERS);
		const one = show(document, { layerId: 'layer-1' });
		const other = show(document, { layerId: 'layer-1' });
		expect(made).toHaveLength(1);
		expect(sources(other.container)).toEqual(sources(one.container));
		one.unmount();
		expect(revoked).toEqual([]);
		other.unmount();
		expect(revoked).toEqual(['blob:preview/1']);
	});
});

describe('the watch', () => {
	it('builds again only the picture of the layer a change is in', async () => {
		const document = open(TWO_LAYERS);
		const { container } = show(document, { layerId: 'layer-1' }, { layerId: 'layer-2' });
		const [first, second] = sources(container);
		const serialized = vi.spyOn(XMLSerializer.prototype, 'serializeToString');
		document.execute(recolor('layer-1', '#f00'));
		await settle();
		expect(serialized).toHaveBeenCalledTimes(1);
		expect(sources(container)).toEqual(['blob:preview/3', second]);
		expect(revoked).toEqual([first]);
		expect(await textOf('blob:preview/3')).toContain('fill="#f00"');
	});

	it('looks at every picture for a change outside the layers, and changes only those it shows in', async () => {
		const document = open(TWO_LAYERS);
		document.execute(
			setAdjustments(document.root, 'layer-1', [newAdjustment('blur')], 'adjustments.add')
		);
		const { container } = show(document, { layerId: 'layer-1' }, { layerId: 'layer-2' });
		const [first, second] = sources(container);
		const serialized = vi.spyOn(XMLSerializer.prototype, 'serializeToString');
		const stronger = { kind: 'blur', values: { radius: 9 } } as const;
		document.execute(setAdjustments(document.root, 'layer-1', [stronger], 'adjustments.edit'));
		await settle();
		expect(serialized).toHaveBeenCalledTimes(2);
		expect(sources(container)).toEqual(['blob:preview/3', second]);
		expect(revoked).toEqual([first]);
		expect(await textOf('blob:preview/3')).toContain('stdDeviation="9"');
	});

	it('draws every picture again when the canvas changes', async () => {
		const document = open(TWO_LAYERS);
		const { container } = show(document, { layerId: 'layer-1' }, { layerId: 'layer-2' });
		document.execute(
			cropCanvas({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, ...document.size })
		);
		await settle();
		expect(sources(container)).toEqual(['blob:preview/3', 'blob:preview/4']);
		expect(await textOf('blob:preview/4')).toContain('viewBox="0 0 100 100"');
	});

	it('builds again a picture that copied a definition out of the layer a change is in', async () => {
		const document = open(
			'<g id="layer-1"><use href="#star"/></g><g id="layer-2"><path id="star" d="M0 0L5 5"/></g><g id="layer-3"/>'
		);
		const { container } = show(document, { layerId: 'layer-1' }, { layerId: 'layer-3' });
		const third = sources(container)[1];
		document.execute(
			editLayer('layer-2', 'tools.pen', (layer) => {
				layer.querySelector('path')?.setAttribute('d', 'M0 0L9 9');
			})
		);
		await settle();
		expect(sources(container)).toEqual(['blob:preview/3', third]);
		expect(await textOf('blob:preview/3')).toContain('M0 0L9 9');
	});

	it('looks at every picture when a style sheet’s text changes', async () => {
		const document = open(`<style>rect { fill: red }</style>${TWO_LAYERS}`);
		const { container } = show(document, { layerId: 'layer-1' }, { layerId: 'layer-2' });
		const sheet = document.root.querySelector('style')?.firstChild;
		if (!(sheet instanceof Text)) throw new Error('the style sheet has its text');
		sheet.data = 'rect { fill: blue }';
		await settle();
		expect(sources(container)).toEqual(['blob:preview/3', 'blob:preview/4']);
		expect(await textOf('blob:preview/4')).toContain('fill: blue');
	});

	it('keeps the URL of a picture that came out the same: shown, hidden, faded, blended', async () => {
		const document = open(TWO_LAYERS);
		const { container } = show(document, { layerId: 'layer-1' });
		document.execute(setLayerHidden('layer-1', true));
		document.execute(setLayerOpacity('layer-1', 0.3));
		document.execute(setLayerBlend('layer-1', 'multiply'));
		await settle();
		expect(made).toHaveLength(1);
		expect(sources(container)).toEqual(['blob:preview/1']);
	});

	it('follows an undo that puts a copy of the layer in its place, and the redo', async () => {
		const document = open(TWO_LAYERS);
		const { container } = show(document, { layerId: 'layer-1' });
		const opened = await textOf('blob:preview/1');
		document.execute(recolor('layer-1', '#0f0'));
		await settle();
		const edited = await textOf('blob:preview/2');
		const live = document.layer('layer-1');
		document.undo();
		await settle();
		expect(document.layer('layer-1')).not.toBe(live);
		expect(sources(container)).toEqual(['blob:preview/3']);
		expect(await textOf('blob:preview/3')).toBe(opened);
		document.redo();
		await settle();
		expect(await textOf('blob:preview/4')).toBe(edited);
	});

	it('shows a raster stroke once it lands as the layer’s new picture', async () => {
		const document = open(
			`<g id="layer-1" draw:kind="raster"><image href="${PIXELS('AAAA')}" width="200" height="100" preserveAspectRatio="none"/></g>`
		);
		const { container } = show(document, { layerId: 'layer-1' });
		const href = PIXELS('BBBB');
		document.execute(
			replaceRasterImage('layer-1', 'tools.brush', {
				href,
				x: 0,
				y: 0,
				width: 200,
				height: 100,
			})
		);
		await settle();
		expect(sources(container)).toEqual(['blob:preview/2']);
		const text = await textOf('blob:preview/2');
		expect(text).toContain(href);
		expect(text).not.toContain('AAAA');
	});

	it('follows a layer into a new group', async () => {
		const document = open(TWO_LAYERS);
		const { container } = show(document, { layerId: 'layer-1' }, { layerId: 'layer-2' });
		const second = sources(container)[1];
		const group = groupLayer(document.root, 'layer-1');
		document.execute(group);
		await settle();
		expect(sources(container)).toEqual(['blob:preview/3', second]);
		expect(await textOf('blob:preview/3')).toContain(`id="${group.id}"`);
	});

	it('empties the preview of a layer that is gone, and lets its URL go', async () => {
		const document = open(TWO_LAYERS);
		const { container } = show(document, { layerId: 'layer-1' }, { layerId: 'layer-2' });
		document.execute(removeLayer('layer-2'));
		await settle();
		expect(sources(container)).toEqual(['blob:preview/1', null]);
		expect(revoked).toEqual(['blob:preview/2']);
	});

	it('waits for the changes to stop, then builds once', async () => {
		const document = open(TWO_LAYERS);
		const { container } = show(document, { layerId: 'layer-1' });
		document.execute(recolor('layer-1', '#100'));
		await pass(PREVIEW_DELAY_MS - 50);
		document.execute(recolor('layer-1', '#200'));
		await pass(PREVIEW_DELAY_MS - 50);
		expect(made).toHaveLength(1);
		await pass(50);
		expect(made).toHaveLength(2);
		expect(sources(container)).toEqual(['blob:preview/2']);
		expect(await textOf('blob:preview/2')).toContain('fill="#200"');
	});

	it('revokes every URL it replaces, and the last when the preview goes', async () => {
		const document = open(TWO_LAYERS);
		const { unmount } = show(document, { layerId: 'layer-1' });
		await Array.from({ length: 12 }, (_, index) => index).reduce(async (before, index) => {
			await before;
			document.execute(recolor('layer-1', `#${String(index).padStart(3, '0')}`));
			await settle();
		}, Promise.resolve());
		expect(made).toHaveLength(13);
		expect(revoked).toEqual(made.slice(0, 12).map((each) => each.url));
		unmount();
		expect(revoked).toEqual(made.map((each) => each.url));
	});

	it('stops watching once no preview is shown', async () => {
		const document = open(TWO_LAYERS);
		const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
		const { unmount } = show(document, { layerId: 'layer-1' }, { layerId: 'layer-2' });
		document.execute(recolor('layer-1', '#f00'));
		await pass(PREVIEW_DELAY_MS - 50);
		unmount();
		expect(disconnect).toHaveBeenCalledTimes(1);
		await settle();
		document.execute(recolor('layer-2', '#f00'));
		await settle();
		expect(made).toHaveLength(2);
		expect(revoked).toEqual(['blob:preview/1', 'blob:preview/2']);
	});
});
