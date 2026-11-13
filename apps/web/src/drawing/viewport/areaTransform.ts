import { cell } from '@skysa/storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { editActionFor, isCommitKey, isTyping, nudgeFor } from '../keys.js';
import type { SelectionActionId } from '../selectionActions.js';
import { areaPolygons } from '../tools/raster/area.js';
import {
	type Grip,
	GRIP_CURSORS,
	gripAt,
	gripMatrix,
	type Outline,
	placeOutline,
	sameMatrix,
} from '../tools/raster/areaTransform.js';
import type { PointerSample, Region, ToolBehavior, ToolId } from '../tools/types.js';
import {
	type Box,
	IDENTITY,
	type Mat,
	multiply,
	type Point,
	translate,
} from '../tools/vector/geometry.js';
import { drawSelectionBox } from '../tools/vector/selection.js';
import { type Observable, observable } from './observable.js';
import { isMac } from './pointer.js';
import type { ViewportSelection } from './selectionState.js';
import type { View } from './transform.js';

/**
 * Transform selection, as the viewport works it (docs/decisions/0004-the-interface.md,
 * "Transform selection"): Photoshop's Select › Transform Selection, a box
 * with handles on the marching ants, by which the area's outline, and not
 * its pixels, is moved, scaled and rotated, then kept with Enter or Apply,
 * or put back with Escape or Cancel. The math is pure
 * (`tools/raster/areaTransform.ts`); this is the mode.
 *
 * While it is on, it is the canvas's tool: the viewport hands its presses
 * and its hover to `behavior` in place of the tool in hand, so the tool does
 * nothing on the canvas and Auto-Select picks no layer, while Space still
 * pans and two fingers still pan and pinch, a second finger putting back
 * the drag the first began. Every sample sets the area, its outline mapped
 * from the outline it began with by one matrix, so the marching ants follow
 * each drag and nothing is rounded twice; the feather is kept, and an
 * inverted area, which has no outline of its own to put a box on, is not
 * transformed. The box is drawn on a layer of its own over the drawing,
 * which no tool empties, at the view's scale whenever the view moves.
 *
 * The keys are Photoshop's: Enter applies, unless it is aimed at a control
 * the keyboard is on or a field (`isCommitKey`); Escape cancels, before
 * anything else the viewport does with it; the arrows nudge the outline a
 * unit, or ten with Shift. Ctrl or ⌘ Z steps back through the drags and
 * nudges, and Shift with it, or Y, forward again, as Photoshop's does
 * during a transform, and never reaches the drawing's history while the
 * transform is on; nor does a two-finger tap. Those two keys are read on the
 * window's capture phase, before the frame's own undo and redo hear them.
 * An area is never a step of the history, so neither is a transform of it.
 *
 * Anything else that would change the area applies the transform first, as
 * Photoshop's Apply when it asks: a new tool in hand, another layer made
 * active, Deselect or any other action of the selection's (`applyingFirst`).
 * The area set by anything else (a new drawing, which drops it) ends the
 * transform where it is.
 */

/** The selection's actions that are the transform's own: any other applies it first. */
const OWN_ACTIONS: ReadonlySet<SelectionActionId> = new Set([
	'transformSelection',
	'applyTransform',
	'cancelTransform',
]);

const MAC = isMac();

type Deps = Readonly<{
	region: Observable<Region | undefined>;
	/** The selection's flag, which the menu and the selection bar read to show Apply and Cancel. */
	transforming: Observable<boolean>;
	view: Observable<View>;
	/** The `<svg>` the box is drawn on, over the drawing in its user units. */
	layer: () => SVGSVGElement | null;
	/** The stroke under way abandoned, whatever its tool's: the transform takes the canvas. */
	abandon: () => void;
}>;

/** A drag of the box: what it took hold of, where it began, the box then, and the outline's matrix then. */
type Drag = Readonly<{ grip: Grip; from: Point; box: Box; start: Mat }>;

type Session = Readonly<{
	/** The area as it was: what Cancel puts back, and what every matrix maps. */
	original: Region;
	outline: Outline;
	/** The box around the original outline. */
	home: Box;
	/** From the original outline to the one shown. */
	matrix: Mat;
	/** The box around the outline shown. */
	box: Box;
	/** The area this set last; any other there is someone else's. */
	shown: Region;
	/** The matrix before each step, the last step's last: what Ctrl or ⌘ Z goes back to. */
	back: readonly Mat[];
	/** The matrices stepped back from, the last one's last: what a redo goes to. */
	forward: readonly Mat[];
	drag: Drag | undefined;
}>;

