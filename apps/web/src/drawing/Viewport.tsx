import type { DrawingSize } from '@skysa/draw-core';
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useEffectEvent,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';

import { t } from '../i18n/t.js';
import type { EditorDocument } from './document/model.js';
import { editActionFor, isHandKey } from './keys.js';
import { handBehaviour } from './tools/common/hand.js';
import { behaviourFor, notAvailableMessage } from './tools/index.js';
import type { ToolBehaviour, ToolContext } from './tools/types.js';
import { deleteSelection } from './tools/vector/index.js';
import type { ViewportHandle, ViewportProps } from './types.js';
import { createToolContext, NO_SELECTION } from './viewport/context.js';
import {
	type GestureEffect,
	type GestureEvent,
	gestureReducer,
	type GestureState,
	INITIAL_GESTURE,
} from './viewport/gestures.js';
import { observable } from './viewport/observable.js';
import { isMac, pointerTypeOf, sampleFrom } from './viewport/pointer.js';
import {
	actualSizeView,
	fitView,
	IDENTITY_VIEW,
	panBy,
	parseViewBox,
	stageTransform,
	toUser,
	type ViewBox,
	ZOOM_STEP,
	zoomAbout,
} from './viewport/transform.js';

/**
 * The viewport (docs/ARCHITECTURE.md §7, "The editor" and "Input"): the
 * drawing's live root on a stage the view moves and scales, an overlay over it
 * in the same user units for a tool's previews, and a canvas over the whole in
 * device pixels for a live raster stroke. Pointer Events alone come in; they
 * go out as samples in user units to the active tool's behaviour for the
 * active layer's kind, or to the gesture reducer when they are fingers
 * navigating. The document is mounted, never copied and never changed by
 * being shown. The selection is the viewport's, and so is the key that
 * deletes it; the frame has the other keys (`keys.ts`).
 */

/** How many screen pixels of wheel multiply the scale by e, with Ctrl or ⌘ held. */
const WHEEL_ZOOM = 0.002;
/** A wheel that counts in lines, as Firefox's does, is taken at this many pixels a line. */
const LINE_PX = 16;

const MAC = isMac();

type Stroke = Readonly<{ pointerId: number; behaviour: ToolBehaviour; context: ToolContext }>;

/** The document and the user units the view was last fitted to, at a size it could measure. */
type Fitted = Readonly<{ document: EditorDocument; box: ViewBox }>;

/** A wheel's delta in pixels, whichever unit the browser gave it in. */
const wheelPixels = (delta: number, mode: number): number =>
	mode === WheelEvent.DOM_DELTA_LINE ? delta * LINE_PX : delta;

/** Before layout, and always in a test, the viewport measures nothing: there is nothing to fit in. */
const measurable = (size: DrawingSize): boolean => size.width > 0 && size.height > 0;

/** The event as the gesture reducer reads it: where on the screen, and which kind of pointer. */
const gestureEvent = (type: GestureEvent['type'], event: PointerEvent): GestureEvent => ({
	type,
	id: event.pointerId,
	x: event.clientX,
	y: event.clientY,
	time: event.timeStamp,
	pointerType: pointerTypeOf(event.pointerType),
});

/**
 * The samples a move carries: the coalesced ones where the browser bundles a
 * fast stroke's into one event (docs/ARCHITECTURE.md §7, "Tools"), else the
 * event itself. A browser without the method, and a synthetic event, which
 * has an empty list, both fall back to the event.
 */
const samplesOf = (event: PointerEvent): readonly PointerEvent[] => {
	const bundled = (event as Partial<Pick<PointerEvent, 'getCoalescedEvents'>>).getCoalescedEvents;
	const coalesced = bundled === undefined ? [] : event.getCoalescedEvents();
	return coalesced.length > 0 ? coalesced : [event];
};

/**
 * The pointer stays this element's until it lifts, so a stroke that leaves the
 * viewport still ends. Where the browser has it: jsdom has not, and a stroke
 * is not worth a throw.
 */
