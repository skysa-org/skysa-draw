import { DEFAULT_DRAWING_SIZE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import type { EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import {
	addToArea,
	areaPolygons,
	areaTouchesBox,
	polygonPath,
	rectPath,
} from '../../src/drawing/tools/raster/area.js';
import { rasterBehaviours } from '../../src/drawing/tools/raster/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehaviour,
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
	/** What the area is now. */
	area: () => string | undefined;
	/** What is selected now. */
	selected: () => readonly Element[];
	notices: string[];
	/** By id, the elements of `layer-1`. */
	element: (id: string) => Element;
}>;

type Setup = Readonly<{
	layer?: Partial<LayerInfo>;
	area?: string;
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
	let area = setup.area;
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
				return area;
			},
			set: (path) => {
				area = path;
			},
		},
		host: document.createElement('div'),
		setColour: noop,
		notify: (message) => notices.push(message),
	};
	return { context, area: () => area, selected: () => selected, notices, element };
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
const drag = (behaviour: ToolBehaviour, context: ToolContext, steps: readonly Step[]): void => {
	const [first, ...rest] = steps;
	if (first === undefined) return;
	behaviour.begin(context, at(first.x, first.y, first));
	rest.forEach((step) => behaviour.move(context, at(step.x, step.y, step)));
	const last = rest.at(-1) ?? first;
	behaviour.end(context, at(last.x, last.y, last));
};

const raster = (id: 'marquee' | 'lasso'): ToolBehaviour => {
	const behaviour = rasterBehaviours[id];
	if (behaviour === undefined) throw new Error(`no raster ${id}`);
	return behaviour;
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

	it('draws from the centre with Alt', () => {
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

	it('previews the drag on the overlay, and takes the preview away when it ends or is cancelled', () => {
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
