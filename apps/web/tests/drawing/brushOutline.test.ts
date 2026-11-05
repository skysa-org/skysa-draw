import { SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { withBrushOutline } from '../../src/drawing/tools/common/brushOutline.js';
import { TOOLS } from '../../src/drawing/tools/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehavior,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';

/**
 * The brush's outline (`tools/common/brushOutline.ts`), the pointer of every
 * tool with a size, as Photoshop's Normal Brush Tip: a circle the tool's size
 * across in the drawing's units, on the overlay, so as big on the screen as
 * what it paints at any zoom, with a crosshair at its middle that is the same
 * on the screen at any zoom, and the crosshair alone for a circle too small to
 * see. Against a bare overlay and a behavior that records what it is told, or
 * the tools themselves for which tools have it. What this cannot show is how
 * it looks, or the cursor the stylesheet hides under it (`viewport.css`); the
 * viewport's part, the pointer leaving and a tool put down, is in
 * `viewport.test.tsx`.
 */

const noop = (): undefined => undefined;

const contextAt = (scale: number, options: Partial<ToolOptions> = {}): ToolContext => ({
	document: {} as EditorDocument,
	layer: undefined,
	options: { ...DEFAULT_TOOL_OPTIONS, ...options },
	overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
	screen: { canvas: document.createElement('canvas'), toScreen: (x, y) => [x, y], pixelRatio: 1 },
	viewport: { scale, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
	selection: { elements: [], set: noop, clear: noop },
	region: { path: undefined, region: undefined, set: noop, update: noop },
	host: document.createElement('div'),
	setColor: noop,
	notify: noop,
});

const sampleAt = (x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample => ({
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

/** A behavior that records what it is told and adds a preview of its own as it begins, as a stroke does. */
const recorder = () => {
	const calls: string[] = [];
	const behavior: ToolBehavior = {
		begin: (context) => {
			calls.push('begin');
			context.overlay.append(
				context.overlay.ownerDocument.createElementNS(SVG_NAMESPACE, 'path')
			);
		},
		move: () => calls.push('move'),
		end: () => calls.push('end'),
		cancel: () => calls.push('cancel'),
		hover: () => calls.push('hover'),
		leave: () => calls.push('leave'),
		optionsChanged: () => calls.push('optionsChanged'),
	};
	return { calls, behavior: withBrushOutline(behavior) };
};

const outlineOf = (context: ToolContext) => context.overlay.querySelector('[data-brush-outline]');

const circlesOf = (context: ToolContext): Element[] =>
	Array.from(outlineOf(context)?.querySelectorAll('circle') ?? []);

const crossesOf = (context: ToolContext): Element[] =>
	Array.from(outlineOf(context)?.querySelectorAll('path') ?? []);

/** The circle's radius on the screen, in CSS pixels: its radius in user units times the scale. */
const screenRadius = (context: ToolContext): number =>
	Number(circlesOf(context)[0]?.getAttribute('r')) * context.viewport.scale;

/** The crosshair's arms, each from the middle, in user units, read from its `d`. */
const armOf = (context: ToolContext): number => {
	const [x0 = 0, , x1 = 0] = (crossesOf(context)[0]?.getAttribute('d') ?? '')
		.replace(/[A-Z]/g, ' ')
		.trim()
		.split(/\s+/)
		.map(Number);
	return (x1 - x0) / 2;
};

describe('the brush’s outline', () => {
	it.each([0.55, 1, 2, 4])(
		'is as big on the screen as the size times the zoom, at %s',
		(scale) => {
			const context = contextAt(scale, { size: 40 });
			const { behavior } = recorder();
			behavior.hover?.(context, sampleAt(30, 20));
			expect(circlesOf(context)).toHaveLength(2);
			circlesOf(context).forEach((circle) => {
				expect(circle.getAttribute('r')).toBe('20');
				expect([circle.getAttribute('cx'), circle.getAttribute('cy')]).toEqual([
					'30',
					'20',
				]);
				expect(circle.hasAttribute('display')).toBe(false);
			});
			expect(screenRadius(context)).toBeCloseTo(20 * scale);
			// The crosshair's arms are the same on the screen at any zoom.
			expect(armOf(context) * scale).toBeCloseTo(4);
		}
	);

	it('is a halo under a hairline, both of one width on the screen, out of the pointer’s way', () => {
		const context = contextAt(1);
		const { behavior } = recorder();
		behavior.hover?.(context, sampleAt(5, 5));
		const outline = outlineOf(context);
		expect(outline?.getAttribute('class')).toBe('brush-outline');
		expect(
			Array.from(outline?.children ?? []).map((part) => part.getAttribute('class'))
		).toEqual([
			'brush-outline-halo',
			'brush-outline-halo',
			'brush-outline-line',
			'brush-outline-line',
		]);
		Array.from(outline?.children ?? []).forEach((part) => {
			expect(part.getAttribute('vector-effect')).toBe('non-scaling-stroke');
		});
	});

	it('is the crosshair alone where the circle would be too small to see', () => {
		const { behavior } = recorder();
		const small = contextAt(0.55, { size: 2 });
		behavior.hover?.(small, sampleAt(5, 5));
		circlesOf(small).forEach((circle) => expect(circle.getAttribute('display')).toBe('none'));
		expect(crossesOf(small)).toHaveLength(2);
		// The same size zoomed in until it is seen.
		const near = contextAt(4, { size: 2 });
		behavior.hover?.(near, sampleAt(5, 5));
		circlesOf(near).forEach((circle) => expect(circle.hasAttribute('display')).toBe(false));
	});

	it('follows the pointer, and is told what the tool is told', () => {
		const context = contextAt(1, { size: 10 });
		const { behavior, calls } = recorder();
		behavior.hover?.(context, sampleAt(5, 5));
		behavior.hover?.(context, sampleAt(25, 15));
		expect(context.overlay.querySelectorAll('[data-brush-outline]')).toHaveLength(1);
		expect(circlesOf(context)[0]?.getAttribute('cx')).toBe('25');
		behavior.leave?.(context);
		expect(calls).toEqual(['hover', 'hover', 'leave']);
	});

	it('takes a new size at once, where it is, and makes none where there is none', () => {
		const context = contextAt(2, { size: 10 });
		const { behavior, calls } = recorder();
		behavior.optionsChanged?.(context);
		expect(outlineOf(context)).toBeNull();
		behavior.hover?.(context, sampleAt(12, 8));
		// `]` or the strip, with the pointer still.
		behavior.optionsChanged?.({ ...context, options: { ...context.options, size: 30 } });
		circlesOf(context).forEach((circle) => {
			expect(circle.getAttribute('r')).toBe('15');
			expect(circle.getAttribute('cx')).toBe('12');
		});
		expect(screenRadius(context)).toBe(30);
		expect(calls).toEqual(['optionsChanged', 'hover', 'optionsChanged']);
	});

	it('follows a stroke over its preview, and stays where a mouse or a pen lifts', () => {
		const context = contextAt(1);
		const { behavior } = recorder();
		behavior.hover?.(context, sampleAt(1, 1));
		behavior.begin(context, sampleAt(2, 2));
		expect(context.overlay.lastElementChild).toBe(outlineOf(context));
		behavior.move(context, sampleAt(6, 4));
		behavior.end(context, sampleAt(8, 4, { pointerType: 'pen' }));
		expect(circlesOf(context)[0]?.getAttribute('cx')).toBe('8');
	});

	it('shows the whole size, whatever the pressure', () => {
		const context = contextAt(1, { size: 20, pressure: true });
		const { behavior } = recorder();
		behavior.begin(context, sampleAt(5, 5, { pressure: 0, pointerType: 'pen' }));
		expect(circlesOf(context)[0]?.getAttribute('r')).toBe('10');
	});

	it('goes when the pointer leaves the canvas, and on cancel', () => {
		const context = contextAt(1);
		const { behavior } = recorder();
		behavior.hover?.(context, sampleAt(5, 5));
		behavior.leave?.(context);
		expect(outlineOf(context)).toBeNull();
		behavior.begin(context, sampleAt(5, 5));
		expect(outlineOf(context)).not.toBeNull();
		behavior.cancel(context);
		expect(outlineOf(context)).toBeNull();
	});

	it('is never shown for a finger, and goes when one presses', () => {
		const context = contextAt(1);
		const { behavior } = recorder();
		behavior.begin(context, sampleAt(5, 5, { pointerType: 'touch' }));
		behavior.move(context, sampleAt(9, 5, { pointerType: 'touch' }));
		behavior.end(context, sampleAt(9, 5, { pointerType: 'touch' }));
		expect(outlineOf(context)).toBeNull();
		// A pen hovered, then a finger drew.
		behavior.hover?.(context, sampleAt(5, 5, { pointerType: 'pen' }));
		expect(outlineOf(context)).not.toBeNull();
		behavior.begin(context, sampleAt(5, 5, { pointerType: 'touch' }));
		expect(outlineOf(context)).toBeNull();
	});

	it('is the pointer of every tool with a size, on every kind of layer it works on', () => {
		const sized = TOOLS.filter((tool) => tool.options.includes('size'));
		expect(sized.map((tool) => tool.id).sort()).toEqual(
			['brush', 'eraser', 'pencil', 'remove', 'smudge'].sort()
		);
		sized.forEach((tool) => {
			Object.entries(tool.behaviors).forEach(([kind, behavior]) => {
				const context = contextAt(2, { size: 12 });
				behavior.hover?.(context, sampleAt(10, 10));
				expect([tool.id, kind, screenRadius(context)]).toEqual([tool.id, kind, 12]);
				behavior.leave?.(context);
				expect([tool.id, kind, outlineOf(context)]).toEqual([tool.id, kind, null]);
			});
		});
		const unsized = TOOLS.filter((tool) => !tool.options.includes('size'));
		unsized.forEach((tool) => {
			Object.values(tool.behaviors).forEach((behavior) => {
				const context = contextAt(1);
				behavior.hover?.(context, sampleAt(10, 10));
				expect([tool.id, outlineOf(context)]).toEqual([tool.id, null]);
			});
		});
	});
});
