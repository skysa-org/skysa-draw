import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { rectPath } from '../../src/drawing/tools/raster/area.js';
import { CLICK_SEARCH_PX, redEyeBehavior } from '../../src/drawing/tools/raster/redEye.js';
import {
	fixRedEye,
	type Pixels,
	PUPIL_FLOOR,
	type RedEyeRequest,
	rednessOf,
	SEED_REDNESS,
} from '../../src/drawing/tools/raster/redEyeFix.js';
import type * as Space from '../../src/drawing/tools/raster/space.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolBehavior,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import type * as Geometry from '../../src/drawing/tools/vector/geometry.js';
import { t } from '../../src/i18n/t.js';
import {
	installFakeCanvas,
	pictureAt,
	registerPicture,
	uninstallFakeCanvas,
} from './fakeCanvas.js';

/**
 * The red eye tool (docs/decisions/0004-the-interface.md): the correction
 * itself, `fixRedEye`, on pixels in memory, and the tool on a raster layer
 * against a real document and the compositing fake canvas (`fakeCanvas.ts`),
 * so what is checked is the pixels written into the layer's picture. What
 * this cannot show is how a corrected pupil looks in a real photograph, which
 * only a browser and a picture with a flash's red in it can.
 *
 * jsdom has no SVG transforms, so where a layer's `transform` is read here it
 * is read from the attribute, as a browser reads one on a layer at the root.
 */

vi.mock('../../src/drawing/tools/raster/space.js', async (importOriginal) => {
	const geometry = await vi.importActual<typeof Geometry>(
		'../../src/drawing/tools/vector/geometry.js'
	);
	return {
		...(await importOriginal<typeof Space>()),
		toLocal: (
			layer: Element,
			_root: Element,
			x: number,
			y: number
		): readonly [number, number] => {
			const local = geometry.apply(
				geometry.invert(geometry.parseTransform(layer.getAttribute('transform'))),
				{ x, y }
			);
			return [local.x, local.y];
		},
	};
});

type Rgba = readonly [number, number, number, number];

/** A flash's red in a pupil, its pink rim, and what is around them. */
const RED: Rgba = [200, 40, 40, 255];
const RIM: Rgba = [190, 100, 105, 255];
const GLINT: Rgba = [250, 250, 250, 255];
const IRIS: Rgba = [120, 80, 50, 255];
const SCLERA: Rgba = [235, 230, 225, 255];
const SKIN: Rgba = [224, 172, 140, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** Skin, and the colors near an eye that are warm without being a pupil's red. */
const WARM: readonly (readonly [string, Rgba])[] = [
	['light skin', [240, 200, 175, 255]],
	['skin', SKIN],
	['tanned skin', [200, 150, 120, 255]],
	['dark skin', [140, 95, 70, 255]],
	['flushed skin', [220, 140, 130, 255]],
	['the pink corner of an eye', [220, 140, 140, 255]],
	['a brown iris', IRIS],
	['a warm brown', [150, 90, 60, 255]],
	['an orange', [255, 160, 60, 255]],
];

/** What a pixel of an eye is, by its center's distance from the eye's. */
type Part = 'glint' | 'pupil' | 'rim' | 'iris' | 'sclera' | 'around';

const partAt = (cx: number, cy: number, x: number, y: number): Part => {
	const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
	if (d < 1.5) return 'glint';
	if (d < 5) return 'pupil';
	if (d < 6) return 'rim';
	if (d < 10) return 'iris';
	if (d < 14) return 'sclera';
	return 'around';
};

const COLORS: Readonly<Record<Part, Rgba>> = {
	glint: GLINT,
	pupil: RED,
	rim: RIM,
	iris: IRIS,
	sclera: SCLERA,
	around: SKIN,
};

/** An eye at `(cx, cy)` with a red pupil, a catchlight in it and a pink rim around it, on skin. */
const eyeAt =
	(cx: number, cy: number) =>
	(x: number, y: number): Rgba =>
		COLORS[partAt(cx, cy, x, y)];

const pixelsOf = (width: number, height: number, paint: (x: number, y: number) => Rgba): Pixels => {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i += 1) {
		data.set(paint(i % width, Math.floor(i / width)), i * 4);
	}
	return { data, width, height };
};

