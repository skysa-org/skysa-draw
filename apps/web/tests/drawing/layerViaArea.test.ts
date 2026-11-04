import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renameLayer } from '../../src/drawing/document/commands.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { layerViaArea } from '../../src/drawing/tools/raster/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Region,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';
import {
	installFakeCanvas,
	pictureAt,
	pictureSize,
	registerPicture,
	uninstallFakeCanvas,
} from './fakeCanvas.js';

/**
 * Layer via copy and layer via cut on a raster layer
 * (docs/decisions/0004-the-interface.md, "The context menu"): the area's
 * pixels made a new layer just above, in one command, against a real
 * document and its real commands, so that the new layer's place and undo to
 * the bytes are the document's own; the canvas is the compositing fake
 * (`fakeCanvas.ts`), so the pixels each layer ends with are read back from
 * its `href`. The vector side is `layerVia.test.ts`.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const RED = [255, 0, 0, 255];
const CLEAR = [0, 0, 0, 0];

/** A square from (10, 5) to (30, 25), as the marquee writes it. */
const SQUARE = 'M 10 5 L 30 5 L 30 25 L 10 25 Z';

/** `layer-2` holds a picture over the whole 40 × 30 canvas, and is moved, named and faded. */
const drawingText = (layerAttributes: string, picture: string, wrap = false): string => {
	const layer = `<g id="layer-2" draw:kind="raster" draw:name="Sky" transform="translate(3 4)" opacity="0.5"${layerAttributes}><image href="${picture}" x="0" y="0" width="40" height="30" preserveAspectRatio="none"/></g>`;
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 40 30" width="40" height="30">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		wrap ? `  <g id="layer-4" draw:kind="group">\n    ${layer}\n  </g>` : `  ${layer}`,
		'  <g id="layer-5" draw:kind="vector"/>',
		'</svg>',
		'',
	].join('\n');
};

const noop = (): undefined => undefined;

type Fake = Readonly<{
	context: ToolContext;
	document: EditorDocument;
	labels: string[];
	notices: string[];
	/** The markup of the whole drawing now, as the DOM has it. */
	markup: () => string;
	hrefOf: (id: string) => string | null | undefined;
}>;

type Setup = Readonly<{
	layerAttributes?: string;
	region?: Region;
	/** A picture of the canvas's size for `layer-2`; red all over by default. */
	picture?: string;
	/** `layer-2` inside a group. */
	wrap?: boolean;
}>;

