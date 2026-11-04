import { cell } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import { inToolOptions } from '../optionsRegion.js';
import type { ToolContext } from '../types.js';
import type { Point } from './geometry.js';
import { LINE_HEIGHT } from './textMarkup.js';

/**
 * The text tool's field (docs/decisions/0004-the-interface.md): a
 * `<textarea>` over the canvas, in the viewport's own element
 * (`ToolContext.host`), that the words are typed into before they are a
 * `<text>`. It is the live preview: in the text's size and color, its first
 * baseline on the text's, so what is typed is seen where it will be drawn,
 * and the layer is not touched until the text is written. How it looks is
 * `styles/text.css`; where it is and how big, which follow the view, are set
 * on the element, which the CSP's `style-src 'unsafe-inline'` allows
 * (`apps/web/public/_headers`).
 *
 * The keys the editor maps leave it alone, a letter, Delete and Space
 * included: `isTyping` in `keys.ts` takes a focused textarea for typing, and
 * the frame and the viewport both ask it.
 *
 * The focus may go to the tool's options and come back
 * (`tools/optionsRegion.ts`): a size or a color chosen while typing is a
 * change to the text, not the end of it. A textarea keeps its selection while
 * it is not focused, and the field is given the focus back with it when the
 * user is done with the control: a slider let go, a color picked, a button
 * pressed, or Enter. A control worked by keys keeps the focus until Enter, or
 * until Tab takes it on, so a number typed or a slider stepped by the arrows
 * is not cut short. The focus going anywhere else finishes the field, as a
 * press anywhere but the canvas does while the focus is in the options.
 */

/**
 * Where the first baseline is below the top of the field, in ems: the
 * half-leading of a line of `LINE_HEIGHT` and the face's ascent, which for the
 * sans-serif faces a browser falls back to puts it near 0.95 (Arial 0.947,
 * Helvetica and Inter 0.96). A face with a very different ascent is drawn a
 * little above or below its field.
 */
const BASELINE = 0.95;

/**
 * Safari on a phone zooms the page into a field whose font is smaller than
 * this (`--text-field-floor`, `styles/tokens.css`), so a smaller text's field
 * is set at this size and scaled down to the text's.
 */
const FIELD_FLOOR_PX = 16;

/** What the canvas listens for, and must not hear from inside the field. */
const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;

export type FieldSpec = Readonly<{
	/** The first line's baseline, where the text starts, in the drawing's user units. */
	at: Point;
	/** The text's size in the drawing's user units, as it is seen: its own, by the scale of what it is placed in. */
	size: number;
	color: string;
	/** The face the text is drawn in, where it is known; otherwise the field's own, which is the page's, as a text in the drawing inherits it. */
	family: string | undefined;
	/** What the field starts with: the words of a text being edited. */
	initial: string;
}>;

/** What of the text's look the options change while it is typed. */
export type FieldLook = Pick<FieldSpec, 'size' | 'color'>;

/** How the user finished: a key that means done, or the focus going elsewhere. */
export type FieldEnd = 'key' | 'blur';

export type TextField = Readonly<{
	value: () => string;
	/** The text's size or color changed while it is typed: the field shows it so. */
	restyle: (look: FieldLook) => void;
	/** Off the canvas, and everything it listened to with it. */
	remove: () => void;
}>;

/** The field's selection, kept while the focus is in the tool's options. */
type Kept = Readonly<{
	start: number;
	end: number;
	direction: HTMLTextAreaElement['selectionDirection'];
}>;

/** Escape, or Ctrl or ⌘ with Enter, outside an input method's composition, where Escape is the method's. */
const finishes = (event: KeyboardEvent): boolean =>
	!event.isComposing &&
	(event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey)));

/**
 * As many rows as lines and columns as the longest, for a browser without
 * `field-sizing: content` (`text.css`), which sizes the field to its words exactly.
 */
const fitContent = (field: HTMLTextAreaElement): void => {
	const lines = field.value.split('\n');
	field.setAttribute('rows', String(lines.length));
	field.setAttribute('cols', String(Math.max(...lines.map((line) => line.length)) + 2));
};

/**
 * The field where the text lands on the screen, now: `toScreen` gives device
 * pixels from the viewport's corner, and the field is placed in CSS pixels
 * from the same corner.
 */
