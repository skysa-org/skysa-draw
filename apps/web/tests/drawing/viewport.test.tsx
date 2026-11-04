import { DEFAULT_DRAWING_SIZE, emptyDrawing, type LayerKind } from '@skysa/draw-core';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DocumentSnapshot, EditorDocument } from '../../src/drawing/document/model.js';
import { ZOOM_CLICK, ZOOM_DRAG_PX } from '../../src/drawing/tools/common/zoom.js';
import { toolById } from '../../src/drawing/tools/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Tool,
	type ToolBehaviour,
	type ToolContext,
	type ToolId,
} from '../../src/drawing/tools/types.js';
import type { ViewportHandle, ViewportProps } from '../../src/drawing/types.js';
import { Viewport } from '../../src/drawing/Viewport.js';
import { t } from '../../src/i18n/t.js';

/**
 * The viewport (docs/ARCHITECTURE.md §7, "Input"): the drawing mounted on a
 * stage, pointer events turned into samples in user units for the tool, and
 * fingers, wheels and keys moving the view. jsdom lays nothing out, so the
 * viewport measures 0 × 0 and the view starts as the identity, which makes
 * every screen point a user point, unless a test gives it a size (`measured`).
 */

// The tests hand the viewport tools of their own. The vector and raster
// behaviours have tests of their own, and loading them here would tie the
// viewport's tests to every tool's imports; the hand and the zoom, which the
// viewport and the registry carry themselves, stay real.
const behaviours = vi.hoisted(() => ({
	deleteSelection: vi.fn<(context: ToolContext) => void>(),
	clearArea: vi.fn<(context: ToolContext) => boolean>(() => true),
}));
vi.mock('../../src/drawing/tools/vector/index.js', () => ({
	vectorBehaviours: {},
	deleteSelection: behaviours.deleteSelection,
}));
vi.mock('../../src/drawing/tools/raster/index.js', () => ({
	rasterBehaviours: {},
	clearArea: behaviours.clearArea,
}));

const ID = 'drawing-1';
const SVG_NS = 'http://www.w3.org/2000/svg';

type FakeDocument = Readonly<{
	document: EditorDocument;
	calls: string[];
	/** A command ran: the snapshot is new, and whoever subscribed is told. */
	changed: () => void;
}>;

/** A document with two layers, vector unless asked otherwise, which records what is asked of it. */
const fakeDocument = (
	kinds: Readonly<[LayerKind, LayerKind]> = ['vector', 'vector']
): FakeDocument => {
	const parsed = new DOMParser().parseFromString(emptyDrawing({ id: ID }), 'image/svg+xml');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	let snapshot: DocumentSnapshot = {
		layers: [
			{
				id: 'layer-1',
				kind: kinds[0],
				name: undefined,
				hidden: false,
				locked: false,
				opacity: 1,
				blend: 'normal',
				depth: 0,
				parentId: undefined,
				loose: false,
			},
			{
				id: 'layer-2',
				kind: kinds[1],
				name: undefined,
				hidden: false,
				locked: false,
				opacity: 1,
				blend: 'normal',
				depth: 0,
				parentId: undefined,
				loose: false,
			},
		],
		size: DEFAULT_DRAWING_SIZE,
		canUndo: true,
		canRedo: true,
		dirty: false,
		version: 0,
	};
	const calls: string[] = [];
	const listeners = new Set<() => void>();
	return {
		calls,
		changed: () => {
			snapshot = { ...snapshot, version: snapshot.version + 1 };
			listeners.forEach((listener) => listener());
		},
		document: {
			root,
			prolog: '',
			size: DEFAULT_DRAWING_SIZE,
			snapshot: () => snapshot,
			text: () => '',
			// By the root, not its document: mounted, the root is in a shadow
			// root, which `getElementById` does not reach.
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
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			pending: () => undefined,
			settle: () => Promise.resolve(),
		},
	};
};

type Call = Readonly<{ name: string; sample?: PointerSample; context?: ToolContext }>;

/** A behaviour that records every call, and draws a mark on the overlay when it begins. */
const recorder = (onBegin?: (context: ToolContext) => void) => {
	const calls: Call[] = [];
	const behaviour: ToolBehaviour = {
		begin: (context, sample) => {
			calls.push({ name: 'begin', sample, context });
			context.overlay.appendChild(
				context.overlay.ownerDocument.createElementNS(SVG_NS, 'circle')
			);
			onBegin?.(context);
		},
		move: (context, sample) => {
			calls.push({ name: 'move', sample, context });
		},
		end: (context, sample) => {
			calls.push({ name: 'end', sample, context });
		},
		cancel: (context) => {
			calls.push({ name: 'cancel', context });
		},
		hover: (context, sample) => {
			calls.push({ name: 'hover', sample, context });
		},
	};
	const names = () => calls.map((call) => call.name);
	return { calls, behaviour, names };
};

const fakeTool = (id: ToolId, kinds: Tool['behaviours'], cursor = 'crosshair'): Tool => ({
	id,
	options: [],
	behaviours: kinds,
	cursor,
});

type PointerType =
	'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture';

type PointerInit = PointerEventInit & Readonly<{ at?: number }>;

