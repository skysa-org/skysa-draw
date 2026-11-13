import { SVG_NAMESPACE } from '@skysa/draw-core';
import { type Cell, cell } from '@skysa/storage';

import { type CanvasBox, canvasBoxOf, cropCanvas } from '../../document/crop.js';
import type { EditorDocument } from '../../document/model.js';
import { isTyping } from '../../keys.js';
import type { PointerSample, ToolBehavior, ToolContext } from '../types.js';

/**
 * The crop, on any layer (docs/decisions/0004-the-interface.md: "Crop C: the
 * canvas's `viewBox`"): a box dragged on the canvas, shown with the outside
 * darkened and a handle at each corner and side, moved by its inside and
 * sized by its handles; Enter or a double-click applies it, Escape and
 * another tool let it go. Applying is one command that sets the root's
 * `viewBox` (`cropCanvas`); nothing drawn is resampled. With the constrain
 * option the box keeps the canvas's proportions.
 *
 * Before a box is drawn the canvas is the box, so its edges and corners can
 * be dragged in at once; a press anywhere else starts a new one. The box
 * outlives the stroke that drew it, held per overlay, and lives as long as its
 * marks are in the overlay: the viewport empties the overlay when the tool or
 * the layer changes, and the box goes with it.
 */

type Point = Readonly<{ x: number; y: number }>;

type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** What a press is on: a handle, the box's inside, or outside it. */
type CropGrip = CropHandle | 'inside' | 'outside';

const HANDLES: readonly CropHandle[] = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'];

/** Where each handle is along the box, 0 at its start and 1 at its end. */
const ALONG: Readonly<Record<CropHandle, Point>> = {
	nw: { x: 0, y: 0 },
	n: { x: 0.5, y: 0 },
	ne: { x: 1, y: 0 },
	e: { x: 1, y: 0.5 },
	se: { x: 1, y: 1 },
	s: { x: 0.5, y: 1 },
	sw: { x: 0, y: 1 },
	w: { x: 0, y: 0.5 },
};

/** How near a handle, on screen, a press takes it. */
const GRIP_PX = 16;
/** A handle's size on screen. */
const HANDLE_PX = 10;
/** A box smaller than this on screen, either way, is a click, not a box. */
const MIN_PX = 4;

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

const within = (value: number, from: number, size: number, tolerance: number): boolean =>
	value >= from - tolerance && value <= from + size + tolerance;

/**
 * What a press at `point` is on, `tolerance` user units being near enough: a
 * corner first, then a side anywhere along it, then the inside or the outside.
 */
export const gripAt = (box: CanvasBox, point: Point, tolerance: number): CropGrip => {
	const corner = HANDLES.slice(0, 4).find(
		(handle) =>
			near(point.x, box.x + ALONG[handle].x * box.width, tolerance) &&
			near(point.y, box.y + ALONG[handle].y * box.height, tolerance)
	);
	if (corner !== undefined) return corner;
	const inX = within(point.x, box.x, box.width, 0);
	const inY = within(point.y, box.y, box.height, 0);
	const side = HANDLES.slice(4).find((handle) =>
		ALONG[handle].y === 0.5
			? inY && near(point.x, box.x + ALONG[handle].x * box.width, tolerance)
			: inX && near(point.y, box.y + ALONG[handle].y * box.height, tolerance)
	);
	if (side !== undefined) return side;
	return inX && inY ? 'inside' : 'outside';
};

/** A box from two corners in any order. */
const between = (a: Point, b: Point): CanvasBox => ({
	x: Math.min(a.x, b.x),
	y: Math.min(a.y, b.y),
	width: Math.abs(b.x - a.x),
	height: Math.abs(b.y - a.y),
});

const signOf = (value: number): number => (value < 0 ? -1 : 1);

/**
 * From a fixed corner to a moving one, kept to `aspect` (width over height)
 * where there is one: the longer way the pointer went decides the size.
 */
const fromCorner = (fixed: Point, moving: Point, aspect: number | undefined): CanvasBox => {
	const dx = moving.x - fixed.x;
	const dy = moving.y - fixed.y;
	if (aspect === undefined || !(aspect > 0)) return between(fixed, moving);
	const wide = Math.abs(dx) >= Math.abs(dy) * aspect;
	const width = wide ? Math.abs(dx) : Math.abs(dy) * aspect;
	const height = wide ? Math.abs(dx) / aspect : Math.abs(dy);
	return between(fixed, {
		x: fixed.x + signOf(dx) * width,
		y: fixed.y + signOf(dy) * height,
	});
};

/**
 * One side moved, kept to `aspect` by sizing the other way about the box's
 * middle, as every editor's constrained side handle does.
 */
