import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	addLayer,
	compound,
	duplicateLayer,
	editLayer,
	moveLayer,
	removeLayer,
	renameLayer,
	replaceRasterImage,
	setLayerBlend,
	setLayerHidden,
	setLayerLocked,
	setLayerOpacity,
	wrapLooseLayer,
} from '../../src/drawing/document/commands.js';
import {
	defsOf,
	drawingPrefixOf,
	giveLayerIds,
	isLayerHidden,
	isLayerLocked,
	layerBlendOf,
	layerById,
	layerElementsOf,
	layerInfoOf,
	layerKindOf,
	layerNameOf,
	layerOpacityOf,
	layersOf,
	writeLayerKind,
} from '../../src/drawing/document/layers.js';
import type { Command } from '../../src/drawing/document/model.js';
import {
	parseDrawing,
	XLINK_NAMESPACE,
	XMLNS_NAMESPACE,
} from '../../src/drawing/document/sanitize.js';

/**
 * The commands (docs/ARCHITECTURE.md §7, "Commands and history"): what each
 * does to the SVG, and that each undoes itself exactly, attribute order and
 * whitespace included, in the XML document the drawing was parsed into and
 * once the viewport has put the root in the page. A drawing whose app
 * namespace is bound to another prefix, or not bound at all, is undone as
 * exactly as one this app wrote.
 */

const INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const drawing = (prefix = 'draw'): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NAMESPACE}" xmlns:${prefix}="${DRAWING_NAMESPACE}" xmlns:xlink="${XLINK_NAMESPACE}" ${prefix}:id="d1" viewBox="0 0 100 100">
  <title>Harbor</title>
  <defs>
    <linearGradient id="outside"><stop offset="0"/></linearGradient>
  </defs>
  <g id="layer-1" ${prefix}:kind="vector" style="fill:red;display:inline">
    <rect id="r" width="10" height="10" fill="url(#outside)"/>
  </g>
  <g id="layer-2" ${prefix}:kind="raster">
    <image href="${PNG}" x="0" y="0" width="10" height="10" preserveAspectRatio="none"/>
  </g>
  <g id="layer-3" ${prefix}:kind="group" ${prefix}:name="Boats">
    <g id="layer-4" ${prefix}:kind="vector">
      <defs><linearGradient id="hull"><stop offset="0"/></linearGradient></defs>
      <path id="boat" d="M0 0" fill="url(#hull)" style="stroke:url('#hull')"/>
      <use href="#boat" x="5"/>
    </g>
    <g id="layer-5" ${prefix}:kind="vector"/>
  </g>
  <path id="loose" d="M1 1"/>
  <path d="M2 2"/>
</svg>
`;

/** A drawing from elsewhere: no app namespace, Inkscape's layers. */
const INKSCAPE_DRAWING = `<svg xmlns="${SVG_NAMESPACE}" xmlns:inkscape="${INKSCAPE}" xmlns:xlink="${XLINK_NAMESPACE}" viewBox="0 0 10 10">
  <g id="layer1" inkscape:label="Sky" inkscape:groupmode="layer" style="display:inline"><rect width="1" height="1"/></g>
  <g id="layer2" inkscape:label="Photo"><image xlink:href="${PNG}" width="5" height="5"/></g>