/** A pointer event as the browser would send it; `at` is its time, for a tap. */
const pointer = (type: PointerType, { at, ...init }: PointerInit = {}): PointerEvent => {
	const lifted =
		type === 'pointerup' || type === 'pointercancel' || type === 'lostpointercapture';
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		button: type === 'pointermove' ? -1 : 0,
		buttons: lifted ? 0 : 1,
		...init,
	});
	if (at !== undefined) Object.defineProperty(event, 'timeStamp', { value: at });
	return event;
};

/** A finger's event, at a time, on a line across the viewport. */
const touch = (type: PointerType, pointerId: number, clientX: number, at = 0): PointerEvent =>
	pointer(type, { pointerId, pointerType: 'touch', clientX, clientY: 100, at });

const fire = (target: EventTarget, event: Event): Event => {
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
};

const keyDown = (key: string, target: EventTarget = window): Event =>
	fire(target, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

/** A key with the primary key held: both Ctrl and ⌘, so it reads the same on any platform. */
const primaryDown = (key: string, target: EventTarget = window): Event =>
	fire(
		target,
		new KeyboardEvent('keydown', {
			key,
			ctrlKey: true,
			metaKey: true,
			bubbles: true,
			cancelable: true,
		})
	);

const keyUp = (key: string) => {
	fire(window, new KeyboardEvent('keyup', { key, bubbles: true }));
};

/** A click: down and up at one point. */
const click = (target: EventTarget, clientX: number, clientY: number, init: PointerInit = {}) => {
	fire(target, pointer('pointerdown', { clientX, clientY, ...init }));
	fire(target, pointer('pointerup', { clientX, clientY, ...init }));
};

const setup = (tool: Tool, overrides: Partial<ViewportProps> = {}) => {
	const fake = fakeDocument();
	const ref = createRef<ViewportHandle>();
	const onNotify = vi.fn<(message: string) => void>();
	const onScale = vi.fn<(scale: number) => void>();
	const onColour = vi.fn<(which: 'fill' | 'stroke', value: string) => void>();
	const props: ViewportProps = {
		document: fake.document,
		tool,
		options: DEFAULT_TOOL_OPTIONS,
		layerId: 'layer-1',
		onColour,
		onNotify,
		onScale,
		ref,
		...overrides,
	};
	const utils = render(<Viewport {...props} />);
	const region = utils.getByRole('region', { name: t('editor.panes.canvas') });
	const stage = utils.container.querySelector('.viewport-stage') as HTMLElement;
	const overlay = utils.container.querySelector('.viewport-overlay') as SVGSVGElement;
	const screen = utils.container.querySelector('.viewport-screen') as HTMLCanvasElement;
	return {
		...utils,
		...fake,
		props,
		ref,
		onNotify,
		onScale,
		onColour,
		region,
		stage,
		overlay,
		screen,
	};
};

const lastScale = (onScale: ReturnType<typeof vi.fn<(scale: number) => void>>): number =>
	onScale.mock.calls[onScale.mock.calls.length - 1]?.[0] ?? Number.NaN;

/** The stage's translation and scale, read back from its transform. */
const placed = (stage: HTMLElement, tx: number, ty: number, scale: number) => {
	const match = /^translate\((.+)px, (.+)px\) scale\((.+)\)$/.exec(stage.style.transform);
	const [x, y, s] = match === null ? [] : match.slice(1).map(Number);
	expect(x).toBeCloseTo(tx);
	expect(y).toBeCloseTo(ty);
	expect(s).toBeCloseTo(scale);
};

/** Every element `width` × `height` CSS pixels, with its corner at `left`, `top` on the page. */
const measured = (width: number, height: number, left = 0, top = 0) => {
	vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width);
	vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(height);
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	});
};

