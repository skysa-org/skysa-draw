import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setAdjustments } from '../../src/drawing/document/adjustments.js';
import { clipStateOf, clipToBelow, releaseClip } from '../../src/drawing/document/clip.js';
import { duplicateLayer, editLayer } from '../../src/drawing/document/commands.js';
import { describeLayers } from '../../src/drawing/document/describe.js';
import { groupLayer, ungroupLayer, ungroupProblem } from '../../src/drawing/document/groups.js';
import { giveLayerIds, layerById, layersOf } from '../../src/drawing/document/layers.js';
import {
	mergeDown,
	mergeProblem,
	rasterizeLayer,
	rasterizeProblem,
} from '../../src/drawing/document/merge.js';
import type { Command, EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { parseDrawing } from '../../src/drawing/document/sanitize.js';

/**
 * The layer operations (docs/ARCHITECTURE.md §7, "Layers"): group and
 * ungroup, clip to the layer below, merge down and rasterize. What each
 * writes, and that each undoes itself exactly, in the XML document and in
 * the page, and through a document whose later edits replace the layers it
 * moved. The render a merge or a rasterize needs is the export module's, and
 * jsdom has none, so it is mocked here to a picture of its own and to the
 * arguments it was given.
 */

const render = vi.hoisted(() => ({
	texts: [] as string[],
	sizes: [] as (readonly [number, number])[],
	boxes: [] as unknown[],
	canvas: true,
}));

vi.mock('../../src/drawing/export/render.js', () => ({
	renderSvg: (
		text: string,
		box: unknown,
		width: number,
		height: number
	): Promise<HTMLCanvasElement | undefined> => {
		render.texts.push(text);
		render.boxes.push(box);
		render.sizes.push([width, height]);
		return Promise.resolve(render.canvas ? document.createElement('canvas') : undefined);
	},
	canvasToPng: () => Promise.resolve('data:image/png;base64,UkVOREVSRUQ='),
}));

const RENDERED = 'data:image/png;base64,UkVOREVSRUQ=';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
	render.texts.length = 0;
	render.sizes.length = 0;
	render.boxes.length = 0;
	render.canvas = true;
});

afterEach(() => {
	window.document.body.replaceChildren();
});

const DRAWING = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="d1" viewBox="0 0 100 80">
  <title>Harbor</title>
  <g id="layer-1" draw:kind="vector" draw:name="Sea" style="fill:red">
    <rect width="10" height="10"/>
  </g>
  <g id="layer-2" draw:kind="vector" opacity="0.5" transform="translate(5 5)">
    <circle r="3"/>
  </g>
  <g id="layer-3" draw:kind="raster">
    <image href="${PNG}" x="0" y="0" width="10" height="10" preserveAspectRatio="none"/>
  </g>
  <g id="layer-4" draw:kind="group" transform="translate(1 2)" style="display:inline">
    <g id="layer-5" draw:kind="vector"><path d="M0 0"/></g>
    <g id="layer-6" draw:kind="vector" transform="scale(2)"><path d="M1 1"/></g>
  </g>
</svg>
`;

/** The same drawing as another tool wrote it: no app namespace, Inkscape's layers. */
const FOREIGN = `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 10 10">
  <g id="a"><rect width="1" height="1"/></g>
  <g id="b"><rect width="2" height="2"/></g>
