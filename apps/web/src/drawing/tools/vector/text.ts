import { cell } from '@skysa/storage';

import { toHex } from '../../../components/ui/color.js';
import { editLayer } from '../../document/commands.js';
import type { ToolBehavior, ToolContext, ToolOptions } from '../types.js';
import { apply, type Mat, multiply, parseTransform, type Point } from './geometry.js';
import {
	activeLayerElement,
	guardLayer,
	layerSpace,
	newElementSpace,
	targetLayer,
} from './guard.js';
import {
	elementsAt,
	elementsAtPositions,
	elementsOf,
	paintedColor,
	positionsIn,
	withoutStyleProperty,
} from './hit.js';
import { type Measure, measureOf } from './measure.js';
import { createSvg, inkOf } from './svg.js';
import {
	type FieldEnd,
	type FieldLook,
	type FieldSpec,
	openTextField,
	type TextField,
} from './textField.js';
import { type Edited, type HiddenText, hideText } from './textHide.js';
import {
	fillText,
	firstNumber,
	isBlank,
	LINE_HEIGHT,
	linesIn,
	linesOf,
	rounded,
} from './textMarkup.js';

/**
 * The text tool on a vector layer (docs/decisions/0004-the-interface.md): a
 * `<text>`, typed in place. A click on the canvas opens a field there
 * (`textField.ts`) whose first baseline is the click; a click on a text of the
 * active layer opens it on that text's words. It opens as the pointer lifts,
 * so a press a second finger turns into a pinch, which cancels it, opens no
 * field, and on a phone no keyboard. The field is the preview, and the layer
 * is not touched while it is open. It is finished by Escape, by Ctrl or ⌘
 * with Enter, by the focus going elsewhere, by `cancel`, or by the next press
 * on the canvas, which only finishes it: a tap away is how a touch screen,
 * which has no Escape, says done, and a field it opened would be one more to
 * close.
 * Finishing writes what was typed in one command (`tools.text`): a new text
 * of the font size and the fill color in the options, upright and of that
 * size on the canvas whatever the layer's placement (`newElementSpace`), or
 * the edited text's words in place of its old ones, its own attributes, its
 * `transform` among them, kept. Nothing typed writes nothing; an edited text
 * emptied is removed.
 *
 * The options may change while the field is open, from the options strip or
 * the color panel, which the focus goes to and comes back from without
 * finishing it (`textField.ts`): the field shows the new size or color at
 * once, a new text is written in them, and an edited one has its
 * `font-size` or `fill` rewritten in the same one command as its words,
 * whichever of the two was changed while it was open and differs from its
 * own. The size is the whole text's, since a `<text>` here has one size, and
 * in the options it is the size seen on the canvas, through the text's own
 * `transform` and its layer's, as Photoshop's options show a text that was
 * scaled: a new text is written in it, and an edited one reads back in it.
 * As the field opens on a text, its size and, where it is a plain color, its
 * fill are put in the options (`ToolContext.setOptions`), so the strip shows
 * the text's own, as Photoshop's options bar does, and the first move of the
 * slider does not jump; that is not a change of the user's, and writes
 * nothing. The options stay so when the field closes, so the next new text
 * is in the last one's size, as in Photoshop.
 *
 * The select tool hands it a text to edit on a double press (`edit`): the
 * field opens on that text with the caret where the press was, as
 * Illustrator's and Inkscape's selection tools do.
 *
 * While the field is open on a text, the text is hidden under it, by a rule
 * beside the drawing and not by a change to it (`textHide.ts`). An undo or a
 * redo is not held up by the field, and may move the text, put a copy of its
 * layer in the layer's place, or take it away: the field follows it through
 * each change of the document, which the write finds it by, and hides it
 * wherever it is. One taken away is shown nowhere and written nothing, so
 * the field's words are not written over another text, nor bring back one an
 * undo took away. A field whose drawing leaves the viewport, closed or
 * another opened in its place, is finished as a cancel finishes it.
 */

/** How near a click may be to a text's box and still edit it, in CSS pixels: as near as the select tool's. */
const HIT_SLOP_PX = 4;

/** SVG's font size where nothing sets one: CSS's `medium`. */
const DEFAULT_FONT_SIZE = 16;

/** What a text is painted in where nothing says: SVG's black. */
const DEFAULT_INK = '#000000';

