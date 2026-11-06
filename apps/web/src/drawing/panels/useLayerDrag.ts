import { type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';

import { canPlaceLayers, placeLayers } from '../document/arrange.js';
import type { EditorDocument } from '../document/model.js';
import {
	type DropTarget,
	dropTargetAt,
	type Indent,
	type MeasuredRow,
	scrollStep,
} from './layerDrop.js';

/**
 * Layers dragged to another place in the layers panel, into and out of groups
 * (docs/ARCHITECTURE.md §7, "The interface"), with Pointer Events alone, as
 * everything here is (decision 0004). A mouse or a pen drags a row by the
 * layer itself; a finger, which scrolls the list there, by the row's grip.
 * The press is a click until it moves `DRAG_FROM_PX`, and from then the
 * pointer is captured, so a drag that leaves the list still ends.
 *
 * What is dragged is the layers chosen where the row pressed is one of them,
 * else that row alone, made active and chosen alone as the drag begins. Where
 * it would land is `dropTargetAt` over the rows as they are drawn, read from
 * the list each time, so a scroll or a render between two moves is never out
 * of date; a place `canPlaceLayers` refuses shows nothing and drops nothing.
 * Near the scrolling body's top or bottom the drag scrolls it, a frame at a
 * time while the pointer is held there. Escape, or the browser taking the
 * pointer back, cancels; the click that ends a drag chooses nothing.
 */

/** How far a press moves, in CSS px, before it is a drag rather than a click. */
const DRAG_FROM_PX = 4;

/** The drag the panel draws: the layers dragged, and where they would land. */
type LayerDrag = Readonly<{ ids: readonly string[]; target: DropTarget | undefined }>;

/** What the drag is pressed by: the layer itself, which a finger leaves to scroll, or the grip. */
type DragFrom = 'pick' | 'grip';

type Press = Readonly<{ pointerId: number; element: Element; id: string; x: number; y: number }>;

type Point = Readonly<{ x: number; y: number }>;

/** The list's rows as they are drawn, each with the facts the drop is read from (`LayerRow`). */
const measureRows = (list: HTMLElement): readonly MeasuredRow[] =>
	[...list.children].flatMap((row) => {
		if (!(row instanceof HTMLElement) || row.dataset.layerId === undefined) return [];
		const box = row.getBoundingClientRect();
		return [
			{
				id: row.dataset.layerId,
				depth: Number(row.dataset.depth ?? 0),
				parentId: row.dataset.parentId,
				group: row.dataset.group !== undefined,
				collapsed: row.dataset.collapsed !== undefined,
				topLayer: row.dataset.topLayer,
				top: box.top,
				bottom: box.bottom,
			},
		];
	});

/** A CSS length in px, or nothing where it is not one, as in jsdom. */
const pxOf = (length: string): number | undefined => {
	const px = Number.parseFloat(length);
	return Number.isFinite(px) && px > 0 ? px : undefined;
};

/**
 * Where depth 0 begins and how far in each depth more is drawn: a nested
 * row's own indent over its depth, or a rem, which is what the rows are
 * indented by (`--space-l`), where no row is nested.
 */
const indentOf = (list: HTMLElement): Indent => {
	const nested = [...list.children].find(
		(row): row is HTMLElement => row instanceof HTMLElement && Number(row.dataset.depth) > 0
	);
	const measured =
		nested === undefined ? undefined : pxOf(getComputedStyle(nested).paddingInlineStart);
	const step =
		measured === undefined || nested === undefined
			? (pxOf(getComputedStyle(window.document.documentElement).fontSize) ?? 16)
			: measured / Number(nested.dataset.depth);
	return { left: list.getBoundingClientRect().left, step };
};

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

const sameTarget = (one: DropTarget | undefined, other: DropTarget | undefined): boolean =>
	one === other ||
	(one !== undefined &&
		other !== undefined &&
		one.kind === other.kind &&
		one.place.parentId === other.place.parentId &&
		one.place.aboveId === other.place.aboveId &&
		(one.kind === 'into' || (other.kind === 'gap' && one.before === other.before)));

export const useLayerDrag = ({
	document,
	list,
	chosen,
	onActivate,
	onDropped,
}: Readonly<{
	document: EditorDocument;
	/** The list of rows, inside the panel's body, which is what scrolls (`Panel`). */
	list: RefObject<HTMLUListElement | null>;
	/** The layers chosen, top first. */
	chosen: readonly string[];
	onActivate: (id: string) => void;
	/** After a drop, with the layers it moved. */
	onDropped: (ids: readonly string[]) => void;
}>) => {
	const [drag, setDrag] = useState<LayerDrag | undefined>(undefined);
	const press = useRef<Press | undefined>(undefined);
	const dragging = useRef<LayerDrag | undefined>(undefined);
	const point = useRef<Point | undefined>(undefined);
	const frame = useRef<number | undefined>(undefined);
	/** Set by a drop, for the click the browser sends after it. */
	const clickSpent = useRef(false);

	const show = (next: LayerDrag | undefined) => {
		dragging.current = next;
		setDrag(next);
	};

	/** Where the drag would land now, from the rows as drawn, shown where it changed. */
	const retarget = () => {
		const now = dragging.current;
		const rows = list.current;
		const at = point.current;
		if (now === undefined || rows === null || at === undefined) return;
		const found = dropTargetAt(measureRows(rows), at, indentOf(rows));
		const target =
			found !== undefined && canPlaceLayers(document.root, now.ids, found.place)
				? found
				: undefined;
		if (!sameTarget(target, now.target)) show({ ids: now.ids, target });
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

	const begin = (pressed: Press) => {
		const ids = chosen.includes(pressed.id) ? chosen : [pressed.id];
		if (!chosen.includes(pressed.id)) onActivate(pressed.id);
		capture(pressed.element, pressed.pointerId);
		show({ ids, target: undefined });
		frame.current = requestAnimationFrame(scrollFrame);
	};

	const onPointerDown = (event: PointerEvent<HTMLElement>, id: string, from: DragFrom) => {
		clickSpent.current = false;
		if (event.button !== 0 || (from === 'pick' && event.pointerType === 'touch')) return;
		press.current = {
			pointerId: event.pointerId,
			element: event.currentTarget,
			id,
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
		if (done.target === undefined) return;
		document.execute(placeLayers(document.root, done.ids, done.target.place));
		onDropped(done.ids);
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

	/** The handlers for a row's layer and its grip. */
	const handlers = (id: string, from: DragFrom) => ({
		onPointerDown: (event: PointerEvent<HTMLElement>) => onPointerDown(event, id, from),
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		onLostPointerCapture: onPointerCancel,
	});

	/** Whether this click ends a drag, and so chooses nothing. */
	const spentClick = (): boolean => clickSpent.current;

	return { drag, handlers, spentClick };
};
