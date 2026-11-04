import { describe, expect, it } from 'vitest';

import {
	type GestureEffect,
	type GestureEvent,
	gestureReducer,
	type GestureState,
	INITIAL_GESTURE,
	TAP_MS,
} from '../../src/drawing/viewport/gestures.js';
import {
	isMac,
	isMacPlatform,
	type PointerEventLike,
	sampleFrom,
} from '../../src/drawing/viewport/pointer.js';
import {
	actualSizeView,
	clampScale,
	FIT_MARGIN,
	fitView,
	IDENTITY_VIEW,
	MAX_SCALE,
	MIN_SCALE,
	panBy,
	parseViewBox,
	stageTransform,
	toScreen,
	toUser,
	type View,
	zoomAbout,
} from '../../src/drawing/viewport/transform.js';

/**
 * The viewport's arithmetic (docs/ARCHITECTURE.md §7, "Input"), which has no
 * DOM in it: the view, the sample a pointer event becomes, and what fingers do.
 */

describe('the view', () => {
	const view: View = { scale: 2, tx: 10, ty: 20 };

	it('maps user units to the screen and back', () => {
		expect(toScreen(view, 5, 5)).toEqual([20, 30]);
		expect(toUser(view, 20, 30)).toEqual([5, 5]);
		const [x, y] = toUser(view, ...toScreen(view, 123.4, -56.7));
		expect(x).toBeCloseTo(123.4);
		expect(y).toBeCloseTo(-56.7);
	});

	it('zooms about a point, which stays under its screen point', () => {
		const zoomed = zoomAbout(view, 3, 100, 50);
		expect(zoomed.scale).toBe(6);
		expect(toScreen(zoomed, 100, 50)).toEqual(toScreen(view, 100, 50));
		expect(zoomAbout(IDENTITY_VIEW, 2, 0, 0)).toEqual({ scale: 2, tx: 0, ty: 0 });
	});

	it('holds the scale between the limits', () => {
		expect(clampScale(1)).toBe(1);
		expect(clampScale(0)).toBe(MIN_SCALE);
		expect(clampScale(1e9)).toBe(MAX_SCALE);
		expect(zoomAbout(view, 1e6, 0, 0).scale).toBe(MAX_SCALE);
		expect(zoomAbout(view, 1e-6, 0, 0).scale).toBe(MIN_SCALE);
	});

	it('pans in user units, by the scale', () => {
		expect(panBy(view, 10, -5)).toEqual({ scale: 2, tx: 30, ty: 10 });
	});

	it('fits the drawing in the middle of the viewport with the margin around it', () => {
		const fitted = fitView({ width: 1600, height: 1000 }, { width: 800, height: 600 });
		expect(fitted.scale).toBeCloseTo((800 - 2 * FIT_MARGIN) / 1600);
		expect(fitted.tx).toBeCloseTo(FIT_MARGIN);
		expect(fitted.ty).toBeCloseTo((600 - 1000 * fitted.scale) / 2);
		const tall = fitView({ width: 100, height: 1000 }, { width: 800, height: 600 }, 50);
		expect(tall.scale).toBeCloseTo(0.5);
		expect(tall.tx).toBeCloseTo(375);
		expect(tall.ty).toBeCloseTo(50);
	});

	it('shows actual size in the middle of the viewport', () => {
		expect(actualSizeView({ width: 1600, height: 1000 }, { width: 800, height: 600 })).toEqual({
			scale: 1,
			tx: -400,
			ty: -200,
		});
	});

	it('is the identity for a viewport that measures nothing, as before layout', () => {
		expect(fitView({ width: 1600, height: 1000 }, { width: 0, height: 0 })).toEqual(
			IDENTITY_VIEW
		);
		expect(actualSizeView({ width: 1600, height: 1000 }, { width: 0, height: 300 })).toEqual(
			IDENTITY_VIEW
		);
	});

	it('reads a viewBox of four numbers, and nothing else', () => {
		expect(parseViewBox('0 0 1600 1000')).toEqual({ x: 0, y: 0, width: 1600, height: 1000 });
		expect(parseViewBox(' -10,20, 30 40 ')).toEqual({ x: -10, y: 20, width: 30, height: 40 });
		expect(parseViewBox(null)).toBeUndefined();
		expect(parseViewBox(undefined)).toBeUndefined();
		expect(parseViewBox('')).toBeUndefined();
		expect(parseViewBox('0 0 10')).toBeUndefined();
		expect(parseViewBox('0 0 0 10')).toBeUndefined();
		expect(parseViewBox('a b c d')).toBeUndefined();
	});

	it("puts the stage's corner where the viewBox's origin lands", () => {
		expect(stageTransform(view, { x: 0, y: 0 })).toBe('translate(10px, 20px) scale(2)');
		expect(stageTransform(view, { x: 5, y: -10 })).toBe('translate(20px, 0px) scale(2)');
	});
});

