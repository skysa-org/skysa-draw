import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import type { ToolBehaviour, ToolContext } from '../types.js';
import { apply, type Mat, multiply, parseTransform, type Point } from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace, targetLayer } from './guard.js';
import { elementsAt, elementsAtPositions, elementsOf, paintedColour, positionsIn } from './hit.js';
import { type Measure, measureOf } from './measure.js';
import { createSvg, inkOf } from './svg.js';
import { type FieldEnd, type FieldSpec, openTextField, type TextField } from './textField.js';
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
 * of the font size and the fill colour in the options, or the edited text's
 * words in place of its old ones, its own attributes kept. Nothing typed
 * writes nothing; an edited text emptied is removed.
 */

/** How near a click may be to a text's box and still edit it, in CSS pixels: as near as the select tool's. */
const HIT_SLOP_PX = 4;

/** SVG's font size where nothing sets one: CSS's `medium`. */
const DEFAULT_FONT_SIZE = 16;

/** What a text is painted in where nothing says: SVG's black. */
const DEFAULT_INK = '#000000';

/** What the field is for: a text to add at a point of the drawing, or the one at a place in the layer. */
type Target =
	| Readonly<{ kind: 'new'; at: Point }>
	| Readonly<{ kind: 'edit'; position: number; before: string }>;

type Editing = Readonly<{ context: ToolContext; target: Target; field: TextField }>;

type Opening = Readonly<{ target: Target; spec: FieldSpec }>;

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

/** A plain colour to type in: the text's fill, else its stroke; a gradient or nothing is black. */
const inkOfText = (element: Element, root: Element): string => {
	const plain = (paint: string): boolean => paint !== 'none' && !paint.startsWith('url(');
	const fill = paintedColour(element, 'fill', root, DEFAULT_INK);
	if (plain(fill)) return fill;
	const stroke = paintedColour(element, 'stroke', root, 'none');
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

/** The topmost text of the layer under `point`, in the layer's units. */
const textAt = (context: ToolContext, layer: Element, point: Point): Element | undefined => {
	const texts = elementsOf(layer).filter((element) => element.localName === 'text');
	const measure = textMeasure((element) => fontSizeOf(context, element));
	return elementsAt(texts, point, measure, HIT_SLOP_PX / context.viewport.scale).at(-1);
};

/** A new text at `at`, in the drawing's units, in the options' size and colour, scaled as the layer is. */
const newText = (context: ToolContext, layer: Element, at: Point): Opening => ({
	target: { kind: 'new', at },
	spec: {
		at,
		size: context.options.fontSize * scaleOf(layerSpace(layer).outOf),
		colour: inkOf(context.options, 'fill'),
		family: familyOf(context, layer),
		initial: '',
	},
});

/** The text `text`, at its first baseline, in its own size, colour and face, as placed in the drawing. */
const existingText = (context: ToolContext, layer: Element, text: Element): Opening | undefined => {
	const [position] = positionsIn(layer, [text]);
	if (position === undefined) return undefined;
	const placement = multiply(
		layerSpace(layer).outOf,
		parseTransform(text.getAttribute('transform'))
	);
	const before = linesIn(text).join('\n');
	const anchor = {
		x: firstNumber(text.getAttribute('x')) ?? 0,
		y: firstNumber(text.getAttribute('y')) ?? 0,
	};
	return {
		target: { kind: 'edit', position, before },
		spec: {
			at: apply(placement, anchor),
			size: fontSizeOf(context, text) * scaleOf(placement),
			colour: inkOfText(text, context.document.root),
			family: familyOf(context, text),
			initial: before,
		},
	};
};

/** A new `<text>` of `lines`, at `at` in the drawing's units, added to the active layer. */
const writeNew = (context: ToolContext, at: Point, lines: readonly string[]): void => {
	const layer = targetLayer(context);
	if (layer === undefined) return;
	const point = apply(layerSpace(layer).into, at);
	const attributes = {
		x: rounded(point.x),
		y: rounded(point.y),
		'font-size': context.options.fontSize,
		// Named, so the text is the same face in the editor, in a thumbnail and in
		// another tool; inherited, it would be the app's font here and a serif there.
		'font-family': 'sans-serif',
		fill: inkOf(context.options, 'fill'),
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
 * The text at `position` given `lines` for its words, or taken away for none.
 * Found by its place in the layer, as the layer is when the command runs: the
 * wrapping of a loose layer, or an undo, replaces the element itself.
 */
const rewrite = (context: ToolContext, position: number, lines: readonly string[]): void => {
	const layer = targetLayer(context);
	if (layer === undefined) return;
	const blank = isBlank(lines);
	context.document.execute(
		editLayer(layer.id, 'tools.text', (g: Element) => {
			elementsAtPositions(g, [position])
				.filter((element) => element.localName === 'text')
				.forEach((text) => {
					if (blank) {
						text.remove();
						return;
					}
					fillText(text, lines);
				});
		})
	);
};

/** What the field held, written: nothing for a new text left blank, or for an edit that changed nothing. */
const write = (context: ToolContext, target: Target, value: string): void => {
	const lines = linesOf(value);
	if (target.kind === 'new') {
		if (!isBlank(lines)) writeNew(context, target.at, lines);
		return;
	}
	if (value !== target.before) rewrite(context, target.position, lines);
};

export const createText = (): ToolBehaviour => {
	const editing = cell<Editing | undefined>(undefined);
	/** A press that will open a field when it lifts. */
	const pressed = cell<Opening | undefined>(undefined);

	/** The field closed and what it held written; with a key, the canvas has the focus back. */
	const finish = (how: FieldEnd | 'press' | 'cancel'): void => {
		const current = editing.current;
		if (current === undefined) return;
		editing.current = undefined;
		const value = current.field.value();
		current.field.remove();
		if (how === 'key') current.context.host.focus({ preventScroll: true });
		write(current.context, current.target, value);
	};

	return {
		begin: (context, sample) => {
			pressed.current = undefined;
			const open = editing.current;
			finish('press');
			// A field on this canvas is finished by the press; one left on a
			// canvas no longer shown is not what this press was about.
			if (open?.context.host === context.host) return;
			if (guardLayer(context) === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			const at = { x: sample.x, y: sample.y };
			const hit = textAt(context, layer, apply(layerSpace(layer).into, at));
			pressed.current =
				hit === undefined ? newText(context, layer, at) : existingText(context, layer, hit);
		},
		move: nothing,
		end: (context) => {
			const opening = pressed.current;
			pressed.current = undefined;
			if (opening === undefined) return;
			editing.current = {
				context,
				target: opening.target,
				field: openTextField(context, opening.spec, finish),
			};
		},
		cancel: () => {
			pressed.current = undefined;
			finish('cancel');
		},
	};
};