const place = (context: ToolContext, field: HTMLTextAreaElement, spec: FieldSpec): void => {
	const px = spec.size * context.viewport.scale;
	const font = Math.max(px, FIELD_FLOOR_PX);
	const [sx, sy] = context.screen.toScreen(spec.at.x, spec.at.y);
	const ratio = context.screen.pixelRatio;
	field.style.setProperty('left', `${sx / ratio}px`);
	field.style.setProperty('top', `${sy / ratio - BASELINE * px}px`);
	field.style.setProperty('font-size', `${font}px`);
	if (font === px) {
		field.style.removeProperty('transform');
		return;
	}
	field.style.setProperty('transform', `scale(${px / font})`);
};

/**
 * Where in the field's words a point of the drawing falls on the screen, where
 * the browser can say: `caretPositionFromPoint` gives a text control and the
 * offset in its value (CSSOM View,
 * https://drafts.csswg.org/cssom-view/#dom-document-caretpositionfrompoint).
 * None where it cannot, which jsdom and an older Safari cannot.
 */
const caretIndexAt = (
	context: ToolContext,
	field: HTMLTextAreaElement,
	at: Point
): number | undefined => {
	const owner = field.ownerDocument;
	if (!('caretPositionFromPoint' in owner)) return undefined;
	const [sx, sy] = context.screen.toScreen(at.x, at.y);
	const ratio = context.screen.pixelRatio;
	const corner = context.host.getBoundingClientRect();
	const position = owner.caretPositionFromPoint(
		corner.left + sx / ratio,
		corner.top + sy / ratio
	);
	return position?.offsetNode === field
		? Math.min(position.offset, field.value.length)
		: undefined;
};

/** The field's selection as it is now, to give it back. */
const keptOf = (field: HTMLTextAreaElement): Kept => ({
	start: field.selectionStart,
	end: field.selectionEnd,
	direction: field.selectionDirection,
});

/**
 * The focus between the field and the tool's options (the module's comment):
 * what is listened for on the page while the field is open, so that the focus
 * going to the options keeps the field and coming back gives it its
 * selection again. The listeners are on the page's document, in the capture
 * phase for what decides where a press or a key went before any control acts
 * on it, and in the bubble phase for what a control has done, after it did.
 */
const keepThroughOptions = (
	context: ToolContext,
	field: HTMLTextAreaElement,
	end: (how: FieldEnd) => void
): (() => void) => {
	const owner = field.ownerDocument;
	// The selection while the focus is in the options; none while it is here.
	const away = cell<Kept | undefined>(undefined);
	// The last press was in the options, and nothing was typed since: Safari
	// focuses no slider or button that is pressed, so the field's blur may
	// not say where the focus went.
	const pressed = cell(false);
	// What is being done in the options is done by keys, which keep the focus.
	const byKeys = cell(false);

	const back = (): void => {
		const kept = away.current;
		if (kept === undefined) return;
		field.focus({ preventScroll: true });
		field.setSelectionRange(kept.start, kept.end, kept.direction);
	};

	// The window losing focus blurs the field and leaves it the active
	// element, to have the focus again on the way back: that is not done.
	const onBlur = (event: FocusEvent): void => {
		if (owner.activeElement === field) return;
		if (inToolOptions(event.relatedTarget) || pressed.current) {
			away.current = keptOf(field);
			return;
		}
		end('blur');
	};
	const onFocus = (): void => {
		away.current = undefined;
		pressed.current = false;
	};
	// A press on the canvas is the text tool's, which finishes the field.
	const onPointerDown = (event: Event): void => {
		const { target } = event;
		if (target instanceof Node && field.contains(target)) return;
		pressed.current = inToolOptions(target);
		byKeys.current = false;
		if (away.current === undefined || pressed.current) return;
		if (target instanceof Node && context.host.contains(target)) return;
		end('blur');
	};
	const onKeyDown = (event: Event): void => {
		pressed.current = false;
		if (inToolOptions(event.target)) byKeys.current = true;
	};
	const onFocusIn = (event: Event): void => {
		if (away.current === undefined || event.target === field) return;
		if (!inToolOptions(event.target)) end('blur');
	};
	// After the control's own handlers: a value set, a color picked, a button pressed.
	const onDone = (event: Event): void => {
		if (away.current === undefined || byKeys.current || !inToolOptions(event.target)) return;
		if (
			event.type === 'click' &&
			!(event.target instanceof Element && event.target.closest('button'))
		) {
			return;
		}
		back();
	};
	// On the key's way up, so that what Enter does down (a button pressed,
	// a typed color taken) is done, and no line break is typed here.
	const onKeyUp = (event: KeyboardEvent): void => {
		if (event.key === 'Enter' && inToolOptions(event.target)) back();
	};

	field.addEventListener('blur', onBlur);
	field.addEventListener('focus', onFocus);
	owner.addEventListener('pointerdown', onPointerDown, true);
	owner.addEventListener('keydown', onKeyDown, true);
	owner.addEventListener('focusin', onFocusIn);
	owner.addEventListener('change', onDone);
	owner.addEventListener('click', onDone);
	owner.addEventListener('keyup', onKeyUp);
	return () => {
		owner.removeEventListener('pointerdown', onPointerDown, true);
		owner.removeEventListener('keydown', onKeyDown, true);
		owner.removeEventListener('focusin', onFocusIn);
		owner.removeEventListener('change', onDone);
		owner.removeEventListener('click', onDone);
		owner.removeEventListener('keyup', onKeyUp);
	};
};

