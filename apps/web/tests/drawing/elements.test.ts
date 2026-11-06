import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	arrangedPositions,
	arrangeElements,
	canArrange,
	canMoveElements,
	duplicateElements,
	type ElementArrangement,
	type ElementPlace,
	isLayerHeld,
	moveElements,
} from '../../src/drawing/document/elements.js';
import { layerById } from '../../src/drawing/document/layers.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { serializeDrawing } from '../../src/drawing/document/serialize.js';
import {
	invert,
	type Mat,
	multiply,
	parseTransform,
	rotate,
} from '../../src/drawing/tools/vector/geometry.js';
import { elementsOf } from '../../src/drawing/tools/vector/hit.js';
import { t } from '../../src/i18n/t.js';
import { onCanvas } from './placements.js';

/**
 * A vector layer's elements arranged, duplicated and moved
 * (`document/elements.ts`): each one command, which undoes to the file's own
 * bytes, moves the very nodes a selection holds, leaves what is not an
 * element where it is, and keeps the markup's indentation. Real documents, as
 * the editor opens them, serialized by the document's own serializer.
 */

const DRAWING = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="d1" viewBox="0 0 100 80">
  <title>Harbor</title>
  <g id="layer-1" draw:kind="vector" draw:name="Boats">
    <defs><linearGradient id="sky"><stop offset="0"/></linearGradient></defs>
    <rect id="hull" width="10" height="10" fill="url(#sky)"/>
    <circle id="sun" cx="40" cy="20" r="3"/>
    <title>The mast</title>
    <path d="M0 0 L5 5"/>
    <ellipse cx="5" cy="5" rx="2" ry="1" transform="rotate(30)"/>
    <desc>Boats at anchor</desc>
  </g>
  <g id="layer-2" draw:kind="vector">
    <use href="#hull"/>
    <g id="flag"><linearGradient id="stripes"><stop offset="1"/></linearGradient><rect id="cloth" width="4" height="2" fill="url(#stripes)"/><use href="#cloth"/></g>
  </g>
  <g id="layer-3" draw:kind="vector" transform="translate(10 20)">
    <line x1="0" y1="0" x2="5" y2="5" transform="translate(-10 -20)"/>
    <polygon points="0,0 1,1 1,0"/>
  </g>
  <g id="layer-4" draw:kind="group" transform="matrix(0 1 -1 0 80 0)">
    <g id="layer-5" draw:kind="vector" transform="scale(2)">
      <polyline points="0,0 2,2"/>
    </g>
  </g>
  <g id="layer-6" draw:kind="raster">
    <image href="data:image/png;base64,iVBORw0KGgo=" width="2" height="2" preserveAspectRatio="none"/>
  </g>
  <circle id="layer-7" cx="1" cy="1" r="1"/>
  <g id="layer-8" draw:kind="vector" draw:locked="true">
    <rect width="1" height="1"/>
  </g>
  <g id="layer-9" draw:kind="group" display="none">
    <g id="layer-10" draw:kind="vector">
      <rect width="2" height="2"/>
    </g>
  </g>
  <g id="layer-11" draw:kind="vector"/>
