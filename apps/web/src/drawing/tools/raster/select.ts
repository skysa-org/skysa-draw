import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import { movedTransform, setTransform, translated } from '../common/layersMove.js';
import type { ToolBehavior, ToolContext } from '../types.js';
import { guardedLayer } from './guard.js';
import { createAreaMove } from './move.js';
import type { Point } from './pixels.js';

/**
 * Select on a raster layer (docs/decisions/0004-the-interface.md): with an
 * area that reaches the layer, or pixels still afloat from the last move,
 * the drag moves the area's pixels (`move.ts`), as Photoshop's move tool
 * does; otherwise the layer moves as a whole, as a `transform` on its `<g>`,
 * never a resample (docs/ARCHITECTURE.md §7, "The editor"). That drag changes
 * the attribute live; at its end the original is put back and the move is
 * executed as a command, so the history holds the layer before and after and
 * nothing else. Resize and rotate of a raster layer are not here yet.
 */

interface Move {
	readonly layerId: string;
	readonly start: Point;
	/** The `transform` as it was, or `null` for none. */
	readonly original: string | null;
}

/**
 * The transform the drag gives the layer, from the pointer's move in the
 * root's units: a translation in front of the original, in the units of the
 * layer's parent, as the move of layers whole writes it (`movedTransform`).
 */
const movedTo = (
	context: ToolContext,
	element: SVGGraphicsElement,
	move: Move,
	sample: Point
): string | undefined =>
	movedTransform(
		element,
		context.document.root,
		move.original,
		sample.x - move.start.x,
		sample.y - move.start.y
	);

const createSelect = (): ToolBehavior => {
	const active = cell<Move | undefined>(undefined);
	const area = createAreaMove();

	/** The attribute as it was before the drag, back on the live element. */
	const restore = (element: Element | undefined, move: Move): void => {
		if (element !== undefined) setTransform(element, move.original);
	};

	return {
		begin: (context, sample) => {
			const layer = guardedLayer(context);
			if (layer === undefined || area.begin(context, sample)) return;
			const element = context.document.layer(layer.id);
			if (element === undefined) return;
			active.current = {
				layerId: layer.id,
				start: { x: sample.x, y: sample.y },
				original: element.getAttribute('transform'),
			};
		},
		move: (context, sample) => {
			area.move(context, sample);
			const move = active.current;
			if (move === undefined) return;
			const element = context.document.layer(move.layerId);
			if (element === undefined) return;
			setTransform(element, movedTo(context, element, move, sample));
		},
		end: (context, sample) => {
			area.end(context, sample);
			const move = active.current;
			if (move === undefined) return;
			active.current = undefined;
			const element = context.document.layer(move.layerId);
			// Back to the original before the command runs: `editLayer` reads the
			// layer before and after its change, and the live drag was not a change.
			restore(element, move);
			if (element === undefined) return;
			const final = movedTo(context, element, move, sample);
			// A click, or a drag back to where it began, moved nothing.
			if (final === translated(move.original, 0, 0)) return;
			context.document.execute(
				editLayer(move.layerId, 'tools.select', (layer: SVGGraphicsElement) =>
					setTransform(layer, final)
				)
			);
		},
		cancel: (context) => {
			area.cancel(context);
			const move = active.current;
			active.current = undefined;
			if (move !== undefined) restore(context.document.layer(move.layerId), move);
		},
	};
};

export const select: ToolBehavior = createSelect();
