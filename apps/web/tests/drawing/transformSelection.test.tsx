import { DEFAULT_DRAWING_SIZE, emptyDrawing } from '@skysa/draw-core';
import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DocumentSnapshot, EditorDocument } from '../../src/drawing/document/model.js';
import { isCommitKey } from '../../src/drawing/keys.js';
import { areaPolygons } from '../../src/drawing/tools/raster/area.js';
import {
	gripAt,
	gripMatrix,
	outlineBox,
	transformPath,
} from '../../src/drawing/tools/raster/areaTransform.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Region,
	type Tool,
	type ToolBehavior,
} from '../../src/drawing/tools/types.js';
import {
	apply,
	IDENTITY,
	rotate,
	scale,
	translate,
} from '../../src/drawing/tools/vector/geometry.js';
import type { ViewportHandle, ViewportProps } from '../../src/drawing/types.js';
import { Viewport } from '../../src/drawing/Viewport.js';
import { createViewportSelection } from '../../src/drawing/viewport/selectionState.js';
import { t } from '../../src/i18n/t.js';

/**
 * Transform selection (docs/decisions/0004-the-interface.md, "Transform
 * selection"): the area's outline moved, scaled and rotated by a box with
 * handles, as Photoshop's Select › Transform Selection does, kept with Enter
 * or Apply and put back with Escape or Cancel. The math first, pure; then
 * the mode in the viewport, whose view in jsdom is the identity, so a
 * client point is a user point and a screen pixel a unit.
 */

const AREA = 'M 10 10 L 50 10 L 50 30 L 10 30 Z';

/** Twice the signed area of each subpath: positive for one wound clockwise on a y-down screen. */
const windings = (d: string): readonly number[] =>
	areaPolygons(d).map((points) =>
		points.reduce((sum, p, i) => {
			const q = points[(i + 1) % points.length] ?? p;
			return sum + p.x * q.y - q.x * p.y;
		}, 0)
	);

describe('the outline transformed', () => {
	it('maps every corner, in the area’s grammar, to two decimals', () => {
		expect(transformPath(AREA, IDENTITY)).toBe(AREA);
		expect(transformPath(AREA, translate(5, -2))).toBe('M 15 8 L 55 8 L 55 28 L 15 28 Z');
		expect(transformPath(AREA, scale(2, 2, { x: 10, y: 10 }))).toBe(
			'M 10 10 L 90 10 L 90 50 L 10 50 Z'
		);
		expect(transformPath(AREA, rotate(90, { x: 30, y: 20 }))).toBe(
			'M 40 0 L 40 40 L 20 40 L 20 0 Z'
		);
		expect(transformPath('M 0 0 L 1 0 L 1 1 Z', scale(1 / 3, 1 / 3))).toBe(
			'M 0 0 L 0.33 0 L 0.33 0.33 Z'
		);
	});

	it('keeps every subpath, and walks each back where the map mirrors, so the windings stay', () => {
		const ring = 'M 0 0 L 30 0 L 30 30 L 0 30 Z M 10 10 L 10 20 L 20 20 L 20 10 Z';
		expect(windings(ring).map(Math.sign)).toEqual([1, -1]);
		const mirrored = transformPath(ring, scale(-1, 1, { x: 15, y: 15 }));
		expect(areaPolygons(mirrored)).toHaveLength(2);
		expect(windings(mirrored).map(Math.sign)).toEqual([1, -1]);
		expect(outlineBox(mirrored)).toEqual({ x: 0, y: 0, width: 30, height: 30 });
		const flipped = transformPath(ring, scale(1, -1, { x: 15, y: 15 }));
		expect(windings(flipped).map(Math.sign)).toEqual([1, -1]);
		// A rotation by a half turn mirrors nothing.
		const turned = transformPath(ring, rotate(180, { x: 15, y: 15 }));
		expect(windings(turned).map(Math.sign)).toEqual([1, -1]);
	});

	it('boxes the outline', () => {
		expect(outlineBox(AREA)).toEqual({ x: 10, y: 10, width: 40, height: 20 });
		expect(outlineBox('')).toBeUndefined();
	});
});