export type AreaTransform = Readonly<{
	/** The box put on the area's outline; whether there was an outline to put it on. */
	start: () => boolean;
	/** The outline kept as it is now; whether a transform was on. */
	apply: () => boolean;
	/** The outline put back as it was; whether a transform was on. */
	cancel: () => boolean;
	active: () => boolean;
	/** What takes the canvas's presses and hover while the transform is on. */
	behavior: ToolBehavior;
	/**
	 * Enter, Escape and the arrows while the transform is on, `pressed` being
	 * what the last pointer press was in: whether the key was the transform's.
	 */
	key: (event: KeyboardEvent, pressed: Node | null) => boolean;
	/** A step back, or forward: whether the transform took it, which it does whenever it is on. */
	undo: () => boolean;
	redo: () => boolean;
	/** The selection's actions as `run` does them, each applying the transform first unless it is its own. */
	applyingFirst: (
		run: (action: SelectionActionId) => boolean
	) => (action: SelectionActionId) => boolean;
	/** The cursor over the canvas while the transform is on, by what a press would take hold of; none while it is off. */
	cursors: Observable<string | undefined>;
	/**
	 * Listens to the area, the view and the keys that step back and forward;
	 * the cleanup ends a transform still on, keeping the outline.
	 */
	connect: () => () => void;
}>;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/** The transform's machine, one for the viewport's life; `useAreaTransform` makes it and connects it. */
const createAreaTransform = (deps: Deps): AreaTransform => {
	const session = cell<Session | undefined>(undefined);
	const cursors = observable<string | undefined>(undefined);

	const scale = (): number => {
		const now = deps.view.get().scale;
		return now > 0 ? now : 1;
	};

	const draw = (): void => {
		const layer = deps.layer();
		if (layer !== null) drawSelectionBox(layer, session.current?.box, scale());
	};

	/** The outline shown after `matrix`, from the original; the original area itself for none. */
	const place = (now: Session, matrix: Mat): void => {
		const home = sameMatrix(matrix, IDENTITY);
		const placed = home ? undefined : placeOutline(now.outline, matrix);
		const shown = placed === undefined ? now.original : { ...now.original, path: placed.path };
		const box = placed === undefined ? now.home : (placed.box ?? now.box);
		session.current = { ...now, matrix, box, shown };
		deps.region.set(shown);
		draw();
	};

	/** A finished step, from `before`: one Ctrl or ⌘ Z goes back past it. */
	const stepped = (now: Session, before: Mat): Session =>
		sameMatrix(now.matrix, before) ? now : { ...now, back: [...now.back, before], forward: [] };

	/** The transform over, the area left as it is shown. */
	const stop = (): void => {
		session.current = undefined;
		deps.transforming.set(false);
		cursors.set(undefined);
		draw();
	};

	/** An area with an outline of its own to put the box on: none for an inverse, the canvas outside one. */
	const transformable = (): Region | undefined => {
		const region = deps.region.get();
		return region === undefined || region.inverted ? undefined : region;
	};

	// The stroke under way is abandoned first, and the area read after it,
	// since a drag of the outline that is put back changes it.
	const start = (): boolean => {
		if (session.current !== undefined || transformable() === undefined) return false;
		deps.abandon();
		const region = transformable();
		if (region === undefined) return false;
		const outline = areaPolygons(region.path);
		const home = placeOutline(outline, IDENTITY).box;
		if (home === undefined) return false;
		session.current = {
			original: region,
			outline,
			home,
			matrix: IDENTITY,
			box: home,
			shown: region,
			back: [],
			forward: [],
			drag: undefined,
		};
		deps.transforming.set(true);
		cursors.set('default');
		draw();
		return true;
	};

	// A drag under way is put back first, by its stroke's cancel, as any
	// stroke is abandoned when its tool is put down.
	const apply = (): boolean => {
		if (session.current === undefined) return false;
		deps.abandon();
		stop();
		return true;
	};

	const cancel = (): boolean => {
		const now = session.current;
		if (now === undefined) return false;
		deps.abandon();
		stop();
		deps.region.set(now.original);
		return true;
	};

	/** The outline where the drag under way has it at `sample`. */
	const dragTo = (sample: PointerSample): void => {
		const now = session.current;
		if (now?.drag === undefined) return;
		const delta = gripMatrix(now.drag, pointOf(sample), sample, scale());
		place(now, multiply(delta, now.drag.start));
	};

	const behavior: ToolBehavior = {
		begin: (_context, sample) => {
			const now = session.current;
			if (now === undefined) return;
			const from = pointOf(sample);
			const grip = gripAt(now.box, from, scale());
			session.current = { ...now, drag: { grip, from, box: now.box, start: now.matrix } };
			cursors.set(GRIP_CURSORS[grip]);
		},
		move: (_context, sample) => {
			dragTo(sample);
		},
		end: (_context, sample) => {
			dragTo(sample);
			const now = session.current;
			if (now?.drag === undefined) return;
			session.current = { ...stepped(now, now.drag.start), drag: undefined };
		},
		cancel: () => {
			const now = session.current;
			if (now?.drag === undefined) return;
			place({ ...now, drag: undefined }, now.drag.start);
		},
		hover: (_context, sample) => {
			const now = session.current;
			if (now !== undefined)
				cursors.set(GRIP_CURSORS[gripAt(now.box, pointOf(sample), scale())]);
		},
	};

	/** The outline moved by an arrow, as one step; nothing while a drag is under way. */
	const nudge = (now: Session, by: readonly [number, number]): void => {
		if (now.drag !== undefined) return;
		place(
			{ ...now, back: [...now.back, now.matrix], forward: [] },
			multiply(translate(by[0], by[1]), now.matrix)
		);
	};

	const key = (event: KeyboardEvent, pressed: Node | null): boolean => {
		const now = session.current;
		if (now === undefined) return false;
		if (event.key === 'Escape') {
			if (event.defaultPrevented || isTyping(event.target)) return false;
			event.preventDefault();
			cancel();
			return true;
		}
		if (event.defaultPrevented) return false;
		if (isCommitKey(event, pressed)) {
			// Kept from a control the last press left the focus on, which Enter would press too.
			event.preventDefault();
			apply();
			return true;
		}
		const by = nudgeFor(event);
		if (by === undefined) return false;
		event.preventDefault();
		nudge(now, by);
		return true;
	};

	const undo = (): boolean => {
		const now = session.current;
		if (now === undefined) return false;
		const to = now.back.at(-1);
		if (now.drag !== undefined || to === undefined) return true;
		place({ ...now, back: now.back.slice(0, -1), forward: [...now.forward, now.matrix] }, to);
		return true;
	};

	const redo = (): boolean => {
		const now = session.current;
		if (now === undefined) return false;
		const to = now.forward.at(-1);
		if (now.drag !== undefined || to === undefined) return true;
		place({ ...now, forward: now.forward.slice(0, -1), back: [...now.back, now.matrix] }, to);
		return true;
	};

	const STEPS: Readonly<Partial<Record<string, () => boolean>>> = { undo, redo };

	const connect = (): (() => void) => {
		if (session.current === undefined) deps.transforming.set(false);
		const offRegion = deps.region.subscribe(() => {
			const now = session.current;
			if (now !== undefined && deps.region.get() !== now.shown) stop();
		});
		const offView = deps.view.subscribe(() => {
			if (session.current !== undefined) draw();
		});
		const onKey = (event: KeyboardEvent) => {
			if (session.current === undefined || event.defaultPrevented) return;
			const step = STEPS[editActionFor(event, MAC) ?? ''];
			if (step?.() === true) event.preventDefault();
		};
		window.addEventListener('keydown', onKey, true);
		return () => {
			offRegion();
			offView();
			window.removeEventListener('keydown', onKey, true);
			if (session.current !== undefined) stop();
		};
	};

	return {
		start,
		apply,
		cancel,
		active: () => session.current !== undefined,
		behavior,
		key,
		undo,
		redo,
		applyingFirst: (run) => (action) => {
			if (!OWN_ACTIONS.has(action)) apply();
			return run(action);
		},
		cursors,
		connect,
	};
};

type HookDeps = Omit<Deps, 'region' | 'transforming'> &
	Readonly<{ selection: ViewportSelection; toolId: ToolId; layerId: string | undefined }>;

/**
 * The viewport's transform, made once and connected while the viewport is
 * up, with the cursor it asks for now. A new tool in hand or another layer
 * made active applies it, as the area outlives both. A hook in name only
 * for what it is given, which may reach the viewport's refs: nothing here
 * reads one while rendering.
 */
export const useAreaTransform = ({
	selection,
	view,
	layer,
	abandon,
	toolId,
	layerId,
}: HookDeps): AreaTransform & Readonly<{ cursor: string | undefined }> => {
	const [machine] = useState(() =>
		createAreaTransform({
			region: selection.region,
			transforming: selection.transforming,
			view,
			layer,
			abandon,
		})
	);
	const cursor = useSyncExternalStore(machine.cursors.subscribe, machine.cursors.get);
	useEffect(() => machine.connect(), [machine]);
	useEffect(() => {
		machine.apply();
	}, [machine, toolId, layerId]);
	return { ...machine, cursor };
};