const fromSide = (
	from: CanvasBox,
	handle: CropHandle,
	dx: number,
	dy: number,
	aspect: number | undefined
): CanvasBox => {
	const left = from.x + (handle === 'w' ? dx : 0);
	const right = from.x + from.width + (handle === 'e' ? dx : 0);
	const top = from.y + (handle === 'n' ? dy : 0);
	const bottom = from.y + from.height + (handle === 's' ? dy : 0);
	const moved = between({ x: left, y: top }, { x: right, y: bottom });
	if (aspect === undefined || !(aspect > 0)) return moved;
	if (handle === 'e' || handle === 'w') {
		const height = moved.width / aspect;
		return { ...moved, y: from.y + from.height / 2 - height / 2, height };
	}
	const width = moved.height * aspect;
	return { ...moved, x: from.x + from.width / 2 - width / 2, width };
};

/** What a drag does: a new box from where it began, a move of the box, or a handle. */
type CropDrag = Readonly<{
	grip: CropHandle | 'inside' | 'new';
	start: Point;
	from: CanvasBox;
}>;

/** A drag under way, and whether there was a box on the canvas before it began. */
type CropStroke = CropDrag & Readonly<{ had: boolean }>;

/** The box a drag has made by the time the pointer is at `point`. */
export const draggedBox = (drag: CropDrag, point: Point, aspect: number | undefined): CanvasBox => {
	const dx = point.x - drag.start.x;
	const dy = point.y - drag.start.y;
	const { from, grip } = drag;
	if (grip === 'new') return fromCorner(drag.start, point, aspect);
	if (grip === 'inside') return { ...from, x: from.x + dx, y: from.y + dy };
	const along = ALONG[grip];
	if (along.x === 0.5 || along.y === 0.5) return fromSide(from, grip, dx, dy, aspect);
	const fixed = {
		x: from.x + (1 - along.x) * from.width,
		y: from.y + (1 - along.y) * from.height,
	};
	const moving = {
		x: from.x + along.x * from.width + dx,
		y: from.y + along.y * from.height + dy,
	};
	return fromCorner(fixed, moving, aspect);
};

/** A box as the file will hold it: to a thousandth of a unit. */
const rounded = (box: CanvasBox): CanvasBox => ({
	x: Number(box.x.toFixed(3)),
	y: Number(box.y.toFixed(3)),
	width: Number(box.width.toFixed(3)),
	height: Number(box.height.toFixed(3)),
});

const sameBox = (a: CanvasBox, b: CanvasBox): boolean =>
	a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const svg = (name: string, attributes: Readonly<Record<string, string | number>>): SVGElement => {
	const element = window.document.createElementNS(SVG_NAMESPACE, name);
	Object.entries(attributes).forEach(([attribute, value]) =>
		element.setAttribute(attribute, String(value))
	);
	return element;
};

/**
 * The box's marks, in user units: the outside darkened (a path with the box
 * cut out of a far larger one), the box's outline, its thirds, and a handle at
 * each corner and side, sized for the screen at the scale given.
 */
const marks = (box: CanvasBox, scale: number): readonly SVGElement[] => {
	const far = 100 * Math.max(box.width, box.height, 1) + 10_000;
	const { x, y, width, height } = box;
	const shade = svg('path', {
		class: 'crop-shade',
		'fill-rule': 'evenodd',
		d: `M${x - far} ${y - far}H${x + width + far}V${y + height + far}H${x - far}Z M${x} ${y}h${width}v${height}h${-width}Z`,
	});
	const thirds = svg('path', {
		class: 'crop-thirds',
		d: [1, 2]
			.flatMap((n) => [
				`M${x + (width * n) / 3} ${y}v${height}`,
				`M${x} ${y + (height * n) / 3}h${width}`,
			])
			.join(' '),
	});
	const frame = svg('rect', { class: 'crop-frame', x, y, width, height });
	const side = HANDLE_PX / Math.max(scale, Number.EPSILON);
	const handles = HANDLES.map((handle) =>
		svg('rect', {
			class: 'crop-handle',
			x: x + ALONG[handle].x * width - side / 2,
			y: y + ALONG[handle].y * height - side / 2,
			width: side,
			height: side,
		})
	);
	return [shade, thirds, frame, ...handles];
};

/** One box being made, on one viewport's overlay. */
type Session = Readonly<{
	box: Cell<CanvasBox>;
	group: SVGElement;
	document: EditorDocument;
	dispose: () => void;
}>;