/**
 * What the field is for: a text to add at a point of the drawing, or one of
 * the layer's, with its words, its size in its own units, the color it is
 * seen in and the fill it declares, as they were.
 */
type Target =
	| Readonly<{ kind: 'new'; at: Point }>
	| Readonly<{ kind: 'edit'; before: string; size: number; color: string; fill: string }>;

/** Which of the text's size and color the options changed while the field was open. */
type Touched = Readonly<{ size: boolean; fill: boolean }>;

type Editing = Readonly<{
	/** The latest context, whose options are the ones to write. */
	context: ToolContext;
	target: Target;
	/**
	 * How many of the drawing's units one of the text's own is, by its own
	 * `transform` and its layer's: the options are in the drawing's units, as
	 * the text is seen, and the field is sized and the text written by it.
	 */
	unit: number;
	touched: Touched;
	field: TextField;
	/** The edited text and its layer, as last found; none for a new text. */
	edited: Edited | undefined;
	/** The rule that hides the edited text under the field. */
	hidden: HiddenText;
	/** Stops following the document's changes. */
	unsubscribe: () => void;
}>;

type Opening = Readonly<{
	target: Target;
	spec: FieldSpec;
	unit: number;
	edited: Edited | undefined;
}>;

/** The text's own size and fill, written over: none for one that stays. */
type Restyle = Readonly<{ size: number | undefined; fill: string | undefined }>;

const nothing = (): undefined => undefined;

/** How much a matrix scales a length, as one factor: the square root of what it scales an area by. */
const scaleOf = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** A property as the element sets it, in `style` first, then as an attribute, else up the tree as far as `stopAt`. */
const declaredUp = (element: Element, property: string, stopAt: Element): string | undefined => {
	const styled = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(
		element.getAttribute('style') ?? ''
	);
	const own = styled?.[1]?.trim() ?? element.getAttribute(property)?.trim();
	if (own !== undefined && own !== '') return own;
	const parent = element.parentElement;
	return element === stopAt || parent === null ? undefined : declaredUp(parent, property, stopAt);
};

/** A font size in user units as a file writes it most often: a number, or pixels, which are user units. */
const PLAIN_SIZE = /^(\d+\.?\d*|\.\d+)(?:px)?$/;

/** What the browser makes of an element's style, where there is a window to ask. */
const computedOf = (context: ToolContext, element: Element): CSSStyleDeclaration | undefined =>
	context.host.ownerDocument.defaultView?.getComputedStyle(element);

/**
 * A text's font size in its own user units: as it or a group above it sets
 * it, where that is a plain size, else the browser's reading, which knows
 * `em`, a percentage, a keyword and a stylesheet's rule, else SVG's default.
 */
const fontSizeOf = (context: ToolContext, element: Element): number => {
	const declared = PLAIN_SIZE.exec(declaredUp(element, 'font-size', context.document.root) ?? '');
	if (declared?.[1] !== undefined) return Number(declared[1]);
	const computed = Number.parseFloat(computedOf(context, element)?.fontSize ?? '');
	return Number.isFinite(computed) && computed > 0 ? computed : DEFAULT_FONT_SIZE;
};

/** The face an element's text is drawn in, as the browser reads it; none where it cannot say. */
const familyOf = (context: ToolContext, element: Element): string | undefined => {
	const family = computedOf(context, element)?.fontFamily;
	return family === undefined || family === '' ? undefined : family;
};

/** A plain color to type in: the text's fill, else its stroke; a gradient or nothing is black. */
const inkOfText = (element: Element, root: Element): string => {
	const plain = (paint: string): boolean => paint !== 'none' && !paint.startsWith('url(');
	const fill = paintedColor(element, 'fill', root, DEFAULT_INK);
	if (plain(fill)) return fill;
	const stroke = paintedColor(element, 'stroke', root, 'none');
	return plain(stroke) ? stroke : DEFAULT_INK;
};

/**
 * A text's box: the browser's, or, where it cannot measure (jsdom, and a text
 * not drawn yet), one guessed from its size and lines: an em above the first
 * baseline, a line height for each line after, a quarter em below the last,
 * and six tenths of an em for a character.
 */