</svg>
`;

/** Lines of the drawing, as it is written: what the expected texts are made of. */
const HULL = '\n    <rect id="hull" width="10" height="10" fill="url(#sky)"/>';
const SUN = '\n    <circle id="sun" cx="40" cy="20" r="3"/>';
const MAST = '\n    <title>The mast</title>';
const PATH = '\n    <path d="M0 0 L5 5"/>';
const ELLIPSE = '\n    <ellipse cx="5" cy="5" rx="2" ry="1" transform="rotate(30)"/>';
const DESC = '\n    <desc>Boats at anchor</desc>';

/** The first layer's body, its elements in the order given, around what is not one of them. */
const boats = (...lines: readonly string[]): string =>
	DRAWING.replace(`${HULL}${SUN}${MAST}${PATH}${ELLIPSE}${DESC}`, `${lines.join('')}${DESC}`);

const opened = (text = DRAWING): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('the test drawing opens');
	return document;
};

/** The document as the editor would write it now: its own serializer, never the text kept from the open. */
const written = (document: EditorDocument): string =>
	serializeDrawing(document.root, document.prolog);

const layer = (document: EditorDocument, id: string): Element => {
	const found = layerById(document.root, id);
	if (found === undefined) throw new Error(`no ${id}`);
	return found;
};

const elements = (document: EditorDocument, id: string): readonly Element[] =>
	elementsOf(layer(document, id));

/** What a layer draws: the local names of its elements, bottom to top. */
const drawn = (document: EditorDocument, id: string): readonly string[] =>
	elements(document, id).map((element) => element.localName);

/** The element at `position` in the layer, which the test needs there. */
const at = (document: EditorDocument, id: string, position: number): Element => {
	const found = elements(document, id)[position];
	if (found === undefined) throw new Error(`no element ${String(position)} in ${id}`);
	return found;
};

/** Two matrices the same to a millionth. */
const expectMatrix = (actual: Mat, expected: Mat): void => {
	actual.forEach((value, index) => {
		expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 6);
	});
};

afterEach(() => {
	window.document.body.replaceChildren();
});

describe('the positions an arrangement gives', () => {
	it.each<readonly [ElementArrangement, readonly number[], readonly number[]]>([
		['front', [1], [4]],
		['front', [1, 3], [3, 4]],
		['front', [3, 4], [3, 4]],
		['front', [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]],
		['back', [3], [0]],
		['back', [1, 3], [0, 1]],
		['back', [0, 1], [0, 1]],
		['forward', [1], [2]],
		// A run moves up past the next one above it together.
		['forward', [1, 2], [2, 3]],
		['forward', [2, 4], [3, 4]],
		['forward', [0, 2, 3], [1, 3, 4]],
		// At the top, a run stays.
		['forward', [3, 4], [3, 4]],
		['forward', [4], [4]],
		['backward', [3], [2]],
		['backward', [2, 3], [1, 2]],
		['backward', [0, 2], [0, 1]],
		['backward', [1, 2, 4], [0, 1, 3]],
		['backward', [0, 1], [0, 1]],
		['backward', [0], [0]],
		// Given in any order, they come back ascending.
		['front', [3, 1], [3, 4]],
	])('%s of %j among five is %j', (how, positions, expected) => {
		expect(arrangedPositions(5, positions, how)).toEqual(expected);
		const sorted = [...positions].sort((a, b) => a - b);
		expect(canArrange(5, positions, how)).toBe(
			expected.some((position, index) => position !== sorted[index])
		);
	});

	it('ignores a position that names no element, and one given twice', () => {
		expect(arrangedPositions(5, [1, 1, 7, -1, 1.5], 'forward')).toEqual([2]);
		expect(arrangedPositions(5, [], 'front')).toEqual([]);
		expect(canArrange(5, [], 'front')).toBe(false);
		expect(canArrange(5, [9], 'back')).toBe(false);
		expect(canArrange(0, [0], 'front')).toBe(false);
	});
});

describe('arranging elements', () => {
	it('opens to the file’s own bytes, so what follows compares with them', () => {
		expect(written(opened())).toBe(DRAWING);
	});

	it('brings one to the front, the same node, with its indentation, the rest where they were', () => {
		const document = opened();
		const sun = at(document, 'layer-1', 1);
		const command = arrangeElements('layer-1', [1], 'front');
		document.execute(command);
		expect(command.layerId).toBe('layer-1');
		expect(command.positions).toEqual([3]);
		expect(drawn(document, 'layer-1')).toEqual(['rect', 'path', 'ellipse', 'circle']);
		expect(at(document, 'layer-1', 3)).toBe(sun);
		// The definitions stay first, the path's title just before it, the description last.
		expect(written(document)).toBe(boats(HULL, MAST, PATH, ELLIPSE, SUN));
		expect(document.snapshot().canUndo).toBe(true);
	});

	it('undoes to the file’s own bytes, and redoes to the same', () => {
		const document = opened();
		document.execute(arrangeElements('layer-1', [0, 2], 'front'));
		const done = written(document);
		expect(done).toBe(boats(SUN, MAST, ELLIPSE, HULL, PATH));
		document.undo();
		expect(written(document)).toBe(DRAWING);
		document.redo();
		expect(written(document)).toBe(done);
		document.undo();
		expect(written(document)).toBe(DRAWING);
	});

	it.each<readonly [ElementArrangement, readonly number[], readonly string[], readonly number[]]>(
		[
			['back', [3], [ELLIPSE, HULL, SUN, MAST, PATH], [0]],
			['forward', [0], [SUN, HULL, MAST, PATH, ELLIPSE], [1]],
			['forward', [0, 1], [MAST, PATH, HULL, SUN, ELLIPSE], [1, 2]],
			['backward', [2], [HULL, PATH, SUN, MAST, ELLIPSE], [1]],
			['backward', [2, 3], [HULL, PATH, ELLIPSE, SUN, MAST], [1, 2]],
		]
	)('%s of %j moves only those, each with the line it is on', (how, positions, lines, after) => {
		const document = opened();
		const moving = positions.map((position) => at(document, 'layer-1', position));
		const command = arrangeElements('layer-1', positions, how);
		document.execute(command);
		expect(written(document)).toBe(boats(...lines));
		expect(command.positions).toEqual(after);
		expect(after.map((position) => at(document, 'layer-1', position))).toEqual(moving);
		document.undo();
		expect(written(document)).toBe(DRAWING);
	});

	it('costs nothing, and is not recorded, where it would change nothing or the layer is not a vector one', () => {
		const document = opened();
		[
			arrangeElements('layer-1', [3], 'front'),
			arrangeElements('layer-1', [0], 'backward'),
			arrangeElements('layer-1', [], 'front'),
			arrangeElements('layer-6', [0], 'back'),
			arrangeElements('layer-4', [0], 'front'),
			arrangeElements('layer-99', [0], 'front'),
		].forEach((command) => {
			document.execute(command);
			expect(command.bytes).toBe(0);
		});
		expect(document.snapshot().canUndo).toBe(false);
		expect(written(document)).toBe(DRAWING);
	});

	it('names itself for the undo history', () => {
		expect(arrangeElements('layer-1', [0], 'front').label).toBe('selection.history.arrange');
		expect(t('selection.history.arrange')).toBe('Arrange');
	});
});

describe('duplicating elements', () => {
	it('puts a copy of each just above it, indented as it is, and says where the copies are', () => {
		const document = opened();
		const [hull, sun] = elements(document, 'layer-1');
		const command = duplicateElements(document.root, 'layer-1', [1, 0]);
		document.execute(command);
		expect(command.layerId).toBe('layer-1');
		expect(command.positions).toEqual([1, 3]);
		expect(drawn(document, 'layer-1')).toEqual([
			'rect',
			'rect',
			'circle',
			'circle',
			'path',
			'ellipse',
		]);
		expect(at(document, 'layer-1', 0)).toBe(hull);
		expect(at(document, 'layer-1', 2)).toBe(sun);
		expect(written(document)).toBe(
			boats(
				HULL,
				HULL.replace('"hull"', '"hull-copy"'),
				SUN,
				SUN.replace('"sun"', '"sun-copy"'),
				MAST,
				PATH,
				ELLIPSE
			)
		);
	});

	it('gives a copy an id only where its original had one, a fresh one each time', () => {
		const document = opened();
		document.execute(duplicateElements(document.root, 'layer-1', [2]));
		expect(at(document, 'layer-1', 3).hasAttribute('id')).toBe(false);
		document.execute(duplicateElements(document.root, 'layer-1', [0]));
		document.execute(duplicateElements(document.root, 'layer-1', [0]));
		expect(
			elements(document, 'layer-1')
				.slice(0, 3)
				.map((element) => element.getAttribute('id'))
		).toEqual(['hull', 'hull-copy-2', 'hull-copy']);
		// What it refers to outside the copy, the layer's gradient, it still does.
		expect(at(document, 'layer-1', 1).getAttribute('fill')).toBe('url(#sky)');
	});

	it('renames the ids inside a copy and points its references at them, and leaves the rest as they were', () => {
		const document = opened();
		const command = duplicateElements(document.root, 'layer-2', [1]);
		document.execute(command);
		expect(command.positions).toEqual([2]);
		const copy = at(document, 'layer-2', 2);
		expect(copy.getAttribute('id')).toBe('flag-copy');
		expect(copy.querySelector('linearGradient')?.getAttribute('id')).toBe('stripes-copy');
		expect(copy.querySelector('rect')?.getAttribute('id')).toBe('cloth-copy');
		expect(copy.querySelector('rect')?.getAttribute('fill')).toBe('url(#stripes-copy)');
		expect(copy.querySelector('use')?.getAttribute('href')).toBe('#cloth-copy');
		const flag = at(document, 'layer-2', 1);
		expect(flag.getAttribute('id')).toBe('flag');
		expect(flag.querySelector('rect')?.getAttribute('fill')).toBe('url(#stripes)');
		expect(at(document, 'layer-2', 0).getAttribute('href')).toBe('#hull');
	});

	it('undoes to the file’s own bytes, and redoes to the same', () => {
		const document = opened();
		document.execute(duplicateElements(document.root, 'layer-1', [0, 3]));
		const done = written(document);
		document.undo();
		expect(written(document)).toBe(DRAWING);
		document.redo();
		expect(written(document)).toBe(done);
	});

	it('costs nothing, and is not recorded, with nothing to copy or no vector layer', () => {
		const document = opened();
		[
			duplicateElements(document.root, 'layer-1', []),
			duplicateElements(document.root, 'layer-1', [9]),
			duplicateElements(document.root, 'layer-6', [0]),
			duplicateElements(document.root, 'layer-7', [0]),
			duplicateElements(document.root, 'layer-99', [0]),
		].forEach((command) => {
			document.execute(command);
			expect(command.bytes).toBe(0);
		});
		expect(document.snapshot().canUndo).toBe(false);
		expect(written(document)).toBe(DRAWING);
	});

	it('names itself for the undo history', () => {
		const document = opened();
		expect(duplicateElements(document.root, 'layer-1', [0]).label).toBe(
			'selection.history.duplicate'
		);
		expect(t('selection.history.duplicate')).toBe('Duplicate');
	});
});

describe('a layer out of reach', () => {
	it.each([
		['layer-1', false],
		['layer-5', false],
		// Locked itself.
		['layer-8', true],
		// Hidden itself, and in a hidden group.
		['layer-9', true],
		['layer-10', true],
		['layer-99', true],
	] as const)('%s is held: %s', (id, held) => {
		expect(isLayerHeld(opened().root, id)).toBe(held);
	});

	it('is held by a locked group around it', () => {
		const document = opened(
			DRAWING.replace(
				'<g id="layer-4" draw:kind="group"',
				'<g id="layer-4" draw:kind="group" draw:locked="true"'
			)
		);
		expect(isLayerHeld(document.root, 'layer-5')).toBe(true);
		expect(isLayerHeld(document.root, 'layer-1')).toBe(false);
	});
});

describe('moving elements within their layer', () => {
	it('moves them up, to directly below the element named', () => {
		const document = opened();
		const hull = at(document, 'layer-1', 0);
		const to: ElementPlace = { layerId: 'layer-1', index: 3 };
		expect(canMoveElements(document.root, 'layer-1', [0], to)).toBe(true);
		const command = moveElements(document.root, 'layer-1', [0], to);
		document.execute(command);
		expect(command.layerId).toBe('layer-1');
		expect(command.positions).toEqual([2]);
		expect(at(document, 'layer-1', 2)).toBe(hull);
		expect(written(document)).toBe(boats(SUN, MAST, PATH, HULL, ELLIPSE));
		expect(command.label).toBe('selection.history.moveElements');
		expect(t('selection.history.moveElements')).toBe('Move');
	});

	it('moves them down, and to the top, in their order', () => {
		const document = opened();
		const down = moveElements(document.root, 'layer-1', [3], { layerId: 'layer-1', index: 0 });
		document.execute(down);
		expect(down.positions).toEqual([0]);
		expect(written(document)).toBe(boats(ELLIPSE, HULL, SUN, MAST, PATH));
		document.undo();
		const top = moveElements(document.root, 'layer-1', [2, 0], {
			layerId: 'layer-1',
			index: 4,
		});
		document.execute(top);
		expect(top.positions).toEqual([2, 3]);
		expect(written(document)).toBe(boats(SUN, MAST, ELLIPSE, HULL, PATH));
		document.undo();
		expect(written(document)).toBe(DRAWING);
	});

	it('is refused, and costs nothing, where it would leave them where they are', () => {
		const document = opened();
		[1, 2].forEach((index) => {
			const to = { layerId: 'layer-1', index };
			expect(canMoveElements(document.root, 'layer-1', [1], to)).toBe(false);
			const command = moveElements(document.root, 'layer-1', [1], to);
			document.execute(command);
			expect(command.bytes).toBe(0);
			expect(command.positions).toEqual([1]);
		});
		expect(
			canMoveElements(document.root, 'layer-1', [0, 1, 2, 3], {
				layerId: 'layer-1',
				index: 4,
			})
		).toBe(false);
		expect(document.snapshot().canUndo).toBe(false);
	});
});

describe('moving elements to another layer', () => {
	it('moves the same nodes, ids and all, indented as their new siblings, as one step', () => {
		const document = opened();
		const sun = at(document, 'layer-1', 1);
		const command = moveElements(document.root, 'layer-1', [1], {
			layerId: 'layer-5',
			index: 0,
		});
		document.execute(command);
		expect(command.layerId).toBe('layer-5');
		expect(command.positions).toEqual([0]);
		expect(at(document, 'layer-5', 0)).toBe(sun);
		expect(sun.getAttribute('id')).toBe('sun');
		expect(drawn(document, 'layer-1')).toEqual(['rect', 'path', 'ellipse']);
		expect(written(document)).toContain(
			'<g id="layer-5" draw:kind="vector" transform="scale(2)">\n      <circle id="sun"'
		);
		expect(written(document)).toContain('"/>\n      <polyline points="0,0 2,2"/>');
		document.undo();
		expect(written(document)).toBe(DRAWING);
		expect(document.snapshot().canUndo).toBe(false);
	});

	it('leaves the transform exactly as it was between two layers neither of them placed', () => {
		const document = opened();
		const command = moveElements(document.root, 'layer-1', [1, 3], {
			layerId: 'layer-2',
			index: 2,
		});
		document.execute(command);
		expect(command.positions).toEqual([2, 3]);
		const [, , sun, ellipse] = elements(document, 'layer-2');
		expect(sun?.hasAttribute('transform')).toBe(false);
		expect(ellipse?.getAttribute('transform')).toBe('rotate(30)');
		expect(written(document)).toBe(
			DRAWING.replace(SUN, '')
				.replace(ELLIPSE, '')
				.replace('<use href="#cloth"/></g>', `<use href="#cloth"/></g>${SUN}${ELLIPSE}`)
		);
		document.undo();
		expect(written(document)).toBe(DRAWING);
	});

	it('keeps where each is seen, out of a placed layer, and takes away a transform that comes to nothing', () => {
		const document = opened();
		const [line, polygon] = elements(document, 'layer-3');
		const lineSeen = onCanvas(line);
		const polygonSeen = onCanvas(polygon);
		document.execute(
			moveElements(document.root, 'layer-3', [0, 1], { layerId: 'layer-1', index: 0 })
		);
		expect(line?.hasAttribute('transform')).toBe(false);
		// Only moved, so written as a drag writes it.
		expect(polygon?.getAttribute('transform')).toBe('matrix(1 0 0 1 10 20)');
		expectMatrix(onCanvas(line), lineSeen);
		expectMatrix(onCanvas(polygon), polygonSeen);
		expect(elements(document, 'layer-1').slice(0, 2)).toEqual([line, polygon]);
		document.undo();
		expect(written(document)).toBe(DRAWING);
	});

	it('keeps where each is seen, into a layer turned and scaled by itself and its group', () => {
		const document = opened();
		const ellipse = at(document, 'layer-1', 3);
		const seen = onCanvas(ellipse);
		const placement = onCanvas(layer(document, 'layer-5'));
		document.execute(
			moveElements(document.root, 'layer-1', [3], { layerId: 'layer-5', index: 1 })
		);
		expect(at(document, 'layer-5', 1)).toBe(ellipse);
		// into(target) × outOf(source) × own, the source placed nowhere.
		expectMatrix(
			parseTransform(ellipse.getAttribute('transform')),
			multiply(invert(placement), rotate(30))
		);
		expectMatrix(onCanvas(ellipse), seen);
		// Written to nine places, as the inverse of a layer's placement is.
		expect(ellipse.getAttribute('transform')).toBe(
			'matrix(0.25 -0.433012702 0.433012702 0.25 0 40)'
		);
		document.undo();
		expect(written(document)).toBe(DRAWING);
	});

	it('puts them first in a layer that holds nothing, with no indentation of its own to give', () => {
		const document = opened();
		document.execute(
			moveElements(document.root, 'layer-1', [0, 2], { layerId: 'layer-11', index: 0 })
		);
		expect(written(document)).toContain(
			'<g id="layer-11" draw:kind="vector"><rect id="hull" width="10" height="10" fill="url(#sky)"/><path d="M0 0 L5 5"/></g>'
		);
		document.undo();
		expect(written(document)).toBe(DRAWING);
	});

	it('redoes to the same markup', () => {
		const document = opened();
		document.execute(
			moveElements(document.root, 'layer-3', [1], { layerId: 'layer-5', index: 1 })
		);
		const done = written(document);
		document.undo();
		document.redo();
		expect(written(document)).toBe(done);
	});

	it.each<readonly [string, string, readonly number[], ElementPlace]>([
		['from a locked layer', 'layer-8', [0], { layerId: 'layer-1', index: 0 }],
		['to a locked layer', 'layer-1', [0], { layerId: 'layer-8', index: 0 }],
		['to a layer in a hidden group', 'layer-1', [0], { layerId: 'layer-10', index: 0 }],
		['from a layer in a hidden group', 'layer-10', [0], { layerId: 'layer-1', index: 0 }],
		['to a loose layer', 'layer-1', [0], { layerId: 'layer-7', index: 0 }],
		['from a loose layer', 'layer-7', [0], { layerId: 'layer-1', index: 0 }],
		['to a raster layer', 'layer-1', [0], { layerId: 'layer-6', index: 0 }],
		['from a raster layer', 'layer-6', [0], { layerId: 'layer-1', index: 0 }],
		['to a group', 'layer-1', [0], { layerId: 'layer-4', index: 0 }],
		['to a layer that is not there', 'layer-1', [0], { layerId: 'layer-99', index: 0 }],
		['from a layer that is not there', 'layer-99', [0], { layerId: 'layer-1', index: 0 }],
		['with no element named', 'layer-1', [7], { layerId: 'layer-2', index: 0 }],
		['past the end of the target', 'layer-1', [0], { layerId: 'layer-2', index: 3 }],
		['before its start', 'layer-1', [0], { layerId: 'layer-2', index: -1 }],
	])('is refused %s, and costs nothing', (_name, from, positions, to) => {
		const document = opened();
		expect(canMoveElements(document.root, from, positions, to)).toBe(false);
		const command = moveElements(document.root, from, positions, to);
		document.execute(command);
		expect(command.bytes).toBe(0);
		expect(command.layerId).toBe(from);
		expect(document.snapshot().canUndo).toBe(false);
		expect(written(document)).toBe(DRAWING);
	});
});
