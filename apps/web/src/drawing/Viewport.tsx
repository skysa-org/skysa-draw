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

import { ContextMenu } from '../components/ui/ContextMenu.js';
import { t } from '../i18n/t.js';
import type { EditorDocument, LayerInfo } from './document/model.js';
import { type EditAction, editActionFor, isHandKey, isTyping, nudgeFor } from './keys.js';
import {
	SELECTION_TOOLS,
	type SelectionActionId,
	selectionActions,
	selectionModeOf,
} from './selectionActions.js';
import { handBehavior } from './tools/common/hand.js';
import { behaviorFor, notAvailableMessage } from './tools/index.js';
import { nudgeArea } from './tools/raster/index.js';
import type { PointerSample, ToolBehavior, ToolContext } from './tools/types.js';
import type { ViewportHandle, ViewportProps } from './types.js';
import { useAreaTransform } from './viewport/areaTransform.js';
import { isLongPress, keyboardPoint, useCanvasMenu } from './viewport/canvasMenu.js';
import { createToolContext, NO_SELECTION } from './viewport/context.js';
import {
	type GestureEffect,
	type GestureEvent,
	gestureReducer,
	type GestureState,
	INITIAL_GESTURE,
} from './viewport/gestures.js';
import { LiveCanvas } from './viewport/LiveCanvas.js';
import { observable } from './viewport/observable.js';
import { isMac, pointerTypeOf, sampleFrom } from './viewport/pointer.js';
import { usePointerPressed } from './viewport/pointerPressed.js';
import { useSelectionCommands } from './viewport/selectionCommands.js';
import { useSelectionFollows } from './viewport/selectionFollows.js';
import { createViewportSelection, useSelectionFacts } from './viewport/selectionState.js';
import { shadowOf } from './viewport/shadow.js';
import { StageMarks } from './viewport/StageMarks.js';
import { useToolHandover } from './viewport/toolHandover.js';
import {
	actualSizeView,
	checkerSize,
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
import { useWheel } from './viewport/wheel.js';

/**
 * The viewport (docs/ARCHITECTURE.md §7, "The editor" and "Input"): the
 * drawing's live root on a stage the view moves and scales, an overlay over it
 * in the same user units for a tool's previews, and a canvas over the whole in
 * device pixels for a live raster stroke. Pointer Events alone come in; they
 * go out as samples in user units to the active tool's behavior for the
 * active layer's kind, or to the gesture reducer when they are fingers
 * navigating. The document is mounted, never copied and never changed by
 * being shown. The selection is the viewport's, and so are the keys that
 * make it, drop it and delete what it holds; the frame has the other keys
 * (`keys.ts`).
 *
 * The area selection is the viewport's too (`ToolContext.region`): the
 * marquee and the lasso set it, the raster tools paint inside it, and it is
 * shown as marching ants in a layer of its own that a change of tool or of
 * layer leaves alone, since the area outlives the tool that made it and
 * every layer is painted inside it, as in Photoshop. A new document drops it.
 * The frame holds both selections (`viewport/selectionState.ts`), so that its
 * selection bar shows the actions the viewport's context menu shows
 * (`selectionActions.ts`); what they do is done here, where the tools'
 * context is (`viewport/selectionCommands.ts`), and the frame asks for it
 * through the handle.
 *
 * A tool may pick the layer a press acts on (`Tool.pick`): the move tool's
 * Auto-Select. The viewport asks it before the press begins, has the frame
 * make that layer the active one, and begins the press with a context of
 * that layer and the behavior for its kind, so the whole press, begin to
 * end, is that layer's, while the frame is still to show it. A press that is
 * canceled gives the layer back, as it leaves nothing else.
 *
 * Transform selection is a mode of the viewport's (`viewport/areaTransform.ts`):
 * while it is on, its behavior takes the canvas's presses and hover in place
 * of the tool's, its box is drawn on a layer of its own over the overlay, and
 * it reads Enter, Escape and the arrows before the viewport's other keys.
 */

const MAC = isMac();

/** The keys whose action is the selection's: the same as its item in the menu does. */
const SELECTION_KEYS: Readonly<Partial<Record<EditAction, SelectionActionId>>> = {
	delete: 'delete',
	selectAll: 'selectAll',
	deselect: 'deselect',
	selectInverse: 'selectInverse',
	feather: 'feather',
	layerViaCut: 'layerViaCut',
	fillArea: 'fill',
	fillAreaStroke: 'fillWithStroke',
	fillDialog: 'fillDialog',
};

type Stroke = Readonly<{
	pointerId: number;
	behavior: ToolBehavior;
	context: ToolContext;
	/** Where the press made another layer active (`Tool.pick`): the active one before it, made so again. */
	giveBack?: () => void;
}>;

/** The document and the user units the view was last fitted to, at a size it could measure. */
type Fitted = Readonly<{ document: EditorDocument; box: ViewBox }>;

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
 * Whether this pointer going down starts a stroke, rather than a gesture or
 * nothing. Only the main button draws: the right one, a pen's barrel button
 * and, on a Mac, a click with Control held are the context menu's.
 */
const startsStroke = (event: PointerEvent, gesture: GestureState): boolean =>
	event.button === 0 &&
	!(MAC && event.ctrlKey && event.pointerType === 'mouse') &&
	(event.pointerType !== 'touch' || gesture.mode === 'stroke');

export const Viewport = ({
	document,
	tool,
	options,
	layerId,
	selection,
	onColor,
	onNotify,
	onScale,
	onActivateLayer,
	onFill,
	onModify,
	onTool,
	onOptions,
	ref,
}: ViewportProps) => {
	const region = useRef<HTMLDivElement>(null);
	const mount = useRef<HTMLDivElement>(null);
	const overlay = useRef<SVGSVGElement>(null);
	const transformed = useRef<SVGSVGElement>(null);
	const screen = useRef<HTMLCanvasElement>(null);
	const stroke = useRef<Stroke | undefined>(undefined);
	// The last stroke begun, ended or not, or the tool last given a context
	// outside one (`viewport/toolHandover.ts`): its tool is told when it is
	// put down, so what it left open (the text tool's field) closes with it.
	const lastStroke = useRef<Omit<Stroke, 'pointerId'> | undefined>(undefined);
	const gesture = useRef<GestureState>(INITIAL_GESTURE);
	const fitted = useRef<Fitted | undefined>(undefined);
	const [views] = useState(() => observable(IDENTITY_VIEW));
	const [ownSelection] = useState(createViewportSelection);
	const held = selection ?? ownSelection;
	const { region: regions, elements: selections } = held;
	const [spaceHeld, setSpaceHeld] = useState(false);
	const pointerPressed = usePointerPressed();
	const view = useSyncExternalStore(views.subscribe, views.get);
	const snapshot = useSyncExternalStore(document.subscribe, document.snapshot);
	const facts = useSelectionFacts(held, snapshot, layerId);
	const area = facts.region;

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

	const cancelStroke = useCallback(() => {
		const current = stroke.current;
		if (current === undefined) return;
		stroke.current = undefined;
		current.behavior.cancel(current.context);
		overlay.current?.replaceChildren();
		current.giveBack?.();
	}, []);

	const toolId = tool.id;
	const transform = useAreaTransform({
		selection: held,
		view: views,
		layer: () => transformed.current,
		abandon: cancelStroke,
		toolId,
		layerId,
	});
	/** The behavior for a press on a layer of `kind`: the transform's while it is on. */
	const canvasBehavior = (kind: LayerInfo['kind'] | undefined): ToolBehavior | undefined =>
		transform.active() ? transform.behavior : behaviorFor(tool, kind);

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

	// An area is the drawing's it was made on: another drawing starts with none.
	useEffect(() => {
		regions.set(undefined);
	}, [document, regions]);

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

	// A tool put down leaves nothing behind: not a stroke, not a preview, not
	// what it left open after its last stroke, and not a selection unless the
	// new tool is one that works on it. Its `cancel` is told once, whether a
	// stroke is under way or one has ended. The area stays: it is in a layer
	// of its own.
	// Then a tool another one asked for is given what it is to edit; and the
	// tool in hand is told of new options (`viewport/toolHandover.ts`).
	const handover = useToolHandover({
		toolId,
		options,
		onTool,
		inHand: () => {
			const behavior = behaviorFor(tool, activeLayer()?.kind);
			const context = toolContext();
			return behavior === undefined || context === undefined
				? undefined
				: { behavior, context };
		},
		keep: ({ behavior, context }) => {
			lastStroke.current = { behavior, context };
		},
	});
	const arrive = useEffectEvent(() => {
		handover.arrived();
	});
	useEffect(() => {
		const last = lastStroke.current;
		lastStroke.current = undefined;
		if (stroke.current === undefined) last?.behavior.cancel(last.context);
		cancelStroke();
		overlay.current?.replaceChildren();
		if (!SELECTION_TOOLS.has(toolId)) selections.set(NO_SELECTION);
		arrive();
	}, [toolId, cancelStroke, selections]);

	// What is selected is the active layer's and in the drawing, and its box
	// goes with what is let go of, under a press too (`viewport/selectionFollows.ts`).
	useSelectionFollows({
		document,
		snapshot,
		layerId,
		selection: selections,
		overlay,
		clearOverlay,
	});

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

	useWheel(region, views);

	const corner = (): Readonly<{ left: number; top: number }> => {
		const rect = region.current?.getBoundingClientRect();
		return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
	};

	const sample = (event: PointerEvent) => sampleFrom(event, views.get(), corner(), MAC);

	const activeLayer = () => snapshot.layers.find((layer) => layer.id === layerId);

	/** What a tool is given, for the active layer or, for a press that picked one, that layer. */
	const toolContext = (layer: LayerInfo | undefined = activeLayer()): ToolContext | undefined => {
		if (overlay.current === null || screen.current === null || region.current === null) {
			return undefined;
		}
		return createToolContext({
			document,
			layer,
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
			setColor: onColor,
			notify: onNotify,
			useTool: handover.useTool,
			setOptions: onOptions,
		});
	};

	// The selection's actions, for the context menu, the frame's selection
	// bar and the keys alike.
	const commands = useSelectionCommands({
		document,
		layer: activeLayer(),
		canvas: box,
		toolId,
		selection: held,
		busy: () => stroke.current !== undefined,
		context: toolContext,
		overlay: () => overlay.current,
		notify: onNotify,
		activate: (id) => onActivateLayer?.(id),
		fill: onFill,
		modify: onModify,
		transform,
	});
	const perform = transform.applyingFirst(commands.run);

	useImperativeHandle(ref, (): ViewportHandle => ({
		fit,
		actualSize,
		zoomIn,
		zoomOut,
		scale: view.scale,
		perform,
		fillArea: commands.fillWith,
		undo: transform.undo,
		redo: transform.redo,
	}));

	/**
	 * The key's action, where it is the selection's: J is layer via copy
	 * while something is selected and the layer duplicated while nothing is,
	 * as in Photoshop. Whether it did anything.
	 */
	const selectionKey = (action: EditAction | undefined): boolean | undefined => {
		if (action === 'duplicate') {
			return perform(
				selectionModeOf(facts) === 'nothing' ? 'duplicateLayer' : 'layerViaCopy'
			);
		}
		const mapped = action === undefined ? undefined : SELECTION_KEYS[action];
		return mapped === undefined ? undefined : perform(mapped);
	};

	// Escape abandons the stroke under way, and with none drops the area; the
	// frame has Escape too, for what it has open, and a field keeps its own.
	// Delete removes what is selected, which the frame cannot see, and so do
	// the selection's other keys; select-all and deselect are always taken
	// from the browser, whose own would select the page. Space held makes the
	// next stroke the hand's.
	const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
		if (transform.key(event, pointerPressed())) return;
		// The arrows nudge the selected pixels with the move tool, before anything else reads them.
		const nudge = event.defaultPrevented || toolId !== 'select' ? undefined : nudgeFor(event);
		const nudging = nudge === undefined ? undefined : toolContext();
		if (
			nudge !== undefined &&
			nudging !== undefined &&
			nudgeArea(nudging, nudge[0], nudge[1])
		) {
			event.preventDefault();
			return;
		}
		const action = editActionFor(event, MAC);
		if (action === 'escape') {
			if (stroke.current !== undefined) {
				cancelStroke();
				return;
			}
			if (!event.defaultPrevented && !isTyping(event.target)) regions.set(undefined);
			return;
		}
		if (event.defaultPrevented) return;
		const done = selectionKey(action);
		if (done !== undefined) {
			if (done || action === 'selectAll' || action === 'deselect') event.preventDefault();
			return;
		}
		if (!isHandKey(event, pointerPressed())) return;
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
			if (!transform.undo()) document.undo();
			return;
		}
		if (effect === 'redo') {
			if (!transform.redo()) document.redo();
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

	// The menu, opened over the canvas and never while a stroke is under way,
	// but for a finger the browser took for a long press, which was none.
	const menu = useCanvasMenu({
		element: region,
		keyboardAt: () => {
			// A DOMRect's sides are its prototype's getters, which a spread would not copy.
			const rect = region.current?.getBoundingClientRect();
			const canvas = {
				left: rect?.left ?? 0,
				top: rect?.top ?? 0,
				width: rect?.width ?? 0,
				height: rect?.height ?? 0,
			};
			return keyboardPoint(canvas, views.get(), commands.center());
		},
		mayOpen: (event) => {
			const current = stroke.current;
			if (current === undefined) return true;
			if (!isLongPress(event, current.pointerId, gesture.current.still)) return false;
			cancelStroke();
			return true;
		},
	});
	const menuItems = selectionActions(facts, perform, MAC);

	/**
	 * The layer the tool picks for this press, other than the active one
	 * (`Tool.pick`); none where it picks none, or there is no frame to make it
	 * the active one.
	 */
	const pickFor = (pressed: PointerSample): LayerInfo | undefined => {
		if (spaceHeld || transform.active() || onActivateLayer === undefined) return undefined;
		if (tool.pick === undefined) return undefined;
		const context = toolContext();
		const picked = context === undefined ? undefined : tool.pick(context, pressed);
		return picked?.id === layerId ? undefined : picked;
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const native = event.nativeEvent;
		// A press that closes the menu draws nothing.
		if (menu.dismissing()) return;
		handover.forget();
		// The same pointer down again never lifted, as far as this element
		// heard: that stroke is over, so a lost `pointerup` cannot stop drawing.
		if (stroke.current?.pointerId === native.pointerId) cancelStroke();
		const state = track('down', native);
		if (stroke.current !== undefined || !startsStroke(native, state)) return;
		const pressed = sample(native);
		const picked = pickFor(pressed);
		const layer = picked ?? activeLayer();
		const behavior = spaceHeld ? handBehavior : canvasBehavior(layer?.kind);
		if (behavior === undefined) {
			onNotify(notAvailableMessage(tool, layer?.kind) ?? t('layers.noneActive'));
			return;
		}
		const context = toolContext(layer);
		if (context === undefined) return;
		// Made active before the press begins, and the frame shows it once the
		// press has; the press has the layer's context already.
		const before = layerId;
		if (picked !== undefined) onActivateLayer?.(picked.id);
		capture(event.currentTarget, native.pointerId);
		behavior.begin(context, pressed);
		stroke.current = {
			pointerId: native.pointerId,
			behavior,
			context,
			...(picked === undefined || before === undefined
				? {}
				: { giveBack: () => onActivateLayer?.(before) }),
		};
		lastStroke.current = stroke.current;
	};

	// A pointer moving with nothing down is a hover: a mouse's or a pen's, a
	// finger has none, and the hand held has nothing to preview.
	const hover = (native: PointerEvent) => {
		if (spaceHeld || native.pointerType === 'touch' || native.buttons !== 0) return;
		const behavior = canvasBehavior(activeLayer()?.kind);
		if (behavior?.hover === undefined) return;
		const context = toolContext();
		if (context !== undefined) behavior.hover(context, sample(native));
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
			current.behavior.move(current.context, sample(each));
		});
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const native = event.nativeEvent;
		track('up', native);
		const current = stroke.current;
		if (current === undefined || current.pointerId !== native.pointerId) return;
		stroke.current = undefined;
		current.behavior.end(current.context, sample(native));
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

	// The pointer gone from the canvas with nothing down: what the tool's hover showed goes with it.
	const onPointerLeave = () => {
		const context = stroke.current === undefined ? toolContext() : undefined;
		if (context !== undefined) behaviorFor(tool, activeLayer()?.kind)?.leave?.(context);
	};

	// A tool that does nothing on the active layer says so on a click, and
	// shows it before one; a tool that picks the layer a press acts on, with
	// Auto-Select on, may act on a group's layers while the group is active.
	const picks = tool.pick !== undefined && onActivateLayer !== undefined && options.autoSelect;
	const available = picks || behaviorFor(tool, activeLayer()?.kind) !== undefined;
	// The move tool over an area moves its pixels, and says so.
	const movesArea = toolId === 'select' && facts.layer?.kind === 'raster' && area !== undefined;
	const toolCursor = available
		? movesArea
			? 'move'
			: (tool.cursor ?? 'default')
		: 'not-allowed';
	const cursor = spaceHeld ? 'grab' : (transform.cursor ?? toolCursor);
	// The tool's own cursor, which the brush's outline stands in for (`viewport.css`).
	const ownCursor = !spaceHeld && transform.cursor === undefined && available;

	return (
		<>
			<div
				ref={region}
				className="viewport"
				role="region"
				aria-label={t('editor.panes.canvas')}
				style={{ cursor }}
				data-tool-cursor={ownCursor ? '' : undefined}
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
				onPointerLeave={onPointerLeave}
			>
				<div
					className="viewport-stage"
					style={{
						transform: stageTransform(view, box),
						width: box.width,
						height: box.height,
					}}
				>
					<div className="viewport-paper" style={{ backgroundSize: checkerSize(view) }} />
					<div className="viewport-mount" ref={mount} />
				</div>
				<LiveCanvas ref={screen} view={view} box={box} />
				<StageMarks
					view={view}
					box={box}
					area={area}
					overlay={overlay}
					transformed={transformed}
				/>
			</div>
			{/* Beside the canvas, not in it, so a press on the menu is never the canvas's. */}
			<ContextMenu
				label={t('selection.menu')}
				items={menuItems}
				at={menu.at}
				onClose={menu.close}
			/>
		</>
	);
};
