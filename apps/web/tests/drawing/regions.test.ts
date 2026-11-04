import { DEFAULT_DRAWING_SIZE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import type { EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import {
	addToArea,
	antsPath,
	areaHolds,
	areaOf,
	areaPixelBox,
	areaPolygons,
	areaTouchesBox,
	polygonPath,
	reachesArea,
	reachesSurface,
	rectPath,
	translatePath,
} from '../../src/drawing/tools/raster/area.js';
import { rasterBehaviors } from '../../src/drawing/tools/raster/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolBehavior,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import { createRegionSelect } from '../../src/drawing/tools/vector/region.js';
import { t } from '../../src/i18n/t.js';

/**
 * The marquee and the lasso (docs/decisions/0004-the-interface.md: "Select
 * pixels in a region" on a raster layer, "Select elements in a region" on a
 * vector one) and the area they make (`RegionControl`), against a fake
 * context with a real SVG document: the area and the selection are cells the
 * test reads back. Painting inside the area is the raster tools' and is
 * tested with them (`raster.test.ts`, `smudge.test.ts`); the keys and the
 * marching ants are the viewport's (`viewport.test.tsx`).
 */

const noop = (): undefined => undefined;

const layerInfo = (overrides: Partial<LayerInfo> = {}): LayerInfo => ({
	id: 'layer-1',
	kind: 'vector',
	name: undefined,
	hidden: false,
	locked: false,
	opacity: 1,
	blend: 'normal',
	depth: 0,
	parentId: undefined,
	loose: false,
	...overrides,
});

type Fake = Readonly<{
	context: ToolContext;
	/** What the area's outline is now. */
	area: () => string | undefined;
	/** The whole area now. */
	region: () => Region | undefined;
	/** What is selected now. */
	selected: () => readonly Element[];
	notices: string[];
	/** By id, the elements of `layer-1`. */
	element: (id: string) => Element;
}>;

type Setup = Readonly<{
	layer?: Partial<LayerInfo>;
	area?: string;
	/** The whole area, where it is inverted or feathered; `area` for a plain one. */
	region?: Region;
	options?: Partial<ToolOptions>;
	selected?: readonly string[];
	scale?: number;
}>;

/** `layer-1` holds three shapes: `a` at the corner, `c` near it, `b` far away. */
const createFake = (setup: Setup = {}): Fake => {
	const parsed = new DOMParser().parseFromString(emptyDrawing({ id: 'd-1' }), 'image/svg+xml');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	const layer = parsed.getElementById('layer-1');
	if (layer === null) throw new Error('an empty drawing starts with layer-1');
	const shapes: Record<string, Record<string, string>> = {
		a: { tag: 'rect', x: '0', y: '0', width: '10', height: '10' },
		b: { tag: 'rect', x: '100', y: '100', width: '10', height: '10' },
		c: { tag: 'ellipse', cx: '30', cy: '30', rx: '5', ry: '5' },
	};
	Object.entries(shapes).forEach(([id, { tag = 'rect', ...attributes }]) => {
		const element = parsed.createElementNS(SVG_NAMESPACE, tag);
		element.setAttribute('id', id);
		Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
		layer.appendChild(element);
	});
	const element = (id: string): Element => {
		const found = parsed.getElementById(id);
		if (found === null) throw new Error(`no ${id}`);
		return found;
	};
	const info = layerInfo(setup.layer);
	const notices: string[] = [];
	let region: Region | undefined =
		setup.region ??
		(setup.area === undefined ? undefined : { path: setup.area, inverted: false, feather: 0 });
	let selected: readonly Element[] = (setup.selected ?? []).map(element);
	const editor: EditorDocument = {
		root,
		prolog: '',
		size: DEFAULT_DRAWING_SIZE,
		snapshot: () => ({
			layers: [info],
			size: DEFAULT_DRAWING_SIZE,
			canUndo: false,
			canRedo: false,
			dirty: false,
			version: 0,
		}),
		text: () => '',
		layer: (id) =>
			(root.ownerDocument.getElementById(id) as unknown as SVGGraphicsElement | null) ??
			undefined,
		execute: noop,
		undo: noop,
		redo: noop,
		subscribe: () => noop,
		pending: noop,
		settle: () => Promise.resolve(),
	};
	const context: ToolContext = {
		document: editor,
		layer: info,
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
		selection: {
			get elements() {
				return selected;
			},
			set: (elements) => {
				selected = elements;
			},
			clear: () => {
				selected = [];
			},
		},
		region: {
			get path() {
				return region?.path;
			},
			get region() {
				return region;
			},
			set: (path) => {
				region = path === undefined ? undefined : { path, inverted: false, feather: 0 };
			},
			update: (change) => {
				if (region !== undefined) region = { ...region, ...change };
			},
		},
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	return {
		context,
		area: () => region?.path,
		region: () => region,
		selected: () => selected,
		notices,
		element,
	};
};

const at = (x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample => ({
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
	...extra,
});

type Step = Readonly<{ x: number; y: number }> & Partial<PointerSample>;

/** A drag: begin at the first step, move through the rest, end at the last. */
const drag = (behavior: ToolBehavior, context: ToolContext, steps: readonly Step[]): void => {
	const [first, ...rest] = steps;
	if (first === undefined) return;
	behavior.begin(context, at(first.x, first.y, first));
	rest.forEach((step) => behavior.move(context, at(step.x, step.y, step)));
	const last = rest.at(-1) ?? first;
	behavior.end(context, at(last.x, last.y, last));
};

const raster = (id: 'marquee' | 'lasso'): ToolBehavior => {
	const behavior = rasterBehaviors[id];
	if (behavior === undefined) throw new Error(`no raster ${id}`);
	return behavior;
};

const RASTER = { id: 'layer-1', kind: 'raster' } as const;

describe('the area’s paths', () => {
	it('writes a rectangle clockwise from its corner, and nothing for one with no inside', () => {
		expect(rectPath({ x: 10, y: 20, width: 30, height: 40 })).toBe(
			'M 10 20 L 40 20 L 40 60 L 10 60 Z'
		);
		expect(rectPath({ x: 10, y: 20, width: 0, height: 40 })).toBeUndefined();
	});

	it('winds a polygon clockwise whichever way it was drawn, so subpaths added are a union', () => {
		const clockwise = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
		];
		expect(polygonPath(clockwise)).toBe('M 0 0 L 10 0 L 10 10 Z');
		expect(polygonPath([...clockwise].reverse())).toBe('M 0 0 L 10 0 L 10 10 Z');
		expect(polygonPath(clockwise.slice(0, 2))).toBeUndefined();
		expect(
			polygonPath([
				{ x: 0, y: 0 },
				{ x: 5, y: 5 },
				{ x: 10, y: 10 },
			])
		).toBeUndefined();
	});

	it('reads its subpaths back as corners, and says what boxes they touch', () => {
		const area = addToArea('M 0 0 L 10 0 L 10 10 L 0 10 Z', 'M 50 50 L 60 50 L 55 60 Z');
		const polygons = areaPolygons(area);
		expect(polygons).toHaveLength(2);
		expect(polygons[1]).toEqual([
			{ x: 50, y: 50 },
			{ x: 60, y: 50 },
			{ x: 55, y: 60 },
		]);
		// Inside one, round one, crossed by one's edge, and clear of both.
		expect(areaTouchesBox(polygons, { x: 2, y: 2, width: 1, height: 1 })).toBe(true);
		expect(areaTouchesBox(polygons, { x: -5, y: -5, width: 30, height: 30 })).toBe(true);
		expect(areaTouchesBox(polygons, { x: 55, y: 40, width: 1, height: 30 })).toBe(true);
		expect(areaTouchesBox(polygons, { x: 20, y: 20, width: 5, height: 5 })).toBe(false);
		// Inside the triangle's box but outside the triangle.
		expect(areaTouchesBox(polygons, { x: 50, y: 58, width: 1, height: 1 })).toBe(false);
	});
});

describe('the marquee on a raster layer', () => {
	it('sets the area to the rectangle dragged, whichever way it was dragged', () => {
		const fake = createFake({ layer: RASTER });
		drag(raster('marquee'), fake.context, [
			{ x: 50, y: 30 },
			{ x: 30, y: 20 },
			{ x: 10, y: 10 },
		]);
		expect(fake.area()).toBe('M 10 10 L 50 10 L 50 30 L 10 30 Z');
	});

	it('keeps it square with the constrain option, or with Shift pressed during the drag', () => {
		const square = 'M 10 10 L 50 10 L 50 50 L 10 50 Z';
		const constrained = createFake({ layer: RASTER, options: { constrain: true } });
		drag(raster('marquee'), constrained.context, [
			{ x: 10, y: 10 },
			{ x: 50, y: 30 },
		]);
		expect(constrained.area()).toBe(square);

		const shifted = createFake({ layer: RASTER });
		drag(raster('marquee'), shifted.context, [
			{ x: 10, y: 10 },
			{ x: 50, y: 30, shiftKey: true },
		]);
		expect(shifted.area()).toBe(square);
	});

	it('draws from the center with Alt', () => {
		const fake = createFake({ layer: RASTER });
		drag(raster('marquee'), fake.context, [
			{ x: 20, y: 20 },
			{ x: 30, y: 25, altKey: true },
		]);
		expect(fake.area()).toBe('M 10 15 L 30 15 L 30 25 L 10 25 Z');
	});

	it('adds to the area with Shift held as it begins, as a second subpath, and not square', () => {
		const first = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';
		const fake = createFake({ layer: RASTER, area: first });
		drag(raster('marquee'), fake.context, [
			{ x: 60, y: 60, shiftKey: true },
			{ x: 80, y: 70, shiftKey: true },
		]);
		expect(fake.area()).toBe(`${first} M 60 60 L 80 60 L 80 70 L 60 70 Z`);

		const replaced = createFake({ layer: RASTER, area: first });
		drag(raster('marquee'), replaced.context, [
			{ x: 60, y: 60 },
			{ x: 80, y: 70 },
		]);
		expect(replaced.area()).toBe('M 60 60 L 80 60 L 80 70 L 60 70 Z');
	});

	it('keeps the feather when Shift adds, and makes a new area plain', () => {
		const first = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';
		const feathered = createFake({
			layer: RASTER,
			region: { path: first, inverted: false, feather: 3 },
		});
		drag(raster('marquee'), feathered.context, [
			{ x: 60, y: 60, shiftKey: true },
			{ x: 80, y: 70, shiftKey: true },
		]);
		expect(feathered.region()).toEqual({
			path: `${first} M 60 60 L 80 60 L 80 70 L 60 70 Z`,
			inverted: false,
			feather: 3,
		});

		// Begun in the hole, outside what an inverse selects: inside it, the drag would move it.
		const replaced = createFake({
			layer: RASTER,
			region: { path: first, inverted: true, feather: 3 },
		});
		drag(raster('marquee'), replaced.context, [
			{ x: 5, y: 5 },
			{ x: 80, y: 70 },
		]);
		expect(replaced.region()).toEqual({
			path: 'M 5 5 L 80 5 L 80 70 L 5 70 Z',
			inverted: false,
			feather: 0,
		});
	});

	it('starts a new plain area with Shift over an inverted one, which no union of outlines adds to', () => {
		const fake = createFake({
			layer: RASTER,
			region: { path: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', inverted: true, feather: 2 },
		});
		drag(raster('lasso'), fake.context, [
			{ x: 60, y: 60, shiftKey: true },
			{ x: 80, y: 60, shiftKey: true },
			{ x: 80, y: 70, shiftKey: true },
		]);
		expect(fake.region()).toEqual({
			path: 'M 60 60 L 80 60 L 80 70 Z',
			inverted: false,
			feather: 0,
		});

		const clicked = createFake({
			layer: RASTER,
			region: { path: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', inverted: true, feather: 2 },
		});
		drag(raster('marquee'), clicked.context, [{ x: 5, y: 5, shiftKey: true }]);
		expect(clicked.region()?.inverted).toBe(true);
	});

	it('drops the area on a click, and keeps it on a Shift-click', () => {
		const first = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';
		const kept = createFake({ layer: RASTER, area: first });
		drag(raster('marquee'), kept.context, [{ x: 5, y: 5, shiftKey: true }]);
		expect(kept.area()).toBe(first);

		const dropped = createFake({ layer: RASTER, area: first });
		drag(raster('marquee'), dropped.context, [
			{ x: 5, y: 5 },
			{ x: 6, y: 6 },
		]);
		expect(dropped.area()).toBeUndefined();
	});

	it('takes a click by the screen: a drag of a unit is a click at 1:1 and an area at 10×', () => {
		const near = createFake({ layer: RASTER });
		drag(raster('marquee'), near.context, [
			{ x: 5, y: 5 },
			{ x: 7, y: 7 },
		]);
		expect(near.area()).toBeUndefined();

		const zoomed = createFake({ layer: RASTER, scale: 10 });
		drag(raster('marquee'), zoomed.context, [
			{ x: 5, y: 5 },
			{ x: 7, y: 7 },
		]);
		expect(zoomed.area()).toBe('M 5 5 L 7 5 L 7 7 L 5 7 Z');
	});

	it('previews the drag on the overlay, and takes the preview away when it ends or is canceled', () => {
		const fake = createFake({ layer: RASTER });
		const marquee = raster('marquee');
		marquee.begin(fake.context, at(10, 10));
		marquee.move(fake.context, at(30, 20));
		const preview = fake.context.overlay.querySelector('path.viewport-area-drag');
		expect(preview?.getAttribute('d')).toBe('M 10 10 L 30 10 L 30 20 L 10 20 Z');
		marquee.end(fake.context, at(30, 20));
		expect(fake.context.overlay.childElementCount).toBe(0);

		marquee.begin(fake.context, at(10, 10));
		marquee.move(fake.context, at(30, 20));
		marquee.cancel(fake.context);
		expect(fake.context.overlay.childElementCount).toBe(0);
		expect(fake.area()).toBe('M 10 10 L 30 10 L 30 20 L 10 20 Z');
	});

	it('makes an area on a locked layer, since it changes no pixel', () => {
		const fake = createFake({ layer: { ...RASTER, locked: true } });
		drag(raster('marquee'), fake.context, [
			{ x: 10, y: 10 },
			{ x: 20, y: 20 },
		]);
		expect(fake.area()).toBe('M 10 10 L 20 10 L 20 20 L 10 20 Z');
		expect(fake.notices).toEqual([]);
	});
});

describe('the lasso on a raster layer', () => {
	it('closes the outline where the pointer lifts, simplified', () => {
		const fake = createFake({ layer: RASTER });
		// A tremor of a fifth of a pixel along the top is let go.
		drag(raster('lasso'), fake.context, [
			{ x: 10, y: 10 },
			{ x: 30, y: 10.2 },
			{ x: 50, y: 10 },
			{ x: 50, y: 40 },
			{ x: 10, y: 40 },
		]);
		expect(fake.area()).toBe('M 10 10 L 50 10 L 50 40 L 10 40 Z');
	});

	it('winds the outline clockwise whichever way it was drawn', () => {
		const fake = createFake({ layer: RASTER });
		drag(raster('lasso'), fake.context, [
			{ x: 10, y: 10 },
			{ x: 10, y: 40 },
			{ x: 50, y: 40 },
			{ x: 50, y: 10 },
		]);
		expect(fake.area()).toBe('M 50 10 L 50 40 L 10 40 L 10 10 Z');
	});

	it('previews the outline open, as it is drawn', () => {
		const fake = createFake({ layer: RASTER });
		const lasso = raster('lasso');
		lasso.begin(fake.context, at(10, 10));
		lasso.move(fake.context, at(20, 10));
		lasso.move(fake.context, at(20, 20));
		const preview = fake.context.overlay.querySelector('path.viewport-area-drag');
		expect(preview?.getAttribute('d')).toBe('M 10 10 L 20 10 L 20 20');
		lasso.cancel(fake.context);
	});

	it('makes no area of an outline with no inside, or of a click', () => {
		const line = createFake({ layer: RASTER, area: 'M 0 0 L 1 0 L 1 1 Z' });
		drag(raster('lasso'), line.context, [
			{ x: 10, y: 10 },
			{ x: 30, y: 10 },
			{ x: 50, y: 10 },
		]);
		expect(line.area()).toBeUndefined();

		const click = createFake({ layer: RASTER, area: 'M 0 0 L 1 0 L 1 1 Z' });
		drag(raster('lasso'), click.context, [{ x: 10, y: 10 }]);
		expect(click.area()).toBeUndefined();
	});
});

describe('a drag from inside the area on a raster layer', () => {
	const FIRST = 'M 10 10 L 30 10 L 30 30 L 10 30 Z';

	it('moves the outline with the pointer, live, and nothing else, with either tool', () => {
		(['marquee', 'lasso'] as const).forEach((kind) => {
			const fake = createFake({
				layer: RASTER,
				region: { path: FIRST, inverted: false, feather: 3 },
			});
			const behavior = raster(kind);
			behavior.begin(fake.context, at(20, 20));
			behavior.move(fake.context, at(25, 22.5));
			expect(fake.area()).toBe('M 15 12.5 L 35 12.5 L 35 32.5 L 15 32.5 Z');
			behavior.end(fake.context, at(30, 25));
			expect(fake.region()).toEqual({
				path: 'M 20 15 L 40 15 L 40 35 L 20 35 Z',
				inverted: false,
				feather: 3,
			});
			expect(fake.context.overlay.childElementCount).toBe(0);
		});
	});

	it('holds the outline across, down or at 45° with Shift pressed during the drag', () => {
		const fake = createFake({ layer: RASTER, area: FIRST });
		drag(raster('marquee'), fake.context, [
			{ x: 20, y: 20 },
			{ x: 30, y: 22, shiftKey: true },
		]);
		expect(fake.area()).toBe('M 20 10 L 40 10 L 40 30 L 20 30 Z');
	});

	it('makes a new area from inside with Shift or Alt held as it begins', () => {
		const added = createFake({ layer: RASTER, area: FIRST });
		drag(raster('marquee'), added.context, [
			{ x: 20, y: 20, shiftKey: true },
			{ x: 40, y: 40, shiftKey: true },
		]);
		expect(added.area()).toBe(`${FIRST} M 20 20 L 40 20 L 40 40 L 20 40 Z`);

		const fromCenter = createFake({ layer: RASTER, area: FIRST });
		drag(raster('marquee'), fromCenter.context, [
			{ x: 20, y: 20, altKey: true },
			{ x: 25, y: 25, altKey: true },
		]);
		expect(fromCenter.area()).toBe('M 15 15 L 25 15 L 25 25 L 15 25 Z');

		// Pressed only once the drag began, Alt leaves it the outline's.
		const later = createFake({ layer: RASTER, area: FIRST });
		drag(raster('marquee'), later.context, [
			{ x: 20, y: 20 },
			{ x: 25, y: 25, altKey: true },
		]);
		expect(later.area()).toBe('M 15 15 L 35 15 L 35 35 L 15 35 Z');
	});

	it('drops the area on a click inside it, and keeps an outline moved away and back', () => {
		const clicked = createFake({ layer: RASTER, area: FIRST });
		drag(raster('lasso'), clicked.context, [
			{ x: 20, y: 20 },
			{ x: 21, y: 21 },
		]);
		expect(clicked.area()).toBeUndefined();

		const back = createFake({ layer: RASTER, area: FIRST });
		drag(raster('marquee'), back.context, [
			{ x: 20, y: 20 },
			{ x: 40, y: 20 },
			{ x: 20, y: 20 },
		]);
		expect(back.area()).toBe(FIRST);
	});

	it('takes an inverse’s inside to be the canvas outside its outline, and keeps it inverted', () => {
		const inverse = { path: FIRST, inverted: true, feather: 0 };
		const moved = createFake({ layer: RASTER, region: inverse });
		drag(raster('marquee'), moved.context, [
			{ x: 50, y: 50 },
			{ x: 55, y: 50 },
		]);
		expect(moved.region()).toEqual({
			path: 'M 15 10 L 35 10 L 35 30 L 15 30 Z',
			inverted: true,
			feather: 0,
		});

		const hole = createFake({ layer: RASTER, region: inverse });
		drag(raster('marquee'), hole.context, [
			{ x: 20, y: 20 },
			{ x: 25, y: 25 },
		]);
		expect(hole.region()).toEqual({
			path: 'M 20 20 L 25 20 L 25 25 L 20 25 Z',
			inverted: false,
			feather: 0,
		});
	});

	it('puts the outline back when canceled', () => {
		const fake = createFake({ layer: RASTER, area: FIRST });
		const marquee = raster('marquee');
		marquee.begin(fake.context, at(20, 20));
		marquee.move(fake.context, at(40, 30));
		marquee.cancel(fake.context);
		expect(fake.area()).toBe(FIRST);
	});

	it('moves the outline of an area on a locked layer, since it changes no pixel', () => {
		const fake = createFake({ layer: { ...RASTER, locked: true }, area: FIRST });
		drag(raster('marquee'), fake.context, [
			{ x: 20, y: 20 },
			{ x: 25, y: 20 },
		]);
		expect(fake.area()).toBe('M 15 10 L 35 10 L 35 30 L 15 30 Z');
		expect(fake.notices).toEqual([]);
	});
});

describe('the marquee and the lasso on a vector layer', () => {
	const marquee = createRegionSelect('marquee');
	const lasso = createRegionSelect('lasso');

	it('selects every element whose box the area touches, and not the others, and drops the area', () => {
		const fake = createFake({ area: 'M 0 0 L 1 0 L 1 1 Z' });
		drag(marquee, fake.context, [
			{ x: 5, y: 5 },
			{ x: 35, y: 35 },
		]);
		expect(fake.selected()).toEqual([fake.element('a'), fake.element('c')]);
		expect(fake.area()).toBeUndefined();
	});

	it('outlines what it selected on the overlay, so it shows before the select tool is picked', () => {
		const fake = createFake();
		drag(marquee, fake.context, [
			{ x: 5, y: 5 },
			{ x: 35, y: 35 },
		]);
		const outlines = fake.context.overlay.querySelectorAll('[data-draw-region-outline] rect');
		expect(Array.from(outlines, (rect) => rect.getAttribute('x'))).toEqual(['0', '25']);
		expect(fake.context.overlay.querySelector('.viewport-area-drag')).toBeNull();

		drag(marquee, fake.context, [{ x: 500, y: 500 }]);
		expect(fake.context.overlay.querySelectorAll('[data-draw-region-outline]')).toHaveLength(0);
	});

	it('adds to the selection with Shift held as it begins, in paint order, and a click selects nothing', () => {
		const fake = createFake({ selected: ['b'] });
		drag(marquee, fake.context, [
			{ x: -5, y: -5, shiftKey: true },
			{ x: 5, y: 5, shiftKey: true },
		]);
		expect(fake.selected()).toEqual([fake.element('a'), fake.element('b')]);

		drag(marquee, fake.context, [{ x: 500, y: 500, shiftKey: true }]);
		expect(fake.selected()).toEqual([fake.element('a'), fake.element('b')]);

		drag(marquee, fake.context, [{ x: 500, y: 500 }]);
		expect(fake.selected()).toEqual([]);
	});

	it('selects with a lasso what its outline touches, not what its box does', () => {
		const fake = createFake();
		// A triangle whose box holds `c` but whose inside reaches only `a`.
		drag(lasso, fake.context, [
			{ x: -5, y: -5 },
			{ x: 40, y: -5 },
			{ x: -5, y: 40 },
		]);
		expect(fake.selected()).toEqual([fake.element('a')]);
	});

	it('says so on a locked layer, and selects nothing', () => {
		const fake = createFake({ layer: { locked: true }, selected: ['b'] });
		drag(marquee, fake.context, [
			{ x: 5, y: 5 },
			{ x: 35, y: 35 },
		]);
		expect(fake.notices).toEqual([t('layers.locked', { name: 'Layer 1' })]);
		expect(fake.selected()).toEqual([fake.element('b')]);
		expect(fake.context.overlay.childElementCount).toBe(0);
	});
});

describe('the area as the raster tools read it', () => {
	const SQUARE = 'M 10 10 L 30 10 L 30 30 L 10 30 Z';
	const areaFor = (region: Region) => {
		const area = areaOf(createFake({ layer: RASTER, region }).context);
		if (area === undefined) throw new Error('an area');
		return area;
	};

	it('is bounded by its outline, grown as far as its feather reaches', () => {
		expect(areaFor({ path: SQUARE, inverted: false, feather: 0 }).bounds).toEqual({
			x: 10,
			y: 10,
			width: 20,
			height: 20,
		});
		// A blur of half the feather reaches three deviations: one and a half feathers.
		expect(areaFor({ path: SQUARE, inverted: false, feather: 4 }).bounds).toEqual({
			x: 4,
			y: 4,
			width: 32,
			height: 32,
		});
	});

	it('is bounded by the canvas when inverted, whatever its outline', () => {
		const area = areaFor({ path: SQUARE, inverted: true, feather: 4 });
		expect(area.bounds).toEqual({ x: 0, y: 0, ...DEFAULT_DRAWING_SIZE });
		expect(area.canvas).toEqual(area.bounds);
	});

	it('is reached by a box in it, and for an inverse not by one wholly in the hole', () => {
		const plain = areaFor({ path: SQUARE, inverted: false, feather: 0 });
		expect(reachesArea(plain, { x: 15, y: 15, width: 2, height: 2 })).toBe(true);
		expect(reachesArea(plain, { x: 50, y: 50, width: 2, height: 2 })).toBe(false);
		expect(reachesArea(undefined, { x: 500, y: 500, width: 1, height: 1 })).toBe(true);

		const inverse = areaFor({ path: SQUARE, inverted: true, feather: 0 });
		expect(reachesArea(inverse, { x: 15, y: 15, width: 2, height: 2 })).toBe(false);
		expect(reachesArea(inverse, { x: 25, y: 15, width: 10, height: 2 })).toBe(true);
		expect(reachesArea(inverse, { x: 50, y: 50, width: 2, height: 2 })).toBe(true);
		const offCanvas = DEFAULT_DRAWING_SIZE.width + 10;
		expect(reachesArea(inverse, { x: offCanvas, y: 0, width: 2, height: 2 })).toBe(false);

		// The feather reaches into the hole: a box near the edge is touched by it.
		const soft = areaFor({ path: SQUARE, inverted: true, feather: 4 });
		expect(reachesArea(soft, { x: 13, y: 19, width: 2, height: 2 })).toBe(true);
		expect(reachesArea(soft, { x: 19, y: 19, width: 2, height: 2 })).toBe(false);
	});

	it('has a box in the layer’s pixels that grows with the feather and stays on the canvas', () => {
		const surface = {
			canvas: Object.assign(document.createElement('canvas'), { width: 100, height: 80 }),
			toPixel: (x: number, y: number) => [x / 2, y / 2] as const,
		};
		const hard = areaFor({ path: SQUARE, inverted: false, feather: 0 });
		expect(areaPixelBox(surface, hard)).toEqual({ x: 5, y: 5, width: 10, height: 10 });
		const soft = areaFor({ path: SQUARE, inverted: false, feather: 10 });
		expect(areaPixelBox(surface, soft)).toEqual({ x: 0, y: 0, width: 23, height: 23 });
	});
});

describe('the area moved and tested', () => {
	const SQUARE = 'M 10 10 L 30 10 L 30 30 L 10 30 Z';
	const areaFor = (region: Region) => {
		const area = areaOf(createFake({ layer: RASTER, region }).context);
		if (area === undefined) throw new Error('an area');
		return area;
	};

	it('moves every number of an outline, x then y, to the area’s two decimals', () => {
		expect(translatePath(SQUARE, 5, -2.5)).toBe('M 15 7.5 L 35 7.5 L 35 27.5 L 15 27.5 Z');
		expect(translatePath('M 0.1 0.2 L 1 0 L 1 1 Z M 5 5 L 6 5 L 6 6 Z', 0.2, 0.1)).toBe(
			'M 0.3 0.3 L 1.2 0.1 L 1.2 1.1 Z M 5.2 5.1 L 6.2 5.1 L 6.2 6.1 Z'
		);
		expect(translatePath('M 10 10 L 20 10 L 20 20 Z', 1 / 3, 0)).toBe(
			'M 10.33 10 L 20.33 10 L 20.33 20 Z'
		);
	});

	it('holds a point inside its outline under nonzero, or an inverse’s on the canvas outside it', () => {
		// The second subpath winds around the first's corner twice: still inside under nonzero.
		const twice = `${SQUARE} M 20 20 L 40 20 L 40 40 L 20 40 Z`;
		const plain = areaFor({ path: twice, inverted: false, feather: 5 });
		expect(areaHolds(plain, { x: 15, y: 15 })).toBe(true);
		expect(areaHolds(plain, { x: 25, y: 25 })).toBe(true);
		expect(areaHolds(plain, { x: 35, y: 15 })).toBe(false);
		const inverse = areaFor({ path: SQUARE, inverted: true, feather: 0 });
		expect(areaHolds(inverse, { x: 15, y: 15 })).toBe(false);
		expect(areaHolds(inverse, { x: 50, y: 50 })).toBe(true);
		expect(areaHolds(inverse, { x: -5, y: 50 })).toBe(false);
	});

	it('reaches a layer’s pixels it covers, and for an inverse not a layer wholly in the hole', () => {
		const layer = (width: number, height: number, x = 0, y = 0) => ({
			canvas: Object.assign(document.createElement('canvas'), { width, height }),
			toPixel: (ux: number, uy: number) => [ux - x, uy - y] as const,
		});
		const plain = areaFor({ path: SQUARE, inverted: false, feather: 0 });
		expect(reachesSurface(layer(40, 40), plain)).toBe(true);
		expect(reachesSurface(layer(5, 5), plain)).toBe(false);
		const inverse = areaFor({ path: SQUARE, inverted: true, feather: 0 });
		expect(reachesSurface(layer(5, 5, 15, 15), inverse)).toBe(false);
		expect(reachesSurface(layer(40, 40), inverse)).toBe(true);
	});
});

describe('the marching ants', () => {
	const SQUARE = 'M 10 10 L 30 10 L 30 30 L 10 30 Z';
	const CANVAS = { x: 0, y: 0, width: 100, height: 80 };

	it('trace the outline, whatever the feather', () => {
		expect(antsPath({ path: SQUARE, inverted: false, feather: 6 }, CANVAS)).toBe(SQUARE);
	});

	it('trace the canvas’s edge as well for an inverse, as Photoshop shows it', () => {
		expect(antsPath({ path: SQUARE, inverted: true, feather: 0 }, CANVAS)).toBe(
			`M 0 0 L 100 0 L 100 80 L 0 80 Z ${SQUARE}`
		);
	});
});