const textMeasure =
	(sizeOf: (element: Element) => number): Measure =>
	(element) => {
		const box = measureOf(element);
		if (box.width > 0 || box.height > 0) return box;
		const size = sizeOf(element);
		const lines = linesIn(element);
		return {
			x: firstNumber(element.getAttribute('x')) ?? 0,
			y: (firstNumber(element.getAttribute('y')) ?? 0) - size,
			width: 0.6 * size * Math.max(1, ...lines.map((line) => line.length)),
			height: size * (1.25 + LINE_HEIGHT * Math.max(0, lines.length - 1)),
		};
	};

/** The topmost text of the layer under `point`, in the drawing's units, where it is seen. */
const textAt = (context: ToolContext, layer: Element, point: Point): Element | undefined => {
	const texts = elementsOf(layer).filter((element) => element.localName === 'text');
	const measure = textMeasure((element) => fontSizeOf(context, element));
	const slop = HIT_SLOP_PX / context.viewport.scale;
	return elementsAt(texts, point, measure, slop, layerSpace(layer).outOf).at(-1);
};

/**
 * A new text at `at`, in the drawing's units, in the options' size and color
 * as it will be seen: one of its units is one of the drawing's, however the
 * layer is placed (`newElementSpace`).
 */
const newText = (context: ToolContext, layer: Element, at: Point): Opening => ({
	target: { kind: 'new', at },
	unit: 1,
	edited: undefined,
	spec: {
		at,
		size: context.options.fontSize,
		color: inkOf(context.options, 'fill'),
		family: familyOf(context, layer),
		initial: '',
	},
});

/** The text `text`, at its first baseline, in its own size, color and face, as placed in the drawing. */
const existingText = (context: ToolContext, layer: Element, text: Element): Opening | undefined => {
	if (positionsIn(layer, [text]).length === 0) return undefined;
	const placement = multiply(
		layerSpace(layer).outOf,
		parseTransform(text.getAttribute('transform'))
	);
	const before = linesIn(text).join('\n');
	const anchor = {
		x: firstNumber(text.getAttribute('x')) ?? 0,
		y: firstNumber(text.getAttribute('y')) ?? 0,
	};
	const { root } = context.document;
	const size = fontSizeOf(context, text);
	const color = inkOfText(text, root);
	const unit = scaleOf(placement);
	return {
		target: {
			kind: 'edit',
			before,
			size,
			color,
			fill: paintedColor(text, 'fill', root, DEFAULT_INK),
		},
		unit,
		edited: { layer, element: text },
		spec: {
			at: apply(placement, anchor),
			size: size * unit,
			color,
			family: familyOf(context, text),
			initial: before,
		},
	};
};

type Placed = Readonly<{ element: Element; at: number }>;

/**
 * The edited text found again after a change of the document, in the active
 * layer, which the write uses: itself, wherever it now is among the layer's
 * elements, while it is one of them; where an undo or a redo put a copy of
 * the layer in its place, the text there that is the same as it, the nearest
 * to its place if there are more, else the text at its place, the change
 * having made it over; none once it is gone.
 */
const refound = (context: ToolContext, last: Edited): Edited | undefined => {
	const layer = activeLayerElement(context);
	if (layer === undefined) return undefined;
	const own = elementsOf(layer);
	if (own.includes(last.element)) return { layer, element: last.element };
	// Taken out of a layer that is still the one it was in.
	if (layer === last.layer) return undefined;
	const [place = -1] = positionsIn(last.layer, [last.element]);
	const texts = own.flatMap((element, at): Placed[] =>
		element.localName === 'text' ? [{ element, at }] : []
	);
	const nearer = (best: Placed | undefined, each: Placed): Placed =>
		best === undefined || Math.abs(each.at - place) < Math.abs(best.at - place) ? each : best;
	const same = texts
		.filter(({ element }) => element.isEqualNode(last.element))
		.reduce<Placed | undefined>(nearer, undefined);
	const element = (same ?? texts.find(({ at }) => at === place))?.element;
	return element === undefined ? undefined : { layer, element };
};

/**
 * The size, as it is seen in the drawing's units, and the color the field
 * shows: the options' for a new text, and for an edited one wherever they
 * were changed while it was open; the text's own otherwise.
 */
const lookOf = (editing: Editing): FieldLook => {
	const { context, target, touched, unit } = editing;
	const ink = inkOf(context.options, 'fill');
	if (target.kind === 'new') return { size: context.options.fontSize, color: ink };
	return {
		size: touched.size ? context.options.fontSize : target.size * unit,
		color: touched.fill ? ink : target.color,
	};
};

