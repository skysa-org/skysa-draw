import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import { isTyping } from '../../keys.js';
import type { PointerSample, ToolBehaviour, ToolContext, ToolOptions } from '../types.js';
import { constrainLine, distance, type Point } from './geometry.js';
import { guardLayer, layerSpace, targetLayer } from './guard.js';
import { mirror } from './path/edit.js';
import { formatPath } from './path/format.js';
import { anchorMark, handleMarks, type Mark, outlineMark, REACH_PX } from './path/marks.js';
import { type Anchor, corner, mapAnchors, samePlace } from './path/model.js';
import { type Attributes, createSvg, inkOf, paintOf } from './svg.js';

/**
 * The pen on a vector layer (docs/decisions/0004-the-interface.md): a Bézier
 * `<path>`, point by point, as in Illustrator and Figma. A click adds a
 * corner; a press and drag adds a smooth point whose handles mirror the drag,
 * and Alt while dragging moves the one handle alone; Shift keeps the new
 * segment, and a handle, to a multiple of 45°. A click on the first point
 * closes the path; a click on the last point again, which is what the second
 * click of a double-click is, Enter, or Escape finishes it open. The path is
 * drawn on the overlay until it is finished, and then added to the layer by
 * one command, so the layer is untouched until then and an undo takes the
 * whole path away.
 *
 * Escape keeps what is drawn, as Illustrator and Figma do, where it has a
 * segment to keep: a path of one point draws nothing and goes. A cancel from
 * the viewport (a second finger, the pointer lost) lets go of the press under
 * way only, the point it was placing or the handles it was pulling, and the
 * path carries on, so pinching to zoom between points loses none of them. The
 * tool or the layer changed under a path, which the viewport shows by
 * emptying the overlay, finishes it there, as Illustrator keeps a path when
 * the tool changes.
 *
 * Neither Enter nor Escape between presses reaches a tool through
 * `ToolBehaviour`, which hears the pointer alone, so the pen listens for them
 * on the document while a path is being drawn, and for the overlay being
 * emptied, and stops when the path is done.
 */

/** A press that moves less than this, in CSS pixels, is a click, and makes a corner. */
const DRAG_PX = 3;

/** The attribute that marks the pen's preview on the overlay. */
const MARK = 'data-draw-pen';

/** What a press is doing: placing a new point, closing on the first, or pressing on the last again. */
type Press = Readonly<{
	kind: 'add' | 'close' | 'last';
	/** The anchor it shapes. */
	index: number;
	/** That anchor as it was before the press, to put back where the press is let go of. */
	before: Anchor;
	from: Point;
	dragged: boolean;
}>;

type Drawing = Readonly<{
	layerId: string;
	/** In the drawing's units, as the pointer and the overlay are; into the layer's only when written. */
	anchors: readonly Anchor[];
	press: Press | undefined;
	/** The pointer between presses, for the segment that follows it, and whether Shift held it to 45°. */
	pointer: Readonly<{ at: Point; shift: boolean }> | undefined;
	/** The latest context the viewport gave, for a key or an emptied overlay to finish with. */
	context: ToolContext;
	preview: SVGElement;
	/** A cancel came, which the viewport follows by emptying the overlay: the preview is to be put back. */
	restoring: boolean;
	stop: () => void;
}>;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/**
 * The paint a pen path gets: the shape tools' (`paintOf`), the fill and the
 * stroke and its width from the options, with one exception. An open path
 * with no stroke, whose fill would make a wedge of a line, or a path with
 * neither colour, is a line in the fill colour with no fill, as the line
 * tool's line is (`shapes.ts`) and as Figma's pen draws.
 */
const paintFor = (options: ToolOptions, closed: boolean): Attributes => {
	const paint = paintOf(options);
	if (options.stroke !== 'none' || (closed && options.fill !== 'none')) return paint;
	return {
		...paint,
		fill: 'none',
		stroke: inkOf(options, 'stroke'),
		'stroke-width': options.strokeWidth,
	};
};

/** The press let go of: the point it placed taken out, or the handles it pulled put back. */
const settled = (drawing: Drawing): Drawing => {
	const { press } = drawing;
	if (press === undefined) return drawing;
	const anchors =
		press.kind === 'add'
			? drawing.anchors.filter((_, i) => i !== press.index)
			: drawing.anchors.map((anchor, i) => (i === press.index ? press.before : anchor));
	return { ...drawing, anchors, press: undefined };
};

/**
 * An anchor as a drag from it leaves it. Its `out` handle follows the
 * pointer and its `in` mirrors it; with Alt the mirror is broken and the
 * handle toward the segment not yet drawn moves alone: the `out` of a new
 * point, the `in` of the first point being closed on. A drag from the last
 * point again pulls its `out` alone, since the segment into it is drawn.
 */
