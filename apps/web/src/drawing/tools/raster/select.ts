import { cell } from '@skysa/draw-core';

import { type ClipPreview, keepingClips, previewClips } from '../../document/clip.js';
import { editLayer } from '../../document/commands.js';
import type { Offset } from '../common/align.js';
import { movedTransform, setTransform, translated } from '../common/layersMove.js';
import { createDragSnap, type ExtentOf } from '../common/snap.js';
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
 * nothing else. The drag snaps the layer to the canvas and to the other
 * layers (`snap.ts`). A clipped layer's clip stays where the layer below
 * is, live and in the command (`previewClips`, `keepingClips`). Resize and
 * rotate of a raster layer are not here yet.
 */

interface Move {
	readonly layerId: string;
	readonly start: Point;
	/** The `transform` as it was, or `null` for none. */
	readonly original: string | null;
	/** The layer's clip, kept as the drag goes. */
	readonly clips: ClipPreview;
}

/** How far the drag has taken the pointer, in the root's units. */
const offsetOf = (move: Move, sample: Point): Offset => [
	sample.x - move.start.x,
	sample.y - move.start.y,
];

/**
 * The transform the drag gives the layer, from its offset in the root's
 * units: a translation in front of the original, in the units of the layer's
 * parent, as the move of layers whole writes it (`movedTransform`).
 */
const movedTo = (
	context: ToolContext,
	element: SVGGraphicsElement,
	move: Move,
	[dx, dy]: Offset
): string | undefined => movedTransform(element, context.document.root, move.original, dx, dy);

/**
 * The move tool on a raster layer: the area's pixels where an area reaches
 * the layer (`move.ts`), else the layer whole, its drag snapping what the
 * layer paints to the canvas and the other layers (`snap.ts`), measured by
 * `extentOf`, the browser's where none is given. The area's pixels do not
 * snap: they move by the layer's whole pixels, which would round a snapped
 * offset off the line it snapped to.
 */
export const createSelect = (extentOf?: ExtentOf): ToolBehavior => {
	const active = cell<Move | undefined>(undefined);
	const area = createAreaMove();
	const snap = createDragSnap(extentOf);

	/** The attribute as it was before the drag, back on the live element, and its clip. */
	const restore = (element: Element | undefined, move: Move): void => {
		move.clips.putBack();
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
				clips: previewClips(context.document.root),
			};
			snap.beginLayers(context, [layer.id]);
		},
		move: (context, sample) => {
			area.move(context, sample);
			const move = active.current;
			if (move === undefined) return;
			const element = context.document.layer(move.layerId);
			if (element === undefined) return;
			const offset = snap.move(context, sample, offsetOf(move, sample));
			setTransform(element, movedTo(context, element, move, offset));
			move.clips.follow();
		},
		end: (context, sample) => {
			area.end(context, sample);
			const move = active.current;
			if (move === undefined) return;
			active.current = undefined;
			const offset = snap.end(context, sample, offsetOf(move, sample));
			const element = context.document.layer(move.layerId);
			// Back to the original before the command runs: `editLayer` reads the
			// layer before and after its change, and the live drag was not a change.
			restore(element, move);
			if (element === undefined) return;
			const final = movedTo(context, element, move, offset);
			// A click, or a drag back to where it began, moved nothing.
			if (final === translated(move.original, 0, 0)) return;
			context.document.execute(
				keepingClips(
					editLayer(move.layerId, 'tools.select', (layer: SVGGraphicsElement) =>
						setTransform(layer, final)
					)
				)
			);
		},
		cancel: (context) => {
			area.cancel(context);
			snap.cancel(context);
			const move = active.current;
			active.current = undefined;
			if (move !== undefined) restore(context.document.layer(move.layerId), move);
		},
	};
};

export const select: ToolBehavior = createSelect();
