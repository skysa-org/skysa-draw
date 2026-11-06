import { DEFAULT_DRAWING_SIZE } from '@skysa/draw-core';
import { expect } from 'vitest';

import {
	formatFineTransform,
	IDENTITY,
	type Mat,
	multiply,
	parseTransform,
	rotate,
	translate,
} from '../../src/drawing/tools/vector/geometry.js';

/**
 * The placements a layer is given that are more than a move, for the tests of
 * what a vector tool draws on one (`newElementSpace`, `tools/vector/guard.ts`):
 * the `transform`s the Image operations write on the default canvas
 * (`document/canvasOps.ts`), a quarter turn clockwise, a flip across and a
 * turn of 30° about the middle with the canvas grown to hold it, Image size
 * at half without resampling, and Free Transform scaling a layer more one way
 * than the other.
 */
const { width, height } = DEFAULT_DRAWING_SIZE;

/** The canvas a 30° turn grows the default one to, as `rotateCanvas` works it out. */
const TURNED_WIDTH = Math.ceil(width * Math.cos(Math.PI / 6) + height * Math.sin(Math.PI / 6));
const TURNED_HEIGHT = Math.ceil(width * Math.sin(Math.PI / 6) + height * Math.cos(Math.PI / 6));

export const PLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	['turned a quarter', `matrix(0 1 -1 0 ${height} 0)`],
	['flipped across', `matrix(-1 0 0 1 ${width} 0)`],
	[
		'turned 30°',
		formatFineTransform(
			multiply(
				translate((TURNED_WIDTH - width) / 2, (TURNED_HEIGHT - height) / 2),
				rotate(30, { x: width / 2, y: height / 2 })
			)
		),
	],
	['scaled by half', 'matrix(0.5 0 0 0.5 0 0)'],
	['stretched one way', 'matrix(2 0 0 0.5 10 20)'],
];

/** Where an element's own numbers are drawn: its `transform` after every ancestor's, up to the root. */
export const onCanvas = (element: Element | null | undefined): Mat =>
	element === null || element === undefined || element.localName === 'svg'
		? IDENTITY
		: multiply(
				onCanvas(element.parentElement),
				parseTransform(element.getAttribute('transform'))
			);

/**
 * That an element's numbers are the canvas's: what places it, its layer's
 * `transform` and its own, comes to nothing, so it is upright, unmirrored and
 * at the size its attributes say, where they say. The turn, flip and scale to
 * a millionth, and the move to a ten-thousandth of a unit, the nine places a
 * matrix is written to.
 */
export const expectOnCanvasAsWritten = (element: Element | null | undefined): void => {
	const [a, b, c, d, e, f] = onCanvas(element);
	[a - 1, b, c, d - 1].forEach((value) => expect(Math.abs(value)).toBeLessThan(1e-6));
	[e, f].forEach((value) => expect(Math.abs(value)).toBeLessThan(1e-4));
};

/** An element's attributes, but its `transform`, by name: to compare with what the same gesture draws on a layer at rest. */
export const attributesBut = (
	element: Element | null | undefined
): Readonly<Record<string, string>> =>
	Object.fromEntries(
		[...(element?.attributes ?? [])]
			.filter((attribute) => attribute.name !== 'transform')
			.map((attribute) => [attribute.name, attribute.value])
	);