describe('the box’s grips', () => {
	const BOX = { x: 0, y: 0, width: 200, height: 100 };

	it('takes a handle 44 px across on the screen, the nearest, and moves inside and rotates outside', () => {
		expect(gripAt(BOX, { x: 0, y: 0 }, 1)).toBe('nw');
		expect(gripAt(BOX, { x: 200, y: 100 }, 1)).toBe('se');
		expect(gripAt(BOX, { x: 100, y: 3 }, 1)).toBe('n');
		expect(gripAt(BOX, { x: 222, y: 50 }, 1)).toBe('e');
		expect(gripAt(BOX, { x: 215, y: 115 }, 1)).toBe('se');
		expect(gripAt(BOX, { x: 223, y: 50 }, 1)).toBe('rotate');
		expect(gripAt(BOX, { x: 100, y: -24 }, 1)).toBe('rotate');
		expect(gripAt(BOX, { x: 100, y: 50 }, 1)).toBe('move');
		expect(gripAt(BOX, { x: 40, y: 10 }, 1)).toBe('move');
		expect(gripAt(BOX, { x: 300, y: 50 }, 1)).toBe('rotate');
		expect(gripAt(BOX, { x: -30, y: 50 }, 1)).toBe('rotate');
	});

	it('reaches as far on the screen at any zoom', () => {
		expect(gripAt(BOX, { x: 210, y: 110 }, 2)).toBe('se');
		expect(gripAt(BOX, { x: 215, y: 115 }, 2)).toBe('rotate');
		expect(gripAt(BOX, { x: 240, y: 140 }, 0.5)).toBe('se');
	});

	it('moves a box too small for its handles from its middle, and takes the nearest handle elsewhere', () => {
		const small = { x: 0, y: 0, width: 10, height: 10 };
		expect(gripAt(small, { x: 5, y: 5 }, 1)).toBe('move');
		expect(gripAt(small, { x: 0, y: 0 }, 1)).toBe('nw');
		expect(gripAt(small, { x: 9, y: 1 }, 1)).toBe('ne');
		expect(gripAt(small, { x: 5, y: 0 }, 1)).toBe('n');
	});
});

describe('a drag of a grip', () => {
	const BOX = { x: 0, y: 0, width: 200, height: 100 };
	const NONE = { shiftKey: false, altKey: false };
	const SHIFT = { shiftKey: true, altKey: false };
	const ALT = { shiftKey: false, altKey: true };
	const at = (m: Parameters<typeof apply>[0], x: number, y: number) => {
		const p = apply(m, { x, y });
		return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
	};

	it('moves, Shift holding it across, down or at 45°', () => {
		const move = { grip: 'move' as const, box: BOX, from: { x: 50, y: 50 } };
		expect(gripMatrix(move, { x: 60, y: 52 }, NONE, 1)).toEqual(translate(10, 2));
		expect(at(gripMatrix(move, { x: 60, y: 52 }, SHIFT, 1), 0, 0)).toEqual({ x: 10, y: 0 });
	});

	it('resizes about the side across, Shift keeping the ratio and Alt about the middle', () => {
		const corner = { grip: 'se' as const, box: BOX, from: { x: 200, y: 100 } };
		expect(at(gripMatrix(corner, { x: 300, y: 150 }, NONE, 1), 200, 100)).toEqual({
			x: 300,
			y: 150,
		});
		expect(at(gripMatrix(corner, { x: 300, y: 110 }, NONE, 1), 200, 100)).toEqual({
			x: 300,
			y: 110,
		});
		expect(at(gripMatrix(corner, { x: 300, y: 110 }, SHIFT, 1), 200, 100)).toEqual({
			x: 300,
			y: 150,
		});
		const side = { grip: 'e' as const, box: BOX, from: { x: 200, y: 50 } };
		const wider = gripMatrix(side, { x: 250, y: 80 }, NONE, 1);
		expect([at(wider, 0, 0), at(wider, 200, 100)]).toEqual([
			{ x: 0, y: 0 },
			{ x: 250, y: 100 },
		]);
		const both = gripMatrix(side, { x: 250, y: 50 }, ALT, 1);
		expect([at(both, 0, 0), at(both, 200, 100)]).toEqual([
			{ x: -50, y: 0 },
			{ x: 250, y: 100 },
		]);
	});

	it('rotates about the middle, Shift snapping to 15°', () => {
		const turn = { grip: 'rotate' as const, box: BOX, from: { x: 300, y: 50 } };
		expect(at(gripMatrix(turn, { x: 100, y: 250 }, NONE, 1), 200, 50)).toEqual({
			x: 100,
			y: 150,
		});
		const fifty = {
			x: 100 + Math.cos((50 * Math.PI) / 180),
			y: 50 + Math.sin((50 * Math.PI) / 180),
		};
		const snapped = gripMatrix(turn, fifty, SHIFT, 1);
		expect(at(snapped, 200, 50)).toEqual(at(rotate(45, { x: 100, y: 50 }), 200, 50));
	});
});