// jsdom has no pointer capture; the browser has, and the viewport asks for it.
const captured = vi.fn();
beforeAll(() => {
	Object.defineProperty(Element.prototype, 'setPointerCapture', {
		value: captured,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(Element.prototype, 'releasePointerCapture', {
		value: () => undefined,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(Element.prototype, 'hasPointerCapture', {
		value: () => false,
		configurable: true,
		writable: true,
	});
});
afterAll(() => {
	Reflect.deleteProperty(Element.prototype, 'setPointerCapture');
	Reflect.deleteProperty(Element.prototype, 'releasePointerCapture');
	Reflect.deleteProperty(Element.prototype, 'hasPointerCapture');
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	behaviours.deleteSelection.mockClear();
	behaviours.clearArea.mockClear();
});

describe('the viewport', () => {
	it("mounts the document's own root on the stage, unchanged, and sizes the stage and the overlay to it", () => {
		const { behaviour } = recorder();
		const fake = fakeDocument();
		const before = new XMLSerializer().serializeToString(fake.document.root);
		const { container, stage, overlay, unmount } = setup(
			fakeTool('pencil', { vector: behaviour }),
			{ document: fake.document }
		);
		const mount = container.querySelector('.viewport-mount');
		expect(mount?.shadowRoot?.contains(fake.document.root)).toBe(true);
		expect(fake.document.root.parentNode).toBe(mount?.shadowRoot);
		expect(new XMLSerializer().serializeToString(fake.document.root)).toBe(before);
		expect(stage.style.width).toBe('1600px');
		expect(stage.style.height).toBe('1000px');
		expect(stage.style.transform).toBe('translate(0px, 0px) scale(1)');
		expect(overlay.getAttribute('viewBox')).toBe('0 0 1600 1000');
		unmount();
		expect(fake.document.root.parentNode).toBeNull();
		expect(new XMLSerializer().serializeToString(fake.document.root)).toBe(before);
	});

	it("keeps the drawing's own styles to the drawing, in a shadow root the pointer reaches through", () => {
		// jsdom makes no stylesheet of an SVG `<style>`, in a shadow or out of
		// one, so what is checked is the structure that keeps a browser's
		// cascade apart: the drawing, `<style>` and all, is in a shadow root on
		// the mount, out of the reach of the page's selectors and of its own.
		const { behaviour, calls } = recorder();
		const fake = fakeDocument();
		const style = document.createElementNS(SVG_NS, 'style');
		style.textContent = 'body, .viewport { display: none; } svg { position: fixed; }';
		const shape = document.createElementNS(SVG_NS, 'rect');
		fake.document.root.append(style, shape);
		const { container } = setup(fakeTool('pencil', { vector: behaviour }), {
			document: fake.document,
		});
		const mount = container.querySelector('.viewport-mount');
		const shadow = fake.document.root.parentNode;
		expect(shadow).toBeInstanceOf(ShadowRoot);
		expect((shadow as ShadowRoot).host).toBe(mount);
		expect(document.querySelector('style')).toBeNull();
		expect(container.querySelector('rect')).toBeNull();
		// The shadow's own rules size the root: adopted where the browser can,
		// and in a `<style>` before the drawing in jsdom, which cannot.
		expect((shadow as ShadowRoot).firstElementChild?.localName).toBe('style');
		expect((shadow as ShadowRoot).firstElementChild?.textContent).toContain(':host');

		// A pointer on the drawing itself bubbles out to the viewport.
		act(() => {
			shape.dispatchEvent(
				new PointerEvent('pointerdown', {
					bubbles: true,
					composed: true,
					cancelable: true,
					pointerId: 1,
					pointerType: 'mouse',
					isPrimary: true,
					button: 0,
					buttons: 1,
					clientX: 30,
					clientY: 40,
				})
			);
		});
		expect(calls[0]?.name).toBe('begin');
		expect(calls[0]?.sample).toMatchObject({ x: 30, y: 40 });
	});

	it('mounts the next document in the same shadow, and takes the last one out', () => {
		const { behaviour } = recorder();
		const first = fakeDocument();
		const next = fakeDocument();
		const { container, rerender, props } = setup(fakeTool('pencil', { vector: behaviour }), {
			document: first.document,
		});
		const shadow = container.querySelector('.viewport-mount')?.shadowRoot;
		rerender(<Viewport {...props} document={next.document} />);
		expect(first.document.root.parentNode).toBeNull();
		expect(next.document.root.parentNode).toBe(shadow);
	});

	it("keeps the viewBox's origin: the overlay shares it, and a sample is read through it", () => {
		const { behaviour, calls } = recorder();
		const fake = fakeDocument();
		fake.document.root.setAttribute('viewBox', '-100 -50 1600 1000');
		const { region, stage, overlay } = setup(fakeTool('pencil', { vector: behaviour }), {
			document: fake.document,
		});
		expect(overlay.getAttribute('viewBox')).toBe('-100 -50 1600 1000');
		expect(stage.style.transform).toBe('translate(0px, 0px) scale(1)');
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		expect(calls[0]?.sample).toMatchObject({ x: -90, y: -30 });
	});

	it('fits the drawing to the viewport, and draws the screen canvas at the device pixel ratio', () => {
		measured(800, 600);
		vi.stubGlobal('devicePixelRatio', 2);
		const { behaviour } = recorder();
		const { onScale, stage, screen } = setup(fakeTool('pencil', { vector: behaviour }));
		// 736 × 536 of room inside the margin, for 1600 × 1000: the width decides.
		expect(lastScale(onScale)).toBeCloseTo(0.46);
		placed(stage, 32, 70, 0.46);
		expect(screen.width).toBe(1600);
		expect(screen.height).toBe(1200);
	});

	it('fits the drawing once the viewport first measures something, and not again after', () => {
		const observed: ResizeObserverCallback[] = [];
		class FakeResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				observed.push(callback);
			}
			observe = () => undefined;
			unobserve = () => undefined;
			disconnect = () => undefined;
		}
		vi.stubGlobal('ResizeObserver', FakeResizeObserver);
		const resized = () => {
			act(() => {
				observed.forEach((callback) => callback([], {} as ResizeObserver));
			});
		};
		const { behaviour } = recorder();
		const { onScale, ref } = setup(fakeTool('pencil', { vector: behaviour }));
		expect(lastScale(onScale)).toBe(1);

		measured(800, 600);
		resized();
		expect(lastScale(onScale)).toBeCloseTo(0.46);

		act(() => {
			ref.current?.zoomIn();
		});
		resized();
		expect(lastScale(onScale)).toBeCloseTo(0.575);
	});

	it('hands the tool begin, move and end in user units, through the view and the corner', () => {
		measured(800, 600, 100, 50);
		const { behaviour, calls, names } = recorder();
		const { region, ref } = setup(fakeTool('pencil', { vector: behaviour }));
		act(() => {
			ref.current?.actualSize();
		});
		expect(ref.current?.scale).toBe(1);

		// Actual size puts the 1600 × 1000 drawing in the middle of 800 × 600:
		// its corner is 400 to the left of the viewport's and 200 above it.
		fire(region, pointer('pointerdown', { clientX: 110, clientY: 70 }));
		fire(region, pointer('pointermove', { clientX: 130, clientY: 90 }));
		fire(region, pointer('pointerup', { clientX: 130, clientY: 90 }));

		expect(names()).toEqual(['begin', 'move', 'end']);
		expect(calls[0]?.sample).toMatchObject({
			x: 410,
			y: 220,
			pressure: 0.5,
			pointerType: 'mouse',
			primaryKey: false,
		});
		expect(calls[1]?.sample).toMatchObject({ x: 430, y: 240 });
		expect(calls[2]?.sample).toMatchObject({ x: 430, y: 240 });
		// One context for the stroke, begin to end.
		expect(calls[1]?.context).toBe(calls[0]?.context);
		expect(calls[2]?.context).toBe(calls[0]?.context);
		expect(calls[0]?.context?.layer?.id).toBe('layer-1');
		expect(captured).toHaveBeenCalledWith(1);
	});

	it('hands the tool every coalesced sample of a fast move', () => {
		const { behaviour, calls, names } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behaviour }));
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 10 }));
		const move = pointer('pointermove', { clientX: 40, clientY: 10 });
		const bundled = [20, 30, 40].map((clientX) =>
			pointer('pointermove', { clientX, clientY: 10 })
		);
		Object.defineProperty(move, 'getCoalescedEvents', { value: () => bundled });
		fire(region, move);
		expect(names()).toEqual(['begin', 'move', 'move', 'move']);
		expect(calls.slice(1).map((call) => call.sample?.x)).toEqual([20, 30, 40]);
	});

	it('zooms about the cursor on a wheel with Ctrl, and reads the next stroke through the new view', () => {
		const { behaviour, calls } = recorder();
		const { region, onScale, ref, stage } = setup(fakeTool('pencil', { vector: behaviour }));
		expect(lastScale(onScale)).toBe(1);

		const wheel = new WheelEvent('wheel', {
			deltaY: -Math.log(2) / 0.002,
			ctrlKey: true,
			clientX: 0,
			clientY: 0,
			bubbles: true,
			cancelable: true,
		});
		fire(region, wheel);
		expect(wheel.defaultPrevented).toBe(true);
		expect(lastScale(onScale)).toBeCloseTo(2);
		expect(ref.current?.scale).toBeCloseTo(2);
		placed(stage, 0, 0, 2);

		fire(region, pointer('pointerdown', { clientX: 20, clientY: 40 }));
		expect(calls[0]?.sample?.x).toBeCloseTo(10);
		expect(calls[0]?.sample?.y).toBeCloseTo(20);
	});

	it('scrolls the drawing on a plain wheel', () => {
		const { behaviour } = recorder();
		const { region, stage, onScale } = setup(fakeTool('pencil', { vector: behaviour }));
		const wheel = new WheelEvent('wheel', {
			deltaX: 10,
			deltaY: 20,
			bubbles: true,
			cancelable: true,
		});
		fire(region, wheel);
		expect(wheel.defaultPrevented).toBe(true);
		expect(stage.style.transform).toBe('translate(-10px, -20px) scale(1)');
		expect(onScale).toHaveBeenCalledTimes(1);
	});

	it("says so, does not begin, and shows it, when the tool does nothing on the layer's kind", () => {
		const { behaviour, names } = recorder();
		const smudge = fakeTool('smudge', { raster: behaviour });
		const { region, onNotify } = setup(smudge);
		expect(region.style.cursor).toBe('not-allowed');
		click(region, 10, 20);
		expect(onNotify).toHaveBeenCalledWith(t('tools.notOnVector', { tool: t('tools.smudge') }));
		expect(names()).toEqual([]);
	});

	it('asks for a layer when none is active', () => {
		const { behaviour, names } = recorder();
		const { region, onNotify } = setup(fakeTool('pencil', { vector: behaviour }), {
			layerId: undefined,
		});
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		expect(onNotify).toHaveBeenCalledWith(t('layers.noneActive'));
		expect(names()).toEqual([]);
	});

	it('lets the hand pan with no layer at all, since it needs none', () => {
		const hand = toolById('hand') as Tool;
		const { region, stage, onNotify } = setup(hand, { layerId: undefined });
		expect(region.style.cursor).toBe('grab');
		fire(region, pointer('pointerdown', { clientX: 100, clientY: 100 }));
		fire(region, pointer('pointermove', { clientX: 130, clientY: 80 }));
		fire(region, pointer('pointerup', { clientX: 130, clientY: 80 }));
		expect(stage.style.transform).toBe('translate(30px, -20px) scale(1)');
		expect(onNotify).not.toHaveBeenCalled();
	});

	it('zooms in about a click, out with Alt, and by a drag about where it began', () => {
		const zoom = toolById('zoom') as Tool;
		const { region, stage, onScale } = setup(zoom);
		click(region, 100, 50);
		expect(lastScale(onScale)).toBeCloseTo(ZOOM_CLICK);
		// The point clicked stays where it was on the screen.
		placed(stage, 100 - 100 * ZOOM_CLICK, 50 - 50 * ZOOM_CLICK, ZOOM_CLICK);
		click(region, 100, 50, { altKey: true });
		expect(lastScale(onScale)).toBeCloseTo(1);

		fire(region, pointer('pointerdown', { clientX: 100, clientY: 50 }));
		fire(
			region,
			pointer('pointermove', { clientX: 100 + ZOOM_DRAG_PX * Math.log(2), clientY: 50 })
		);
		fire(
			region,
			pointer('pointerup', { clientX: 100 + ZOOM_DRAG_PX * Math.log(2), clientY: 50 })
		);
		expect(lastScale(onScale)).toBeCloseTo(2);
	});

	it('pans with the hand while Space is held, whatever the tool, and previews nothing meanwhile', () => {
		const { behaviour, names } = recorder();
		const { region, stage } = setup(fakeTool('pencil', { vector: behaviour }));
		expect(region.style.cursor).toBe('crosshair');

		expect(keyDown(' ').defaultPrevented).toBe(true);
		expect(region.style.cursor).toBe('grab');
		fire(region, pointer('pointermove', { clientX: 90, clientY: 90, buttons: 0 }));
		fire(region, pointer('pointerdown', { clientX: 100, clientY: 100 }));
		fire(region, pointer('pointermove', { clientX: 115, clientY: 105 }));
		fire(region, pointer('pointermove', { clientX: 125, clientY: 110 }));
		fire(region, pointer('pointerup', { clientX: 125, clientY: 110 }));
		expect(stage.style.transform).toBe('translate(25px, 10px) scale(1)');
		expect(names()).toEqual([]);

		keyUp(' ');
		expect(region.style.cursor).toBe('crosshair');
	});

	it('leaves Space to a field', () => {
		const { behaviour } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behaviour }));
		const input = document.createElement('input');
		document.body.appendChild(input);
		expect(keyDown(' ', input).defaultPrevented).toBe(false);
		expect(region.style.cursor).toBe('crosshair');
		input.remove();
	});

	it('abandons the stroke on Escape', () => {
		const { behaviour, names } = recorder();
		const { region, overlay } = setup(fakeTool('pencil', { vector: behaviour }));
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		expect(overlay.childElementCount).toBe(1);
		keyDown('Escape');
		expect(names()).toEqual(['begin', 'cancel']);
		expect(overlay.childElementCount).toBe(0);
		fire(region, pointer('pointerup', { clientX: 10, clientY: 20 }));
		expect(names()).toEqual(['begin', 'cancel']);
	});

	it('abandons a stroke whose pointer the browser took away, or that went down again without lifting', () => {
		const { behaviour, names } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behaviour }));
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		fire(region, pointer('lostpointercapture'));
		fire(region, pointer('pointerup', { clientX: 10, clientY: 20 }));
		expect(names()).toEqual(['begin', 'cancel']);

		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		fire(region, pointer('pointerdown', { clientX: 30, clientY: 40 }));
		fire(region, pointer('pointerup', { clientX: 30, clientY: 40 }));
		expect(names()).toEqual(['begin', 'cancel', 'begin', 'cancel', 'begin', 'end']);
	});

	it('lets a finger draw, cancels its stroke when a second one lands, and undoes on a two-finger tap', () => {
		const { behaviour, calls, names } = recorder();
		const { region, overlay, calls: asked } = setup(fakeTool('pencil', { vector: behaviour }));

		fire(region, touch('pointerdown', 1, 100, 0));
		expect(calls[0]?.sample?.pointerType).toBe('touch');
		fire(region, touch('pointermove', 1, 150, 30));
		expect(names()).toEqual(['begin', 'move']);
		expect(overlay.childElementCount).toBe(1);
		fire(region, touch('pointerdown', 2, 300, 60));
		expect(names()).toEqual(['begin', 'move', 'cancel']);
		expect(overlay.childElementCount).toBe(0);
		// The two fingers lift: a pair that moved is not a tap.
		fire(region, touch('pointerup', 1, 150, 100));
		fire(region, touch('pointerup', 2, 300, 110));
		expect(asked).toEqual([]);

		fire(region, touch('pointerdown', 1, 100, 1000));
		fire(region, touch('pointerdown', 2, 300, 1020));
		fire(region, touch('pointerup', 1, 100, 1100));
		fire(region, touch('pointerup', 2, 300, 1120));
		expect(asked).toEqual(['undo']);
		expect(names().filter((name) => name === 'end')).toEqual([]);
	});

	it('redoes on a three-finger tap', () => {
		const { behaviour } = recorder();
		const { region, calls: asked } = setup(fakeTool('pencil', { vector: behaviour }));
		fire(region, touch('pointerdown', 1, 100, 0));
		fire(region, touch('pointerdown', 2, 200, 10));
		fire(region, touch('pointerdown', 3, 300, 20));
		fire(region, touch('pointerup', 1, 100, 100));
		fire(region, touch('pointerup', 2, 200, 110));
		fire(region, touch('pointerup', 3, 300, 120));
		expect(asked).toEqual(['redo']);
	});

	it('pans with two fingers and zooms by a pinch', () => {
		const { behaviour } = recorder();
		const { region, onScale, stage } = setup(fakeTool('pencil', { vector: behaviour }));
		fire(region, touch('pointerdown', 1, 100));
		fire(region, touch('pointerdown', 2, 200));
		fire(
			region,
			pointer('pointermove', {
				pointerId: 1,
				pointerType: 'touch',
				clientX: 100,
				clientY: 130,
			})
		);
		fire(
			region,
			pointer('pointermove', {
				pointerId: 2,
				pointerType: 'touch',
				clientX: 200,
				clientY: 130,
			})
		);
		placed(stage, 0, 30, 1);
		fire(
			region,
			pointer('pointermove', {
				pointerId: 2,
				pointerType: 'touch',
				clientX: 300,
				clientY: 130,
			})
		);
		expect(lastScale(onScale)).toBeCloseTo(2);
	});

	it('draws with a pen as it presses, and takes a finger beside it for a palm', () => {
		const { behaviour, calls, names } = recorder();
		const { region } = setup(fakeTool('brush', { vector: behaviour }));
		const pen = (type: PointerType, clientX: number, pressure: number) =>
			pointer(type, {
				pointerId: 7,
				pointerType: 'pen',
				clientX,
				clientY: 10,
				pressure,
				tiltX: 30,
			});

		fire(region, pen('pointerdown', 10, 0.8));
		expect(calls[0]?.sample?.pointerType).toBe('pen');
		expect(calls[0]?.sample?.pressure).toBeCloseTo(0.8);
		expect(calls[0]?.sample?.tiltX).toBe(30);
		fire(region, touch('pointerdown', 2, 300));
		fire(region, touch('pointermove', 2, 320));
		fire(region, pen('pointermove', 20, 0.4));
		fire(region, pen('pointerup', 20, 0));
		expect(names()).toEqual(['begin', 'move', 'end']);
		expect(calls[1]?.sample?.pressure).toBeCloseTo(0.4);

		// The palm stays one until it lifts; then a finger draws again.
		fire(region, touch('pointermove', 2, 340));
		fire(region, touch('pointerup', 2, 340));
		fire(region, touch('pointerdown', 3, 100));
		expect(names()).toEqual(['begin', 'move', 'end', 'begin']);
	});

	it('empties the overlay and abandons the stroke when the tool changes', () => {
		const first = recorder();
		const second = recorder();
		const { region, overlay, rerender, props } = setup(
			fakeTool('pencil', { vector: first.behaviour })
		);
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		expect(overlay.childElementCount).toBe(1);

		rerender(<Viewport {...props} tool={fakeTool('brush', { vector: second.behaviour })} />);
		expect(overlay.childElementCount).toBe(0);
		expect(first.names()).toEqual(['begin', 'cancel']);
		expect(second.names()).toEqual([]);
		expect(region.style.cursor).toBe('crosshair');
	});

	it('keeps the selection for the select tool, and lets go of it for another tool or another layer', () => {
		const mark = document.createElementNS(SVG_NS, 'rect');
		const select = recorder((context) => {
			context.selection.set([mark]);
		});
		const selectTool = fakeTool('select', { vector: select.behaviour }, 'default');
		const { region, rerender, props } = setup(selectTool);
		const selected = () => select.calls[0]?.context?.selection.elements;

		click(region, 10, 20);
		expect(selected()).toEqual([mark]);
		rerender(<Viewport {...props} options={{ ...DEFAULT_TOOL_OPTIONS, size: 20 }} />);
		expect(selected()).toEqual([mark]);
		rerender(<Viewport {...props} layerId="layer-2" />);
		expect(selected()).toEqual([]);

		rerender(<Viewport {...props} />);
		click(region, 10, 20);
		expect(selected()).toEqual([mark]);
		rerender(
			<Viewport {...props} tool={fakeTool('pencil', { vector: recorder().behaviour })} />
		);
		expect(selected()).toEqual([]);
	});

	it('lets go of a selected element an undo took out of the drawing', () => {
		const fake = fakeDocument();
		const mark = document.createElementNS(SVG_NS, 'rect');
		fake.document.root.appendChild(mark);
		const select = recorder((context) => {
			context.selection.set([mark]);
		});
		const { region, overlay } = setup(fakeTool('select', { vector: select.behaviour }), {
			document: fake.document,
		});
		click(region, 10, 20);
		expect(overlay.childElementCount).toBe(1);

		act(() => {
			fake.changed();
		});
		expect(select.calls[0]?.context?.selection.elements).toEqual([mark]);
		expect(overlay.childElementCount).toBe(1);

		mark.remove();
		act(() => {
			fake.changed();
		});
		expect(select.calls[0]?.context?.selection.elements).toEqual([]);
		expect(overlay.childElementCount).toBe(0);
	});

	it('deletes the selection on Delete, and leaves the key alone with nothing selected', () => {
		const mark = document.createElementNS(SVG_NS, 'rect');
		const select = recorder((context) => {
			context.selection.set([mark]);
		});
		const { region } = setup(fakeTool('select', { vector: select.behaviour }, 'default'));
		expect(keyDown('Delete').defaultPrevented).toBe(false);
		expect(behaviours.deleteSelection).not.toHaveBeenCalled();

		click(region, 10, 20);
		expect(keyDown('Backspace').defaultPrevented).toBe(true);
		expect(behaviours.deleteSelection).toHaveBeenCalledTimes(1);
		const context = behaviours.deleteSelection.mock.calls[0]?.[0];
		expect(context?.selection.elements).toEqual([mark]);
		expect(context?.layer?.id).toBe('layer-1');
	});

	it('hovers a mouse with nothing down, and never a finger', () => {
		const { behaviour, names } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behaviour }));
		fire(region, pointer('pointermove', { clientX: 10, clientY: 20, buttons: 0 }));
		fire(
			region,
			pointer('pointermove', { clientX: 10, clientY: 20, buttons: 0, pointerType: 'touch' })
		);
		expect(names()).toEqual(['hover']);
	});

	it('zooms in and out, fits and shows actual size from the handle', () => {
		const { behaviour } = recorder();
		const { ref, onScale } = setup(fakeTool('pencil', { vector: behaviour }));
		act(() => {
			ref.current?.zoomIn();
		});
		expect(lastScale(onScale)).toBeCloseTo(1.25);
		act(() => {
			ref.current?.zoomIn();
		});
		expect(lastScale(onScale)).toBeCloseTo(1.5625);
		expect(ref.current?.scale).toBeCloseTo(1.5625);
		act(() => {
			ref.current?.zoomOut();
		});
		expect(lastScale(onScale)).toBeCloseTo(1.25);
		act(() => {
			ref.current?.fit();
		});
		expect(lastScale(onScale)).toBe(1);
		act(() => {
			ref.current?.zoomIn();
		});
		act(() => {
			ref.current?.actualSize();
		});
		expect(ref.current?.scale).toBe(1);
	});

	it('gives the tool a viewport it can move, and a selection it can set and clear', () => {
		const { behaviour, calls } = recorder();
		const { region, stage, onScale } = setup(fakeTool('select', { vector: behaviour }));
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		const context = calls[0]?.context as ToolContext;
		act(() => {
			context.viewport.panBy(5, 5);
		});
		expect(stage.style.transform).toBe('translate(5px, 5px) scale(1)');
		act(() => {
			context.viewport.zoomBy(2, 0, 0);
		});
		expect(context.viewport.scale).toBe(2);
		expect(lastScale(onScale)).toBe(2);
		expect(context.screen.toScreen(10, 10)).toEqual([25, 25]);
		expect(context.screen.pixelRatio).toBe(1);

		const mark = document.createElementNS(SVG_NS, 'rect');
		context.selection.set([mark]);
		expect(context.selection.elements).toEqual([mark]);
		context.selection.clear();
		expect(context.selection.elements).toEqual([]);
	});
});