const pixelAt = (data: Uint8ClampedArray, width: number, x: number, y: number): number[] =>
	Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));

/** The eye at the middle of 40 × 40 pixels. */
const EYE = pixelsOf(40, 40, eyeAt(20, 20));

const fix = (pixels: Pixels, change: Partial<RedEyeRequest> = {}) =>
	fixRedEye({
		pixels,
		search: { x: 0, y: 0, width: pixels.width, height: pixels.height },
		at: { x: pixels.width / 2, y: pixels.height / 2 },
		pupilSize: 0.5,
		darken: 0.5,
		...change,
	});

/** Every pixel that differs between two pictures of the same size, by its index. */
const changedOf = (before: Uint8ClampedArray, after: Uint8ClampedArray): number[] =>
	Array.from({ length: before.length / 4 }, (_, i) => i).filter((i) =>
		[0, 1, 2, 3].some((c) => before[i * 4 + c] !== after[i * 4 + c])
	);

/** A pixel of the pupil, of its rim, and one of each thing around it. */
const PUPIL_PX = [17, 20] as const;
const RIM_PX = [14, 20] as const;

describe('rednessOf', () => {
	it('measures a pupil’s red as red however bright it is, and a warm or pink color by how much red it shows', () => {
		expect(rednessOf(200, 40, 40)).toBeCloseTo(160 / 280);
		expect(rednessOf(100, 20, 20)).toBeCloseTo(rednessOf(200, 40, 40));
		expect(rednessOf(200, 40, 40)).toBeGreaterThan(SEED_REDNESS);
		// A pink rim keeps enough red to be taken at the largest pupil size.
		expect(rednessOf(200, 110, 120)).toBeGreaterThan(PUPIL_FLOOR);
		expect(rednessOf(RIM[0], RIM[1], RIM[2])).toBeGreaterThan(PUPIL_FLOOR);
		expect(rednessOf(RIM[0], RIM[1], RIM[2])).toBeLessThan(SEED_REDNESS);
		WARM.forEach(([, [r, g, b]]) => expect(rednessOf(r, g, b)).toBeLessThan(PUPIL_FLOOR));
		expect(rednessOf(0, 0, 0)).toBe(0);
		expect(rednessOf(128, 128, 128)).toBe(0);
	});
});

