import type { PointerSample } from '../tools/types.js';

/**
 * What fingers do that is not drawing (docs/decisions/0004-the-interface.md;
 * docs/ARCHITECTURE.md §7, "Input"): one finger draws, a second one landing
 * turns the stroke into a gesture, two fingers pan and pinch, a two-finger tap
 * undoes and a three-finger tap redoes, and while a pen is down a finger is a
 * palm. A pure reducer over the pointer events, in screen pixels, which emits
 * what the viewport is to do; the viewport keeps the state and feeds it every
 * touch and pen event. A mouse never reaches it.
 */
export type GestureEvent = Readonly<{
	type: 'down' | 'move' | 'up' | 'cancel';
	id: number;
	x: number;
	y: number;
	time: number;
	pointerType: PointerSample['pointerType'];
}>;

/** A finger on the screen: where it is, and where it landed, to tell a tap from a drag. */
type Finger = Readonly<{ x: number; y: number; startX: number; startY: number }>;

/** What the fingers are doing: nothing, one of them drawing, or two or more navigating. */
type GestureMode = 'idle' | 'stroke' | 'gesture';

export type GestureState = Readonly<{
	touches: ReadonlyMap<number, Finger>;
	mode: GestureMode;
	/** A pen is in contact. */
	penDown: boolean;
	/**
	 * The fingers down are a palm, since a pen landed while they were down or
	 * they landed while it was, and so is every finger until all of them lift.
	 */
	ignored: boolean;
	/** When the first finger of these landed. */
	since: number;
	/** The most fingers down at once since then: two tapping is undo, three redo. */
	peak: number;
	/** Whether what is down could still be a tap: nothing moved past `TAP_SLOP` and nothing was cancelled. */
	still: boolean;
}>;

type PanEffect = Readonly<{ pan: Readonly<{ dx: number; dy: number }> }>;
type ZoomEffect = Readonly<{
	zoom: Readonly<{ factor: number; aboutX: number; aboutY: number }>;
}>;
export type GestureEffect = 'cancelStroke' | 'undo' | 'redo' | PanEffect | ZoomEffect;

type GestureResult = Readonly<{ state: GestureState; effects: readonly GestureEffect[] }>;

/** How long fingers may be down and still have tapped. */
export const TAP_MS = 250;
/** How far a finger may move, in screen pixels, and still have tapped. */
const TAP_SLOP = 10;

export const INITIAL_GESTURE: GestureState = {
	touches: new Map(),
	mode: 'idle',
	penDown: false,
	ignored: false,
	since: 0,
	peak: 0,
	still: true,
};

const NONE: readonly GestureEffect[] = [];

const result = (state: GestureState, effects: readonly GestureEffect[] = NONE): GestureResult => ({
	state,
	effects,
});

const withFinger = (
	touches: ReadonlyMap<number, Finger>,
	id: number,
	finger: Finger
): ReadonlyMap<number, Finger> => new Map(touches).set(id, finger);

const withoutFinger = (
	touches: ReadonlyMap<number, Finger>,
	id: number
): ReadonlyMap<number, Finger> => {
	const next = new Map(touches);
	next.delete(id);
	return next;
};

const centroid = (touches: ReadonlyMap<number, Finger>): Readonly<{ x: number; y: number }> => {
	const fingers = [...touches.values()];
	const count = Math.max(1, fingers.length);
	return {
		x: fingers.reduce((sum, finger) => sum + finger.x, 0) / count,
		y: fingers.reduce((sum, finger) => sum + finger.y, 0) / count,
	};
};

/** How far apart two fingers are; nothing for any other number of them. */
const spread = (touches: ReadonlyMap<number, Finger>): number => {
	const [first, second] = [...touches.values()];
	if (touches.size !== 2 || first === undefined || second === undefined) return 0;
	return Math.hypot(second.x - first.x, second.y - first.y);
};

/**
 * The fingers' centre moved: pan by that. Two fingers' distance changed: zoom
 * by the ratio, about where they are now, so the thing between them stays
 * between them.
 */