describe('a pointer sample', () => {
	const event = (init: Partial<PointerEventLike> = {}): PointerEventLike => ({
		clientX: 0,
		clientY: 0,
		pressure: 0,
		tiltX: 0,
		tiltY: 0,
		pointerType: 'mouse',
		timeStamp: 1234,
		shiftKey: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		...init,
	});
	const view: View = { scale: 2, tx: 10, ty: 20 };
	const rect = { left: 5, top: 5 };

	it("is the event's point in user units, through the view and the viewport's corner", () => {
		const sample = sampleFrom(event({ clientX: 35, clientY: 45 }), view, rect, false);
		expect(sample.x).toBe(10);
		expect(sample.y).toBe(10);
		expect(sample.time).toBe(1234);
	});

	it('gives a mouse the default pressure whatever it says, and a pen or a finger its own', () => {
		expect(sampleFrom(event({ pressure: 0 }), view, rect, false).pressure).toBe(0.5);
		expect(sampleFrom(event({ pressure: 1 }), view, rect, false).pressure).toBe(0.5);
		expect(
			sampleFrom(event({ pointerType: 'pen', pressure: 0.3 }), view, rect, false).pressure
		).toBe(0.3);
		expect(
			sampleFrom(event({ pointerType: 'touch', pressure: 0.9 }), view, rect, false).pressure
		).toBe(0.9);
		expect(
			sampleFrom(event({ pointerType: 'pen', pressure: Number.NaN }), view, rect, false)
				.pressure
		).toBe(0.5);
	});

	it('knows three kinds of pointer, and takes any other for a mouse', () => {
		expect(sampleFrom(event({ pointerType: 'pen' }), view, rect, false).pointerType).toBe(
			'pen'
		);
		expect(sampleFrom(event({ pointerType: 'touch' }), view, rect, false).pointerType).toBe(
			'touch'
		);
		expect(sampleFrom(event({ pointerType: '' }), view, rect, false).pointerType).toBe('mouse');
	});

	it('reads the primary key as ⌘ on a Mac and Ctrl elsewhere, and the tilt where there is one', () => {
		const held = event({ metaKey: true, ctrlKey: false, tiltX: 12, tiltY: -3, shiftKey: true });
		expect(sampleFrom(held, view, rect, true).primaryKey).toBe(true);
		expect(sampleFrom(held, view, rect, false).primaryKey).toBe(false);
		expect(sampleFrom(held, view, rect, false).shiftKey).toBe(true);
		expect(sampleFrom(held, view, rect, false).tiltX).toBe(12);
		expect(sampleFrom(held, view, rect, false).tiltY).toBe(-3);
		const bare = { ...event(), tiltX: undefined } as unknown as PointerEventLike;
		expect(sampleFrom(bare, view, rect, false).tiltX).toBe(0);
	});

	it('tells a Mac from its platform, and is not one here', () => {
		expect(isMacPlatform('MacIntel')).toBe(true);
		expect(isMacPlatform('macOS')).toBe(true);
		expect(isMacPlatform('iPad')).toBe(true);
		expect(isMacPlatform('Win32')).toBe(false);
		expect(isMacPlatform('Linux x86_64')).toBe(false);
		expect(isMacPlatform(undefined)).toBe(false);
		expect(isMac()).toBe(false);
	});
});