const capture = (element: Element, pointerId: number): void => {
	(element as Partial<Pick<Element, 'setPointerCapture'>>).setPointerCapture?.(pointerId);
};

/**
 * The shadow root's own rules: the host fills the stage, and the drawing's
 * root fills the host, its own `width` and `height` attributes being
 * presentation, which these win over. The root alone, `:host > svg`: an `<svg>`
 * nested in the drawing keeps the size it gives itself. Never set on the root
 * itself: the document is not changed by being looked at (CLAUDE.md).
 */
const SHADOW_RULES =
	':host { display: block; width: 100%; height: 100%; } :host > svg { display: block; width: 100%; height: 100%; }';

/**
 * The rules, as one sheet every viewport's shadow adopts where the browser
 * has constructed stylesheets, and as a `<style>` of its own where it has not
 * (jsdom, which has no `adoptedStyleSheets`).
 */
const shadowSheet = (): CSSStyleSheet | undefined => {
	if (typeof CSSStyleSheet !== 'function' || !('replaceSync' in CSSStyleSheet.prototype)) {
		return undefined;
	}
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(SHADOW_RULES);
	return sheet;
};

const SHEET = shadowSheet();

/**
 * Where the drawing's root goes: a shadow root on the mount, made once, so the
 * drawing's own `<style>`, which the sanitizer keeps (docs/ARCHITECTURE.md
 * §9), applies to the drawing and to nothing of the app's — an inline SVG's
 * stylesheet is otherwise the whole page's, and could restyle the app or lay
 * a `position: fixed` element over it. Pointer events still reach the
 * viewport's handlers: they bubble out of the shadow, retargeted to the host.
 */
const shadowOf = (host: HTMLElement): ShadowRoot => {
	if (host.shadowRoot !== null) return host.shadowRoot;
	const shadow = host.attachShadow({ mode: 'open' });
	if (SHEET !== undefined && 'adoptedStyleSheets' in shadow) {
		shadow.adoptedStyleSheets = [SHEET];
		return shadow;
	}
	const style = host.ownerDocument.createElement('style');
	style.textContent = SHADOW_RULES;
	shadow.appendChild(style);
	return shadow;
};

/** Whether this pointer going down starts a stroke, rather than a gesture or nothing. */
const startsStroke = (event: PointerEvent, gesture: GestureState): boolean =>
	event.button === 0 && (event.pointerType !== 'touch' || gesture.mode === 'stroke');