</svg>
`;

const placements = ['in its own document', 'in the page'] as const;

type Placement = (typeof placements)[number];

/** The root, with its layers' ids given, where the viewport would have it or not. */
const open = (text: string, placement: Placement = 'in its own document'): SVGSVGElement => {
	const document = parseDrawing(text);
	if (document === undefined) throw new Error('the test drawing parses');
	const root = document.documentElement as unknown as SVGSVGElement;
	giveLayerIds(root);
	if (placement === 'in the page') window.document.body.appendChild(root);
	return root;
};

afterEach(() => {
	window.document.body.replaceChildren();
});

/** Applied, reverted, applied again and reverted again: the same root each way. */
const roundTrips = (root: SVGSVGElement, command: Command): string => {
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
	return after;
};

const ids = (root: Element): readonly string[] => layersOf(root).map((layer) => layer.id);

describe.each(placements)('the commands, with the root %s', (placement) => {
	describe.each(['draw', 'sk'])('and the app namespace bound to %s', (prefix) => {
		const root = (): SVGSVGElement => open(drawing(prefix), placement);

		it('adds a layer on top, with the next free id and its kind', () => {
			const live = root();
			const command = addLayer(live, 'raster');
			expect(command.id).toBe('layer-7');
			expect(command.label).toBe('layers.addRaster');
			roundTrips(live, command);
			const layer = layerById(live, 'layer-7');
			expect(layer?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe('raster');
			expect(layer?.getAttribute(`${prefix}:kind`)).toBe('raster');
			expect(live.lastElementChild).toBe(layer);
		});

		it('adds a layer above the one named, in its group', () => {
			const live = root();
			roundTrips(live, addLayer(live, 'vector', { above: 'layer-4' }));
			expect(ids(live)).toEqual([
				'layer-1',
				'layer-2',
				'layer-3',
				'layer-4',
				'layer-7',
				'layer-5',
				'loose',
				'layer-6',
			]);
			expect(layerById(live, 'layer-7')?.parentElement?.getAttribute('id')).toBe('layer-3');
		});

		it('removes a layer, and puts it back where it was', () => {
			const live = root();
			roundTrips(live, removeLayer('layer-2'));
			expect(layerById(live, 'layer-2')).toBeUndefined();
			expect(live.outerHTML).not.toContain(PNG);
		});

		it('moves a layer up and down among its siblings', () => {
			const live = root();
			roundTrips(live, moveLayer('layer-1', 'up'));
			expect(ids(live).slice(0, 2)).toEqual(['layer-2', 'layer-1']);
			const inGroup = root();
			roundTrips(inGroup, moveLayer('layer-5', 'down'));
			expect(ids(inGroup).slice(2, 5)).toEqual(['layer-3', 'layer-5', 'layer-4']);
		});

		it('does nothing, and costs nothing, moving a layer past the end', () => {
			const live = root();
			const before = live.outerHTML;
			const top = moveLayer('layer-6', 'up');
			top.apply(live);
			expect(top.bytes).toBe(0);
			const bottom = moveLayer('layer-4', 'down');
			bottom.apply(live);
			expect(bottom.bytes).toBe(0);
			expect(live.outerHTML).toBe(before);
		});

		it('renames a layer into draw:name, under the prefix the file binds', () => {
			const live = root();
			roundTrips(live, renameLayer('layer-1', 'Sky'));
			const layer = layerById(live, 'layer-1');
			expect(layer?.getAttributeNS(DRAWING_NAMESPACE, 'name')).toBe('Sky');
			expect(layer?.getAttribute(`${prefix}:name`)).toBe('Sky');
		});

		it('hides a layer with display="none", taking a display out of style', () => {
			const live = root();
			roundTrips(live, setLayerHidden('layer-1', true));
			const layer = layerById(live, 'layer-1');
			expect(layer?.getAttribute('display')).toBe('none');
			expect(layer?.getAttribute('style')).toBe('fill:red');
			expect(layersOf(live)[0]?.hidden).toBe(true);
		});

		it('locks a layer with draw:locked', () => {
			const live = root();
			roundTrips(live, setLayerLocked('layer-1', true));
			expect(layerById(live, 'layer-1')?.getAttributeNS(DRAWING_NAMESPACE, 'locked')).toBe(
				'true'
			);
		});

		it('sets the opacity attribute', () => {
			const live = root();
			roundTrips(live, setLayerOpacity('layer-1', 0.25));
			expect(layerById(live, 'layer-1')?.getAttribute('opacity')).toBe('0.25');
		});

		it('sets the blend mode in style, keeping the rest of it', () => {
			const live = root();
			roundTrips(live, setLayerBlend('layer-1', 'multiply'));
			expect(layerById(live, 'layer-1')?.getAttribute('style')).toBe(
				'fill:red;display:inline;mix-blend-mode:multiply'
			);
			expect(layersOf(live)[0]?.blend).toBe('multiply');
		});

		it('duplicates a group above itself, with fresh ids and its references pointed at the copy', () => {
			const live = root();
			const command = duplicateLayer(live, 'layer-3');
			expect(command.id).toBe('layer-7');
			roundTrips(live, command);
			expect(ids(live)).toEqual([
				'layer-1',
				'layer-2',
				'layer-3',
				'layer-4',
				'layer-5',
				'layer-7',
				'layer-8',
				'layer-9',
				'loose',
				'layer-6',
			]);
			const copy = layerById(live, 'layer-7');
			expect(copy?.previousElementSibling?.getAttribute('id')).toBe('layer-3');
			expect(copy?.getAttributeNS(DRAWING_NAMESPACE, 'name')).toBe('Boats');
			const path = copy?.querySelector('path');
			expect(path?.getAttribute('id')).toBe('boat-copy');
			expect(path?.getAttribute('fill')).toBe('url(#hull-copy)');
			expect(path?.getAttribute('style')).toBe("stroke:url('#hull-copy')");
			expect(copy?.querySelector('linearGradient')?.getAttribute('id')).toBe('hull-copy');
			expect(copy?.querySelector('use')?.getAttribute('href')).toBe('#boat-copy');
			// The original is as it was.
			expect(layerById(live, 'layer-4')?.querySelector('path')?.getAttribute('fill')).toBe(
				'url(#hull)'
			);
		});

		it('duplicates with a reference to something outside the copy left alone', () => {
			const live = root();
			roundTrips(live, duplicateLayer(live, 'layer-1'));
			const copy = layerById(live, 'layer-7');
			expect(copy?.querySelector('rect')?.getAttribute('id')).toBe('r-copy');
			expect(copy?.querySelector('rect')?.getAttribute('fill')).toBe('url(#outside)');
		});

		it('wraps a loose element whose id it gave in a vector group that takes the id', () => {
			const live = root();
			const command = wrapLooseLayer(live, 'layer-6');
			expect(command.id).toBe('layer-6');
			roundTrips(live, command);
			const group = layerById(live, 'layer-6');
			expect(group?.localName).toBe('g');
			expect(group?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe('vector');
			expect(group?.firstElementChild?.localName).toBe('path');
			expect(group?.firstElementChild?.hasAttribute('id')).toBe(false);
			expect(layersOf(live).at(-1)?.loose).toBe(false);
		});

		it('wraps a loose element with an id of its own in a group with a new one', () => {
			const live = root();
			const command = wrapLooseLayer(live, 'loose');
			expect(command.id).toBe('layer-7');
			roundTrips(live, command);
			const group = layerById(live, 'layer-7');
			expect(group?.firstElementChild?.getAttribute('id')).toBe('loose');
		});

		it('edits a layer, and puts back the markup before and after', () => {
			const live = root();
			const command = editLayer('layer-1', 'tools.pencil', (layer) => {
				const path = layer.ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
				path.setAttribute('d', 'M0 0 L10 10');
				layer.appendChild(path);
			});
			const after = roundTrips(live, command);
			expect(after).toContain('d="M0 0 L10 10"');
			expect(command.bytes).toBeGreaterThan(0);
			expect(command.label).toBe('tools.pencil');
		});

		it('replaces a raster layer’s picture, and puts the old one back', () => {
			const live = root();
			const command = replaceRasterImage('layer-2', 'tools.brush', {
				href: 'data:image/png;base64,NEW=',
				x: 1,
				y: 2,
				width: 30,
				height: 40,
			});
			roundTrips(live, command);
			const image = layerById(live, 'layer-2')?.querySelector('image');
			expect(image?.getAttribute('href')).toBe('data:image/png;base64,NEW=');
			expect([
				...['x', 'y', 'width', 'height'].map((name) => image?.getAttribute(name)),
			]).toEqual(['1', '2', '30', '40']);
			expect(image?.getAttribute('preserveAspectRatio')).toBe('none');
		});
	});

	describe('a drawing from elsewhere', () => {
		const root = (): SVGSVGElement => open(INKSCAPE_DRAWING, placement);

		it('declares the app namespace to rename a layer, and takes it away on undo', () => {
			const live = root();
			roundTrips(live, renameLayer('layer1', 'Clouds'));
			expect(live.getAttribute('xmlns:draw')).toBe(DRAWING_NAMESPACE);
			const layer = layerById(live, 'layer1');
			expect(layer?.getAttribute('draw:name')).toBe('Clouds');
			// Inkscape's label is read, never written.
			expect(layer?.getAttributeNS(INKSCAPE, 'label')).toBe('Sky');
			expect(layersOf(live)[0]?.name).toBe('Clouds');
		});

		it('declares the app namespace to add a layer, and takes it away on undo', () => {
			const live = root();
			roundTrips(live, addLayer(live, 'vector'));
			expect(layerById(live, 'layer-1')?.getAttribute('draw:kind')).toBe('vector');
		});

		it('replaces an xlink:href picture with href, writing preserveAspectRatio and taking it away on undo', () => {
			const live = root();
			const image = (): Element | null | undefined =>
				layerById(live, 'layer2')?.querySelector('image');
			expect(image()?.hasAttribute('preserveAspectRatio')).toBe(false);
			roundTrips(
				live,
				replaceRasterImage('layer2', 'tools.brush', {
					href: PNG,
					x: 0,
					y: 0,
					width: 5,
					height: 5,
				})
			);
			expect(image()?.getAttribute('href')).toBe(PNG);
			expect(image()?.hasAttributeNS(XLINK_NAMESPACE, 'href')).toBe(false);
			expect(image()?.getAttribute('preserveAspectRatio')).toBe('none');
		});

		it('writes preserveAspectRatio="none" over another value, and puts that value back on undo', () => {
			const live = open(
				`<svg xmlns="${SVG_NAMESPACE}"><g id="photo"><image href="${PNG}" width="5" height="5" preserveAspectRatio="xMidYMid slice"/></g></svg>`,
				placement
			);
			const image = (): Element | null | undefined =>
				layerById(live, 'photo')?.querySelector('image');
			const command = replaceRasterImage('photo', 'tools.brush', {
				href: PNG,
				x: 0,
				y: 0,
				width: 5,
				height: 5,
			});
			roundTrips(live, command);
			expect(image()?.getAttribute('preserveAspectRatio')).toBe('none');
			command.revert(live);
			expect(image()?.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice');
		});

		it('hides an Inkscape layer whose style says display:inline', () => {
			const live = root();
			roundTrips(live, setLayerHidden('layer1', true));
			expect(layerById(live, 'layer1')?.hasAttribute('style')).toBe(false);
			expect(layersOf(live)[0]?.hidden).toBe(true);
		});
	});

	it('makes the image on an empty raster layer, and takes it away on undo', () => {
		const live = open(drawing(), placement);
		const added = addLayer(live, 'raster');
		added.apply(live);
		roundTrips(
			live,
			replaceRasterImage(added.id, 'tools.brush', {
				href: PNG,
				x: 0,
				y: 0,
				width: 8,
				height: 6,
			})
		);
		const image = layerById(live, added.id)?.firstElementChild;
		expect(image?.localName).toBe('image');
		expect(image?.namespaceURI).toBe(SVG_NAMESPACE);
		expect(image?.getAttribute('preserveAspectRatio')).toBe('none');
		expect(layersOf(live).at(-1)?.kind).toBe('raster');
	});
});

describe('a command whose layer is gone', () => {
	it('does nothing and costs nothing', () => {
		const live = open(drawing());
		const before = live.outerHTML;
		const commands = [
			editLayer('nowhere', 'tools.pencil', () => undefined),
			replaceRasterImage('nowhere', 'tools.brush', {
				href: PNG,
				x: 0,
				y: 0,
				width: 1,
				height: 1,
			}),
			removeLayer('nowhere'),
			renameLayer('nowhere', 'x'),
			setLayerHidden('nowhere', true),
			moveLayer('nowhere', 'up'),
		];
		commands.forEach((command) => command.apply(live));
		expect(commands.map((command) => command.bytes)).toEqual([0, 0, 0, 0, 0, 0]);
		expect(live.outerHTML).toBe(before);
	});
});

describe('the layer helpers the commands are made of', () => {
	it('lists the layer elements in the order layersOf does', () => {
		const live = open(drawing());
		expect(layerElementsOf(live).map((element) => element.getAttribute('id'))).toEqual(
			ids(live)
		);
	});

	it('finds the defs, or makes one after the title', () => {
		const live = open(drawing());
		expect(defsOf(live).querySelector('linearGradient')?.getAttribute('id')).toBe('outside');
		const bare = open(`<svg xmlns="${SVG_NAMESPACE}"><title>T</title><g/></svg>`);
		const made = defsOf(bare);
		expect(bare.children[1]).toBe(made);
		expect(defsOf(bare)).toBe(made);
		const untitled = open(`<svg xmlns="${SVG_NAMESPACE}"><g/></svg>`);
		const first = defsOf(untitled);
		expect(untitled.firstElementChild).toBe(first);
	});

	it('declares draw2 where the file binds draw to something else', () => {
		const live = open(
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="urn:example:other"><g id="a"/></svg>`
		);
		expect(drawingPrefixOf(live)).toBe('draw2');
		const layer = layerById(live, 'a');
		if (layer === undefined) throw new Error('the layer is there');
		writeLayerKind(live, layer, 'raster');
		expect(layer.getAttribute('draw2:kind')).toBe('raster');
		expect(layersOf(live)[0]?.kind).toBe('raster');
	});

	it('declares a free prefix however many are taken', () => {
		const taken = Array.from(
			{ length: 20_000 },
			(_, i) => ` xmlns:draw${i === 0 ? '' : i + 1}="urn:example:other"`
		).join('');
		const live = open(`<svg xmlns="${SVG_NAMESPACE}"${taken}><g id="a"/></svg>`);
		expect(drawingPrefixOf(live)).toBe('draw20001');
		expect(live.getAttributeNS(XMLNS_NAMESPACE, 'draw20001')).toBe(DRAWING_NAMESPACE);
	});

	it('reads what a layer says of itself, the style before the attribute', () => {
		const live = open(
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:sk="${DRAWING_NAMESPACE}" xmlns:inkscape="${INKSCAPE}">` +
				`<g id="a" sk:kind="raster" sk:name="" inkscape:label="Sky" sk:locked="true" display="none" style="display:inline; opacity: 40% ; mix-blend-mode: Screen !important"/>` +
				`<g id="b" opacity="7" style="display:none;mix-blend-mode:sideways"/>` +
				`<g id="c" draw-kind="group" opacity="nonsense"/>` +
				`</svg>`
		);
		const [a, b, c] = layerElementsOf(live);
		if (a === undefined || b === undefined || c === undefined) throw new Error('three layers');
		expect([layerKindOf(a), layerKindOf(b), layerKindOf(c)]).toEqual([
			'raster',
			'vector',
			'vector',
		]);
		expect([layerNameOf(a), layerNameOf(b)]).toEqual(['Sky', undefined]);
		expect([isLayerHidden(a), isLayerHidden(b)]).toEqual([false, true]);
		expect([layerOpacityOf(a), layerOpacityOf(b), layerOpacityOf(c)]).toEqual([0.4, 1, 1]);
		expect([layerBlendOf(a), layerBlendOf(b)]).toEqual(['screen', 'normal']);
		expect([isLayerLocked(a), isLayerLocked(b)]).toEqual([true, false]);
		expect(layerInfoOf(a, 2, 'folder')).toEqual({
			id: 'a',
			kind: 'raster',
			name: 'Sky',
			hidden: false,
			locked: true,
			opacity: 0.4,
			blend: 'screen',
			depth: 2,
			parentId: 'folder',
			loose: false,
		});
	});
});

describe('compound', () => {
	it('applies its parts in order, reverts them in reverse, and costs what they cost', () => {
		const order: string[] = [];
		const part = (name: string, bytes: number) => ({
			label: name,
			apply: () => {
				order.push(`apply ${name}`);
			},
			revert: () => {
				order.push(`revert ${name}`);
			},
			bytes,
		});
		const both = compound('layers.add', [part('a', 3), part('b', 4)]);
		const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		both.apply(root);
		both.revert(root);
		expect(order).toEqual(['apply a', 'apply b', 'revert b', 'revert a']);
		expect(both.bytes).toBe(7);
		expect(both.label).toBe('layers.add');
	});
});