/**
 * Opens the field over the canvas, focused, and calls `onEnd` once when the
 * user finishes with it. The text tool removes it, and writes what it holds.
 * The caret goes where `caretAt` is, a point of the drawing, where the
 * browser can say which character that is, else after the last.
 */
export const openTextField = (
	context: ToolContext,
	spec: FieldSpec,
	onEnd: (how: FieldEnd) => void,
	caretAt?: Point
): TextField => {
	const { host } = context;
	const owner = host.ownerDocument;
	const field = owner.createElement('textarea');
	const live = cell(true);
	const shown = cell(spec);
	const end = (how: FieldEnd): void => {
		if (live.current) onEnd(how);
	};

	field.setAttribute('class', 'text-field');
	field.setAttribute('aria-label', t('text.field'));
	// A textarea's default value is its text, and its value until it is typed in.
	field.append(owner.createTextNode(spec.initial));
	field.style.setProperty('color', spec.color);
	field.style.setProperty('line-height', String(LINE_HEIGHT));
	if (spec.family !== undefined) field.style.setProperty('font-family', spec.family);
	fitContent(field);
	place(context, field, spec);

	// A pointer in the field is the field's: the viewport listens on its own
	// element, which a pointer event in here would bubble to and begin a
	// stroke on, so it goes no further.
	POINTER_EVENTS.forEach((type) => {
		field.addEventListener(type, (event) => {
			event.stopPropagation();
		});
	});
	field.addEventListener('input', () => {
		fitContent(field);
	});
	field.addEventListener('keydown', (event) => {
		if (!finishes(event)) return;
		event.preventDefault();
		event.stopPropagation();
		end('key');
	});
	const unlisten = keepThroughOptions(context, field, end);

	// A press on the canvas focuses the viewport, which takes focus, and a
	// tap's mouse events come after the finger lifts, when the field is open:
	// they would close it at once. While the field is open, a press on the
	// canvas leaves the focus where it is. A press that finishes the field has
	// closed it, and this with it, before its mouse events come.
	const keepFocus = (event: MouseEvent): void => {
		if (event.target instanceof Node && field.contains(event.target)) return;
		event.preventDefault();
	};
	// A wheel moves the view under the field, which follows it.
	const follow = (): void => {
		place(context, field, shown.current);
	};
	// The viewport clips rather than scrolls, but a browser scrolls a clipped
	// element to show a caret typed past its edge, which would move the
	// drawing from under the pointer: it is put back.
	const unscroll = (): void => {
		host.scrollTo({ left: 0, top: 0 });
	};
	host.addEventListener('mousedown', keepFocus);
	host.addEventListener('wheel', follow, { passive: true });
	host.addEventListener('scroll', unscroll);

	host.append(field);
	field.focus({ preventScroll: true });
	const caret =
		(caretAt === undefined ? undefined : caretIndexAt(context, field, caretAt)) ??
		field.value.length;
	field.setSelectionRange(caret, caret);

	return {
		value: () => field.value,
		restyle: (look) => {
			shown.current = { ...shown.current, ...look };
			field.style.setProperty('color', look.color);
			place(context, field, shown.current);
		},
		remove: () => {
			live.current = false;
			unlisten();
			host.removeEventListener('mousedown', keepFocus);
			host.removeEventListener('wheel', follow);
			host.removeEventListener('scroll', unscroll);
			field.remove();
		},
	};
};
