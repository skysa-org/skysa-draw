import { DEFAULT_DRAWING_SIZE, emptyDrawing, type LayerKind } from '@skysa/draw-core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as ContextMenuModule from '../../src/components/ui/ContextMenu.js';
import type { MenuPoint } from '../../src/components/ui/ContextMenu.js';
import type { DocumentSnapshot, EditorDocument } from '../../src/drawing/document/model.js';
import { withBrushOutline } from '../../src/drawing/tools/common/brushOutline.js';
import { ZOOM_CLICK, ZOOM_DRAG_PX } from '../../src/drawing/tools/common/zoom.js';
import { toolById } from '../../src/drawing/tools/index.js';
import type { FillSpec } from '../../src/drawing/tools/raster/areaFill.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Handover,
	type PointerSample,
	type Tool,
	type ToolBehavior,
	type ToolContext,
	type ToolId,
} from '../../src/drawing/tools/types.js';
import type { ViewportHandle, ViewportProps } from '../../src/drawing/types.js';
import { Viewport } from '../../src/drawing/Viewport.js';
import { createViewportSelection } from '../../src/drawing/viewport/selectionState.js';
import { t } from '../../src/i18n/t.js';

/**
 * The viewport (docs/ARCHITECTURE.md §7, "Input"): the drawing mounted on a
 * stage, pointer events turned into samples in user units for the tool, and
 * fingers, wheels and keys moving the view. jsdom lays nothing out, so the
 * viewport measures 0 × 0 and the view starts as the identity, which makes
 * every screen point a user point, unless a test gives it a size (`measured`).
 */

// The tests hand the viewport tools of their own. The vector and raster
// behaviors have tests of their own, and loading them here would tie the
// viewport's tests to every tool's imports; the hand and the zoom, which the
// viewport and the registry carry themselves, stay real.
const behaviors = vi.hoisted(() => ({
	deleteSelection: vi.fn<(context: ToolContext) => void>(),
	clearArea: vi.fn<(context: ToolContext) => boolean>(() => true),
	fillArea: vi.fn<(context: ToolContext) => boolean>(() => true),
	fillAreaWith: vi.fn<(context: ToolContext, spec: FillSpec) => boolean>(() => true),
	canFillArea: vi.fn<(context: ToolContext) => boolean>(() => true),
	layerViaArea: vi.fn<
		(context: ToolContext, how: 'copy' | 'cut') => Promise<string | undefined> | undefined
	>(() => Promise.resolve('layer-9')),
}));
vi.mock('../../src/drawing/tools/vector/index.js', () => ({
	vectorBehaviors: {},
	deleteSelection: behaviors.deleteSelection,
}));
vi.mock('../../src/drawing/tools/raster/index.js', () => ({
	rasterBehaviors: {},
	clearArea: behaviors.clearArea,
	fillArea: behaviors.fillArea,
	layerViaArea: behaviors.layerViaArea,
}));
vi.mock('../../src/drawing/tools/raster/areaFill.js', () => ({
	fillAreaWith: behaviors.fillAreaWith,
	canFillArea: behaviors.canFillArea,
}));

// The real context menu, with where it was last asked to open kept, since
// jsdom lays nothing out to read it back from.
const menus = vi.hoisted(() => ({ at: undefined as MenuPoint | undefined }));
vi.mock('../../src/components/ui/ContextMenu.js', async (importOriginal) => {
	const real = await importOriginal<typeof ContextMenuModule>();
	return {
		...real,
		ContextMenu: (props: ComponentProps<typeof real.ContextMenu>) => {
			menus.at = props.at;
			return <real.ContextMenu {...props} />;
		},
	};
});

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