describe('Enter as a commit', () => {
	const enter = (target: EventTarget | null, extra: Partial<KeyboardEventInit> = {}) => ({
		key: 'Enter',
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		target,
		...extra,
	});

	it('is bare, outside a field, and not on a control the keyboard is on', () => {
		const button = document.createElement('button');
		const field = document.createElement('input');
		const canvas = document.createElement('div');
		expect(isCommitKey(enter(canvas))).toBe(true);
		expect(isCommitKey(enter(null))).toBe(true);
		expect(isCommitKey(enter(canvas, { shiftKey: true }))).toBe(false);
		expect(isCommitKey(enter(canvas, { ctrlKey: true }))).toBe(false);
		expect(isCommitKey(enter(field))).toBe(false);
		expect(isCommitKey(enter(button))).toBe(false);
		expect(isCommitKey(enter(button), button)).toBe(true);
		expect(isCommitKey({ ...enter(canvas), key: ' ' })).toBe(false);
	});
});

const ID = 'drawing-1';

/** A document of two layers, a raster one and a vector one, which records the history asked of it. */
const fakeDocument = () => {
	const parsed = new DOMParser().parseFromString(emptyDrawing({ id: ID }), 'image/svg+xml');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	const layer = (id: string, kind: 'raster' | 'vector') => ({
		id,
		kind,
		name: undefined,
		hidden: false,
		locked: false,
		opacity: 1,
		blend: 'normal' as const,
		depth: 0,
		parentId: undefined,
		loose: false,
	});
	const snapshot: DocumentSnapshot = {
		layers: [layer('layer-1', 'raster'), layer('layer-2', 'vector')],
		size: DEFAULT_DRAWING_SIZE,
		canUndo: true,
		canRedo: true,
		dirty: false,
		version: 0,
	};
	const calls: string[] = [];
	const document: EditorDocument = {
		root,
		prolog: '',
		size: DEFAULT_DRAWING_SIZE,
		snapshot: () => snapshot,
		text: () => '',
		layer: (id) => root.querySelector<SVGGraphicsElement>(`[id="${id}"]`) ?? undefined,
		execute: () => {
			calls.push('execute');
		},
		undo: () => {
			calls.push('undo');
		},
		redo: () => {
			calls.push('redo');
		},
		subscribe: () => () => undefined,
		pending: () => undefined,
		settle: () => Promise.resolve(),
	};
	return { document, calls };
};

/** A tool that records what reaches it. */
const recording = () => {
	const calls: string[] = [];
	const behavior: ToolBehavior = {
		begin: () => calls.push('begin'),
		move: () => calls.push('move'),
		end: () => calls.push('end'),
		cancel: () => calls.push('cancel'),
		hover: () => calls.push('hover'),
	};
	return { calls, behavior };
};

const toolOf = (id: Tool['id'], behavior: ToolBehavior): Tool => ({
	id,
	options: [],
	behaviors: { vector: behavior, raster: behavior },
	cursor: 'crosshair',
});

type PointerInit = PointerEventInit;

const pointer = (type: string, init: PointerInit = {}): PointerEvent =>
	new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		button: type === 'pointermove' ? -1 : 0,
		buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
		...init,
	});

const fire = (target: EventTarget, event: Event): Event => {
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
};

const key = (keyName: string, init: KeyboardEventInit = {}, target: EventTarget = window): Event =>
	fire(
		target,
		new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init })
	);

/** Both Ctrl and ⌘, so the key reads as the primary one on any platform. */
const PRIMARY = { ctrlKey: true, metaKey: true };

/** A drag from one point to another, in one move. */
const drag = (
	target: EventTarget,
	from: readonly [number, number],
	to: readonly [number, number],
	init: PointerInit = {}
) => {
	fire(target, pointer('pointerdown', { clientX: from[0], clientY: from[1], ...init }));
	fire(target, pointer('pointermove', { clientX: to[0], clientY: to[1], ...init }));
	fire(target, pointer('pointerup', { clientX: to[0], clientY: to[1], ...init }));
};

beforeAll(() => {
	Object.defineProperty(Element.prototype, 'setPointerCapture', {
		value: () => undefined,
		configurable: true,
		writable: true,
	});
});
afterAll(() => {
	Reflect.deleteProperty(Element.prototype, 'setPointerCapture');
});
afterEach(() => {
	document.body.replaceChildren();
});