export const Viewport = ({
	document,
	tool,
	options,
	layerId,
	onColour,
	onNotify,
	onScale,
	ref,
}: ViewportProps) => {
	const region = useRef<HTMLDivElement>(null);
	const mount = useRef<HTMLDivElement>(null);
	const overlay = useRef<SVGSVGElement>(null);
	const screen = useRef<HTMLCanvasElement>(null);
	const stroke = useRef<Stroke | undefined>(undefined);
	const gesture = useRef<GestureState>(INITIAL_GESTURE);
	const fitted = useRef<Fitted | undefined>(undefined);
	const [views] = useState(() => observable(IDENTITY_VIEW));
	const [selections] = useState(() => observable(NO_SELECTION));
	const [regions] = useState(() => observable<string | undefined>(undefined));
	const [spaceHeld, setSpaceHeld] = useState(false);
	const view = useSyncExternalStore(views.subscribe, views.get);
	const snapshot = useSyncExternalStore(document.subscribe, document.snapshot);

	// The drawing's user units: the root's `viewBox`, whose origin need not be
	// 0, or the size the document read where there is none.
	const viewBoxAttribute = document.root.getAttribute('viewBox');
	const { width, height } = snapshot.size;
	const box = useMemo<ViewBox>(
		() => parseViewBox(viewBoxAttribute) ?? { x: 0, y: 0, width, height },
		[viewBoxAttribute, width, height]
	);

	// Before layout, and always in a test, this is 0 × 0: the view functions
	// give the identity for that.
	const measure = useCallback(
		(): DrawingSize => ({
			width: region.current?.clientWidth ?? 0,
			height: region.current?.clientHeight ?? 0,
		}),
		[]
	);
	const fit = useCallback(() => {
		views.set(panBy(fitView(box, measure()), -box.x, -box.y));
	}, [box, measure, views]);
	const actualSize = useCallback(() => {
		views.set(panBy(actualSizeView(box, measure()), -box.x, -box.y));
	}, [box, measure, views]);
	const zoomStep = useCallback(
		(factor: number) => {
			const size = measure();
			const current = views.get();
			const [x, y] = toUser(current, size.width / 2, size.height / 2);
			views.set(zoomAbout(current, factor, x, y));
		},
		[measure, views]
	);
	const zoomIn = useCallback(() => zoomStep(ZOOM_STEP), [zoomStep]);
	const zoomOut = useCallback(() => zoomStep(1 / ZOOM_STEP), [zoomStep]);

	useImperativeHandle(
		ref,
		(): ViewportHandle => ({ fit, actualSize, zoomIn, zoomOut, scale: view.scale }),
		[fit, actualSize, zoomIn, zoomOut, view.scale]
	);

	const cancelStroke = useCallback(() => {
		const current = stroke.current;
		if (current === undefined) return;
		stroke.current = undefined;
		current.behaviour.cancel(current.context);
		overlay.current?.replaceChildren();
	}, []);

	/** The overlay emptied of a tool's handles, unless a stroke is drawing its preview there. */
	const clearOverlay = useCallback(() => {
		if (stroke.current === undefined) overlay.current?.replaceChildren();
	}, []);

	// The root goes into the page, inside the mount's shadow, and comes out
	// when the document or the viewport does. Appended, not copied: it is the
	// document's live element.
	useEffect(() => {
		const host = mount.current;
		if (host === null) return undefined;
		shadowOf(host).appendChild(document.root);
		return () => {
			document.root.remove();
		};
	}, [document]);

	// Fitted to the window for each document and each change of its user
	// units, as soon as the viewport measures something: now, or at the first
	// size the resize observer reports, if layout had not given it one yet.
	const fitOnce = useEffectEvent(() => {
		const done = fitted.current;
		if (done?.document === document && done.box === box) return;
		fit();
		if (measurable(measure())) fitted.current = { document, box };
	});
	useEffect(() => {
		fitOnce();
	}, [document, box]);

	useEffect(() => {
		onScale?.(view.scale);
	}, [onScale, view.scale]);

	// A tool put down leaves nothing behind: not a stroke, not a preview, and
	// not a selection unless the new tool is the one that works on it.
	const toolId = tool.id;
	useEffect(() => {
		cancelStroke();
		overlay.current?.replaceChildren();
		if (toolId !== 'select') selections.set(NO_SELECTION);
	}, [toolId, cancelStroke, selections]);

	// What is selected is on the active layer, and a key that deletes it acts
	// on that layer: another layer made active lets go of it.
	useEffect(() => {
		selections.set(NO_SELECTION);
		clearOverlay();
	}, [layerId, selections, clearOverlay]);

	// An undo puts a layer's markup back, which replaces its elements: one that
	// left the drawing is no longer selected, and its box goes with it.
	useEffect(() => {
		const selected = selections.get();
		const kept = selected.filter((element) => document.root.contains(element));
		if (kept.length === selected.length) return;
		selections.set(kept.length === 0 ? NO_SELECTION : kept);
		clearOverlay();
	}, [document, snapshot, selections, clearOverlay]);

	// The screen canvas in device pixels, as big as the viewport; set only
	// when the size changed, since setting a canvas's size clears it.
	useEffect(() => {
		const element = region.current;
		const canvas = screen.current;
		if (element === null || canvas === null) return undefined;
		const resize = () => {
			const ratio = window.devicePixelRatio;
			const nextWidth = Math.round(element.clientWidth * ratio);
			const nextHeight = Math.round(element.clientHeight * ratio);
			if (canvas.width !== nextWidth) canvas.width = nextWidth;
			if (canvas.height !== nextHeight) canvas.height = nextHeight;
			fitOnce();
		};
		resize();
		if (typeof ResizeObserver !== 'function') return undefined;
		const observer = new ResizeObserver(resize);
		observer.observe(element);
		return () => {
			observer.disconnect();
		};
	}, []);

	// A wheel scrolls the drawing and, with Ctrl or ⌘, zooms it about the
	// cursor. By hand rather than React's `onWheel`, which is passive on the
	// root and so cannot keep the page from scrolling too.
	useEffect(() => {
		const element = region.current;
		if (element === null) return undefined;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const current = views.get();
			const dx = wheelPixels(event.deltaX, event.deltaMode);
			const dy = wheelPixels(event.deltaY, event.deltaMode);
			if (event.ctrlKey || event.metaKey) {
				const rect = element.getBoundingClientRect();
				const [x, y] = toUser(current, event.clientX - rect.left, event.clientY - rect.top);
				views.set(zoomAbout(current, Math.exp(-dy * WHEEL_ZOOM), x, y));
				return;
			}
			views.set(panBy(current, -dx / current.scale, -dy / current.scale));
		};
		element.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			element.removeEventListener('wheel', onWheel);
		};
	}, [views]);

	const corner = (): Readonly<{ left: number; top: number }> => {
		const rect = region.current?.getBoundingClientRect();
		return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
	};

	const sample = (event: PointerEvent) => sampleFrom(event, views.get(), corner(), MAC);

	const activeLayer = () => snapshot.layers.find((layer) => layer.id === layerId);

	const toolContext = (): ToolContext | undefined => {
		if (overlay.current === null || screen.current === null || region.current === null) {
			return undefined;
		}
		return createToolContext({
			document,
			layer: activeLayer(),
			options,
			overlay: overlay.current,
			canvas: screen.current,
			pixelRatio: () => window.devicePixelRatio,
			view: views,
			selection: selections,
			region: regions,
			host: region.current,
			fit,
			actualSize,
			setColour: onColour,
			notify: onNotify,
		});
	};

	/** Delete, with something selected on a vector layer and no stroke under way: whether it did. */
	const deleteSelected = (): boolean => {
		if (selections.get().length === 0 || stroke.current !== undefined) return false;
		if (activeLayer()?.kind !== 'vector') return false;
		const context = toolContext();
		if (context === undefined) return false;
		deleteSelection(context);
		return true;
	};

	// Escape abandons the stroke under way; the frame has Escape too, for what
	// it has open. Delete removes the selection, which the frame cannot see.
	// Space held makes the next stroke the hand's.
	const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
		const action = editActionFor(event, MAC);
		if (action === 'escape') {
			cancelStroke();
			return;
		}
		if (action === 'delete') {
			if (deleteSelected()) event.preventDefault();
			return;
		}
		if (!isHandKey(event)) return;
		event.preventDefault();
		setSpaceHeld(true);
	});

	// The window losing focus lets go of Space, since its keyup will never arrive.
	useEffect(() => {
		const keyDown = (event: KeyboardEvent) => {
			onKeyDown(event);
		};
		const keyUp = (event: KeyboardEvent) => {
			if (event.key === ' ') setSpaceHeld(false);
		};
		const blur = () => {
			setSpaceHeld(false);
		};
		window.addEventListener('keydown', keyDown);
		window.addEventListener('keyup', keyUp);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('keydown', keyDown);
			window.removeEventListener('keyup', keyUp);
			window.removeEventListener('blur', blur);
		};
	}, []);

	const applyEffect = (effect: GestureEffect) => {
		if (effect === 'cancelStroke') {
			cancelStroke();
			return;
		}
		if (effect === 'undo') {
			document.undo();
			return;
		}
		if (effect === 'redo') {
			document.redo();
			return;
		}
		const current = views.get();
		if ('pan' in effect) {
			views.set(panBy(current, effect.pan.dx / current.scale, effect.pan.dy / current.scale));
			return;
		}
		const { left, top } = corner();
		const [x, y] = toUser(current, effect.zoom.aboutX - left, effect.zoom.aboutY - top);
		views.set(zoomAbout(current, effect.zoom.factor, x, y));
	};

	/** The gesture reducer sees every pointer event, and what it asks for is done at once. */
	const track = (type: GestureEvent['type'], event: PointerEvent): GestureState => {
		const { state, effects } = gestureReducer(gesture.current, gestureEvent(type, event));
		gesture.current = state;
		effects.forEach(applyEffect);
		return state;
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const native = event.nativeEvent;
		// The same pointer down again never lifted, as far as this element
		// heard: that stroke is over, so a lost `pointerup` cannot stop drawing.
		if (stroke.current?.pointerId === native.pointerId) cancelStroke();
		const state = track('down', native);
		if (stroke.current !== undefined || !startsStroke(native, state)) return;
		const layer = activeLayer();
		const behaviour = spaceHeld ? handBehaviour : behaviourFor(tool, layer?.kind);
		if (behaviour === undefined) {
			onNotify(notAvailableMessage(tool, layer?.kind) ?? t('layers.noneActive'));
			return;
		}
		const context = toolContext();
		if (context === undefined) return;
		capture(event.currentTarget, native.pointerId);
		behaviour.begin(context, sample(native));
		stroke.current = { pointerId: native.pointerId, behaviour, context };
	};

	// A pointer moving with nothing down is a hover: a mouse's or a pen's, a
	// finger has none, and the hand held has nothing to preview.
	const hover = (native: PointerEvent) => {
		if (spaceHeld || native.pointerType === 'touch' || native.buttons !== 0) return;
		const behaviour = behaviourFor(tool, activeLayer()?.kind);
		if (behaviour?.hover === undefined) return;
		const context = toolContext();
		if (context !== undefined) behaviour.hover(context, sample(native));
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const native = event.nativeEvent;
		track('move', native);
		const current = stroke.current;
		if (current === undefined) {
			hover(native);
			return;
		}
		if (current.pointerId !== native.pointerId) return;
		samplesOf(native).forEach((each) => {
			current.behaviour.move(current.context, sample(each));
		});
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const native = event.nativeEvent;
		track('up', native);
		const current = stroke.current;
		if (current === undefined || current.pointerId !== native.pointerId) return;
		stroke.current = undefined;
		current.behaviour.end(current.context, sample(native));
	};

	const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
		const native = event.nativeEvent;
		track('cancel', native);
		if (stroke.current?.pointerId === native.pointerId) cancelStroke();
	};

	// The browser took the pointer away without a `pointerup`, which comes
	// before this when there is one: the stroke cannot end, so it is abandoned.
	const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (stroke.current?.pointerId === event.nativeEvent.pointerId) cancelStroke();
	};

	// A tool that does nothing on the active layer says so on a click, and
	// shows it before one.
	const available = behaviourFor(tool, activeLayer()?.kind) !== undefined;
	const toolCursor = available ? (tool.cursor ?? 'default') : 'not-allowed';
	const cursor = spaceHeld ? 'grab' : toolCursor;

	return (
		<div
			ref={region}
			className="viewport"
			role="region"
			aria-label={t('editor.panes.canvas')}
			style={{ cursor }}
			// Focusable, so the keys act where the drawing is and a keyboard
			// user can reach it: to the rule a landmark is nothing the keyboard
			// stops at, and this one is where it works.
			// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			onLostPointerCapture={onLostPointerCapture}
		>
			<div
				className="viewport-stage"
				style={{
					transform: stageTransform(view, box),
					width: box.width,
					height: box.height,
				}}
			>
				<div className="viewport-paper" />
				<div className="viewport-mount" ref={mount} />
				<svg
					className="viewport-overlay"
					ref={overlay}
					viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
					width={box.width}
					height={box.height}
					aria-hidden="true"
				/>
			</div>
			<canvas className="viewport-screen" ref={screen} aria-hidden="true" />
		</div>
	);
};