describe('fixRedEye', () => {
	it('makes a red pupil a dark neutral, from the mean of its green and blue, darkened by Darken amount', () => {
		const [x, y] = PUPIL_PX;
		expect(partAt(20, 20, x, y)).toBe('pupil');
		const half = fix(EYE);
		expect(half.outcome).toBe('corrected');
		expect(pixelAt(half.data, 40, x, y)).toEqual([20, 20, 20, 255]);
		expect(pixelAt(fix(EYE, { darken: 0 }).data, 40, x, y)).toEqual([40, 40, 40, 255]);
		expect(pixelAt(fix(EYE, { darken: 1 }).data, 40, x, y)).toEqual([0, 0, 0, 255]);
	});

	it('changes the pupil and nothing else at the default Pupil size, the catchlight in it included', () => {
		const result = fix(EYE);
		const pupil = Array.from({ length: 40 * 40 }, (_, i) => i).filter(
			(i) => partAt(20, 20, i % 40, Math.floor(i / 40)) === 'pupil'
		);
		expect(changedOf(EYE.data, result.data)).toEqual(pupil);
		expect(result.changed).toBe(pupil.length);
		expect(pixelAt(result.data, 40, 20, 20)).toEqual([...GLINT]);
	});

	it('takes the pink rim only at a large Pupil size, and blends it rather than blacking it out', () => {
		const [x, y] = RIM_PX;
		expect(partAt(20, 20, x, y)).toBe('rim');
		expect(pixelAt(fix(EYE, { pupilSize: 0 }).data, 40, x, y)).toEqual([...RIM]);
		expect(pixelAt(fix(EYE, { pupilSize: 0.5 }).data, 40, x, y)).toEqual([...RIM]);
		const large = fix(EYE, { pupilSize: 1, darken: 0.5 });
		const [r, g, b, a] = pixelAt(large.data, 40, x, y);
		// The neutral the pupil goes to is (100 + 105) / 2 × 0.5, about 51.
		expect(r).toBeLessThan(RIM[0]);
		expect(r).toBeGreaterThan(60);
		expect(g).toBeLessThanOrEqual(RIM[1]);
		expect(b).toBeLessThan(RIM[2]);
		expect(a).toBe(255);
		expect(large.changed).toBeGreaterThan(fix(EYE).changed);
	});

	it('takes only the reddest core at a Pupil size of 0, and the rest of the red as it grows', () => {
		// A pupil brighter in the middle than at its edge.
		const graded = pixelsOf(30, 30, (x, y) => {
			const d = Math.hypot(x + 0.5 - 15, y + 0.5 - 15);
			if (d < 2.5) return [230, 30, 30, 255];
			if (d < 5) return [170, 60, 60, 255];
			return SKIN;
		});
		const core = fix(graded, { pupilSize: 0 });
		expect(pixelAt(core.data, 30, 15, 15)).not.toEqual([230, 30, 30, 255]);
		expect(pixelAt(core.data, 30, 11, 15)).toEqual([170, 60, 60, 255]);
		const most = fix(graded, { pupilSize: 0.5 });
		expect(pixelAt(most.data, 30, 15, 15)).not.toEqual([230, 30, 30, 255]);
		expect(pixelAt(most.data, 30, 11, 15)).toEqual([30, 30, 30, 255]);
	});

	it.each([0, 0.5, 1])(
		'leaves the iris, the white of the eye and the skin exactly as they were at a Pupil size of %s',
		(pupilSize) => {
			const result = fix(EYE, { pupilSize, darken: 1 });
			changedOf(EYE.data, result.data).forEach((i) => {
				expect(['pupil', 'rim']).toContain(partAt(20, 20, i % 40, Math.floor(i / 40)));
			});
		}
	);

	it.each(WARM)(
		'leaves %s right beside a pupil as it was, even at the largest Pupil size',
		(_, warm) => {
			const beside = pixelsOf(24, 24, (x, y) =>
				Math.hypot(x + 0.5 - 12, y + 0.5 - 12) < 5 ? RED : warm
			);
			const result = fix(beside, { pupilSize: 1, darken: 1 });
			expect(result.outcome).toBe('corrected');
			changedOf(beside.data, result.data).forEach((i) => {
				expect(pixelAt(beside.data, 24, i % 24, Math.floor(i / 24))).toEqual([...RED]);
			});
		}
	);

	it.each(WARM)('finds no pupil in %s alone, and changes nothing', (_, warm) => {
		const plain = pixelsOf(16, 16, () => warm);
		const result = fix(plain, { pupilSize: 1 });
		expect(result.outcome).toBe('notFound');
		expect(result.changed).toBe(0);
		expect(result.data).toEqual(plain.data);
	});

	it('looks only in the search, and nowhere when it misses the pixels', () => {
		const away = fix(EYE, { search: { x: 0, y: 0, width: 8, height: 8 }, at: { x: 4, y: 4 } });
		expect(away.outcome).toBe('notFound');
		expect(away.data).toEqual(EYE.data);
		const off = fix(EYE, { search: { x: -20, y: -20, width: 10, height: 10 } });
		expect(off.outcome).toBe('notFound');
		// A search partly off the pixels is kept to them.
		const partly = fix(EYE, { search: { x: 10, y: -30, width: 20, height: 60 } });
		expect(partly.outcome).toBe('corrected');
	});

	it('grows the pupil past the search, but never past the pixels it is given', () => {
		const result = fix(EYE, { search: { x: 18, y: 18, width: 2, height: 2 } });
		expect(result.changed).toBe(fix(EYE).changed);
	});

	it('corrects the pupil nearer the aim where two are in the search, the other one redder or not', () => {
		const two = pixelsOf(60, 20, (x, y) => {
			if (Math.hypot(x + 0.5 - 10, y + 0.5 - 10) < 4) return RED;
			if (Math.hypot(x + 0.5 - 50, y + 0.5 - 10) < 4) return [235, 25, 25, 255];
			return SKIN;
		});
		const left = fix(two, { at: { x: 16, y: 10 } });
		expect(pixelAt(left.data, 60, 10, 10)).toEqual([20, 20, 20, 255]);
		expect(pixelAt(left.data, 60, 50, 10)).toEqual([235, 25, 25, 255]);
		const right = fix(two, { at: { x: 44, y: 10 } });
		expect(pixelAt(right.data, 60, 10, 10)).toEqual([...RED]);
		expect(pixelAt(right.data, 60, 50, 10)).not.toEqual([235, 25, 25, 255]);
	});

	it('changes a pixel by as much as the area covers it, and says so where the red is all outside it', () => {
		const coverage = (alpha: (x: number) => number): Uint8ClampedArray =>
			pixelsOf(40, 40, (x) => [0, 0, 0, alpha(x)]).data;
		const left = fix(EYE, { coverage: coverage((x) => (x < 20 ? 255 : 0)) });
		expect(left.outcome).toBe('corrected');
		changedOf(EYE.data, left.data).forEach((i) => expect(i % 40).toBeLessThan(20));
		expect(pixelAt(left.data, 40, 22, 20)).toEqual([...RED]);
		const [x, y] = PUPIL_PX;
		// Half covered, halfway: 200 + (20 − 200) × 128 / 255 is 109.6.
		const half = fix(EYE, { coverage: coverage(() => 128) });
		expect(pixelAt(half.data, 40, x, y)).toEqual([110, 30, 30, 255]);
		const none = fix(EYE, { coverage: coverage(() => 0) });
		expect(none.outcome).toBe('outsideArea');
		expect(none.data).toEqual(EYE.data);
	});

	it('keeps each pixel’s alpha and passes over a clear one', () => {
		const faint = pixelsOf(20, 20, (x, y) => {
			if (x === 10 && y === 10) return CLEAR;
			return Math.hypot(x + 0.5 - 10, y + 0.5 - 10) < 5 ? [200, 40, 40, 128] : CLEAR;
		});
		const result = fix(faint);
		expect(pixelAt(result.data, 20, 8, 10)).toEqual([20, 20, 20, 128]);
		expect(pixelAt(result.data, 20, 10, 10)).toEqual([...CLEAR]);
		expect(pixelAt(result.data, 20, 0, 0)).toEqual([...CLEAR]);
	});

	it('leaves the pixels it is given as they were', () => {
		const copy = new Uint8ClampedArray(EYE.data);
		fix(EYE, { pupilSize: 1, darken: 1 });
		expect(EYE.data).toEqual(copy);
	});

	it('floods a pupil as large as a photo without recursing', () => {
		const size = 1000;
		const red = pixelsOf(size, size, () => RED);
		expect(fix(red).changed).toBe(size * size);
	});
});