const FEATHERED: Region = { path: AREA, inverted: false, feather: 3 };

const setup = (overrides: Partial<ViewportProps> = {}) => {
	const fake = fakeDocument();
	const ref = createRef<ViewportHandle>();
	const selection = createViewportSelection();
	const tool = recording();
	const props: ViewportProps = {
		document: fake.document,
		tool: toolOf('marquee', tool.behavior),
		options: DEFAULT_TOOL_OPTIONS,
		layerId: 'layer-1',
		selection,
		onColor: vi.fn(),
		onNotify: vi.fn(),
		onActivateLayer: vi.fn(),
		ref,
		...overrides,
	};
	const utils = render(<Viewport {...props} />);
	const canvas = utils.getByRole('region', { name: t('editor.panes.canvas') });
	act(() => {
		selection.region.set(FEATHERED);
	});
	const perform = (action: Parameters<ViewportHandle['perform']>[0]): boolean | undefined => {
		const done = { value: undefined as boolean | undefined };
		act(() => {
			done.value = ref.current?.perform(action);
		});
		return done.value;
	};
	const path = () => selection.region.get()?.path;
	const ants = () =>
		Array.from(utils.container.querySelectorAll('.viewport-area path')).map((each) =>
			each.getAttribute('d')
		);
	const box = () => {
		const frame = utils.container.querySelector(
			'.viewport-transform [data-draw-selection] rect'
		);
		return frame === null
			? undefined
			: ['x', 'y', 'width', 'height'].map((name) => Number(frame.getAttribute(name)));
	};
	const handles = () =>
		Array.from(utils.container.querySelectorAll('.viewport-transform [data-handle]')).map(
			(handle) => handle.getAttribute('data-handle')
		);
	return {
		...utils,
		...fake,
		props,
		ref,
		selection,
		tool,
		canvas,
		perform,
		path,
		ants,
		box,
		handles,
	};
};

