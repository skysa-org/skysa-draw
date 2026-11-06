import { t } from '../../../i18n/t.js';
import { editLayer } from '../../document/commands.js';
import { type Arrangement, arrangementOffsets } from '../common/align.js';
import type { AlignTo, ToolContext } from '../types.js';
import { formatTransform, parseTransform, translate } from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace, targetLayer } from './guard.js';
import { elementsAtPositions, placedBox, positionsIn } from './hit.js';
import type { Measure } from './measure.js';
import { showSelection } from './region.js';
import { movedBy, setTransform } from './select.js';

/**
 * The move tool's alignment of what is selected on a vector layer
 * (docs/decisions/0004-the-interface.md, "Align and distribute"), as
 * Photoshop's path selection tool aligns the paths it has selected and
 * Illustrator its objects: the same buttons and the same menu as for layers
 * (`common/align.ts`), done to the elements instead, each measured by its box
 * as it is seen on the canvas, its own `transform` and its layer's boxed as
 * one, and each moved by its own `transform`, as a drag of them moves them
 * (`select.ts`, `movedBy`).
 *
 * Aligned to the selection, they line up with the area where one is
 * selected, else with the box around them all, where two or more were
 * measured, else, one alone, with the canvas, as a layer does. One command
 * moves them, a layer edit as a drag's is, so one undo puts them back; an
 * element already where it would go is left as it is, and one with no box,
 * an empty group, stays where it is. What was selected stays selected, found
 * again after the edit by where each is in the layer, and its box is drawn
 * again around where it went.
 */
export const arrangeElements = (
	context: ToolContext,
	arrangement: Arrangement,
	alignTo: AlignTo,
	measure: Measure
): boolean => {
	if (guardLayer(context) === undefined) return false;
	const before = activeLayerElement(context);
	if (before === undefined) return false;
	const positions = positionsIn(before, context.selection.elements);
	const { outOf } = layerSpace(before);
	const measured = positions.flatMap((position) =>
		elementsAtPositions(before, [position])
			.map((element) => ({ position, box: placedBox(measure, element, outOf) }))
			.filter(({ box }) => box.width > 0 || box.height > 0)
	);
	if (measured.length === 0) {
		context.notify(t('tools.align.nothing'));
		return false;
	}
	const offsets = arrangementOffsets(
		context,
		arrangement,
		alignTo,
		measured.map(({ box }) => box)
	);
	const moving = measured.flatMap(({ position }, index) => {
		const [dx, dy] = offsets[index] ?? [0, 0];
		return dx === 0 && dy === 0 ? [] : [{ position, dx, dy }];
	});
	if (moving.length === 0) return false;
	// Found again, and their space read again, after the wrapping of a loose
	// layer, which may have moved them and their `transform`.
	const layer = targetLayer(context);
	if (layer === undefined) return false;
	const space = layerSpace(layer);
	const finals = moving.flatMap(({ position, dx, dy }) =>
		elementsAtPositions(layer, [position]).flatMap((element) => {
			const matrix = parseTransform(element.getAttribute('transform'));
			const value = movedBy(translate(dx, dy), space, matrix);
			return value === formatTransform(matrix) ? [] : [{ position, value }];
		})
	);
	if (finals.length === 0) return false;
	context.document.execute(
		editLayer(
			layer.id,
			arrangement.kind === 'align' ? 'tools.align.aligned' : 'tools.align.distributed',
			(g: Element) => {
				finals.forEach(({ position, value }) =>
					elementsAtPositions(g, [position]).forEach((element) =>
						setTransform(element, value)
					)
				);
			}
		)
	);
	const now = elementsAtPositions(context.document.layer(layer.id), positions);
	context.selection.set(now);
	showSelection(context, now, true);
	return true;
};