/** Whether a style declares `property`, which would win over the attribute. */
const declares = (style: string, property: string): boolean =>
	new RegExp(`(?:^|;)\\s*${property}\\s*:`, 'i').test(style);

/** `property` taken out of the element's `style`, and the `style` with it once nothing is left. */
const unstyle = (element: Element, property: string): void => {
	const style = element.getAttribute('style');
	if (style === null || !declares(style, property)) return;
	const rest = withoutStyleProperty(style, property);
	if (rest === '') {
		element.removeAttribute('style');
		return;
	}
	element.setAttribute('style', rest);
};

/**
 * `property` given the text as an attribute, as a new text has it, and taken
 * out of whatever would win over it or hide it: its `style`, and its
 * `<tspan>`s, which Inkscape gives a size of their own. A text here has one
 * size and one color.
 */
const setThroughout = (text: Element, property: string, value: string): void => {
	unstyle(text, property);
	text.querySelectorAll('tspan').forEach((tspan) => {
		unstyle(tspan, property);
		tspan.removeAttribute(property);
	});
	text.setAttribute(property, value);
};

/** A new `<text>` of `lines`, at `at` in the drawing's units, added to the active layer upright. */
const writeNew = (context: ToolContext, at: Point, lines: readonly string[]): void => {
	const layer = targetLayer(context);
	if (layer === undefined) return;
	const { into, transform } = newElementSpace(layer);
	const point = apply(into, at);
	const attributes = {
		x: rounded(point.x),
		y: rounded(point.y),
		'font-size': context.options.fontSize,
		// Named, so the text is the same face in the editor, in a thumbnail and in
		// another tool; inherited, it would be the app's font here and a serif there.
		'font-family': 'sans-serif',
		fill: inkOf(context.options, 'fill'),
		transform,
	};
	context.document.execute(
		editLayer(layer.id, 'tools.text', (g: Element) => {
			const text = createSvg(g.ownerDocument, 'text', attributes);
			fillText(text, lines);
			g.appendChild(text);
		})
	);
};

/**
 * The text at `position` given `lines` for its words, or taken away for none,
 * and its size and fill rewritten where `restyle` says; its words kept for no
 * `lines`. Found by its place in the layer, as the layer is when the command
 * runs: the wrapping of a loose layer, or an undo, replaces the element itself.
 */
const rewrite = (
	context: ToolContext,
	position: number,
	lines: readonly string[] | undefined,
	restyle: Restyle
): void => {
	const layer = targetLayer(context);
	if (layer === undefined) return;
	const blank = lines !== undefined && isBlank(lines);
	context.document.execute(
		editLayer(layer.id, 'tools.text', (g: Element) => {
			elementsAtPositions(g, [position])
				.filter((element) => element.localName === 'text')
				.forEach((text) => {
					if (blank) {
						text.remove();
						return;
					}
					if (lines !== undefined) fillText(text, lines);
					if (restyle.size !== undefined) {
						setThroughout(text, 'font-size', String(restyle.size));
					}
					if (restyle.fill !== undefined) setThroughout(text, 'fill', restyle.fill);
				});
		})
	);
};

/**
 * What the field held, written: nothing for a new text left blank, for an
 * edit that changed neither the words nor, of what the options changed while
 * it was open, the size or the fill, or for one whose text is gone.
 */
const write = (editing: Editing, value: string): void => {
	const { context, target, touched, edited, unit } = editing;
	const lines = linesOf(value);
	if (target.kind === 'new') {
		if (!isBlank(lines)) writeNew(context, target.at, lines);
		return;
	}
	const found = edited === undefined ? undefined : refound(context, edited);
	const [position] = found === undefined ? [] : positionsIn(found.layer, [found.element]);
	if (position === undefined) return;
	const size = rounded(context.options.fontSize / unit);
	const ink = inkOf(context.options, 'fill');
	const restyle = {
		size: touched.size && size !== rounded(target.size) ? size : undefined,
		fill: touched.fill && ink !== target.fill ? ink : undefined,
	};
	const words = value === target.before ? undefined : lines;
	if (words === undefined && restyle.size === undefined && restyle.fill === undefined) return;
	rewrite(context, position, words, restyle);
};

const UNTOUCHED: Touched = { size: false, fill: false };