const shaped = (kind: Press['kind'], anchor: Anchor, handle: Point, alt: boolean): Anchor => {
	if (kind === 'last') return { ...anchor, out: handle };
	if (!alt) return { point: anchor.point, in: mirror(anchor.point, handle), out: handle };
	return kind === 'close'
		? { ...anchor, in: mirror(anchor.point, handle) }
		: { ...anchor, out: handle };
};

/** The drawing after the pointer moved with a press down. */
const pulled = (
	drawing: Drawing,
	press: Press,
	context: ToolContext,
	sample: PointerSample
): Drawing => {
	const at = pointOf(sample);
	const dragged = press.dragged || distance(press.from, at) * context.viewport.scale >= DRAG_PX;
	if (!dragged) return { ...drawing, context };
	const anchor = drawing.anchors[press.index] ?? press.before;
	const handle = constrainLine(anchor.point, at, sample.shiftKey);
	const next = shaped(press.kind, anchor, handle, sample.altKey);
	return {
		...drawing,
		context,
		anchors: drawing.anchors.map((each, i) => (i === press.index ? next : each)),
		press: { ...press, dragged: true },
	};
};

/** The handles of one anchor, where it has them. */
const handlesOf = (anchor: Anchor, scale: number): readonly Mark[] =>
	[anchor.in, anchor.out]
		.filter((handle) => !samePlace(handle, anchor.point))
		.flatMap((handle) => handleMarks(anchor.point, handle, scale));

/**
 * The preview: the path so far in its own paint and as an outline, the
 * segment the next click would add, out to the pointer, the handles of the
 * point being shaped, or else of the last, and every anchor, the first drawn
 * larger where a click would close on it.
 */
const marksOf = (drawing: Drawing): readonly Mark[] => {
	const { anchors, press, pointer, context } = drawing;
	const first = anchors[0];
	const last = anchors.at(-1);
	if (first === undefined || last === undefined) return [];
	const scale = context.viewport.scale;
	const closing =
		press === undefined &&
		pointer !== undefined &&
		anchors.length >= 2 &&
		distance(pointer.at, first.point) <= REACH_PX / scale;
	const d = formatPath([{ anchors, closed: press?.kind === 'close' }]);
	const path: readonly Mark[] =
		anchors.length < 2
			? []
			: [
					{
						name: 'path',
						attributes: { d, ...paintFor(context.options, press?.kind === 'close') },
					},
					outlineMark(d),
				];
	const towards = closing
		? first
		: corner(constrainLine(last.point, pointer?.at ?? last.point, pointer?.shift ?? false));
	const band: readonly Mark[] =
		press === undefined && pointer !== undefined
			? [outlineMark(formatPath([{ anchors: [last, towards], closed: false }]))]
			: [];
	const shaping = (press === undefined ? undefined : anchors[press.index]) ?? last;
	return [
		...path,
		...band,
		...handlesOf(shaping, scale),
		...anchors.map((anchor, i) =>
			anchorMark(anchor.point, scale, i === anchors.length - 1, i === 0 && closing ? 1.5 : 1)
		),
	];
};

const draw = (drawing: Drawing): void => {
	const { overlay } = drawing.context;
	const owner = overlay.ownerDocument;
	if (drawing.preview.parentNode !== overlay) overlay.appendChild(drawing.preview);
	drawing.preview.replaceChildren(
		...marksOf(drawing).map((mark) => createSvg(owner, mark.name, mark.attributes))
	);
};