const navigation = (
	before: ReadonlyMap<number, Finger>,
	after: ReadonlyMap<number, Finger>
): readonly GestureEffect[] => {
	const from = centroid(before);
	const to = centroid(after);
	const pan: PanEffect = { pan: { dx: to.x - from.x, dy: to.y - from.y } };
	const was = spread(before);
	const is = spread(after);
	if (was === 0 || is === 0) return [pan];
	return [pan, { zoom: { factor: is / was, aboutX: to.x, aboutY: to.y } }];
};

const tapEffects = (peak: number): readonly GestureEffect[] => {
	if (peak === 2) return ['undo'];
	if (peak === 3) return ['redo'];
	return NONE;
};

/**
 * A pen landing takes the stroke from a finger drawing, and makes the fingers
 * down a palm; lifting ends only the pen's part, the fingers stay a palm until
 * they lift too.
 */
const pen = (state: GestureState, event: GestureEvent): GestureResult => {
	if (event.type === 'move') return result(state);
	if (event.type !== 'down') return result({ ...state, penDown: false });
	const effects: readonly GestureEffect[] = state.mode === 'stroke' ? ['cancelStroke'] : NONE;
	return result(
		{
			...state,
			penDown: true,
			ignored: state.touches.size > 0,
			mode: 'idle',
			peak: 0,
			still: true,
		},
		effects
	);
};

/** A finger beside a pen: counted, so the viewport knows when all have lifted, and nothing else. */
const palm = (state: GestureState, event: GestureEvent): GestureResult => {
	const finger: Finger = { x: event.x, y: event.y, startX: event.x, startY: event.y };
	const touches =
		event.type === 'down' || event.type === 'move'
			? withFinger(state.touches, event.id, finger)
			: withoutFinger(state.touches, event.id);
	return result({ ...state, touches, mode: 'idle', ignored: touches.size > 0 });
};

const touchDown = (state: GestureState, event: GestureEvent): GestureResult => {
	const touches = withFinger(state.touches, event.id, {
		x: event.x,
		y: event.y,
		startX: event.x,
		startY: event.y,
	});
	if (touches.size === 1) {
		return result({
			...state,
			touches,
			mode: 'stroke',
			since: event.time,
			peak: 1,
			still: true,
		});
	}
	const effects: readonly GestureEffect[] = state.mode === 'stroke' ? ['cancelStroke'] : NONE;
	return result(
		{ ...state, touches, mode: 'gesture', peak: Math.max(state.peak, touches.size) },
		effects
	);
};

const touchMove = (state: GestureState, event: GestureEvent): GestureResult => {
	const before = state.touches.get(event.id);
	if (before === undefined) return result(state);
	const touches = withFinger(state.touches, event.id, { ...before, x: event.x, y: event.y });
	const still =
		state.still && Math.hypot(event.x - before.startX, event.y - before.startY) < TAP_SLOP;
	const next: GestureState = { ...state, touches, still };
	// One finger drawing is the viewport's stroke, sample by sample; nothing to say.
	if (state.mode !== 'gesture') return result(next);
	return result(next, navigation(state.touches, touches));
};

const touchUp = (state: GestureState, event: GestureEvent): GestureResult => {
	if (!state.touches.has(event.id)) return result(state);
	const touches = withoutFinger(state.touches, event.id);
	const still = state.still && event.type === 'up';
	if (touches.size > 0) return result({ ...state, touches, still });
	const tapped = state.mode === 'gesture' && still && event.time - state.since <= TAP_MS;
	return result(
		{ ...state, touches, mode: 'idle', peak: 0, still: true },
		tapped ? tapEffects(state.peak) : NONE
	);
};

const touch = (state: GestureState, event: GestureEvent): GestureResult => {
	if (state.penDown || state.ignored) return palm(state, event);
	if (event.type === 'down') return touchDown(state, event);
	if (event.type === 'move') return touchMove(state, event);
	return touchUp(state, event);
};

export const gestureReducer = (state: GestureState, event: GestureEvent): GestureResult => {
	if (event.pointerType === 'pen') return pen(state, event);
	if (event.pointerType === 'touch') return touch(state, event);
	return result(state);
};
