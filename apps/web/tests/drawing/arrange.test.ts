import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	canPlaceLayers,
	canStepLayers,
	duplicateLayers,
	groupLayers,
	type LayerPlace,
	outermostLayers,
	placeLayers,
	removeLayers,
	stepLayers,
} from '../../src/drawing/document/arrange.js';
import { duplicateLayer, editLayer, moveLayer } from '../../src/drawing/document/commands.js';
import { groupLayer } from '../../src/drawing/document/groups.js';
import { giveLayerIds, layerById, layersOf } from '../../src/drawing/document/layers.js';
import type { Command, EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { parseDrawing } from '../../src/drawing/document/sanitize.js';
import {
	IDENTITY,
	type Mat,
	multiply,
	parseTransform,
} from '../../src/drawing/tools/vector/geometry.js';

/**
 * The layers moved as a selection (docs/ARCHITECTURE.md §3, "Layers"): placed
 * anywhere in the stack, into a group and out of one, stepped up and down,
 * grouped, deleted and duplicated together. That each acts on the outermost
 * of the layers chosen, draws every layer where it was drawn, does nothing
 * and costs nothing where there is nothing to do, and undoes itself exactly,
 * in the XML document and in the page, and through a document whose later
 * edits replace the layers and the groups it moved.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/**
 * Paint order 1 to 9. Layer 3 is a group moved by `translate(10 20)` holding
 * 4, 5 (scaled) and the group 6, which holds 7; layer 8 is an empty group
 * scaled by 2.
 */
const DRAWING = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="d1" viewBox="0 0 100 100">
  <title>Harbor</title>
  <g id="layer-1" draw:kind="vector"><rect id="hull" width="1" height="1"/></g>
  <g id="layer-2" draw:kind="vector" transform="translate(3 4)"><rect width="2" height="2"/></g>
  <g id="layer-3" draw:kind="group" draw:name="Boats" transform="translate(10 20)">
    <g id="layer-4" draw:kind="vector"><path d="M0 0"/></g>
    <g id="layer-5" draw:kind="vector" transform="scale(2)"><path d="M1 1"/></g>
    <g id="layer-6" draw:kind="group">
      <g id="layer-7" draw:kind="vector"><path d="M2 2"/></g>
    </g>
  </g>
  <g id="layer-8" draw:kind="group" transform="scale(2)"/>
  <g id="layer-9" draw:kind="raster">
    <image href="${PNG}" x="0" y="0" width="10" height="10" preserveAspectRatio="none"/>
  </g>
</svg>
`;

const placements = ['in its own document', 'in the page'] as const;

type Placement = (typeof placements)[number];

const open = (text: string, placement: Placement): SVGSVGElement => {
	const parsed = parseDrawing(text);
	if (parsed === undefined) throw new Error('the test drawing parses');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	giveLayerIds(root);
	if (placement === 'in the page') window.document.body.appendChild(root);
	return root;
};

const opened = (text = DRAWING): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('the test drawing opens');
	return document;
};

afterEach(() => {
	window.document.body.replaceChildren();
});

const serialized = (root: Element): string => new XMLSerializer().serializeToString(root);

/** Applied, reverted, applied again and reverted again: the same root each way. */
const roundTrips = (root: SVGSVGElement, command: Command): string => {
	const before = serialized(root);
	command.apply(root);
	const after = serialized(root);
	expect(after).not.toBe(before);
	expect(command.bytes).toBeGreaterThan(0);
	command.revert(root);
	expect(serialized(root)).toBe(before);
	command.apply(root);
	expect(serialized(root)).toBe(after);
	command.revert(root);
	expect(serialized(root)).toBe(before);
	command.apply(root);
	return after;
};

/** Applied, changing nothing and costing nothing. */
const changesNothing = (root: SVGSVGElement, command: Command): void => {
	const before = serialized(root);
	command.apply(root);
	expect(command.bytes).toBe(0);
	expect(serialized(root)).toBe(before);
};

const ids = (root: Element): readonly string[] => layersOf(root).map((layer) => layer.id);

/** Each layer as `id` in `parent`, in paint order, so where everything is reads as one list. */
const tree = (root: Element): readonly string[] =>
	layersOf(root).map((layer) => `${layer.id}<${layer.parentId ?? 'root'}`);

const childrenOf = (root: Element, id: string | undefined): readonly string[] =>
	layersOf(root)
		.filter((layer) => layer.parentId === id)
		.map((layer) => layer.id);

/** Where a layer is drawn: its transform and every group's around it, as one matrix. */
const drawnAt = (root: Element, id: string): Mat => {
	const chain = (element: Element | null): Mat =>
		element === null || element === root
			? IDENTITY
			: multiply(
					chain(element.parentElement),
					parseTransform(element.getAttribute('transform'))
				);
	return chain(layerById(root, id) ?? null);
};

const expectDrawnAlike = (one: Mat, other: Mat): void => {
	one.forEach((value, i) => {
		expect(value).toBeCloseTo(other[i] ?? Number.NaN, 4);
	});
};

/** Every layer drawn where it was before `change`, wherever it went. */
const keepsDrawn = (root: SVGSVGElement, change: () => void): void => {
	const before = new Map(ids(root).map((id) => [id, drawnAt(root, id)]));
	change();
	before.forEach((matrix, id) => {
		expectDrawnAlike(drawnAt(root, id), matrix);
	});
};

const transformOf = (root: Element, id: string): string | null =>
	layerById(root, id)?.getAttribute('transform') ?? null;

describe.each(placements)('with the root %s', (placement) => {
	const root = (text = DRAWING): SVGSVGElement => open(text, placement);

	describe('the outermost layers', () => {
		it('are in paint order, bottom first, whatever order they are named in', () => {
			expect(outermostLayers(root(), ['layer-9', 'layer-1', 'layer-4'])).toEqual([
				'layer-1',
				'layer-4',
				'layer-9',
			]);
		});

		it('leave out a layer inside a chosen group, at any depth', () => {
			const live = root();
			expect(outermostLayers(live, ['layer-7', 'layer-3', 'layer-5', 'layer-2'])).toEqual([
				'layer-2',
				'layer-3',
			]);
			// The group around layer 7 is not chosen, so both stay.
			expect(outermostLayers(live, ['layer-7', 'layer-4'])).toEqual(['layer-4', 'layer-7']);
		});

		it('name each once, and leave out what is not a layer', () => {
			expect(outermostLayers(root(), ['layer-1', 'nothing', 'layer-1', 'hull'])).toEqual([
				'layer-1',
			]);
			expect(outermostLayers(root(), [])).toEqual([]);
		});
	});

	describe('placing', () => {
		const cannot: readonly (readonly [string, readonly string[], LayerPlace])[] = [
			['nothing chosen', [], { parentId: undefined, aboveId: 'layer-9' }],
			['a group into itself', ['layer-3'], { parentId: 'layer-3', aboveId: undefined }],
			[
				'a group into its own group',
				['layer-3'],
				{ parentId: 'layer-6', aboveId: 'layer-7' },
			],
			[
				'into a layer that is no group',
				['layer-2'],
				{ parentId: 'layer-1', aboveId: undefined },
			],
			[
				'into a group that is not there',
				['layer-2'],
				{ parentId: 'gone', aboveId: undefined },
			],
			[
				'above a layer of another parent',
				['layer-2'],
				{ parentId: undefined, aboveId: 'layer-4' },
			],
			[
				'above a layer that is not there',
				['layer-2'],
				{ parentId: undefined, aboveId: 'gone' },
			],
			['where it is', ['layer-2'], { parentId: undefined, aboveId: 'layer-1' }],
			['to the bottom it is at', ['layer-1'], { parentId: undefined, aboveId: undefined }],
			[
				'two where they are',
				['layer-1', 'layer-2'],
				{ parentId: undefined, aboveId: undefined },
			],
			[
				'above one of them, with nothing under it but them',
				['layer-1', 'layer-2'],
				{ parentId: undefined, aboveId: 'layer-2' },
			],
			['a group in its place', ['layer-6'], { parentId: 'layer-3', aboveId: 'layer-5' }],
		];

		it.each(cannot)('does nothing, costing nothing: %s', (_name, chosen, place) => {
			const live = root();
			expect(canPlaceLayers(live, chosen, place)).toBe(false);
			changesNothing(live, placeLayers(live, chosen, place));
		});

		it('moves a layer above another in the same parent, its indentation the place’s', () => {
			const live = root();
			const place = { parentId: undefined, aboveId: 'layer-3' };
			expect(canPlaceLayers(live, ['layer-1'], place)).toBe(true);
			const command = placeLayers(live, ['layer-1'], place);
			expect(command.label).toBe('layers.move');
			const after = roundTrips(live, command);
			expect(childrenOf(live, undefined)).toEqual([
				'layer-2',
				'layer-3',
				'layer-1',
				'layer-8',
				'layer-9',
			]);
			expect(after).toContain('<title>Harbor</title>\n  <g id="layer-2"');
			expect(after).toContain('  </g>\n  <g id="layer-1"');
			expect(after).toContain('height="1"/></g>\n  <g id="layer-8"');
			expect(transformOf(live, 'layer-1')).toBeNull();
		});

		it('moves a layer to the bottom of the root, under the title', () => {
			const live = root();
			const after = roundTrips(
				live,
				placeLayers(live, ['layer-9'], { parentId: undefined, aboveId: undefined })
			);
			expect(childrenOf(live, undefined)[0]).toBe('layer-9');
			expect(after).toContain('<title>Harbor</title>\n  <g id="layer-9"');
		});

		it('takes the label it is given', () => {
			const live = root();
			const place = { parentId: undefined, aboveId: 'layer-9' };
			expect(placeLayers(live, ['layer-1'], place, 'layers.drag').label).toBe('layers.drag');
		});

		it('moves a layer out of a group, its transform taking the group’s', () => {
			const live = root();
			keepsDrawn(live, () => {
				roundTrips(
					live,
					placeLayers(live, ['layer-5'], { parentId: undefined, aboveId: 'layer-9' })
				);
			});
			expect(tree(live).at(-1)).toBe('layer-5<root');
			expect(transformOf(live, 'layer-5')).toBe('matrix(2 0 0 2 10 20)');
			expect(serialized(live)).toContain('</g>\n  <g id="layer-5"');
		});

		it('moves a layer into a group, its transform undoing the group’s', () => {
			const live = root();
			keepsDrawn(live, () => {
				roundTrips(
					live,
					placeLayers(live, ['layer-2'], { parentId: 'layer-3', aboveId: 'layer-4' })
				);
			});
			expect(childrenOf(live, 'layer-3')).toEqual([
				'layer-4',
				'layer-2',
				'layer-5',
				'layer-6',
			]);
			expect(transformOf(live, 'layer-2')).toBe('matrix(1 0 0 1 -7 -16)');
			expect(serialized(live)).toContain('</g>\n    <g id="layer-2"');
		});

		it('moves a layer into an empty group, scaled', () => {
			const live = root();
			keepsDrawn(live, () => {
				roundTrips(
					live,
					placeLayers(live, ['layer-2'], { parentId: 'layer-8', aboveId: undefined })
				);
			});
			expect(childrenOf(live, 'layer-8')).toEqual(['layer-2']);
			expect(transformOf(live, 'layer-2')).toBe('matrix(0.5 0 0 0.5 1.5 2)');
		});

		it('leaves a transform alone, to the byte, between parents drawn alike', () => {
			const live = root();
			roundTrips(
				live,
				placeLayers(live, ['layer-5'], { parentId: 'layer-6', aboveId: 'layer-7' })
			);
			expect(transformOf(live, 'layer-5')).toBe('scale(2)');
			roundTrips(
				live,
				placeLayers(live, ['layer-7'], { parentId: 'layer-3', aboveId: undefined })
			);
			expect(transformOf(live, 'layer-7')).toBeNull();
		});

		it('takes the transform away where what is left is none', () => {
			const live = root(
				DRAWING.replace(
					'<g id="layer-4" draw:kind="vector">',
					'<g id="layer-4" draw:kind="vector" transform="translate(-10 -20)">'
				)
			);
			keepsDrawn(live, () => {
				roundTrips(
					live,
					placeLayers(live, ['layer-4'], { parentId: undefined, aboveId: 'layer-1' })
				);
			});
			expect(layerById(live, 'layer-4')?.hasAttribute('transform')).toBe(false);
		});

		it('moves layers from several parents together, in their paint order', () => {
			const live = root();
			keepsDrawn(live, () => {
				roundTrips(
					live,
					placeLayers(live, ['layer-9', 'layer-4', 'layer-1'], {
						parentId: 'layer-6',
						aboveId: 'layer-7',
					})
				);
			});
			expect(childrenOf(live, 'layer-6')).toEqual([
				'layer-7',
				'layer-1',
				'layer-4',
				'layer-9',
			]);
			expect(childrenOf(live, undefined)).toEqual(['layer-2', 'layer-3', 'layer-8']);
		});

		it('moves a chosen group with what is in it, and not its chosen layers out of it', () => {
			const live = root();
			roundTrips(
				live,
				placeLayers(live, ['layer-4', 'layer-3'], {
					parentId: undefined,
					aboveId: 'layer-9',
				})
			);
			expect(childrenOf(live, undefined)).toEqual([
				'layer-1',
				'layer-2',
				'layer-8',
				'layer-9',
				'layer-3',
			]);
			expect(childrenOf(live, 'layer-3')).toEqual(['layer-4', 'layer-5', 'layer-6']);
		});

		it('reads an anchor among the moved as the nearest layer under it that is not', () => {
			const live = root();
			roundTrips(
				live,
				placeLayers(live, ['layer-2', 'layer-9'], {
					parentId: undefined,
					aboveId: 'layer-9',
				})
			);
			expect(childrenOf(live, undefined)).toEqual([
				'layer-1',
				'layer-3',
				'layer-8',
				'layer-2',
				'layer-9',
			]);
		});

		it('reads an anchor among the moved with none under it as the bottom', () => {
			const live = root();
			roundTrips(
				live,
				placeLayers(live, ['layer-1', 'layer-8'], {
					parentId: undefined,
					aboveId: 'layer-1',
				})
			);
			expect(childrenOf(live, undefined)).toEqual([
				'layer-1',
				'layer-8',
				'layer-2',
				'layer-3',
				'layer-9',
			]);
		});

		it('moves the whole of a group’s layers out, and back in again', () => {
			const live = root();
			const out = placeLayers(live, ['layer-4', 'layer-5', 'layer-6'], {
				parentId: undefined,
				aboveId: 'layer-3',
			});
			const emptied = roundTrips(live, out);
			expect(childrenOf(live, 'layer-3')).toEqual([]);
			expect(emptied).toContain('transform="translate(10 20)">\n  </g>');
			roundTrips(
				live,
				placeLayers(live, ['layer-6', 'layer-4'], {
					parentId: 'layer-3',
					aboveId: undefined,
				})
			);
			expect(childrenOf(live, 'layer-3')).toEqual(['layer-4', 'layer-6']);
			expect(transformOf(live, 'layer-4')).toBeNull();
		});
	});

	describe('stepping', () => {
		const order = (live: Element): readonly string[] => childrenOf(live, undefined);

		it('does for one layer what moveLayer does, to the byte', () => {
			const cases = [
				['layer-1', 'up'],
				['layer-3', 'up'],
				['layer-3', 'down'],
				['layer-5', 'down'],
				['layer-9', 'down'],
			] as const;
			cases.forEach(([id, direction]) => {
				const ours = root();
				const theirs = root();
				const command = stepLayers(ours, [id], direction);
				expect(command.label).toBe(
					direction === 'up' ? 'layers.moveUp' : 'layers.moveDown'
				);
				roundTrips(ours, command);
				moveLayer(id, direction).apply(theirs);
				expect(serialized(ours)).toBe(serialized(theirs));
			});
		});

		it('does nothing, costing nothing, at the end', () => {
			const live = root();
			expect(canStepLayers(live, ['layer-9'], 'up')).toBe(false);
			changesNothing(live, stepLayers(live, ['layer-9'], 'up'));
			expect(canStepLayers(live, ['layer-1', 'layer-2'], 'down')).toBe(false);
			changesNothing(live, stepLayers(live, ['layer-1', 'layer-2'], 'down'));
			expect(canStepLayers(live, ['layer-7'], 'down')).toBe(false);
			expect(canStepLayers(live, [], 'up')).toBe(false);
		});

		it('moves a run of layers past the next one, keeping their order', () => {
			const live = root();
			expect(canStepLayers(live, ['layer-2', 'layer-1'], 'up')).toBe(true);
			roundTrips(live, stepLayers(live, ['layer-2', 'layer-1'], 'up'));
			expect(order(live)).toEqual(['layer-3', 'layer-1', 'layer-2', 'layer-8', 'layer-9']);
			const down = root();
			roundTrips(down, stepLayers(down, ['layer-3', 'layer-2'], 'down'));
			expect(order(down)).toEqual(['layer-2', 'layer-3', 'layer-1', 'layer-8', 'layer-9']);
		});

		it('moves each run on its own, and leaves one with nothing past it', () => {
			const live = root();
			roundTrips(live, stepLayers(live, ['layer-1', 'layer-2', 'layer-8'], 'up'));
			expect(order(live)).toEqual(['layer-3', 'layer-1', 'layer-2', 'layer-9', 'layer-8']);
			const edge = root();
			roundTrips(edge, stepLayers(edge, ['layer-1', 'layer-9'], 'up'));
			expect(order(edge)).toEqual(['layer-2', 'layer-1', 'layer-3', 'layer-8', 'layer-9']);
		});

		it('steps in every parent at once, and never out of a group', () => {
			const live = root();
			roundTrips(live, stepLayers(live, ['layer-2', 'layer-4', 'layer-7'], 'up'));
			expect(order(live)).toEqual(['layer-1', 'layer-3', 'layer-2', 'layer-8', 'layer-9']);
			expect(childrenOf(live, 'layer-3')).toEqual(['layer-5', 'layer-4', 'layer-6']);
			expect(childrenOf(live, 'layer-6')).toEqual(['layer-7']);
		});

		it('steps a chosen group, and not its chosen layers inside it', () => {
			const live = root();
			roundTrips(live, stepLayers(live, ['layer-5', 'layer-3'], 'up'));
			expect(order(live)).toEqual(['layer-1', 'layer-2', 'layer-8', 'layer-3', 'layer-9']);
			expect(childrenOf(live, 'layer-3')).toEqual(['layer-4', 'layer-5', 'layer-6']);
		});
	});

	describe('grouping', () => {
		it('does for one layer what groupLayer does, to the byte', () => {
			['layer-2', 'layer-5', 'layer-7'].forEach((id) => {
				const ours = root();
				const theirs = root();
				const command = groupLayers(ours, [id]);
				const reference = groupLayer(theirs, id);
				expect(command.id).toBe(reference.id);
				expect(command.label).toBe('layers.group');
				command.apply(ours);
				reference.apply(theirs);
				expect(serialized(ours)).toBe(serialized(theirs));
				expect(command.bytes).toBe(reference.bytes);
			});
		});

		it('puts layers of one parent in a new group where the topmost was', () => {
			const live = root();
			const command = groupLayers(live, ['layer-9', 'layer-2']);
			expect(command.id).toBe('layer-10');
			expect(command.label).toBe('layers.group');
			keepsDrawn(live, () => {
				roundTrips(live, command);
			});
			expect(childrenOf(live, undefined)).toEqual([
				'layer-1',
				'layer-3',
				'layer-8',
				'layer-10',
			]);
			expect(childrenOf(live, 'layer-10')).toEqual(['layer-2', 'layer-9']);
			expect(layerById(live, 'layer-10')?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe(
				'group'
			);
			expect(transformOf(live, 'layer-2')).toBe('translate(3 4)');
		});

		it('groups layers of several parents in the topmost one’s, each drawn where it was', () => {
			const live = root();
			const command = groupLayers(live, ['layer-4', 'layer-1']);
			keepsDrawn(live, () => {
				roundTrips(live, command);
			});
			expect(childrenOf(live, 'layer-3')).toEqual(['layer-10', 'layer-5', 'layer-6']);
			expect(childrenOf(live, 'layer-10')).toEqual(['layer-1', 'layer-4']);
			expect(transformOf(live, 'layer-1')).toBe('matrix(1 0 0 1 -10 -20)');
			expect(transformOf(live, 'layer-4')).toBeNull();
		});

		it('groups a chosen group whole, with a layer from outside it', () => {
			const live = root();
			roundTrips(live, groupLayers(live, ['layer-5', 'layer-3', 'layer-1']));
			expect(childrenOf(live, 'layer-10')).toEqual(['layer-1', 'layer-3']);
			expect(childrenOf(live, 'layer-3')).toEqual(['layer-4', 'layer-5', 'layer-6']);
		});

		it('does nothing, costing nothing, with nothing chosen', () => {
			const live = root();
			changesNothing(live, groupLayers(live, ['nothing']));
		});
	});

	describe('deleting', () => {
		it('deletes the outermost, a group with its layers, and puts them all back', () => {
			const live = root();
			const command = removeLayers(live, ['layer-5', 'layer-3', 'layer-1']);
			expect(command.label).toBe('layers.delete');
			roundTrips(live, command);
			expect(ids(live)).toEqual(['layer-2', 'layer-8', 'layer-9']);
		});

		it('deletes layers side by side, and their indentation with them', () => {
			const live = root();
			const after = roundTrips(live, removeLayers(live, ['layer-2', 'layer-1']));
			expect(after).toContain('<title>Harbor</title>\n  <g id="layer-3"');
		});
	});

	describe('duplicating', () => {
		it('does for one layer what duplicateLayer does, to the byte', () => {
			['layer-2', 'layer-3'].forEach((id) => {
				const ours = root();
				const theirs = root();
				const command = duplicateLayers(ours, [id]);
				const reference = duplicateLayer(theirs, id);
				expect(command.ids).toEqual([reference.id]);
				expect(command.label).toBe('layers.duplicate');
				command.apply(ours);
				reference.apply(theirs);
				expect(serialized(ours)).toBe(serialized(theirs));
				expect(command.bytes).toBe(reference.bytes);
			});
		});

		it('puts each copy above its original, under ids of their own', () => {
			const live = root();
			const command = duplicateLayers(live, ['layer-9', 'layer-1']);
			expect(command.ids).toEqual(['layer-10', 'layer-11']);
			roundTrips(live, command);
			expect(childrenOf(live, undefined)).toEqual([
				'layer-1',
				'layer-10',
				'layer-2',
				'layer-3',
				'layer-8',
				'layer-9',
				'layer-11',
			]);
		});

		it('numbers the layers in a copied group past every copy', () => {
			const live = root();
			const command = duplicateLayers(live, ['layer-9', 'layer-3', 'layer-6']);
			expect(command.ids).toEqual(['layer-10', 'layer-11']);
			roundTrips(live, command);
			const every = [...live.querySelectorAll('[id]')].map((element) => element.id);
			expect(new Set(every).size).toBe(every.length);
			expect(childrenOf(live, 'layer-10')).toEqual(['layer-12', 'layer-13', 'layer-14']);
			expect(childrenOf(live, 'layer-14')).toEqual(['layer-15']);
			expect(childrenOf(live, undefined).slice(-2)).toEqual(['layer-9', 'layer-11']);
		});
	});
});

describe('in a document', () => {
	it('undoes a move to the drawing that was opened, and redoes it', () => {
		const document = opened();
		const start = serialized(document.root);
		document.execute(
			placeLayers(document.root, ['layer-9', 'layer-2'], {
				parentId: 'layer-3',
				aboveId: 'layer-5',
			})
		);
		const moved = document.text();
		expect(document.snapshot().dirty).toBe(true);
		document.undo();
		expect(serialized(document.root)).toBe(start);
		document.redo();
		expect(document.text()).toBe(moved);
	});

	it('records nothing for a move that changes nothing', () => {
		const document = opened();
		document.execute(
			placeLayers(document.root, ['layer-2'], { parentId: undefined, aboveId: 'layer-1' })
		);
		expect(document.snapshot().canUndo).toBe(false);
		expect(document.text()).toBe(DRAWING);
	});

	it('undoes through later edits that replaced the layers and the groups it moved', () => {
		const document = opened();
		const touch = (id: string): Command =>
			editLayer(id, 'tools.select', (layer) => {
				layer.setAttribute('data-touched', id);
			});
		const start = serialized(document.root);
		document.execute(
			placeLayers(document.root, ['layer-1', 'layer-7'], {
				parentId: 'layer-3',
				aboveId: 'layer-4',
			})
		);
		document.execute(touch('layer-3'));
		document.execute(touch('layer-1'));
		document.execute(touch('layer-6'));
		const edited = document.text();
		[1, 2, 3, 4].forEach(() => {
			document.undo();
		});
		expect(serialized(document.root)).toBe(start);
		[1, 2, 3, 4].forEach(() => {
			document.redo();
		});
		expect(document.text()).toBe(edited);
		[1, 2, 3, 4].forEach(() => {
			document.undo();
		});
		expect(serialized(document.root)).toBe(start);
	});

	it('undoes a group of several, a step and a duplicate through later edits', () => {
		const document = opened();
		const touch = (id: string): Command =>
			editLayer(id, 'tools.select', (layer) => {
				layer.setAttribute('data-touched', id);
			});
		const start = serialized(document.root);
		const grouped = groupLayers(document.root, ['layer-1', 'layer-4', 'layer-9']);
		document.execute(grouped);
		document.execute(touch(grouped.id));
		document.execute(stepLayers(document.root, ['layer-2', 'layer-8'], 'up'));
		document.execute(touch('layer-2'));
		document.execute(duplicateLayers(document.root, ['layer-2', 'layer-1']));
		document.execute(touch(grouped.id));
		const edited = document.text();
		Array.from({ length: 6 }).forEach(() => {
			document.undo();
		});
		expect(serialized(document.root)).toBe(start);
		Array.from({ length: 6 }).forEach(() => {
			document.redo();
		});
		expect(document.text()).toBe(edited);
	});
});