/** A behavior that records every call, and draws a mark on the overlay when it begins. */
const recorder = (onBegin?: (context: ToolContext) => void) => {
	const calls: Call[] = [];
	const behavior: ToolBehavior = {
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
	return { calls, behavior, names };
};

const fakeTool = (id: ToolId, kinds: Tool['behaviors'], cursor = 'crosshair'): Tool => ({
	id,
	options: [],
	behaviors: kinds,
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
	const onColor = vi.fn<(which: 'fill' | 'stroke', value: string) => void>();
	const props: ViewportProps = {
		document: fake.document,
		tool,
		options: DEFAULT_TOOL_OPTIONS,
		layerId: 'layer-1',
		onColor,
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
		onColor,
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
	behaviors.deleteSelection.mockClear();
	behaviors.clearArea.mockClear();
	behaviors.fillArea.mockClear();
	behaviors.fillAreaWith.mockClear();
	behaviors.canFillArea.mockClear();
	behaviors.layerViaArea.mockClear();
	menus.at = undefined;
});

describe('the viewport', () => {
	it("mounts the document's own root on the stage, unchanged, and sizes the stage and the overlay to it", () => {
		const { behavior } = recorder();
		const fake = fakeDocument();
		const before = new XMLSerializer().serializeToString(fake.document.root);
		const { container, stage, overlay, unmount } = setup(
			fakeTool('pencil', { vector: behavior }),
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
		const { behavior, calls } = recorder();
		const fake = fakeDocument();
		const style = document.createElementNS(SVG_NS, 'style');
		style.textContent = 'body, .viewport { display: none; } svg { position: fixed; }';
		const shape = document.createElementNS(SVG_NS, 'rect');
		fake.document.root.append(style, shape);
		const { container } = setup(fakeTool('pencil', { vector: behavior }), {
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
		const { behavior } = recorder();
		const first = fakeDocument();
		const next = fakeDocument();
		const { container, rerender, props } = setup(fakeTool('pencil', { vector: behavior }), {
			document: first.document,
		});
		const shadow = container.querySelector('.viewport-mount')?.shadowRoot;
		rerender(<Viewport {...props} document={next.document} />);
		expect(first.document.root.parentNode).toBeNull();
		expect(next.document.root.parentNode).toBe(shadow);
	});

	it("keeps the viewBox's origin: the overlay shares it, and a sample is read through it", () => {
		const { behavior, calls } = recorder();
		const fake = fakeDocument();
		fake.document.root.setAttribute('viewBox', '-100 -50 1600 1000');
		const { region, stage, overlay } = setup(fakeTool('pencil', { vector: behavior }), {
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
		const { behavior } = recorder();
		const { onScale, stage, screen } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior } = recorder();
		const { onScale, ref } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior, calls, names } = recorder();
		const { region, ref } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior, calls, names } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior, calls } = recorder();
		const { region, onScale, ref, stage } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior } = recorder();
		const { region, stage, onScale } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior, names } = recorder();
		const smudge = fakeTool('smudge', { raster: behavior });
		const { region, onNotify } = setup(smudge);
		expect(region.style.cursor).toBe('not-allowed');
		click(region, 10, 20);
		expect(onNotify).toHaveBeenCalledWith(t('tools.notOnVector', { tool: t('tools.smudge') }));
		expect(names()).toEqual([]);
	});

	it('asks for a layer when none is active', () => {
		const { behavior, names } = recorder();
		const { region, onNotify } = setup(fakeTool('pencil', { vector: behavior }), {
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
		const { behavior, names } = recorder();
		const { region, stage } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behavior }));
		const input = document.createElement('input');
		document.body.appendChild(input);
		expect(keyDown(' ', input).defaultPrevented).toBe(false);
		expect(region.style.cursor).toBe('crosshair');
		input.remove();
	});

	it('leaves Space to a button the keyboard is on, and keeps it the hand on one a pointer just pressed', () => {
		const { behavior } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behavior }));
		const button = document.createElement('button');
		const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		button.append(icon);
		document.body.appendChild(button);
		// Reached by the keyboard: Space presses it, as a browser's button.
		act(() => {
			button.focus();
		});
		expect(keyDown(' ', button).defaultPrevented).toBe(false);
		expect(region.style.cursor).toBe('crosshair');
		// Pressed by a pointer, on its icon, which keeps the focus on it in Chrome: Space is the hand.
		fire(icon, new PointerEvent('pointerdown', { bubbles: true }));
		expect(keyDown(' ', button).defaultPrevented).toBe(true);
		expect(region.style.cursor).toBe('grab');
		keyUp(' ');
		// The focus gone elsewhere and back by the keyboard: the press is forgotten.
		const other = document.createElement('button');
		document.body.appendChild(other);
		act(() => {
			other.focus();
			button.focus();
		});
		expect(keyDown(' ', button).defaultPrevented).toBe(false);
		button.remove();
		other.remove();
	});

	it('abandons the stroke on Escape', () => {
		const { behavior, names } = recorder();
		const { region, overlay } = setup(fakeTool('pencil', { vector: behavior }));
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		expect(overlay.childElementCount).toBe(1);
		keyDown('Escape');
		expect(names()).toEqual(['begin', 'cancel']);
		expect(overlay.childElementCount).toBe(0);
		fire(region, pointer('pointerup', { clientX: 10, clientY: 20 }));
		expect(names()).toEqual(['begin', 'cancel']);
	});

	it('abandons a stroke whose pointer the browser took away, or that went down again without lifting', () => {
		const { behavior, names } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior, calls, names } = recorder();
		const { region, overlay, calls: asked } = setup(fakeTool('pencil', { vector: behavior }));

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
		const { behavior } = recorder();
		const { region, calls: asked } = setup(fakeTool('pencil', { vector: behavior }));
		fire(region, touch('pointerdown', 1, 100, 0));
		fire(region, touch('pointerdown', 2, 200, 10));
		fire(region, touch('pointerdown', 3, 300, 20));
		fire(region, touch('pointerup', 1, 100, 100));
		fire(region, touch('pointerup', 2, 200, 110));
		fire(region, touch('pointerup', 3, 300, 120));
		expect(asked).toEqual(['redo']);
	});

	it('pans with two fingers and zooms by a pinch', () => {
		const { behavior } = recorder();
		const { region, onScale, stage } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior, calls, names } = recorder();
		const { region } = setup(fakeTool('brush', { vector: behavior }));
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
			fakeTool('pencil', { vector: first.behavior })
		);
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		expect(overlay.childElementCount).toBe(1);

		rerender(<Viewport {...props} tool={fakeTool('brush', { vector: second.behavior })} />);
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
		const selectTool = fakeTool('select', { vector: select.behavior }, 'default');
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
			<Viewport {...props} tool={fakeTool('pencil', { vector: recorder().behavior })} />
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
		const { region, overlay } = setup(fakeTool('select', { vector: select.behavior }), {
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
		const { region } = setup(fakeTool('select', { vector: select.behavior }, 'default'));
		expect(keyDown('Delete').defaultPrevented).toBe(false);
		expect(behaviors.deleteSelection).not.toHaveBeenCalled();

		click(region, 10, 20);
		expect(keyDown('Backspace').defaultPrevented).toBe(true);
		expect(behaviors.deleteSelection).toHaveBeenCalledTimes(1);
		const context = behaviors.deleteSelection.mock.calls[0]?.[0];
		expect(context?.selection.elements).toEqual([mark]);
		expect(context?.layer?.id).toBe('layer-1');
	});

	it('hovers a mouse with nothing down, and never a finger', () => {
		const { behavior, names } = recorder();
		const { region } = setup(fakeTool('pencil', { vector: behavior }));
		fire(region, pointer('pointermove', { clientX: 10, clientY: 20, buttons: 0 }));
		fire(
			region,
			pointer('pointermove', { clientX: 10, clientY: 20, buttons: 0, pointerType: 'touch' })
		);
		expect(names()).toEqual(['hover']);
	});

	it('zooms in and out, fits and shows actual size from the handle', () => {
		const { behavior } = recorder();
		const { ref, onScale } = setup(fakeTool('pencil', { vector: behavior }));
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
		const { behavior, calls } = recorder();
		const { region, stage, onScale } = setup(fakeTool('select', { vector: behavior }));
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
		const { behavior } = marking();
		const { region, container, overlay, rerender, props } = setup(
			fakeTool('marquee', { vector: behavior })
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

		rerender(<Viewport {...props} tool={fakeTool('brush', { vector: recorder().behavior })} />);
		expect(overlay.childElementCount).toBe(0);
		expect(ants(container)).toHaveLength(2);
		rerender(<Viewport {...props} layerId="layer-2" />);
		expect(ants(container)).toHaveLength(2);
	});

	it('drops the area for another drawing', () => {
		const { behavior } = marking();
		const { region, container, rerender, props } = setup(
			fakeTool('marquee', { vector: behavior })
		);
		click(region, 10, 20);
		expect(ants(container)).toHaveLength(2);
		rerender(<Viewport {...props} document={fakeDocument().document} />);
		expect(ants(container)).toEqual([]);
	});

	it('selects the whole canvas with Ctrl or ⌘ A on a raster layer, and drops it with D', () => {
		const { container } = rasterSetup(fakeTool('brush', { raster: recorder().behavior }));
		expect(primaryDown('a').defaultPrevented).toBe(true);
		expect(ants(container)[0]?.getAttribute('d')).toBe(WHOLE);
		expect(primaryDown('d').defaultPrevented).toBe(true);
		expect(ants(container)).toEqual([]);
	});

	it('drops the area on Escape with no stroke under way, and only the stroke with one', () => {
		const { behavior, names } = recorder();
		const { region, container } = rasterSetup(fakeTool('brush', { raster: behavior }));
		primaryDown('a');
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		keyDown('Escape');
		expect(names()).toEqual(['begin', 'cancel']);
		expect(ants(container)).toHaveLength(2);
		keyDown('Escape');
		expect(ants(container)).toEqual([]);
	});

	it('leaves Ctrl or ⌘ A and Escape to a field, which selects its own text', () => {
		const { container } = rasterSetup(fakeTool('brush', { raster: recorder().behavior }));
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
		const { behavior, calls } = recorder();
		const { region, container, overlay } = setup(fakeTool('pencil', { vector: behavior }), {
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
		const { overlay } = setup(fakeTool('select', { vector: recorder().behavior }), {
			document: fake.document,
		});
		primaryDown('a');
		expect(overlay.querySelector('[data-draw-selection]')).not.toBeNull();
		expect(overlay.querySelector('[data-draw-region-outline]')).toBeNull();
		primaryDown('d');
		expect(overlay.childElementCount).toBe(0);
	});

	it('clears the area’s pixels on Delete on a raster layer, and not on a vector one', () => {
		const raster = rasterSetup(fakeTool('brush', { raster: recorder().behavior }));
		expect(keyDown('Delete').defaultPrevented).toBe(false);
		expect(behaviors.clearArea).not.toHaveBeenCalled();
		primaryDown('a');
		expect(keyDown('Delete').defaultPrevented).toBe(true);
		expect(behaviors.clearArea).toHaveBeenCalledTimes(1);
		const context = behaviors.clearArea.mock.calls[0]?.[0];
		expect(context?.region.path).toBe(WHOLE);
		expect(context?.layer?.kind).toBe('raster');
		raster.unmount();

		const { behavior } = marking();
		const { region } = setup(fakeTool('marquee', { vector: behavior }));
		click(region, 10, 20);
		expect(keyDown('Delete').defaultPrevented).toBe(false);
		expect(behaviors.clearArea).toHaveBeenCalledTimes(1);
	});

	it('keeps the element selection for the marquee and the lasso, which work on it', () => {
		const mark = document.createElementNS(SVG_NS, 'rect');
		const select = recorder((context) => {
			context.selection.set([mark]);
		});
		const { region, rerender, props } = setup(fakeTool('select', { vector: select.behavior }));
		click(region, 10, 20);
		const selected = () => select.calls[0]?.context?.selection.elements;
		rerender(
			<Viewport {...props} tool={fakeTool('marquee', { vector: recorder().behavior })} />
		);
		expect(selected()).toEqual([mark]);
		rerender(<Viewport {...props} tool={fakeTool('lasso', { vector: recorder().behavior })} />);
		expect(selected()).toEqual([mark]);
	});

	it('tells a tool it is put down once, after its stroke has ended as well as during one', () => {
		const first = recorder();
		const { region, rerender, props } = setup(fakeTool('text', { vector: first.behavior }));
		click(region, 10, 20);
		expect(first.names()).toEqual(['begin', 'end']);
		rerender(
			<Viewport {...props} tool={fakeTool('pencil', { vector: recorder().behavior })} />
		);
		expect(first.names()).toEqual(['begin', 'end', 'cancel']);
		rerender(<Viewport {...props} tool={fakeTool('brush', { vector: recorder().behavior })} />);
		expect(first.names()).toEqual(['begin', 'end', 'cancel']);
	});
});

describe('the context menu', () => {
	const AREA = 'M 10 10 L 50 10 L 50 30 L 10 30 Z';

	const marking = () =>
		recorder((context) => {
			context.region.set(AREA);
		});

	const rasterSetup = (tool: Tool, overrides: Partial<ViewportProps> = {}) =>
		setup(tool, { document: fakeDocument(['raster', 'vector']).document, ...overrides });

	/** A right-click, or a pen's barrel button: a `contextmenu` with a point of its own. */
	const rightClick = (target: EventTarget, clientX: number, clientY: number): Event => {
		fire(target, pointer('pointerdown', { clientX, clientY, button: 2, buttons: 2 }));
		return fire(
			target,
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX,
				clientY,
				button: 2,
			})
		);
	};

	/** The keyboard's Menu key, as a browser that sends a `PointerEvent` sends it. */
	const menuKey = (target: EventTarget): Event =>
		fire(
			target,
			new PointerEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				pointerId: -1,
				pointerType: '',
			})
		);

	const menu = () => screen.queryByRole('menu', { name: t('selection.menu') });

	/** The items' names, without the keys shown beside them. */
	const itemNames = () =>
		screen.getAllByRole('menuitem').map((item) => item.firstChild?.textContent);

	const choose = (name: string) => {
		act(() => {
			screen.getByRole('menuitem', { name }).click();
		});
	};

	/**
	 * The canvas placed on the page, without a size the view would be fitted
	 * to: a real `DOMRect`, whose sides are getters a spread would lose.
	 */
	const placedAt = (left: number, top: number, width: number, height: number) => {
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
			new DOMRect(left, top, width, height)
		);
	};

	it('opens at a right-click, keeps the browser’s own menu from the canvas, and draws nothing', () => {
		const { behavior, names } = recorder();
		const { region } = setup(fakeTool('brush', { vector: behavior }));
		const event = rightClick(region, 40, 30);
		expect(event.defaultPrevented).toBe(true);
		expect(names()).toEqual([]);
		expect(menus.at).toEqual({ x: 40, y: 30 });
		expect(menu()).not.toBeNull();
		expect(screen.getAllByRole('menuitem').map((item) => item.firstChild?.textContent)).toEqual(
			['Select all', 'Undo', 'Redo', 'New layer', 'Duplicate layer']
		);
	});

	it('does what the item chosen says, and closes', () => {
		const { container, region } = rasterSetup(
			fakeTool('brush', { raster: recorder().behavior })
		);
		rightClick(region, 40, 30);
		choose('Select all');
		expect(menu()).toBeNull();
		expect(container.querySelectorAll('.viewport-area path')).toHaveLength(2);
	});

	it('never opens while a stroke is under way, and still keeps the browser’s from it', () => {
		const { behavior, names } = recorder();
		const { region } = setup(fakeTool('brush', { vector: behavior }));
		fire(region, pointer('pointerdown', { clientX: 10, clientY: 20 }));
		const event = fire(
			region,
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
		);
		expect(event.defaultPrevented).toBe(true);
		expect(menu()).toBeNull();
		expect(names()).toEqual(['begin']);
	});

	it('opens for a finger held still, which the browser made a long press of, in place of its stroke', () => {
		const { behavior, names } = recorder();
		const { region } = setup(fakeTool('brush', { vector: behavior }));
		fire(region, touch('pointerdown', 1, 60));
		fire(
			region,
			new PointerEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				pointerId: 1,
				pointerType: 'touch',
				clientX: 60,
				clientY: 100,
			})
		);
		expect(names()).toEqual(['begin', 'cancel']);
		expect(menus.at).toEqual({ x: 60, y: 100 });
	});

	it('draws nothing with the press that closes it', () => {
		const { behavior, names } = recorder();
		const { region } = setup(fakeTool('brush', { vector: behavior }));
		rightClick(region, 40, 30);
		expect(menu()).not.toBeNull();
		click(region, 10, 20);
		expect(menu()).toBeNull();
		expect(names()).toEqual([]);
		click(region, 10, 20);
		expect(names()).toEqual(['begin', 'end']);
	});

	it('opens from the keyboard at the middle of the canvas, or of the area, kept inside the canvas', () => {
		placedAt(100, 50, 800, 600);
		const { behavior } = marking();
		const { region } = rasterSetup(fakeTool('marquee', { raster: behavior }));
		menuKey(region);
		expect(menus.at).toEqual({ x: 500, y: 350 });
		act(() => {
			screen
				.getByRole('menu')
				.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		expect(menu()).toBeNull();

		// The area is 10 to 50 across and 10 to 30 down; the view is the identity.
		click(region, 110, 60);
		menuKey(region);
		expect(menus.at).toEqual({ x: 130, y: 70 });
		expect(itemNames()[0]).toBe('Deselect');
	});

	it('reads a plain mouse event after the Menu key or Shift+F10 as the keyboard’s, and after a press as the pointer’s', () => {
		placedAt(0, 0, 800, 600);
		const { region } = setup(fakeTool('brush', { vector: recorder().behavior }));
		const plain = () =>
			fire(region, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		keyDown('ContextMenu', region);
		plain();
		expect(menus.at).toEqual({ x: 400, y: 300 });
		act(() => {
			window.dispatchEvent(new Event('blur'));
		});
		fire(region, new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		plain();
		expect(menus.at).toEqual({ x: 400, y: 300 });
		act(() => {
			window.dispatchEvent(new Event('blur'));
		});
		rightClick(region, 0, 0);
		expect(menus.at).toEqual({ x: 0, y: 0 });
	});

	it('opens on Shift+F10 itself, as a Mac makes no menu event of it, and spends the key', () => {
		placedAt(0, 0, 800, 600);
		const { region } = setup(fakeTool('brush', { vector: recorder().behavior }));
		const shiftF10 = (extra: KeyboardEventInit = {}) => {
			const event = new KeyboardEvent('keydown', {
				key: 'F10',
				shiftKey: true,
				bubbles: true,
				cancelable: true,
				...extra,
			});
			fire(region, event);
			return event;
		};
		expect(shiftF10({ ctrlKey: true }).defaultPrevented).toBe(false);
		expect(menu()).toBeNull();
		expect(shiftF10().defaultPrevented).toBe(true);
		expect(menus.at).toEqual({ x: 400, y: 300 });
		expect(menu()).not.toBeNull();
	});

	it('with an area: inverts it, modifies it through the frame, and crops the canvas to it', () => {
		const { behavior, calls } = marking();
		const onModify = vi.fn();
		const fake = fakeDocument(['raster', 'vector']);
		const { region } = setup(fakeTool('marquee', { raster: behavior }), {
			document: fake.document,
			onModify,
		});
		click(region, 10, 20);
		const area = () => calls[0]?.context?.region.region;
		rightClick(region, 40, 30);
		expect(itemNames()).toEqual([
			'Deselect',
			'Select inverse',
			'Modify…',
			'Transform selection',
			'Layer via copy',
			'Layer via cut',
			'Fill…',
			'Clear',
			'Crop to selection',
		]);
		choose('Select inverse');
		expect(area()?.inverted).toBe(true);
		rightClick(region, 40, 30);
		expect(
			screen
				.getByRole('menuitem', { name: 'Crop to selection' })
				.getAttribute('aria-disabled')
		).toBe('true');
		choose('Select inverse');
		rightClick(region, 40, 30);
		choose('Modify…');
		expect(onModify).toHaveBeenCalledExactlyOnceWith(undefined);
		rightClick(region, 40, 30);
		choose('Crop to selection');
		expect(fake.calls).toEqual(['execute']);
		expect(area()?.path).toBe(AREA);
	});

	it('drops the area when it inverts an inverse with no outline, which is the whole canvas', () => {
		const selection = createViewportSelection();
		const fake = fakeDocument(['raster', 'vector']);
		const { region } = setup(fakeTool('marquee', { raster: marking().behavior }), {
			document: fake.document,
			selection,
		});
		act(() => {
			selection.region.set({ path: '', inverted: true, feather: 0 });
		});
		rightClick(region, 40, 30);
		choose('Select inverse');
		expect(selection.region.get()).toBeUndefined();
	});

	it('shows the pixels’ actions disabled on a vector layer', () => {
		const { behavior } = marking();
		const { region } = setup(fakeTool('marquee', { vector: behavior }));
		click(region, 10, 20);
		rightClick(region, 40, 30);
		const disabled = screen
			.getAllByRole('menuitem')
			.filter((item) => item.getAttribute('aria-disabled') === 'true')
			.map((item) => item.firstChild?.textContent);
		expect(disabled).toEqual(['Layer via copy', 'Layer via cut', 'Fill…', 'Clear']);
	});
});

describe('the selection’s keys', () => {
	const AREA = 'M 10 10 L 50 10 L 50 30 L 10 30 Z';

	const primaryShiftDown = (key: string): Event =>
		fire(
			window,
			new KeyboardEvent('keydown', {
				key,
				ctrlKey: true,
				metaKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			})
		);

	/** A raster layer with `AREA` selected on it by a click. */
	const withArea = (overrides: Partial<ViewportProps> = {}) => {
		const marking = recorder((context) => {
			context.region.set(AREA);
		});
		const fake = fakeDocument(['raster', 'vector']);
		const utils = setup(fakeTool('marquee', { raster: marking.behavior }), {
			document: fake.document,
			...overrides,
		});
		click(utils.region, 10, 20);
		return {
			...utils,
			calls: fake.calls,
			area: () => marking.calls[0]?.context?.region.region,
		};
	};

	it('inverts the area with Ctrl or ⌘ Shift I, and opens Modify… at Feather with Shift F6', () => {
		const onModify = vi.fn();
		const { area } = withArea({ onModify });
		expect(primaryShiftDown('I').defaultPrevented).toBe(true);
		expect(area()?.inverted).toBe(true);
		const feather = fire(
			window,
			new KeyboardEvent('keydown', { key: 'F6', shiftKey: true, cancelable: true })
		);
		expect(feather.defaultPrevented).toBe(true);
		expect(onModify).toHaveBeenCalledExactlyOnceWith('feather');
	});

	it('leaves Shift F6 and Ctrl or ⌘ Shift I to the browser with nothing selected', () => {
		const onModify = vi.fn();
		setup(fakeTool('brush', { vector: recorder().behavior }), { onModify });
		expect(primaryShiftDown('I').defaultPrevented).toBe(false);
		const feather = fire(
			window,
			new KeyboardEvent('keydown', { key: 'F6', shiftKey: true, cancelable: true })
		);
		expect(feather.defaultPrevented).toBe(false);
		expect(onModify).not.toHaveBeenCalled();
	});

	it('fills the area with Alt Backspace', () => {
		withArea();
		const event = fire(
			window,
			new KeyboardEvent('keydown', { key: 'Backspace', altKey: true, cancelable: true })
		);
		expect(event.defaultPrevented).toBe(true);
		expect(behaviors.fillArea).toHaveBeenCalledTimes(1);
		expect(behaviors.fillArea.mock.calls[0]?.[0].region.path).toBe(AREA);
	});

	it('fills with the stroke color at once through the handle, in normal at full opacity', () => {
		const { ref } = withArea();
		let done: boolean | undefined;
		act(() => {
			done = ref.current?.perform('fillWithStroke');
		});
		expect(done).toBe(true);
		expect(behaviors.fillAreaWith).toHaveBeenCalledTimes(1);
		const [context, spec] = behaviors.fillAreaWith.mock.calls[0] ?? [];
		expect(context?.region.path).toBe(AREA);
		expect(spec).toEqual({
			contents: 'stroke',
			mode: 'normal',
			opacity: 1,
			preserveTransparency: false,
		});
		expect(behaviors.fillArea).not.toHaveBeenCalled();
	});

	it('opens Fill… with Shift F5 or Shift Backspace, where the layer may be filled', () => {
		const onFill = vi.fn();
		withArea({ onFill });
		const shiftDown = (key: string) =>
			fire(window, new KeyboardEvent('keydown', { key, shiftKey: true, cancelable: true }));
		expect(shiftDown('F5').defaultPrevented).toBe(true);
		expect(shiftDown('Backspace').defaultPrevented).toBe(true);
		expect(onFill).toHaveBeenCalledTimes(2);
		// A locked or a hidden layer says so (`canFillArea`), and the dialog stays shut.
		behaviors.canFillArea.mockReturnValueOnce(false);
		expect(shiftDown('F5').defaultPrevented).toBe(true);
		expect(onFill).toHaveBeenCalledTimes(2);
		expect(behaviors.fillAreaWith).not.toHaveBeenCalled();
	});

	it('leaves Shift F5 to the browser with nothing selected', () => {
		const onFill = vi.fn();
		setup(fakeTool('brush', { vector: recorder().behavior }), { onFill });
		const event = fire(
			window,
			new KeyboardEvent('keydown', { key: 'F5', shiftKey: true, cancelable: true })
		);
		expect(event.defaultPrevented).toBe(false);
		expect(onFill).not.toHaveBeenCalled();
	});

	it('fills the area with the stroke color with Ctrl or ⌘ Backspace', () => {
		withArea();
		expect(primaryDown('Backspace').defaultPrevented).toBe(true);
		expect(behaviors.fillAreaWith).toHaveBeenCalledTimes(1);
		expect(behaviors.fillAreaWith.mock.calls[0]?.[1]).toMatchObject({ contents: 'stroke' });
		expect(behaviors.fillArea).not.toHaveBeenCalled();
	});

	it('fills as Fill…’s dialog says through the handle', () => {
		const { ref } = withArea();
		const spec: FillSpec = {
			contents: 'contentAware',
			mode: 'multiply',
			opacity: 0.5,
			preserveTransparency: true,
		};
		let done: boolean | undefined;
		act(() => {
			done = ref.current?.fillArea(spec);
		});
		expect(done).toBe(true);
		expect(behaviors.fillAreaWith).toHaveBeenCalledWith(expect.anything(), spec);
	});

	it('leaves Fill… alone where there is no frame to open its dialog', () => {
		const { ref } = withArea();
		let done: boolean | undefined;
		act(() => {
			done = ref.current?.perform('fillDialog');
		});
		expect(done).toBe(false);
		expect(behaviors.fillAreaWith).not.toHaveBeenCalled();
		expect(behaviors.fillArea).not.toHaveBeenCalled();
	});

	it('says Fill… needs a raster layer, for an area on a vector one', () => {
		const marking = recorder((context) => {
			context.region.set(AREA);
		});
		const { region, onNotify, ref } = setup(fakeTool('marquee', { vector: marking.behavior }));
		click(region, 10, 20);
		act(() => {
			ref.current?.perform('fillDialog');
		});
		expect(onNotify).toHaveBeenCalledWith(
			t('selection.rasterOnly', { action: t('selection.actions.fillDialog') })
		);
		expect(behaviors.canFillArea).not.toHaveBeenCalled();
	});

	it('makes a layer via copy with Ctrl or ⌘ J, drops the area and activates the layer once it is made', async () => {
		const onActivateLayer = vi.fn();
		const { area } = withArea({ onActivateLayer });
		expect(primaryDown('j').defaultPrevented).toBe(true);
		expect(behaviors.layerViaArea).toHaveBeenCalledWith(expect.anything(), 'copy');
		await act(() => Promise.resolve());
		expect(onActivateLayer).toHaveBeenCalledWith('layer-9');
		expect(area()).toBeUndefined();
	});

	it('cuts with Ctrl or ⌘ Shift J, and keeps the area when nothing was made, adding no word to the tool’s', async () => {
		behaviors.layerViaArea.mockReturnValueOnce(Promise.resolve(undefined));
		const onActivateLayer = vi.fn();
		const { area, onNotify } = withArea({ onActivateLayer });
		primaryShiftDown('J');
		expect(behaviors.layerViaArea).toHaveBeenCalledWith(expect.anything(), 'cut');
		await act(() => Promise.resolve());
		// `layerViaArea` says why itself; the viewport says nothing more.
		expect(onNotify).not.toHaveBeenCalled();
		expect(onActivateLayer).not.toHaveBeenCalled();
		expect(area()?.path).toBe(AREA);
	});

	it('duplicates the layer with Ctrl or ⌘ J while nothing is selected, as Photoshop does', () => {
		const onActivateLayer = vi.fn();
		const { calls } = setup(fakeTool('brush', { vector: recorder().behavior }), {
			onActivateLayer,
		});
		expect(primaryDown('j').defaultPrevented).toBe(true);
		expect(calls).toEqual(['execute']);
		expect(onActivateLayer).toHaveBeenCalledWith('layer-2');
		expect(behaviors.layerViaArea).not.toHaveBeenCalled();
	});

	it('says layer via copy needs a raster layer, for an area on a vector one', () => {
		const marking = recorder((context) => {
			context.region.set(AREA);
		});
		const { region, onNotify, calls } = setup(
			fakeTool('marquee', { vector: marking.behavior })
		);
		click(region, 10, 20);
		primaryDown('j');
		expect(onNotify).toHaveBeenCalledWith(
			t('selection.rasterOnly', { action: t('selection.actions.layerViaCopy') })
		);
		expect(calls).toEqual([]);
	});

	it('does the same through the handle, for the frame’s selection bar', () => {
		const { ref, area } = withArea();
		let done: boolean | undefined;
		act(() => {
			done = ref.current?.perform('deselect');
		});
		expect(done).toBe(true);
		expect(area()).toBeUndefined();
	});
});

describe('a tool asking for another, and the options changing', () => {
	type Told = Readonly<{ name: string; context: ToolContext; handover?: Handover }>;

	/** A behavior that records being put down, handed an element and told of options. */
	const listener = () => {
		const told: Told[] = [];
		const behavior: ToolBehavior = {
			begin: () => undefined,
			move: () => undefined,
			end: () => undefined,
			cancel: (context) => {
				told.push({ name: 'cancel', context });
			},
			edit: (context, handover) => {
				told.push({ name: 'edit', context, handover });
			},
			optionsChanged: (context) => {
				told.push({ name: 'optionsChanged', context });
			},
		};
		return { told, behavior, names: () => told.map((each) => each.name) };
	};

	/** A tool that, as its press lifts, asks for `id` with `handover`, as the select tool's double press does. */
	const asking = (id: ToolId, handover: Handover | undefined, order: string[]) =>
		fakeTool('select', {
			vector: {
				begin: () => undefined,
				move: () => undefined,
				end: (context) => {
					context.useTool?.(id, handover);
				},
				cancel: () => {
					order.push('select put down');
				},
			},
		});

	const handoverFor = (fake: FakeDocument): Handover => ({
		element: fake.document.root,
		at: { x: 5, y: 6 },
	});

	it('asks the frame for the tool, and once it is in hand, the last put down, hands it the element', () => {
		const order: string[] = [];
		const onTool = vi.fn<(id: ToolId) => void>();
		const text = listener();
		const textTool = fakeTool('text', { vector: text.behavior });
		const fake = fakeDocument();
		const handover = handoverFor(fake);
		const { region, rerender, props } = setup(asking('text', handover, order), {
			document: fake.document,
			onTool,
		});
		click(region, 10, 10);
		expect(onTool).toHaveBeenCalledExactlyOnceWith('text');
		expect(text.names()).toEqual([]);
		onTool.mockImplementation(() => order.push('asked'));
		rerender(<Viewport {...props} tool={textTool} />);
		expect(order).toEqual(['select put down']);
		expect(text.names()).toEqual(['edit']);
		expect(text.told[0]?.handover).toBe(handover);
		expect(text.told[0]?.context.layer?.id).toBe('layer-1');
		expect(text.told[0]?.context.options).toBe(props.options);
		// The tool so handed is told when it is put down in turn, as after a stroke.
		rerender(
			<Viewport {...props} tool={fakeTool('pencil', { vector: listener().behavior })} />
		);
		expect(text.names()).toEqual(['edit', 'cancel']);
	});

	it('hands the element at once to the tool already in hand, and asks the frame nothing', () => {
		const onTool = vi.fn<(id: ToolId) => void>();
		const fake = fakeDocument();
		const handover = handoverFor(fake);
		const own = listener();
		const tool = fakeTool('text', {
			vector: {
				...own.behavior,
				end: (context) => {
					context.useTool?.('text', handover);
				},
			},
		});
		const { region } = setup(tool, { document: fake.document, onTool });
		click(region, 10, 10);
		expect(onTool).not.toHaveBeenCalled();
		expect(own.names()).toEqual(['edit']);
		expect(own.told[0]?.handover).toBe(handover);
	});

	it('gives a tool no way to ask for another without a frame to ask', () => {
		const { calls, behavior } = recorder();
		const { region } = setup(fakeTool('select', { vector: behavior }));
		click(region, 10, 10);
		expect(calls[0]?.context?.useTool).toBeUndefined();
	});

	it('drops a tool asked for that the frame did not put in hand before the next press', () => {
		const text = listener();
		const fake = fakeDocument();
		const { region, rerender, props } = setup(asking('text', handoverFor(fake), []), {
			document: fake.document,
			onTool: vi.fn(),
		});
		click(region, 10, 10);
		fire(region, pointer('pointerdown', { clientX: 20, clientY: 20 }));
		rerender(<Viewport {...props} tool={fakeTool('text', { vector: text.behavior })} />);
		expect(text.names()).toEqual([]);
	});

	it('tells the tool in hand of new options, with a context that has them', () => {
		const text = listener();
		const { rerender, props } = setup(fakeTool('text', { vector: text.behavior }));
		rerender(<Viewport {...props} />);
		expect(text.names()).toEqual([]);
		const options = { ...DEFAULT_TOOL_OPTIONS, fontSize: 72 };
		rerender(<Viewport {...props} options={options} />);
		expect(text.names()).toEqual(['optionsChanged']);
		expect(text.told[0]?.context.options).toBe(options);
	});
});

describe('the brush’s outline over the canvas', () => {
	/** A tool with a size, whose pointer is the brush's outline, around a behavior that records what it is told. */
	const sizeTool = (kind: LayerKind = 'vector') => {
		const recorded = recorder();
		const leaves: ToolContext[] = [];
		const behavior = withBrushOutline({
			...recorded.behavior,
			leave: (context) => {
				leaves.push(context);
			},
		});
		return { tool: fakeTool('brush', { [kind]: behavior }), leaves };
	};

	const outlineIn = (overlay: SVGSVGElement) => overlay.querySelector('[data-brush-outline]');

	const leave = (region: HTMLElement) => {
		act(() => {
			fireEvent.pointerLeave(region);
		});
	};

	it('follows a hovering mouse, the size across, and goes when the pointer leaves the canvas', () => {
		const { tool, leaves } = sizeTool();
		const { region, overlay } = setup(tool, { options: { ...DEFAULT_TOOL_OPTIONS, size: 20 } });
		fire(region, pointer('pointermove', { clientX: 30, clientY: 40, buttons: 0 }));
		const circle = outlineIn(overlay)?.querySelector('circle');
		expect([circle?.getAttribute('cx'), circle?.getAttribute('cy')]).toEqual(['30', '40']);
		expect(circle?.getAttribute('r')).toBe('10');
		leave(region);
		expect(outlineIn(overlay)).toBeNull();
		expect(leaves).toHaveLength(1);
	});

	it('is not told the pointer left while a stroke holds it', () => {
		const { tool, leaves } = sizeTool();
		const { region, overlay } = setup(tool);
		fire(region, pointer('pointerdown', { clientX: 30, clientY: 40 }));
		leave(region);
		expect(leaves).toEqual([]);
		expect(outlineIn(overlay)).not.toBeNull();
	});

	it('goes when the tool is put down', () => {
		const { tool } = sizeTool();
		const { region, overlay, rerender, props } = setup(tool);
		fire(region, pointer('pointermove', { clientX: 30, clientY: 40, buttons: 0 }));
		expect(outlineIn(overlay)).not.toBeNull();
		rerender(
			<Viewport {...props} tool={fakeTool('marquee', { vector: recorder().behavior })} />
		);
		expect(outlineIn(overlay)).toBeNull();
	});

	it('marks the cursor the tool’s own, which it is not under Space’s hand or on a layer the tool does nothing on', () => {
		const { region, rerender, props } = setup(sizeTool().tool);
		expect(region.hasAttribute('data-tool-cursor')).toBe(true);
		keyDown(' ');
		expect(region.hasAttribute('data-tool-cursor')).toBe(false);
		keyUp(' ');
		expect(region.hasAttribute('data-tool-cursor')).toBe(true);
		// The active layer is a vector one, and this brush works on a raster one alone.
		rerender(<Viewport {...props} tool={sizeTool('raster').tool} />);
		expect(region.style.cursor).toBe('not-allowed');
		expect(region.hasAttribute('data-tool-cursor')).toBe(false);
	});
});