describe('Transform selection', () => {
	it('puts a box with eight handles and a rotate handle on the outline', () => {
		const { perform, selection, box, handles } = setup();
		expect(box()).toBeUndefined();
		expect(perform('transformSelection')).toBe(true);
		expect(selection.transforming.get()).toBe(true);
		expect(box()).toEqual([10, 10, 40, 20]);
		expect(handles()).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rotate']);
		expect(perform('transformSelection')).toBe(false);
	});

	it('is not there for an inverted area, or none', () => {
		const { perform, selection } = setup();
		act(() => {
			selection.region.set({ ...FEATHERED, inverted: true });
		});
		expect(perform('transformSelection')).toBe(false);
		act(() => {
			selection.region.set(undefined);
		});
		expect(perform('transformSelection')).toBe(false);
		expect(selection.transforming.get()).toBe(false);
		expect(perform('applyTransform')).toBe(false);
		expect(perform('cancelTransform')).toBe(false);
	});

	it('moves the outline by a drag inside the box, the ants following every sample, and the tool hears nothing', () => {
		const { perform, canvas, path, ants, box, tool } = setup();
		perform('transformSelection');
		fire(canvas, pointer('pointerdown', { clientX: 30, clientY: 20 }));
		fire(canvas, pointer('pointermove', { clientX: 35, clientY: 20 }));
		expect(path()).toBe('M 15 10 L 55 10 L 55 30 L 15 30 Z');
		expect(ants()).toEqual([path(), path()]);
		expect(box()).toEqual([15, 10, 40, 20]);
		fire(canvas, pointer('pointermove', { clientX: 40, clientY: 25 }));
		fire(canvas, pointer('pointerup', { clientX: 40, clientY: 25 }));
		expect(path()).toBe('M 20 15 L 60 15 L 60 35 L 20 35 Z');
		fire(canvas, pointer('pointermove', { clientX: 0, clientY: 0, buttons: 0 }));
		expect(tool.calls).toEqual([]);
	});

	it('scales by a handle, Shift keeping the ratio and Alt about the middle', () => {
		const { perform, canvas, path } = setup();
		perform('transformSelection');
		drag(canvas, [50, 30], [90, 50]);
		expect(path()).toBe('M 10 10 L 90 10 L 90 50 L 10 50 Z');
		perform('cancelTransform');
		perform('transformSelection');
		drag(canvas, [50, 30], [90, 34], { shiftKey: true });
		expect(path()).toBe('M 10 10 L 90 10 L 90 50 L 10 50 Z');
		perform('cancelTransform');
		perform('transformSelection');
		drag(canvas, [50, 20], [70, 20], { altKey: true });
		expect(path()).toBe('M -10 10 L 70 10 L 70 30 L -10 30 Z');
	});

	it('rotates by a drag outside the box, about its middle, Shift by 15°', () => {
		const { perform, canvas, path } = setup();
		perform('transformSelection');
		drag(canvas, [90, 20], [30, 80]);
		expect(path()).toBe(transformPath(AREA, rotate(90, { x: 30, y: 20 })));
		perform('cancelTransform');
		perform('transformSelection');
		const fifty = (50 * Math.PI) / 180;
		drag(canvas, [90, 20], [30 + 60 * Math.cos(fifty), 20 + 60 * Math.sin(fifty)], {
			shiftKey: true,
		});
		expect(path()).toBe(transformPath(AREA, rotate(45, { x: 30, y: 20 })));
	});

	it('keeps the outline and its feather with Enter, and puts the area back with Escape', () => {
		const { perform, canvas, selection, box } = setup();
		perform('transformSelection');
		drag(canvas, [30, 20], [40, 20]);
		const event = key('Enter', {}, canvas);
		expect(event.defaultPrevented).toBe(true);
		expect(selection.transforming.get()).toBe(false);
		expect(selection.region.get()).toEqual({
			path: 'M 20 10 L 60 10 L 60 30 L 20 30 Z',
			inverted: false,
			feather: 3,
		});
		expect(box()).toBeUndefined();
		const kept = selection.region.get();
		perform('transformSelection');
		drag(canvas, [40, 20], [80, 60]);
		key('Escape');
		expect(selection.transforming.get()).toBe(false);
		expect(selection.region.get()).toBe(kept);
	});

	it('applies and cancels from the menu, which lists only Apply and Cancel while it is on', () => {
		const { perform, canvas, selection } = setup();
		perform('transformSelection');
		fire(canvas, pointer('pointerdown', { clientX: 30, clientY: 20, button: 2, buttons: 2 }));
		fire(
			canvas,
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: 30,
				clientY: 20,
			})
		);
		expect(screen.getAllByRole('menuitem').map((item) => item.firstChild?.textContent)).toEqual(
			['Apply', 'Cancel']
		);
		act(() => {
			screen.getByRole('menuitem', { name: /Cancel/ }).click();
		});
		expect(selection.transforming.get()).toBe(false);
		expect(selection.region.get()).toBe(FEATHERED);
	});

	it('leaves Enter to a control the keyboard is on, and takes it from one the pointer pressed', () => {
		const { perform, selection } = setup();
		const button = document.createElement('button');
		document.body.appendChild(button);
		perform('transformSelection');
		expect(key('Enter', {}, button).defaultPrevented).toBe(false);
		expect(selection.transforming.get()).toBe(true);
		const field = document.createElement('input');
		document.body.appendChild(field);
		key('Enter', {}, field);
		expect(selection.transforming.get()).toBe(true);
		fire(button, pointer('pointerdown'));
		expect(key('Enter', {}, button).defaultPrevented).toBe(true);
		expect(selection.transforming.get()).toBe(false);
	});

	it('leaves an Escape something else took, and cancels before the area is dropped', () => {
		const { perform, selection } = setup();
		perform('transformSelection');
		const taken = new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
		});
		taken.preventDefault();
		fire(window, taken);
		expect(selection.transforming.get()).toBe(true);
		key('Escape');
		expect(selection.region.get()).toBe(FEATHERED);
		key('Escape');
		expect(selection.region.get()).toBeUndefined();
	});

	it('steps back through its drags and nudges with Ctrl or ⌘ Z, and forward again, and never reaches the history', () => {
		const { perform, canvas, path, calls } = setup();
		perform('transformSelection');
		drag(canvas, [30, 20], [40, 20]);
		key('ArrowDown', { shiftKey: true });
		expect(path()).toBe('M 20 20 L 60 20 L 60 40 L 20 40 Z');
		key('z', PRIMARY);
		expect(path()).toBe('M 20 10 L 60 10 L 60 30 L 20 30 Z');
		key('z', PRIMARY);
		expect(path()).toBe(AREA);
		expect(key('z', PRIMARY).defaultPrevented).toBe(true);
		expect(path()).toBe(AREA);
		key('z', { ...PRIMARY, shiftKey: true });
		expect(path()).toBe('M 20 10 L 60 10 L 60 30 L 20 30 Z');
		key('ArrowLeft');
		expect(path()).toBe('M 19 10 L 59 10 L 59 30 L 19 30 Z');
		key('z', { ...PRIMARY, shiftKey: true });
		expect(path()).toBe('M 19 10 L 59 10 L 59 30 L 19 30 Z');
		expect(calls).toEqual([]);
	});

	it('is applied by a new tool, another layer, or any other action of the selection’s', () => {
		const { perform, canvas, selection, rerender, props } = setup();
		const moved = 'M 20 10 L 60 10 L 60 30 L 20 30 Z';
		perform('transformSelection');
		drag(canvas, [30, 20], [40, 20]);
		rerender(<Viewport {...props} tool={toolOf('brush', recording().behavior)} />);
		expect(selection.transforming.get()).toBe(false);
		expect(selection.region.get()?.path).toBe(moved);
		perform('transformSelection');
		drag(canvas, [40, 20], [50, 20]);
		rerender(<Viewport {...props} layerId="layer-2" />);
		expect(selection.transforming.get()).toBe(false);
		expect(selection.region.get()?.path).toBe('M 30 10 L 70 10 L 70 30 L 30 30 Z');
		perform('transformSelection');
		drag(canvas, [50, 20], [60, 20]);
		expect(perform('selectInverse')).toBe(true);
		expect(selection.transforming.get()).toBe(false);
		expect(selection.region.get()).toEqual({
			path: 'M 40 10 L 80 10 L 80 30 L 40 30 Z',
			inverted: true,
			feather: 3,
		});
		perform('selectInverse');
		perform('transformSelection');
		key('d', PRIMARY);
		expect(selection.transforming.get()).toBe(false);
		expect(selection.region.get()).toBeUndefined();
	});

	it('ends where it is when the area is set by anything else', () => {
		const { perform, selection, box } = setup();
		perform('transformSelection');
		const other: Region = { path: 'M 0 0 L 5 0 L 5 5 L 0 5 Z', inverted: false, feather: 0 };
		act(() => {
			selection.region.set(other);
		});
		expect(selection.transforming.get()).toBe(false);
		expect(box()).toBeUndefined();
		expect(selection.region.get()).toBe(other);
	});

	it('puts back the drag a first finger began when a second lands, and lets the two pan', () => {
		const { perform, canvas, path, selection, container } = setup();
		perform('transformSelection');
		const finger = (type: string, pointerId: number, clientX: number) =>
			pointer(type, { pointerId, pointerType: 'touch', clientX, clientY: 20 });
		fire(canvas, finger('pointerdown', 1, 30));
		fire(canvas, finger('pointermove', 1, 45));
		expect(path()).toBe('M 25 10 L 65 10 L 65 30 L 25 30 Z');
		fire(canvas, finger('pointerdown', 2, 100));
		expect(path()).toBe(AREA);
		fire(canvas, finger('pointermove', 1, 55));
		fire(canvas, finger('pointermove', 2, 110));
		expect(path()).toBe(AREA);
		const stage = container.querySelector('.viewport-stage') as HTMLElement;
		// Both fingers 10 px to the right: the view went with them.
		const [x, y] = /^translate\((.+)px, (.+)px\)/.exec(stage.style.transform)?.slice(1) ?? [];
		expect(Number(x)).toBeCloseTo(10);
		expect(Number(y)).toBeCloseTo(0);
		expect(selection.transforming.get()).toBe(true);
	});

	it('shows what a press would take hold of in the cursor, and Space still pans', () => {
		const { perform, canvas, path } = setup();
		const cursor = () => canvas.style.cursor;
		expect(cursor()).toBe('crosshair');
		perform('transformSelection');
		const hover = (clientX: number, clientY: number) =>
			fire(canvas, pointer('pointermove', { clientX, clientY, buttons: 0 }));
		hover(50, 30);
		expect(cursor()).toBe('nwse-resize');
		hover(30, 20);
		expect(cursor()).toBe('move');
		hover(30, 0);
		expect(cursor()).toBe('ns-resize');
		hover(100, 100);
		expect(cursor()).toBe('crosshair');
		// The rotate grip's crosshair is the transform's, not the tool's own (`viewport.css`).
		expect(canvas.hasAttribute('data-tool-cursor')).toBe(false);
		key(' ', {}, canvas);
		expect(cursor()).toBe('grab');
		drag(canvas, [30, 20], [60, 20]);
		expect(path()).toBe(AREA);
		fire(window, new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
		perform('applyTransform');
		expect(cursor()).toBe('crosshair');
		expect(canvas.hasAttribute('data-tool-cursor')).toBe(true);
	});
});