const createFake = (setup: Setup = {}): Fake => {
	const picture = setup.picture ?? registerPicture(40, 30, () => [255, 0, 0, 255]);
	const opened = openDocument(drawingText(setup.layerAttributes ?? '', picture, setup.wrap));
	if (opened === undefined) throw new Error('the drawing opens');
	const labels: string[] = [];
	const notices: string[] = [];
	const editor: EditorDocument = {
		...opened,
		get size() {
			return opened.size;
		},
		execute: (command) => {
			labels.push(command.label);
			opened.execute(command);
		},
	};
	const region = setup.region ?? { path: SQUARE, inverted: false, feather: 0 };
	const context: ToolContext = {
		document: editor,
		layer: editor.snapshot().layers.find((each) => each.id === 'layer-2'),
		options: DEFAULT_TOOL_OPTIONS,
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: {
			canvas: document.createElement('canvas'),
			toScreen: (x, y) => [x, y],
			pixelRatio: 1,
		},
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: { elements: [], set: noop, clear: noop },
		region: { path: region.path, region, set: noop, update: noop },
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	const hrefOf = (id: string) =>
		Array.from(editor.layer(id)?.children ?? [])
			.find((child) => child.localName === 'image')
			?.getAttribute('href');
	const markup = () => new XMLSerializer().serializeToString(editor.root);
	return { context, document: editor, labels, notices, markup, hrefOf };
};

/** The layer's attributes but its id, and its `<image>`'s but the `href`. */
const placeOf = (fake: Fake, id: string) => {
	const layer = fake.document.layer(id);
	const image = Array.from(layer?.children ?? []).find((child) => child.localName === 'image');
	const attributes = (element: Element | undefined, without: string) =>
		Object.fromEntries(
			Array.from(element?.attributes ?? [])
				.filter((attribute) => attribute.name !== without)
				.map((attribute) => [attribute.name, attribute.value])
		);
	return { layer: attributes(layer, 'id'), image: attributes(image, 'href') };
};

const layerIds = (fake: Fake): readonly string[] =>
	fake.document.snapshot().layers.map((layer) => layer.id);

const lockedOf = (fake: Fake, id: string): boolean | undefined =>
	fake.document.snapshot().layers.find((each) => each.id === id)?.locked;

beforeEach(() => installFakeCanvas());
afterEach(uninstallFakeCanvas);

describe('layer via copy', () => {
	it('makes the area’s pixels a new layer just above, in exactly its place, by one command', async () => {
		const fake = createFake();
		const source = fake.hrefOf('layer-2');
		const made = await layerViaArea(fake.context, 'copy');
		expect(made).toBe('layer-3');
		expect(fake.labels).toEqual(['regions.viaCopy']);
		expect(layerIds(fake)).toEqual(['layer-1', 'layer-2', 'layer-3', 'layer-5']);
		expect(placeOf(fake, 'layer-3')).toEqual(placeOf(fake, 'layer-2'));
		const copy = fake.hrefOf('layer-3');
		expect(pictureSize(copy)).toEqual({ width: 40, height: 30 });
		expect(pictureAt(copy, 20, 15)).toEqual(RED);
		expect(pictureAt(copy, 5, 15)).toEqual(CLEAR);
		expect(fake.hrefOf('layer-2')).toBe(source);
	});

	it('undoes to the bytes, and redoes to the same', async () => {
		const fake = createFake();
		// A step first, so the undo is not only the history back at its origin.
		fake.document.execute(renameLayer('layer-1', 'Ink'));
		const before = fake.markup();
		await layerViaArea(fake.context, 'copy');
		const after = fake.markup();
		fake.document.undo();
		expect(fake.markup()).toBe(before);
		fake.document.redo();
		expect(fake.markup()).toBe(after);
	});

	it('keeps partial alpha at a feathered edge, and takes the canvas outside an inverse', async () => {
		const feathered = createFake({ region: { path: SQUARE, inverted: false, feather: 4 } });
		await layerViaArea(feathered.context, 'copy');
		const edge = pictureAt(feathered.hrefOf('layer-3'), 10, 15)[3] ?? 0;
		expect(edge).toBeGreaterThan(0);
		expect(edge).toBeLessThan(255);
		expect(pictureAt(feathered.hrefOf('layer-3'), 20, 15)).toEqual(RED);

		const inverted = createFake({ region: { path: SQUARE, inverted: true, feather: 0 } });
		await layerViaArea(inverted.context, 'copy');
		expect(pictureAt(inverted.hrefOf('layer-3'), 5, 15)).toEqual(RED);
		expect(pictureAt(inverted.hrefOf('layer-3'), 20, 15)).toEqual(CLEAR);
	});

	it('stays in the layer’s group', async () => {
		const fake = createFake({ wrap: true });
		const made = await layerViaArea(fake.context, 'copy');
		expect(made).toBe('layer-3');
		expect(fake.document.layer('layer-3')?.parentElement?.getAttribute('id')).toBe('layer-4');
	});

	it('reads a locked layer, and the copy is not locked', async () => {
		const fake = createFake({ layerAttributes: ' draw:locked="true"' });
		const made = await layerViaArea(fake.context, 'copy');
		expect(made).toBe('layer-3');
		expect(fake.notices).toEqual([]);
		expect(lockedOf(fake, 'layer-3')).toBe(false);
		expect(lockedOf(fake, 'layer-2')).toBe(true);
	});

	it('is waited for by a save', async () => {
		const fake = createFake();
		const work = layerViaArea(fake.context, 'copy');
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.viaCopy']);
		await expect(work).resolves.toBe('layer-3');
	});
});

describe('layer via cut', () => {
	it('moves the area’s pixels to a new layer above, in the same command', async () => {
		const fake = createFake();
		const made = await layerViaArea(fake.context, 'cut');
		expect(made).toBe('layer-3');
		expect(fake.labels).toEqual(['regions.viaCut']);
		expect(pictureAt(fake.hrefOf('layer-3'), 20, 15)).toEqual(RED);
		expect(pictureAt(fake.hrefOf('layer-3'), 5, 15)).toEqual(CLEAR);
		expect(pictureAt(fake.hrefOf('layer-2'), 20, 15)).toEqual(CLEAR);
		expect(pictureAt(fake.hrefOf('layer-2'), 5, 15)).toEqual(RED);
	});

	it('leaves the rest of a feathered edge behind, and undoes both layers at once', async () => {
		const fake = createFake({ region: { path: SQUARE, inverted: false, feather: 4 } });
		const before = fake.markup();
		await layerViaArea(fake.context, 'cut');
		const taken = pictureAt(fake.hrefOf('layer-3'), 10, 15)[3] ?? 0;
		const left = pictureAt(fake.hrefOf('layer-2'), 10, 15)[3] ?? 0;
		expect(taken).toBeGreaterThan(0);
		expect(left).toBeGreaterThan(0);
		expect(Math.abs(taken + left - 255)).toBeLessThanOrEqual(1);
		fake.document.undo();
		expect(fake.markup()).toBe(before);
	});

	it('says so on a locked layer, and makes nothing', async () => {
		const fake = createFake({ layerAttributes: ' draw:locked="true"' });
		await expect(layerViaArea(fake.context, 'cut')).resolves.toBeUndefined();
		expect(fake.notices).toEqual([t('layers.locked', { name: 'Sky' })]);
		expect(fake.labels).toEqual([]);
	});
});

describe('what layer via copy and cut do not do', () => {
	it('says so on a hidden layer, either way, and makes nothing', async () => {
		const fake = createFake({ layerAttributes: ' display="none"' });
		await expect(layerViaArea(fake.context, 'copy')).resolves.toBeUndefined();
		await expect(layerViaArea(fake.context, 'cut')).resolves.toBeUndefined();
		expect(fake.notices).toEqual([
			t('layers.hidden', { name: 'Sky' }),
			t('layers.hidden', { name: 'Sky' }),
		]);
		expect(fake.labels).toEqual([]);
	});

	it('says so for an area that holds no color', async () => {
		const empty = registerPicture(40, 30, (x) => (x < 5 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
		const fake = createFake({ picture: empty });
		await expect(layerViaArea(fake.context, 'cut')).resolves.toBeUndefined();
		expect(fake.notices).toEqual([t('regions.empty', { name: 'Sky' })]);
		expect(fake.labels).toEqual([]);
		expect(layerIds(fake)).toEqual(['layer-1', 'layer-2', 'layer-5']);
	});

	it('writes nothing where an undo moved the picture while it was encoded, and says so', async () => {
		const fake = createFake();
		fake.document.execute(renameLayer('layer-1', 'Ink'));
		const work = layerViaArea(fake.context, 'cut');
		// The cut is under way; the picture the surface read is put back by
		// hand, as an undo of a stroke would.
		fake.document
			.layer('layer-2')
			?.querySelector('image')
			?.setAttribute(
				'href',
				registerPicture(40, 30, () => [0, 0, 255, 255])
			);
		await expect(work).resolves.toBeUndefined();
		expect(fake.labels).toEqual(['layers.rename']);
		expect(fake.notices).toEqual([t('raster.failed')]);
	});

	it('is not the area’s to do with no area, or on a layer that is not raster', () => {
		const fake = createFake();
		const none: ToolContext = {
			...fake.context,
			region: { path: undefined, region: undefined, set: noop, update: noop },
		};
		expect(layerViaArea(none, 'copy')).toBeUndefined();
		const vector: ToolContext = {
			...fake.context,
			layer: fake.document.snapshot().layers.find((each) => each.id === 'layer-1'),
		};
		expect(layerViaArea(vector, 'copy')).toBeUndefined();
		expect(fake.notices).toEqual([]);
	});
});