/** Whether a key went to the canvas, or to nothing in particular, rather than to a control. */
const aimedAtCanvas = (event: KeyboardEvent, host: HTMLElement): boolean => {
	const target = event.target;
	if (!(target instanceof Element)) return true;
	return target === window.document.body || host.contains(target);
};

const hasModifier = (event: KeyboardEvent): boolean =>
	event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;

export const cropBehavior = (): ToolBehavior | undefined => {
	const sessions = new WeakMap<SVGSVGElement, Session>();
	const drags = new WeakMap<ToolContext, CropStroke>();

	/** The overlay's box, while its marks are still there; one whose marks went is let go. */
	const live = (overlay: SVGSVGElement): Session | undefined => {
		const session = sessions.get(overlay);
		if (session === undefined || overlay.contains(session.group)) return session;
		session.dispose();
		return undefined;
	};

	const apply = (session: Session): void => {
		session.dispose();
		const from = canvasBoxOf(session.document.root, session.document.size);
		const box = rounded(session.box.current);
		if (box.width <= 0 || box.height <= 0 || sameBox(box, rounded(from))) return;
		session.document.execute(cropCanvas(box, from));
	};

	const open = (context: ToolContext, box: CanvasBox): Session => {
		const { overlay, host } = context;
		const group = svg('g', { class: 'crop-overlay' });
		overlay.appendChild(group);
		const onKeyDown = (event: KeyboardEvent): void => {
			const session = live(overlay);
			if (session === undefined || event.defaultPrevented || isTyping(event.target)) return;
			if (event.key === 'Escape') {
				session.dispose();
				return;
			}
			if (event.key !== 'Enter' || hasModifier(event) || !aimedAtCanvas(event, host)) return;
			event.preventDefault();
			apply(session);
		};
		const onDoubleClick = (): void => {
			const session = live(overlay);
			if (session !== undefined) apply(session);
		};
		const session: Session = {
			box: cell(box),
			group,
			document: context.document,
			dispose: () => {
				window.removeEventListener('keydown', onKeyDown);
				host.removeEventListener('dblclick', onDoubleClick);
				group.remove();
				if (sessions.get(overlay) === session) sessions.delete(overlay);
			},
		};
		window.addEventListener('keydown', onKeyDown);
		host.addEventListener('dblclick', onDoubleClick);
		sessions.set(overlay, session);
		return session;
	};

	const draw = (context: ToolContext, box: CanvasBox): void => {
		const session = live(context.overlay) ?? open(context, box);
		session.box.current = box;
		session.group.replaceChildren(...marks(box, context.viewport.scale));
	};

	/** The canvas's proportions, with the constrain option on. */
	const aspectFor = (context: ToolContext): number | undefined => {
		if (!context.options.constrain) return undefined;
		const canvas = canvasBoxOf(context.document.root, context.document.size);
		return canvas.width / canvas.height;
	};

	const atEnd = (context: ToolContext, sample: PointerSample): void => {
		const drag = drags.get(context);
		drags.delete(context);
		if (drag === undefined) return;
		const box = draggedBox(drag, sample, aspectFor(context));
		const least = MIN_PX / Math.max(context.viewport.scale, Number.EPSILON);
		const session = live(context.overlay);
		if (box.width >= least && box.height >= least) {
			// A press that did not move leaves no box behind where there was none.
			if (drag.had || !sameBox(box, drag.from)) draw(context, box);
			else session?.dispose();
			return;
		}
		// A click, or a box squeezed to nothing: the box as it was, or none.
		if (drag.had) draw(context, drag.from);
		else session?.dispose();
	};

	return {
		begin: (context, sample) => {
			const session = live(context.overlay);
			const box =
				session?.box.current ?? canvasBoxOf(context.document.root, context.document.size);
			const tolerance = GRIP_PX / Math.max(context.viewport.scale, Number.EPSILON);
			const grip = gripAt(box, sample, tolerance);
			const fresh = grip === 'outside' || (session === undefined && grip === 'inside');
			drags.set(context, {
				grip: fresh ? 'new' : grip,
				start: sample,
				from: box,
				had: session !== undefined,
			});
		},
		move: (context, sample) => {
			const drag = drags.get(context);
			if (drag !== undefined) draw(context, draggedBox(drag, sample, aspectFor(context)));
		},
		end: atEnd,
		// Mid-stroke, the drag is dropped and the box goes back to what it was
		// before it; told once the stroke is over, as the viewport may when the
		// tool is put down, the box goes.
		cancel: (context) => {
			const drag = drags.get(context);
			drags.delete(context);
			const session = live(context.overlay);
			if (drag?.had === true) draw(context, drag.from);
			else session?.dispose();
		},
	};
};