export const createPen = (): ToolBehaviour => {
	const drawing = cell<Drawing | undefined>(undefined);

	const show = (next: Drawing): void => {
		drawing.current = next;
		draw(next);
	};

	/** The path over: the preview gone, nothing listened for, nothing written. */
	const stop = (current: Drawing): void => {
		current.stop();
		current.preview.remove();
		if (drawing.current === current) drawing.current = undefined;
	};

	/**
	 * The path written to the layer it was begun on, by one command, where it
	 * has a segment to draw. The guard of every vector tool applies then too,
	 * and a loose layer is wrapped first (`targetLayer`); the points go into
	 * the layer's own units (`layerSpace`).
	 */
	const finish = (current: Drawing, closed: boolean): void => {
		stop(current);
		if (current.anchors.length < 2) return;
		const info = current.context.document
			.snapshot()
			.layers.find((each) => each.id === current.layerId);
		if (info === undefined) return;
		const context: ToolContext = { ...current.context, layer: info };
		const layer = targetLayer(context);
		if (layer === undefined) return;
		const anchors = mapAnchors(layerSpace(layer).into, current.anchors);
		const attributes: Attributes = {
			d: formatPath([{ anchors, closed }]),
			...paintFor(context.options, closed),
		};
		context.document.execute(
			editLayer(layer.id, 'tools.pen', (g: Element) => {
				g.appendChild(createSvg(g.ownerDocument, 'path', attributes));
			})
		);
	};

	/** Enter and Escape on the document, and the overlay emptied under the path, while a path is drawn. */
	const listen = (context: ToolContext): (() => void) => {
		const owner = context.overlay.ownerDocument;
		const onKey = (event: KeyboardEvent): void => {
			const current = drawing.current;
			if (current === undefined) return;
			// The editor is gone from the page: there is nothing to write the path into.
			if (!current.context.overlay.isConnected) {
				stop(current);
				return;
			}
			if (event.key === 'Escape') {
				finish(settled(current), false);
				return;
			}
			const bare = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
			if (event.key !== 'Enter' || !bare || isTyping(event.target)) return;
			// Kept from a focused button, which Enter would press too.
			event.preventDefault();
			finish(settled(current), false);
		};
		const observer = new MutationObserver(() => {
			const current = drawing.current;
			if (current === undefined || current.restoring) return;
			if (current.preview.parentNode === current.context.overlay) return;
			finish(settled(current), false);
		});
		owner.addEventListener('keydown', onKey);
		observer.observe(context.overlay, { childList: true });
		return () => {
			owner.removeEventListener('keydown', onKey);
			observer.disconnect();
		};
	};

	const start = (context: ToolContext, layerId: string, at: Point): void => {
		const anchor = corner(at);
		show({
			layerId,
			anchors: [anchor],
			press: { kind: 'add', index: 0, before: anchor, from: at, dragged: false },
			pointer: undefined,
			context,
			preview: createSvg(context.overlay.ownerDocument, 'g', {
				[MARK]: '',
				'pointer-events': 'none',
			}),
			restoring: false,
			stop: listen(context),
		});
	};

	/** A press on a path being drawn: on its first point, its last, or anywhere else for a new one. */
	const press = (current: Drawing, context: ToolContext, sample: PointerSample): void => {
		const at = pointOf(sample);
		const reach = REACH_PX / context.viewport.scale;
		const first = current.anchors[0];
		const lastIndex = current.anchors.length - 1;
		const last = current.anchors[lastIndex];
		if (first === undefined || last === undefined) return;
		const toFirst = current.anchors.length >= 2 ? distance(at, first.point) : Infinity;
		const toLast = distance(at, last.point);
		const base = { from: at, dragged: false };
		const next: Press =
			toFirst <= reach && toFirst <= toLast
				? { ...base, kind: 'close', index: 0, before: first }
				: toLast <= reach
					? { ...base, kind: 'last', index: lastIndex, before: last }
					: {
							...base,
							kind: 'add',
							index: lastIndex + 1,
							before: corner(constrainLine(last.point, at, sample.shiftKey)),
						};
		show({
			...current,
			context,
			press: next,
			pointer: undefined,
			anchors: next.kind === 'add' ? [...current.anchors, next.before] : current.anchors,
		});
	};

	return {
		begin: (context, sample) => {
			const before = drawing.current;
			// A path left on another layer when the active one changed is finished there.
			if (before !== undefined && before.layerId !== context.layer?.id) {
				finish(settled(before), false);
			}
			const layer = guardLayer(context);
			if (layer === undefined) return;
			const current = drawing.current;
			if (current === undefined) {
				start(context, layer.id, pointOf(sample));
				return;
			}
			press(settled(current), context, sample);
		},

		move: (context, sample) => {
			const current = drawing.current;
			if (current?.press === undefined) return;
			show(pulled(current, current.press, context, sample));
		},

		end: (context, sample) => {
			const current = drawing.current;
			if (current?.press === undefined) return;
			const { kind } = current.press;
			const after = pulled(current, current.press, context, sample);
			const dragged = after.press?.dragged ?? false;
			const done: Drawing = {
				...after,
				press: undefined,
				pointer: { at: pointOf(sample), shift: sample.shiftKey },
			};
			if (kind === 'close') {
				finish(done, true);
				return;
			}
			if (kind === 'last' && !dragged) {
				finish(done, false);
				return;
			}
			show(done);
		},

		cancel: () => {
			const current = drawing.current;
			if (current === undefined) return;
			drawing.current = { ...settled(current), restoring: true };
			// The viewport empties the overlay once this returns; the path is still being drawn.
			queueMicrotask(() => {
				const now = drawing.current;
				if (now?.restoring !== true) return;
				show({ ...now, restoring: false });
			});
		},

		hover: (context, sample) => {
			const current = drawing.current;
			if (current === undefined || current.press !== undefined) return;
			show({ ...current, context, pointer: { at: pointOf(sample), shift: sample.shiftKey } });
		},
	};
};
