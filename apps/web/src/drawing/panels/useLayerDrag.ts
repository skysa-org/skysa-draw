import { type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';

import { scrollStep } from './layerDrop.js';

/**
 * A drag in the layers panel (docs/ARCHITECTURE.md §7, "The interface"), with
 * Pointer Events alone, as everything here is (decision 0004): of layers to
 * another place in the stack, into and out of groups (`dragLayers.ts`), or of
 * a vector layer's items to another place among its elements or another
 * vector layer's (`dragItems.ts`), one engine for both. A mouse or a pen
 * drags a row by its button; a finger, which scrolls the list there, by the
 * row's grip. The press is a click until it moves `DRAG_FROM_PX`, and from
 * then the pointer is captured, so a drag that leaves the list still ends.
 *
 * What a drag moves, and where it would land, are its own (`Dragged`): it is
 * begun as the press becomes a drag, choosing or selecting what it moves
 * where that was not already, and aimed anew from the rows as they are drawn,
 * read from the list each time, so a scroll or a render between two moves is
 * never out of date; a place it cannot go shows nothing and drops nothing.
 * Near the scrolling body's top or bottom the drag scrolls it, a frame at a
 * time while the pointer is held there. Escape, or the browser taking the
 * pointer back, cancels; the click that ends a drag chooses nothing.
 */

/** How far a press moves, in CSS px, before it is a drag rather than a click. */
const DRAG_FROM_PX = 4;

type Point = Readonly<{ x: number; y: number }>;

/**
 * A drag under way: what the panel draws of it, `shown`, and `aim`, the drag
 * aimed at `point` over the rows of `list` as they are drawn, which is the
 * very same drag where that changes nothing it shows.
 */
export type Dragged<Shown> = Readonly<{
	shown: Shown;
	aim: (list: HTMLElement, point: Point) => Dragged<Shown>;
}>;

/** What a drag is pressed by: a row's button, which a finger leaves to scroll, or its grip. */
export type DragFrom = 'pick' | 'grip';

/** What a row's button and its grip hear of a drag. */
export type PointerHandlers = Readonly<{
	onPointerDown: (event: PointerEvent<HTMLElement>) => void;
	onPointerMove: (event: PointerEvent<HTMLElement>) => void;
	onPointerUp: (event: PointerEvent<HTMLElement>) => void;
	onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
	onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
}>;

type Press<Shown> = Readonly<{
	pointerId: number;
	element: Element;
	/** The drag this press begins, once it moves far enough to be one. */
	begin: () => Dragged<Shown>;
	x: number;
	y: number;
}>;

/** Where the browser has it: jsdom has not, and a drag is not worth a throw. */
const capture = (element: Element, pointerId: number): void => {
	(element as Partial<Pick<Element, 'setPointerCapture'>>).setPointerCapture?.(pointerId);
};

const release = (element: Element, pointerId: number): void => {
	const held = element as Partial<Pick<Element, 'hasPointerCapture' | 'releasePointerCapture'>>;
	if (held.hasPointerCapture?.(pointerId) === true) held.releasePointerCapture?.(pointerId);
};

const scrollBody = (element: Element, step: number): void => {
	(element as Partial<Pick<Element, 'scrollBy'>>).scrollBy?.(0, step);
};

export const useLayerDrag = <Shown>({
	list,
	onDrop,
}: Readonly<{
	/** The list of rows, inside the panel's body, which is what scrolls (`Panel`). */
	list: RefObject<HTMLUListElement | null>;
	/** A drag let go of, with what it showed last: put down where it was aimed, if anywhere. */
	onDrop: (shown: Shown) => void;
}>) => {
	const [drag, setDrag] = useState<Dragged<Shown> | undefined>(undefined);
	const press = useRef<Press<Shown> | undefined>(undefined);
	const dragging = useRef<Dragged<Shown> | undefined>(undefined);
	const point = useRef<Point | undefined>(undefined);
	const frame = useRef<number | undefined>(undefined);
	/** Set by a drop, for the click the browser sends after it. */
	const clickSpent = useRef(false);

	const show = (next: Dragged<Shown> | undefined) => {
		dragging.current = next;
		setDrag(next);
	};

	/** Where the drag would land now, from the rows as drawn, shown where it changed. */
	const retarget = () => {
		const now = dragging.current;
		const rows = list.current;
		const at = point.current;
		if (now === undefined || rows === null || at === undefined) return;
		const next = now.aim(rows, at);
		if (next !== now) show(next);
	};

	/** A frame of scrolling, while the pointer is held near an edge of the body. */
	const scrollFrame = () => {
		const body = list.current?.closest('.panel-body');
		const at = point.current;
		if (body !== null && body !== undefined && at !== undefined) {
			const step = scrollStep(body.getBoundingClientRect(), at.y);
			if (step !== 0) {
				scrollBody(body, step);
				retarget();
			}
		}
		frame.current =
			dragging.current === undefined ? undefined : requestAnimationFrame(scrollFrame);
	};

	const end = () => {
		const pressed = press.current;
		if (pressed !== undefined) release(pressed.element, pressed.pointerId);
		if (frame.current !== undefined) cancelAnimationFrame(frame.current);
		press.current = undefined;
		point.current = undefined;
		frame.current = undefined;
		if (dragging.current !== undefined) show(undefined);
	};

	const begin = (pressed: Press<Shown>) => {
		const started = pressed.begin();
		capture(pressed.element, pressed.pointerId);
		show(started);
		frame.current = requestAnimationFrame(scrollFrame);
	};

	const onPointerDown = (
		event: PointerEvent<HTMLElement>,
		begins: () => Dragged<Shown>,
		from: DragFrom
	) => {
		clickSpent.current = false;
		if (event.button !== 0 || (from === 'pick' && event.pointerType === 'touch')) return;
		press.current = {
			pointerId: event.pointerId,
			element: event.currentTarget,
			begin: begins,
			x: event.clientX,
			y: event.clientY,
		};
	};

	const onPointerMove = (event: PointerEvent<HTMLElement>) => {
		const pressed = press.current;
		if (pressed === undefined || pressed.pointerId !== event.pointerId) return;
		point.current = { x: event.clientX, y: event.clientY };
		if (dragging.current === undefined) {
			if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_FROM_PX)
				return;
			begin(pressed);
		}
		retarget();
	};

	const onPointerUp = (event: PointerEvent<HTMLElement>) => {
		if (press.current?.pointerId !== event.pointerId) return;
		const done = dragging.current;
		end();
		if (done === undefined) return;
		// The click this press makes is the drag's, and chooses nothing; one the
		// browser does not send is forgotten before anything else can click.
		clickSpent.current = true;
		window.setTimeout(() => {
			clickSpent.current = false;
		}, 0);
		onDrop(done.shown);
	};

	const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
		if (press.current?.pointerId === event.pointerId) end();
	};

	// Escape puts the drag down where it began, before the sheet, the frame or
	// a tool hears the key. Heard only while a drag lasts, and again after each
	// render of it, which is only where the place it would land changes.
	const active = drag !== undefined;
	useEffect(() => {
		if (!active) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			end();
		};
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	});

	// A panel put away mid-drag lets go of the pointer and the frame.
	useEffect(
		() => () => {
			if (frame.current !== undefined) cancelAnimationFrame(frame.current);
		},
		[]
	);

	/** The handlers for a row's button or its grip, `from`, for the drag a press there `begins`. */
	const handlers = (begins: () => Dragged<Shown>, from: DragFrom): PointerHandlers => ({
		onPointerDown: (event) => onPointerDown(event, begins, from),
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		onLostPointerCapture: onPointerCancel,
	});

	/** Whether this click ends a drag, and so chooses nothing. */
	const spentClick = (): boolean => clickSpent.current;

	return { drag: drag?.shown, handlers, spentClick };
};
