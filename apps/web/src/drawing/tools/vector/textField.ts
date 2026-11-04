import { cell } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import type { ToolContext } from '../types.js';
import type { Point } from './geometry.js';
import { LINE_HEIGHT } from './textMarkup.js';

/**
 * The text tool's field (docs/decisions/0004-the-interface.md): a
 * `<textarea>` over the canvas, in the viewport's own element
 * (`ToolContext.host`), that the words are typed into before they are a
 * `<text>`. It is the live preview: in the text's size and colour, its first
 * baseline on the text's, so what is typed is seen where it will be drawn,
 * and the layer is not touched until the text is written. How it looks is
 * `styles/text.css`; where it is and how big, which follow the view, are set
 * on the element, which the CSP's `style-src 'unsafe-inline'` allows
 * (`apps/web/public/_headers`).
 *
 * The keys the editor maps leave it alone, a letter, Delete and Space
 * included: `isTyping` in `keys.ts` takes a focused textarea for typing, and
 * the frame and the viewport both ask it.
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
	colour: string;
	/** The face the text is drawn in, where it is known; otherwise the field's own, which is the page's, as a text in the drawing inherits it. */
	family: string | undefined;
	/** What the field starts with: the words of a text being edited. */
	initial: string;
}>;

/** How the user finished: a key that means done, or the focus going elsewhere. */
export type FieldEnd = 'key' | 'blur';

export type TextField = Readonly<{
	value: () => string;
	/** Off the canvas, and everything it listened to with it. */
	remove: () => void;
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
 * Opens the field over the canvas, focused, and calls `onEnd` once when the
 * user finishes with it. The text tool removes it, and writes what it holds.
 */
export const openTextField = (
	context: ToolContext,
	spec: FieldSpec,
	onEnd: (how: FieldEnd) => void
): TextField => {
	const { host } = context;
	const owner = host.ownerDocument;
	const field = owner.createElement('textarea');
	const live = cell(true);
	const end = (how: FieldEnd): void => {
		if (live.current) onEnd(how);
	};

	field.setAttribute('class', 'text-field');
	field.setAttribute('aria-label', t('text.field'));
	// A textarea's default value is its text, and its value until it is typed in.
	field.append(owner.createTextNode(spec.initial));
	field.style.setProperty('color', spec.colour);
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
	// The window losing focus blurs the field and leaves it the active
	// element, to have the focus again on the way back: that is not done.
	field.addEventListener('blur', () => {
		if (owner.activeElement !== field) end('blur');
	});

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
		place(context, field, spec);
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
	field.setSelectionRange(field.value.length, field.value.length);

	return {
		value: () => field.value,
		remove: () => {
			live.current = false;
			host.removeEventListener('mousedown', keepFocus);
			host.removeEventListener('wheel', follow);
			host.removeEventListener('scroll', unscroll);
			field.remove();
		},
	};
};