describe('the area and the selection keys', () => {
	const AREA = 'M 10 10 L 50 10 L 50 30 L 10 30 Z';
	const WHOLE = 'M 0 0 L 1600 0 L 1600 1000 L 0 1000 Z';

	/** A tool that makes `AREA` when it begins, as the marquee does when it ends. */
	const marking = () =>
		recorder((context) => {
			context.region.set(AREA);
		});

	const ants = (container: HTMLElement) =>
		Array.from(container.querySelectorAll('.viewport-area path'));

	const rasterSetup = (tool: Tool, overrides: Partial<ViewportProps> = {}) =>
		setup(tool, { document: fakeDocument(['raster', 'vector']).document, ...overrides });

	it('shows the area as marching ants, in a layer of its own that a change of tool or layer leaves', () => {
		const { behaviour } = marking();
		const { region, container, overlay, rerender, props } = setup(
			fakeTool('marquee', { vector: behaviour })
		);
		expect(ants(container)).toEqual([]);
		click(region, 10, 20);
		const drawn = ants(container);
		expect(drawn.map((path) => path.getAttribute('d'))).toEqual([AREA, AREA]);
		expect(drawn.map((path) => path.getAttribute('class'))).toEqual([
			'viewport-ants viewport-ants-under',
			'viewport-ants viewport-ants-over',
		]);
		expect(drawn[1]?.getAttribute('vector-effect')).toBe('non-scaling-stroke');
		expect(container.querySelector('.viewport-area')?.getAttribute('viewBox')).toBe(
			'0 0 1600 1000'
		);

		rerender(
			<Viewport {...props} tool={fakeTool('brush', { vector: recorder().behaviour })} />
		);
		expect(overlay.childElementCount).toBe(0);
		expect(ants(container)).toHaveLength(2);
		rerender(<Viewport {...props} layerId="layer-2" />);
		expect(ants(container)).toHaveLength(2);
	});

	it('drops the area for another drawing', () => {
		const { behaviour } = marking();
		const { region, container, rerender, props } = setup(
			fakeTool('marquee', { vector: behaviour })
		);
		click(region, 10, 20);
		expect(ants(container)).toHaveLength(2);
		rerender(<Viewport {...props} document={fakeDocument().document} />);
		expect(ants(container)).toEqual([]);
	});

	it('selects the whole canvas with Ctrl or ⌘ A on a raster layer, and drops it with D', () => {
		const { container } = rasterSetup(fakeTool('brush', { raster: recorder().behaviour }));
		expect(primaryDown('a').defaultPrevented).toBe(true);
		expect(ants(container)[0]?.getAttribute('d')).toBe(WHOLE);
		expect(primaryDown('d').defaultPrevented).toBe(true);
		expect(ants(container)).toEqual([]);
	});

	it('drops the area on Escape with no stroke under way, and only the stroke with one', () => {
		const { behaviour, names } = recorder();
		const { region, container } = rasterSetup(fakeTool('brush', { raster: behaviour }));
		primaryDown('a');
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		keyDown('Escape');
		expect(names()).toEqual(['begin', 'cancel']);
		expect(ants(container)).toHaveLength(2);
		keyDown('Escape');
		expect(ants(container)).toEqual([]);
	});

	it('leaves Ctrl or ⌘ A and Escape to a field, which selects its own text', () => {
		const { container } = rasterSetup(fakeTool('brush', { raster: recorder().behaviour }));
		const field = document.createElement('input');
		document.body.appendChild(field);
		expect(primaryDown('a', field).defaultPrevented).toBe(false);
		expect(ants(container)).toEqual([]);
		primaryDown('a');
		keyDown('Escape', field);
		expect(ants(container)).toHaveLength(2);
		field.remove();
	});

	it('selects every element of a vector layer with Ctrl or ⌘ A, outlined, and lets go with D', () => {
		const fake = fakeDocument();
		const layer = fake.document.root.ownerDocument.getElementById('layer-1');
		const shapes = ['0', '50'].map((x) => {
			const rect = document.createElementNS(SVG_NS, 'rect');
			['x', 'y', 'width', 'height'].forEach((name, i) =>
				rect.setAttribute(name, i < 2 ? x : '10')
			);
			layer?.appendChild(rect);
			return rect;
		});
		const { behaviour, calls } = recorder();
		const { region, container, overlay } = setup(fakeTool('pencil', { vector: behaviour }), {
			document: fake.document,
		});
		click(region, 10, 20);
		const selected = () => calls[0]?.context?.selection.elements;

		primaryDown('a');
		expect(selected()).toEqual(shapes);
		expect(ants(container)).toEqual([]);
		expect(overlay.querySelectorAll('[data-draw-region-outline] rect')).toHaveLength(2);

		// What a tool keeps on the overlay between strokes is not the selection's.
		const kept = document.createElementNS(SVG_NS, 'g');
		overlay.appendChild(kept);
		primaryDown('d');
		expect(selected()).toEqual([]);
		expect(overlay.querySelector('[data-draw-region-outline]')).toBeNull();
		expect(kept.isConnected).toBe(true);
	});

	it('shows a select-all under the select tool as that tool’s own box and handles', () => {
		const fake = fakeDocument();
		const rect = document.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('width', '10');
		rect.setAttribute('height', '10');
		fake.document.root.ownerDocument.getElementById('layer-1')?.appendChild(rect);
		const { overlay } = setup(fakeTool('select', { vector: recorder().behaviour }), {
			document: fake.document,
		});
		primaryDown('a');
		expect(overlay.querySelector('[data-draw-selection]')).not.toBeNull();
		expect(overlay.querySelector('[data-draw-region-outline]')).toBeNull();
		primaryDown('d');
		expect(overlay.childElementCount).toBe(0);
	});

	it('clears the area’s pixels on Delete on a raster layer, and not on a vector one', () => {
		const raster = rasterSetup(fakeTool('brush', { raster: recorder().behaviour }));
		expect(keyDown('Delete').defaultPrevented).toBe(false);
		expect(behaviours.clearArea).not.toHaveBeenCalled();
		primaryDown('a');
		expect(keyDown('Delete').defaultPrevented).toBe(true);
		expect(behaviours.clearArea).toHaveBeenCalledTimes(1);
		const context = behaviours.clearArea.mock.calls[0]?.[0];
		expect(context?.region.path).toBe(WHOLE);
		expect(context?.layer?.kind).toBe('raster');
		raster.unmount();

		const { behaviour } = marking();
		const { region } = setup(fakeTool('marquee', { vector: behaviour }));
		click(region, 10, 20);
		expect(keyDown('Delete').defaultPrevented).toBe(false);
		expect(behaviours.clearArea).toHaveBeenCalledTimes(1);
	});

	it('keeps the element selection for the marquee and the lasso, which work on it', () => {
		const mark = document.createElementNS(SVG_NS, 'rect');
		const select = recorder((context) => {
			context.selection.set([mark]);
		});
		const { region, rerender, props } = setup(fakeTool('select', { vector: select.behaviour }));
		click(region, 10, 20);
		const selected = () => select.calls[0]?.context?.selection.elements;
		rerender(
			<Viewport {...props} tool={fakeTool('marquee', { vector: recorder().behaviour })} />
		);
		expect(selected()).toEqual([mark]);
		rerender(
			<Viewport {...props} tool={fakeTool('lasso', { vector: recorder().behaviour })} />
		);
		expect(selected()).toEqual([mark]);
	});

	it('tells a tool it is put down once, after its stroke has ended as well as during one', () => {
		const first = recorder();
		const { region, rerender, props } = setup(fakeTool('text', { vector: first.behaviour }));
		click(region, 10, 20);
		expect(first.names()).toEqual(['begin', 'end']);
		rerender(
			<Viewport {...props} tool={fakeTool('pencil', { vector: recorder().behaviour })} />
		);
		expect(first.names()).toEqual(['begin', 'end', 'cancel']);
		rerender(
			<Viewport {...props} tool={fakeTool('brush', { vector: recorder().behaviour })} />
		);
		expect(first.names()).toEqual(['begin', 'end', 'cancel']);
	});
});