// ---- The tool on a raster layer ---------------------------------------------

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** The eye on the layer, in its pixels: one pixel a unit, unless the layer moves it. */
const EYE_AT = [40, 60] as const;

/** The canvas is 160 × 120; `layer-2` is a raster layer with a picture the canvas's size. */
const drawingText = (picture: string, layerAttributes: string): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 160 120" width="160" height="120">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		`  <g id="layer-2" draw:kind="raster"${layerAttributes}><image href="${picture}" x="0" y="0" width="160" height="120" preserveAspectRatio="none"/></g>`,
		'</svg>',
		'',
	].join('\n');

const noop = (): undefined => undefined;

type Fake = Readonly<{
	context: ToolContext;
	document: EditorDocument;
	labels: string[];
	notices: string[];
	at: (x: number, y: number) => number[];
}>;

type Setup = Readonly<{
	layerAttributes?: string;
	region?: Region;
	options?: Partial<ToolOptions>;
	scale?: number;
}>;

const createFake = (setup: Setup = {}): Fake => {
	const picture = registerPicture(160, 120, eyeAt(EYE_AT[0], EYE_AT[1]));
	const opened = openDocument(drawingText(picture, setup.layerAttributes ?? ''));
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
	const { region } = setup;
	const context: ToolContext = {
		document: editor,
		layer: editor.snapshot().layers.find((each) => each.id === 'layer-2'),
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: {
			canvas: document.createElement('canvas'),
			toScreen: (x, y) => [x, y],
			pixelRatio: 1,
		},
		viewport: {
			scale: setup.scale ?? 1,
			zoomBy: noop,
			panBy: noop,
			fit: noop,
			actualSize: noop,
		},
		selection: { elements: [], set: noop, clear: noop },
		region: { path: region?.path, region, set: noop, update: noop },
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	const href = () =>
		Array.from(editor.layer('layer-2')?.children ?? [])
			.find((child) => child.localName === 'image')
			?.getAttribute('href');
	return { context, document: editor, labels, notices, at: (x, y) => pictureAt(href(), x, y) };
};

const sample = (x: number, y: number): PointerSample => ({
	x,
	y,
	pressure: 0.5,
	tiltX: 0,
	tiltY: 0,
	pointerType: 'mouse',
	time: 0,
	shiftKey: false,
	altKey: false,
	primaryKey: false,
});

const click = (tool: ToolBehavior, context: ToolContext, x: number, y: number): void => {
	tool.begin(context, sample(x, y));
	tool.end(context, sample(x, y));
};

/** A pixel of the pupil on the layer, left of the catchlight, and its catchlight. */
const PUPIL_ON_LAYER = [EYE_AT[0] - 3, EYE_AT[1]] as const;
const DARK = [20, 20, 20, 255];

describe('the red eye tool on a raster layer', () => {
	beforeEach(() => installFakeCanvas());
	afterEach(uninstallFakeCanvas);

	it('corrects the pupil clicked by one command, and leaves the rest of the layer', async () => {
		const fake = createFake();
		click(redEyeBehavior(), fake.context, 40.5, 60.5);
		await fake.document.settle();
		expect(fake.labels).toEqual(['redEye.command']);
		expect(t('redEye.command')).toBe('Red eye');
		expect(fake.at(...PUPIL_ON_LAYER)).toEqual(DARK);
		expect(fake.at(40, 60)).toEqual([...GLINT]);
		expect(fake.at(40, 52)).toEqual([...IRIS]);
		expect(fake.at(5, 5)).toEqual([...SKIN]);
		expect(fake.notices).toEqual([]);
	});

	it('reads Pupil size and Darken amount from the options', async () => {
		const fake = createFake({ options: { darken: 1, pupilSize: 1 } });
		click(redEyeBehavior(), fake.context, 40.5, 60.5);
		await fake.document.settle();
		expect(fake.at(...PUPIL_ON_LAYER)).toEqual([0, 0, 0, 255]);
		expect(fake.at(EYE_AT[0] - 6, EYE_AT[1])).not.toEqual([...RIM]);
	});

	it(`looks for the pupil in a square ${CLICK_SEARCH_PX} px across on the screen around a click`, async () => {
		// 45 units right of the eye: inside 50 at a scale of 1, outside 25 at a scale of 2.
		const near = createFake({ scale: 1 });
		click(redEyeBehavior(), near.context, 85.5, 60.5);
		await near.document.settle();
		expect(near.at(...PUPIL_ON_LAYER)).toEqual(DARK);

		const zoomed = createFake({ scale: 2 });
		click(redEyeBehavior(), zoomed.context, 85.5, 60.5);
		await zoomed.document.settle();
		expect(zoomed.labels).toEqual([]);
		expect(zoomed.notices).toEqual([t('redEye.notFound')]);

		const closer = createFake({ scale: 2 });
		click(redEyeBehavior(), closer.context, 60.5, 60.5);
		await closer.document.settle();
		expect(closer.at(...PUPIL_ON_LAYER)).toEqual(DARK);
	});

	it('says so and writes nothing where a click finds no red pupil, or misses the layer', async () => {
		const fake = createFake();
		const tool = redEyeBehavior();
		click(tool, fake.context, 140, 20);
		click(tool, fake.context, -200, -200);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([t('redEye.notFound'), t('redEye.notFound')]);
	});

	it('keeps a drag to the box it draws, shown on the overlay as the marquee’s while it lasts', async () => {
		const fake = createFake();
		const tool = redEyeBehavior();
		tool.begin(fake.context, sample(25, 45));
		tool.move(fake.context, sample(55, 75));
		const preview = fake.context.overlay.querySelector('path.viewport-area-drag');
		expect(preview?.getAttribute('d')).toBe(rectPath({ x: 25, y: 45, width: 30, height: 30 }));
		tool.end(fake.context, sample(55, 75));
		expect(fake.context.overlay.childElementCount).toBe(0);
		await fake.document.settle();
		expect(fake.at(...PUPIL_ON_LAYER)).toEqual(DARK);

		// A box away from the eye, though a click there would reach it.
		const away = createFake();
		away.context.overlay.replaceChildren();
		tool.begin(away.context, sample(60, 40));
		tool.move(away.context, sample(100, 80));
		tool.end(away.context, sample(100, 80));
		await away.document.settle();
		expect(away.labels).toEqual([]);
		expect(away.notices).toEqual([t('redEye.notFound')]);
	});

	it('writes nothing for a drag canceled by Escape, and takes its box away', async () => {
		const fake = createFake();
		const tool = redEyeBehavior();
		tool.begin(fake.context, sample(25, 45));
		tool.move(fake.context, sample(55, 75));
		tool.cancel(fake.context);
		expect(fake.context.overlay.childElementCount).toBe(0);
		tool.end(fake.context, sample(55, 75));
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([]);
	});

	it('says a locked or a hidden layer is so, and writes nothing to it', async () => {
		const locked = createFake({ layerAttributes: ' draw:locked="true"' });
		click(redEyeBehavior(), locked.context, 40.5, 60.5);
		const hidden = createFake({ layerAttributes: ' display="none"' });
		click(redEyeBehavior(), hidden.context, 40.5, 60.5);
		await Promise.all([locked.document.settle(), hidden.document.settle()]);
		expect(locked.labels).toEqual([]);
		expect(hidden.labels).toEqual([]);
		expect(locked.notices).toEqual([t('layers.locked', { name: 'Layer 2' })]);
		expect(hidden.notices).toEqual([t('layers.hidden', { name: 'Layer 2' })]);
		expect(locked.context.overlay.childElementCount).toBe(0);
	});

	it('changes only what the area covers, and says so where the pupil is outside it', async () => {
		const left = createFake({
			region: { path: 'M 0 0 L 40 0 L 40 120 L 0 120 Z', inverted: false, feather: 0 },
		});
		click(redEyeBehavior(), left.context, 40.5, 60.5);
		await left.document.settle();
		expect(left.at(...PUPIL_ON_LAYER)).toEqual(DARK);
		expect(left.at(EYE_AT[0] + 2, EYE_AT[1])).toEqual([...RED]);

		const away = createFake({
			region: { path: 'M 100 0 L 160 0 L 160 120 L 100 120 Z', inverted: false, feather: 0 },
		});
		click(redEyeBehavior(), away.context, 40.5, 60.5);
		await away.document.settle();
		expect(away.labels).toEqual([]);
		expect(away.notices).toEqual([t('redEye.outsideArea')]);

		const inverse = createFake({
			region: { path: 'M 100 0 L 160 0 L 160 120 L 100 120 Z', inverted: true, feather: 0 },
		});
		click(redEyeBehavior(), inverse.context, 40.5, 60.5);
		await inverse.document.settle();
		expect(inverse.at(...PUPIL_ON_LAYER)).toEqual(DARK);
	});

	it('finds the pupil under the pointer on a layer its transform moved', async () => {
		const fake = createFake({ layerAttributes: ' transform="translate(20 10)"' });
		click(redEyeBehavior(), fake.context, 60.5, 70.5);
		await fake.document.settle();
		expect(fake.at(...PUPIL_ON_LAYER)).toEqual(DARK);
	});
});