</svg>`;

const placements = ['in its own document', 'in the page'] as const;

const openRoot = (text: string, placement: (typeof placements)[number]): SVGSVGElement => {
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

/** Applied, reverted, applied again and reverted again: the same root each way. */
const roundTrips = (root: SVGSVGElement, command: Command): void => {
	const before = root.outerHTML;
	command.apply(root);
	const after = root.outerHTML;
	expect(after).not.toBe(before);
	command.revert(root);
	expect(root.outerHTML).toBe(before);
	command.apply(root);
	expect(root.outerHTML).toBe(after);
	command.revert(root);
	expect(root.outerHTML).toBe(before);
	command.apply(root);
};

const ids = (root: Element): readonly string[] => layersOf(root).map((layer) => layer.id);

describe.each(placements)('the layer operations, with the root %s', (placement) => {
	const root = (text = DRAWING): SVGSVGElement => openRoot(text, placement);

	describe('group', () => {
		it('puts the layer in a new group of its own, in its place', () => {
			const live = root();
			const command = groupLayer(live, 'layer-2');
			expect(command.id).toBe('layer-7');
			roundTrips(live, command);
			const layers = layersOf(live);
			expect(ids(live).slice(0, 3)).toEqual(['layer-1', 'layer-7', 'layer-2']);
			expect(layers.find((layer) => layer.id === 'layer-7')?.kind).toBe('group');
			expect(layers.find((layer) => layer.id === 'layer-2')).toMatchObject({
				depth: 1,
				parentId: 'layer-7',
			});
		});

		it('declares the app namespace on a file that has none, and takes it back', () => {
			const live = root(FOREIGN);
			roundTrips(live, groupLayer(live, 'a'));
			expect(layerById(live, 'layer-1')?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe(
				'group'
			);
		});
	});

	describe('ungroup', () => {
		it("puts the group's layers in its place, each with the group's transform before its own", () => {
			const live = root();
			roundTrips(live, ungroupLayer(live, 'layer-4'));
			expect(ids(live)).toEqual(['layer-1', 'layer-2', 'layer-3', 'layer-5', 'layer-6']);
			expect(layerById(live, 'layer-5')?.getAttribute('transform')).toBe('translate(1 2)');
			expect(layerById(live, 'layer-6')?.getAttribute('transform')).toBe(
				'translate(1 2) scale(2)'
			);
			expect(layersOf(live).every((layer) => layer.depth === 0)).toBe(true);
		});

		it('refuses a group whose look its layers would lose, and anything that is not a group', () => {
			const live = root(DRAWING.replace('style="display:inline"', 'opacity="0.4"'));
			expect(ungroupProblem(live, 'layer-4')).toBe('styled');
			expect(ungroupLayer(live, 'layer-4').bytes).toBe(0);
			expect(ungroupProblem(live, 'layer-1')).toBe('notGroup');
			const filled = root(DRAWING.replace('style="display:inline"', 'style="fill:blue"'));
			expect(ungroupProblem(filled, 'layer-4')).toBe('styled');
			expect(ungroupProblem(root(), 'layer-4')).toBeUndefined();
		});

		it('deletes a group with nothing in it', () => {
			const live = root(
				DRAWING.replace(
					/<g id="layer-5"[\s\S]*?<\/g>\n {4}<g id="layer-6"[\s\S]*?<\/g>/,
					''
				)
			);
			roundTrips(live, ungroupLayer(live, 'layer-4'));
			expect(layerById(live, 'layer-4')).toBeUndefined();
		});
	});

	describe('clip to the layer below', () => {
		it('masks the layer with a use of the one below, in a defs made after the title', () => {
			const live = root();
			const layer = (): Element | undefined => layerById(live, 'layer-2');
			roundTrips(live, clipToBelow(live, 'layer-2'));
			expect(layer()?.getAttribute('mask')).toBe('url(#clip-layer-2)');
			const mask = live.querySelector('defs > mask');
			expect(mask?.getAttribute('id')).toBe('clip-layer-2');
			expect(mask?.getAttribute('style')).toBe('mask-type:alpha');
			expect([...(mask?.children ?? [])].map((child) => child.localName)).toEqual(['use']);
			expect(mask?.firstElementChild?.getAttribute('href')).toBe('#layer-1');
			expect(live.children[1]?.localName).toBe('defs');
			expect(clipStateOf(live, layer() ?? live)).toBe('clipped');
			expect(describeLayers(live).find((each) => each.id === 'layer-2')?.clipped).toBe(true);
		});

		it('releases the clip, taking the mask away with the attribute', () => {
			const live = root();
			clipToBelow(live, 'layer-2').apply(live);
			const clipped = live.outerHTML;
			const release = releaseClip(live, 'layer-2');
			release.apply(live);
			expect(live.querySelector('mask')).toBeNull();
			expect(layerById(live, 'layer-2')?.hasAttribute('mask')).toBe(false);
			release.revert(live);
			expect(live.outerHTML).toBe(clipped);
		});

		it('keeps the mask a duplicate of the layer still uses', () => {
			const live = root();
			clipToBelow(live, 'layer-2').apply(live);
			duplicateLayer(live, 'layer-2').apply(live);
			releaseClip(live, 'layer-2').apply(live);
			expect(live.querySelector('mask')?.getAttribute('id')).toBe('clip-layer-2');
		});

		it('does nothing at the bottom, or on a layer masked by another tool', () => {
			const live = root();
			expect(clipToBelow(live, 'layer-1').bytes).toBe(0);
			const masked = root(DRAWING.replace('opacity="0.5"', 'mask="url(#theirs)"'));
			const command = clipToBelow(masked, 'layer-2');
			command.apply(masked);
			expect(command.bytes).toBe(0);
			expect(clipStateOf(masked, layerById(masked, 'layer-2') ?? masked)).toBe('foreign');
		});
	});
});

describe('the clip, as the file has it', () => {
	it('is a mask in a defs after the title, indented as the title is, the use undoing the layer’s move', () => {
		const document = opened();
		document.execute(clipToBelow(document.root, 'layer-2'));
		expect(document.text()).toContain(
			'<title>Harbor</title>\n  <defs><mask id="clip-layer-2" style="mask-type:alpha"><use href="#layer-1" transform="translate(-5 -5)"/></mask></defs>'
		);
		expect(document.text()).toContain(
			'opacity="0.5" transform="translate(5 5)" mask="url(#clip-layer-2)"'
		);
		// And it opens again as a clip.
		expect(opened(document.text()).snapshot().layers[1]?.clipped).toBe(true);
	});
});

describe('merge down', () => {
	it('merges a vector layer onto a vector one, each side in a group with its own look', async () => {
		const document = opened();
		expect(await mergeDown(document, 'layer-2')).toBe('done');
		const merged = document.layer('layer-1');
		expect(document.layer('layer-2')).toBeUndefined();
		expect(merged?.getAttribute('style')).toBeNull();
		expect(merged?.getAttributeNS(DRAWING_NAMESPACE, 'name')).toBe('Sea');
		const [own, upper] = [...(merged?.children ?? [])];
		expect(own?.getAttribute('style')).toBe('fill:red');
		expect(own?.querySelector('rect')).not.toBeNull();
		expect(upper?.getAttribute('opacity')).toBe('0.5');
		expect(upper?.getAttribute('transform')).toBe('translate(5 5)');
		expect(upper?.querySelector('circle')).not.toBeNull();
		expect(render.texts).toHaveLength(0);
		document.undo();
		expect(document.text()).toBe(DRAWING);
		document.redo();
		expect(document.layer('layer-2')).toBeUndefined();
	});

	it('wraps a loose element below in a layer first, as one step', async () => {
		const text = DRAWING.replace(/<g id="layer-1"[\s\S]*?<\/g>/, '<path id="shore" d="M0 0"/>');
		const document = opened(text);
		expect(await mergeDown(document, 'layer-2')).toBe('done');
		const merged = document.layer('layer-7');
		expect(merged?.querySelector('#shore')).not.toBeNull();
		expect(merged?.querySelector('circle')).not.toBeNull();
		document.undo();
		expect(document.text()).toBe(text);
	});

	it('names why it will not merge: nothing below, a hidden layer, a locked one', () => {
		const document = opened();
		expect(mergeProblem(document.root, 'layer-1')).toBe('bottom');
		expect(mergeProblem(document.root, 'layer-5')).toBe('bottom');
		const hidden = opened(DRAWING.replace('opacity="0.5"', 'display="none"'));
		expect(mergeProblem(hidden.root, 'layer-2')).toBe('hidden');
		const locked = opened(DRAWING.replace('draw:name="Sea"', 'draw:locked="true"'));
		expect(mergeProblem(locked.root, 'layer-2')).toBe('locked');
		expect(mergeProblem(document.root, 'layer-2')).toBeUndefined();
	});

	it('renders a raster merge into one raster layer under the lower one’s id', async () => {
		const document = opened();
		expect(await mergeDown(document, 'layer-3')).toBe('done');
		expect(document.layer('layer-3')).toBeUndefined();
		const merged = document.layer('layer-2');
		expect(merged?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe('raster');
		expect(merged?.hasAttribute('opacity')).toBe(false);
		expect(merged?.hasAttribute('transform')).toBe(false);
		const image = merged?.querySelector('image');
		expect(image?.getAttribute('href')).toBe(RENDERED);
		expect(['x', 'y', 'width', 'height'].map((name) => image?.getAttribute(name))).toEqual([
			'0',
			'0',
			'100',
			'80',
		]);
		expect(image?.getAttribute('preserveAspectRatio')).toBe('none');
		expect(render.boxes[0]).toEqual({ x: 0, y: 0, width: 100, height: 80 });
		expect(render.sizes[0]).toEqual([100, 80]);
		expect(render.texts[0]).toContain('<circle r="3"/>');
		expect(render.texts[0]).toContain(PNG);
		expect(render.texts[0]).not.toContain('layer-1');
		document.undo();
		expect(document.text()).toBe(DRAWING);
		document.redo();
		expect(document.layer('layer-2')?.querySelector('image')?.getAttribute('href')).toBe(
			RENDERED
		);
	});
});

describe('rasterize', () => {
	it('keeps the id, name, opacity, blend and lock, and draws the transform into the pixels', async () => {
		const document = opened();
		expect(rasterizeProblem(document.root, 'layer-2')).toBeUndefined();
		expect(await rasterizeLayer(document, 'layer-2')).toBe('done');
		const raster = document.layer('layer-2');
		expect(raster?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe('raster');
		expect(raster?.getAttribute('opacity')).toBe('0.5');
		expect(raster?.hasAttribute('transform')).toBe(false);
		expect(raster?.querySelector('image')?.getAttribute('href')).toBe(RENDERED);
		// Rendered without the opacity the layer keeps, so it is not applied twice.
		expect(render.texts[0]).toContain('transform="translate(5 5)"');
		expect(render.texts[0]).not.toContain('opacity');
		document.undo();
		expect(document.text()).toBe(DRAWING);
	});

	it('draws a clip in with the layer it uses, and lets the clip and the filter go', async () => {
		const document = opened();
		document.execute(clipToBelow(document.root, 'layer-2'));
		document.execute(
			setAdjustments(document.root, 'layer-2', [{ kind: 'blur', values: { radius: 2 } }], 'x')
		);
		const adjusted = document.text();
		expect(await rasterizeLayer(document, 'layer-2')).toBe('done');
		expect(render.texts[0]).toMatch(/<defs><g id="layer-1"/);
		expect(document.root.querySelector('mask')).toBeNull();
		expect(document.root.querySelector('filter')).toBeNull();
		expect(document.layer('layer-2')?.hasAttribute('mask')).toBe(false);
		document.undo();
		expect(document.text()).toBe(adjusted);
	});

	it('is not for a raster layer, nor a locked one', () => {
		const document = opened(DRAWING.replace('draw:name="Sea"', 'draw:locked="true"'));
		expect(rasterizeProblem(document.root, 'layer-3')).toBe('raster');
		expect(rasterizeProblem(document.root, 'layer-1')).toBe('locked');
	});

	it('changes nothing where the browser cannot render', async () => {
		render.canvas = false;
		const document = opened();
		expect(await rasterizeLayer(document, 'layer-2')).toBe('unrenderable');
		expect(document.snapshot().dirty).toBe(false);
	});

	it('changes nothing where the drawing changed while it rendered, and a save waits for it', async () => {
		const document = opened();
		const job = rasterizeLayer(document, 'layer-2');
		const settled = document.settle();
		document.execute(groupLayer(document.root, 'layer-1'));
		expect(await job).toBe('changed');
		await settled;
		expect(document.layer('layer-2')?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe('vector');
	});
});

describe('the operations in a history whose later steps replace the layers they moved', () => {
	const stroke = (id: string): Command =>
		editLayer(id, 'tools.brush', (layer) => {
			layer.appendChild(layer.ownerDocument.createElementNS(SVG_NAMESPACE, 'path'));
		});

	it.each([
		['a group', (document: EditorDocument) => groupLayer(document.root, 'layer-2'), 'layer-2'],
		[
			'an ungroup',
			(document: EditorDocument) => ungroupLayer(document.root, 'layer-4'),
			'layer-5',
		],
		['a clip', (document: EditorDocument) => clipToBelow(document.root, 'layer-2'), 'layer-1'],
	])('undoes %s and a stroke after it back to the file', (_name, make, edited) => {
		const document = opened();
		document.execute(make(document));
		const done = document.text();
		document.execute(stroke(edited));
		document.undo();
		document.undo();
		expect(document.text()).toBe(DRAWING);
		document.redo();
		expect(document.text()).toBe(done);
	});

	it('undoes a vector merge and a stroke on the merged layer back to the file', async () => {
		const document = opened();
		await mergeDown(document, 'layer-2');
		document.execute(stroke('layer-1'));
		document.undo();
		document.undo();
		expect(document.text()).toBe(DRAWING);
	});
});