describe('the fingers', () => {
	const finger = (
		type: GestureEvent['type'],
		id: number,
		x: number,
		y: number,
		time = 0
	): GestureEvent => ({ type, id, x, y, time, pointerType: 'touch' });
	const pen = (type: GestureEvent['type'], time = 0): GestureEvent => ({
		type,
		id: 99,
		x: 0,
		y: 0,
		time,
		pointerType: 'pen',
	});

	type Run = Readonly<{ state: GestureState; effects: readonly GestureEffect[] }>;

	/** The reducer run over the events, with every effect it emitted along the way. */
	const run = (events: readonly GestureEvent[], from: GestureState = INITIAL_GESTURE): Run =>
		events.reduce<Run>(
			(acc, event) => {
				const next = gestureReducer(acc.state, event);
				return { state: next.state, effects: [...acc.effects, ...next.effects] };
			},
			{ state: from, effects: [] }
		);

	const zooms = (effects: readonly GestureEffect[]) =>
		effects.flatMap((effect) =>
			typeof effect === 'object' && 'zoom' in effect ? [effect.zoom] : []
		);
	const pans = (effects: readonly GestureEffect[]) =>
		effects.flatMap((effect) =>
			typeof effect === 'object' && 'pan' in effect ? [effect.pan] : []
		);

	it('lets one finger draw, and says nothing of it', () => {
		const { state, effects } = run([finger('down', 1, 10, 10), finger('move', 1, 50, 50)]);
		expect(state.mode).toBe('stroke');
		expect(effects).toEqual([]);
	});

	it('turns the stroke into a gesture when a second finger lands', () => {
		const { state, effects } = run([finger('down', 1, 10, 10), finger('down', 2, 100, 10)]);
		expect(state.mode).toBe('gesture');
		expect(effects).toEqual(['cancelStroke']);
	});

	it('pans by the centre of two fingers and zooms by their distance', () => {
		const { effects } = run([
			finger('down', 1, 100, 100),
			finger('down', 2, 200, 100),
			finger('move', 1, 50, 100),
			finger('move', 2, 250, 100),
		]);
		const factors = zooms(effects);
		expect(factors).toHaveLength(2);
		expect(factors.reduce((product, zoom) => product * zoom.factor, 1)).toBeCloseTo(2);
		expect(factors[1]).toMatchObject({ aboutX: 150, aboutY: 100 });
		const moved = pans(effects);
		expect(moved).toHaveLength(2);
		expect(moved[0]).toEqual({ dx: -25, dy: 0 });
		expect(moved[1]).toEqual({ dx: 25, dy: 0 });
	});

	it('keeps panning with the finger that stays when the other lifts, and never draws with it', () => {
		const { state, effects } = run([
			finger('down', 1, 100, 100),
			finger('down', 2, 200, 100),
			finger('up', 2, 200, 100),
			finger('move', 1, 110, 120),
		]);
		expect(state.mode).toBe('gesture');
		expect(pans(effects)).toEqual([{ dx: 10, dy: 20 }]);
		expect(zooms(effects)).toEqual([]);
	});

	it('undoes on a two-finger tap and redoes on a three-finger tap', () => {
		const two = run([
			finger('down', 1, 10, 10, 0),
			finger('down', 2, 100, 10, 20),
			finger('up', 1, 12, 11, 100),
			finger('up', 2, 100, 10, 120),
		]);
		expect(two.effects).toEqual(['cancelStroke', 'undo']);
		expect(two.state.mode).toBe('idle');
		expect(two.state.touches.size).toBe(0);
		const three = run([
			finger('down', 1, 10, 10, 0),
			finger('down', 2, 100, 10, 10),
			finger('down', 3, 200, 10, 20),
			finger('up', 3, 200, 10, 80),
			finger('up', 1, 10, 10, 90),
			finger('up', 2, 100, 10, 100),
		]);
		expect(three.effects).toEqual(['cancelStroke', 'redo']);
	});

	it('does not take a slow or a moved pair of fingers, or a cancelled one, for a tap', () => {
		const slow = run([
			finger('down', 1, 10, 10, 0),
			finger('down', 2, 100, 10, 20),
			finger('up', 1, 10, 10, TAP_MS + 50),
			finger('up', 2, 100, 10, TAP_MS + 60),
		]);
		expect(slow.effects).toEqual(['cancelStroke']);
		const moved = run([
			finger('down', 1, 10, 10, 0),
			finger('down', 2, 100, 10, 20),
			finger('move', 1, 30, 10, 50),
			finger('up', 1, 30, 10, 100),
			finger('up', 2, 100, 10, 120),
		]);
		expect(moved.effects.filter((effect) => effect === 'undo')).toEqual([]);
		const cancelled = run([
			finger('down', 1, 10, 10, 0),
			finger('down', 2, 100, 10, 20),
			finger('cancel', 1, 10, 10, 100),
			finger('up', 2, 100, 10, 120),
		]);
		expect(cancelled.effects).toEqual(['cancelStroke']);
	});

	it('does not count one finger down and up as a tap', () => {
		const { effects } = run([finger('down', 1, 10, 10, 0), finger('up', 1, 10, 10, 50)]);
		expect(effects).toEqual([]);
	});

	it('takes the fingers for a palm once a pen lands, until all of them lift', () => {
		const landed = run([finger('down', 1, 10, 10), pen('down')]);
		expect(landed.effects).toEqual(['cancelStroke']);
		expect(landed.state.penDown).toBe(true);
		expect(landed.state.ignored).toBe(true);
		const ignored = run(
			[
				finger('move', 1, 50, 50),
				finger('down', 2, 100, 100),
				finger('move', 2, 150, 150),
				pen('up'),
				finger('move', 1, 60, 60),
			],
			landed.state
		);
		expect(ignored.effects).toEqual([]);
		expect(ignored.state.mode).toBe('idle');
		expect(ignored.state.penDown).toBe(false);
		expect(ignored.state.ignored).toBe(true);
		const lifted = run([finger('up', 1, 60, 60), finger('up', 2, 150, 150)], ignored.state);
		expect(lifted.effects).toEqual([]);
		expect(lifted.state.ignored).toBe(false);
		const again = run([finger('down', 3, 10, 10)], lifted.state);
		expect(again.state.mode).toBe('stroke');
	});

	it('ignores a finger that lands while the pen is down', () => {
		const { state, effects } = run([
			pen('down'),
			finger('down', 1, 10, 10),
			finger('down', 2, 20, 20),
		]);
		expect(effects).toEqual([]);
		expect(state.mode).toBe('idle');
		expect(state.ignored).toBe(true);
	});

	it('pays a mouse no attention', () => {
		const mouse: GestureEvent = {
			type: 'down',
			id: 1,
			x: 0,
			y: 0,
			time: 0,
			pointerType: 'mouse',
		};
		const { state, effects } = run([mouse]);
		expect(state).toBe(INITIAL_GESTURE);
		expect(effects).toEqual([]);
	});
});