/**
 * An edited text's own size and fill as options: the size as it is seen, in
 * the drawing's units by `unit`, to two decimals as a coordinate is written,
 * and the fill where it is a plain color, as `#rrggbb`; none for a new text.
 */
const optionsOf = (target: Target, unit: number): Partial<ToolOptions> => {
	if (target.kind === 'new') return {};
	const fill = toHex(target.fill);
	return {
		fontSize: rounded(target.size * unit),
		...(fill === undefined ? {} : { fill }),
	};
};

export const createText = (): ToolBehavior => {
	const editing = cell<Editing | undefined>(undefined);
	/** A press that will open a field when it lifts. */
	const pressed = cell<Opening | undefined>(undefined);

	/** The field closed and what it held written; with a key, the canvas has the focus back. */
	const finish = (how: FieldEnd | 'press' | 'cancel'): void => {
		const current = editing.current;
		if (current === undefined) return;
		editing.current = undefined;
		current.unsubscribe();
		current.hidden.remove();
		const value = current.field.value();
		current.field.remove();
		if (how === 'key') current.context.host.focus({ preventScroll: true });
		write(current, value);
	};

	/** The edited text found again after a change of the document, and hidden where it now is. */
	const follow = (current: Editing): void => {
		const found =
			current.edited === undefined ? undefined : refound(current.context, current.edited);
		if (found !== undefined) editing.current = { ...current, edited: found };
		current.hidden.hide(found);
	};

	/**
	 * The field opened, an edited text's own options put in the strip, and the
	 * text hidden under it and followed through the document's changes. The
	 * context is taken to have the options already, so that `optionsChanged`,
	 * which they bring, finds nothing touched.
	 */
	const open = (context: ToolContext, opening: Opening, caretAt?: Point): void => {
		const own = context.setOptions === undefined ? {} : optionsOf(opening.target, opening.unit);
		const field = openTextField(context, opening.spec, finish, caretAt);
		const mine = (): Editing | undefined =>
			editing.current?.field === field ? editing.current : undefined;
		const { edited } = opening;
		const hidden = hideText(context.document.root, () => {
			if (mine() !== undefined) finish('cancel');
		});
		editing.current = {
			context: { ...context, options: { ...context.options, ...own } },
			target: opening.target,
			unit: opening.unit,
			touched: UNTOUCHED,
			field,
			edited,
			hidden,
			unsubscribe:
				edited === undefined
					? nothing
					: context.document.subscribe(() => {
							const current = mine();
							if (current !== undefined) follow(current);
						}),
		};
		hidden.hide(edited);
		if (Object.keys(own).length > 0) context.setOptions?.(own);
	};

	return {
		begin: (context, sample) => {
			pressed.current = undefined;
			const previous = editing.current;
			finish('press');
			// A field on this canvas is finished by the press; one left on a
			// canvas no longer shown is not what this press was about.
			if (previous?.context.host === context.host) return;
			if (guardLayer(context) === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			const at = { x: sample.x, y: sample.y };
			const hit = textAt(context, layer, at);
			pressed.current =
				hit === undefined ? newText(context, layer, at) : existingText(context, layer, hit);
		},
		move: nothing,
		end: (context) => {
			const opening = pressed.current;
			pressed.current = undefined;
			if (opening !== undefined) open(context, opening);
		},
		cancel: () => {
			pressed.current = undefined;
			finish('cancel');
		},

		// The field takes up the new options, and shows them.
		optionsChanged: (context) => {
			const current = editing.current;
			if (current === undefined || current.context.host !== context.host) return;
			const before = current.context.options;
			const now = context.options;
			const next: Editing = {
				...current,
				context,
				touched: {
					size: current.touched.size || now.fontSize !== before.fontSize,
					fill: current.touched.fill || inkOf(now, 'fill') !== inkOf(before, 'fill'),
				},
			};
			editing.current = next;
			current.field.restyle(lookOf(next));
		},

		// A text the select tool was double-pressed on: the field on its words,
		// the caret at the press.
		edit: (context, { element, at }) => {
			pressed.current = undefined;
			finish('cancel');
			if (guardLayer(context) === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined || element.localName !== 'text') return;
			if (!elementsOf(layer).includes(element)) return;
			const opening = existingText(context, layer, element);
			if (opening !== undefined) open(context, opening, at);
		},
	};
};
