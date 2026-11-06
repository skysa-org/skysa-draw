import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import { newAdjustment, setAdjustments } from '../../src/drawing/document/adjustments.js';
import { clipToBelow } from '../../src/drawing/document/clip.js';
import { cropCanvas } from '../../src/drawing/document/crop.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import {
	buildPreview,
	type BuiltPreview,
	previewContext,
	type PreviewTarget,
} from '../../src/drawing/panels/layerPreviews.js';

/**
 * A layer's picture for the layers panel (`layerPreviews.ts`): the SVG text
 * built from the live root, read back by parsing it, as the `<img>` will.
 */

const XLINK = 'http://www.w3.org/1999/xlink';
const ROOT = `xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" xmlns:xlink="${XLINK}"`;
const CANVAS = 'viewBox="0 0 200 100" width="200" height="100"';

const open = (body: string, canvas = CANVAS): EditorDocument => {
	const document = openDocument(`<svg ${ROOT} ${canvas}>${body}</svg>`);
	if (document === undefined) throw new Error('the drawing opens');
	return document;
};

const built = (document: EditorDocument, target: PreviewTarget): BuiltPreview | undefined =>
	buildPreview(previewContext(document.root, document.size), target);

const textOf = (document: EditorDocument, target: PreviewTarget): string => {
	const preview = built(document, target);
	if (preview === undefined) throw new Error('a picture is built');
	return preview.parts.join('');
};

const pictureOf = (document: EditorDocument, target: PreviewTarget): Element => {
	const parsed = new DOMParser().parseFromString(textOf(document, target), 'image/svg+xml');
	expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
	return parsed.documentElement;
};

const idsIn = (picture: Element): readonly string[] =>
	[...picture.querySelectorAll('[id]')].map((element) => element.id);

const byId = (picture: Element, id: string): Element => {
	const found = [...picture.querySelectorAll('[id]')].find((element) => element.id === id);
	if (found === undefined) throw new Error(`#${id} is in the picture`);
	return found;
};

/** A picture's worth of base64: past the length a value is kept apart at. */
const PIXELS = `data:image/png;base64,${'iVBORw0KGgo'.repeat(400)}`;

describe('a layer by itself', () => {
	it('is the canvas fitted in the box, holding that layer and no other', () => {
		const document = open(
			'<g id="layer-1"><path d="M0 0L10 10"/></g><g id="layer-2"><rect width="5" height="5"/></g>'
		);
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(picture.getAttribute('viewBox')).toBe('0 0 200 100');
		expect(picture.getAttribute('width')).toBe('34');
		expect(picture.getAttribute('height')).toBe('17');
		expect(picture.lookupNamespaceURI('draw')).toBe(DRAWING_NAMESPACE);
		expect(idsIn(picture)).toEqual(['layer-1']);
		expect(byId(picture, 'layer-1').innerHTML).toContain('M0 0L10 10');
	});

	it('fits a tall canvas by its height', () => {
		const document = open('<g id="layer-1"/>', 'viewBox="0 0 100 400"');
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(picture.getAttribute('width')).toBe('6.5');
		expect(picture.getAttribute('height')).toBe('26');
	});

	it('gives a canvas that has only a size the viewBox it stands for, and follows a crop', () => {
		const document = open('<g id="layer-1"/>', 'width="300" height="300"');
		expect(pictureOf(document, { layerId: 'layer-1' }).getAttribute('viewBox')).toBe(
			'0 0 300 300'
		);
		document.execute(
			cropCanvas({ x: 10, y: 20, width: 260, height: 130 }, { x: 0, y: 0, ...document.size })
		);
		const cropped = pictureOf(document, { layerId: 'layer-1' });
		expect(cropped.getAttribute('viewBox')).toBe('10 20 260 130');
		expect(cropped.getAttribute('width')).toBe('34');
		expect(cropped.getAttribute('height')).toBe('17');
	});

	it('keeps a raster layer’s picture as a part of its own, the very string the DOM holds', () => {
		const document = open(
			`<g id="layer-1" draw:kind="raster"><image href="${PIXELS}" width="200" height="100" preserveAspectRatio="none"/></g>`
		);
		const href = document.root.querySelector('image')?.getAttribute('href');
		const preview = built(document, { layerId: 'layer-1' });
		expect(preview?.parts).toHaveLength(3);
		expect(preview?.parts[1]).toBe(href);
		expect(preview?.parts.filter((part) => part.includes('iVBOR'))).toHaveLength(1);
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(picture.querySelector('image')?.getAttribute('href')).toBe(PIXELS);
	});

	it('draws a hidden, faint or blended layer fully, and keeps the rest of its style', () => {
		const document = open(
			'<g id="layer-1" display="none" opacity="0.5" style="mix-blend-mode:multiply;opacity:0.3;fill:#f00"><rect width="5" height="5"/></g>'
		);
		const layer = byId(pictureOf(document, { layerId: 'layer-1' }), 'layer-1');
		expect(layer.hasAttribute('display')).toBe(false);
		expect(layer.hasAttribute('opacity')).toBe(false);
		expect(layer.getAttribute('style')).toBe('fill:#f00');
		expect(document.layer('layer-1')?.getAttribute('opacity')).toBe('0.5');
	});

	it('shows a clipped layer’s own pixels: no mask, and not the layer below', () => {
		const document = open(
			'<g id="layer-1"><rect width="50" height="50"/></g><g id="layer-2"><circle r="40"/></g>'
		);
		document.execute(clipToBelow(document.root, 'layer-2'));
		expect(document.layer('layer-2')?.getAttribute('mask')).toBe('url(#clip-layer-2)');
		const picture = pictureOf(document, { layerId: 'layer-2' });
		expect(byId(picture, 'layer-2').hasAttribute('mask')).toBe(false);
		expect(picture.querySelector('mask')).toBeNull();
		expect(idsIn(picture)).toEqual(['layer-2']);
	});

	it('keeps a mask of the file’s own, and what it uses', () => {
		const document = open(
			'<defs><mask id="fade"><rect width="200" height="100" fill="url(#ramp)"/></mask><linearGradient id="ramp"/></defs><g id="layer-1" mask="url(#fade)"><rect width="5" height="5"/></g>'
		);
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(byId(picture, 'layer-1').getAttribute('mask')).toBe('url(#fade)');
		expect(idsIn(picture)).toEqual(['fade', 'ramp', 'layer-1']);
	});

	it('keeps its adjustments: its filter, and the filter’s definition', () => {
		const document = open('<g id="layer-1"><rect width="5" height="5"/></g>');
		document.execute(
			setAdjustments(document.root, 'layer-1', [newAdjustment('blur')], 'adjustments.add')
		);
		const filter = document.layer('layer-1')?.getAttribute('filter');
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(byId(picture, 'layer-1').getAttribute('filter')).toBe(filter);
		expect(picture.querySelector('defs > filter feGaussianBlur')).not.toBeNull();
	});

	it('is drawn where its groups place it, without their compositing or their other layers', () => {
		const document = open(
			'<defs><filter id="soft"><feGaussianBlur stdDeviation="2"/></filter></defs>' +
				'<g id="layer-1" draw:kind="group" transform="translate(10 20)" filter="url(#soft)" opacity="0.4" style="mix-blend-mode:screen">' +
				'<title>Group</title>' +
				'<g id="layer-2"><rect width="5" height="5"/></g>' +
				'<g id="layer-3"><circle r="5"/></g>' +
				'</g><g id="layer-4"/>'
		);
		const picture = pictureOf(document, { layerId: 'layer-2' });
		const group = byId(picture, 'layer-1');
		expect(group.getAttribute('transform')).toBe('translate(10 20)');
		expect(group.getAttribute('filter')).toBe('url(#soft)');
		expect(group.hasAttribute('opacity')).toBe(false);
		expect(group.hasAttribute('style')).toBe(false);
		expect(group.querySelector('title')?.textContent).toBe('Group');
		expect(idsIn(picture)).toEqual(['soft', 'layer-1', 'layer-2']);
	});

	it('draws a group as its layers together, each with its own compositing', () => {
		const document = open(
			'<g id="layer-1" draw:kind="group" opacity="0.4"><g id="layer-2" opacity="0.5"/><g id="layer-3"/></g>'
		);
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(byId(picture, 'layer-1').hasAttribute('opacity')).toBe(false);
		expect(byId(picture, 'layer-2').getAttribute('opacity')).toBe('0.5');
		expect(idsIn(picture)).toEqual(['layer-1', 'layer-2', 'layer-3']);
	});

	it('is nothing for a layer the document does not have', () => {
		expect(built(open('<g id="layer-1"/>'), { layerId: 'layer-9' })).toBeUndefined();
	});
});

describe('one item of a vector layer', () => {
	const document = (): EditorDocument =>
		open(
			'<g id="layer-1" transform="rotate(10)" opacity="0.5"><title>Shapes</title>' +
				'<rect id="a" width="5" height="5"/><circle id="b" r="5"/><path id="c" d="M0 0H5"/></g>'
		);

	it('is that element alone, in its layer’s shell, where the layer places it', () => {
		const picture = pictureOf(document(), { layerId: 'layer-1', position: 1 });
		const layer = byId(picture, 'layer-1');
		expect(layer.getAttribute('transform')).toBe('rotate(10)');
		expect(layer.hasAttribute('opacity')).toBe(false);
		expect([...layer.children].map((child) => child.localName)).toEqual(['title', 'circle']);
	});

	it('frames the item itself, with room round it, at the box’s aspect', () => {
		const shapes = open(
			'<g id="layer-1" transform="translate(100 0)">' +
				'<rect id="a" x="10" y="10" width="40" height="20"/><circle id="b" cx="150" cy="80" r="1"/></g>'
		);
		const preview = built(shapes, { layerId: 'layer-1', position: 0 });
		const picture = pictureOf(shapes, { layerId: 'layer-1', position: 0 });
		const [x = 0, y = 0, width = 0, height = 0] = (picture.getAttribute('viewBox') ?? '')
			.split(' ')
			.map(Number);
		// Seen on the canvas at 110, 10, 40 by 20: centered there, the room round it 12% of 40.
		expect(x + width / 2).toBeCloseTo(130, 2);
		expect(y + height / 2).toBeCloseTo(20, 2);
		expect(width).toBeCloseTo(40 + 2 * 4.8, 2);
		expect(width / height).toBeCloseTo(34 / 26, 2);
		expect(preview?.fit).toEqual({ width: 34, height: 26 });
		// A dot is not blown up past two pixels to a unit.
		const dot = pictureOf(shapes, { layerId: 'layer-1', position: 1 });
		expect(Number((dot.getAttribute('viewBox') ?? '').split(' ')[2])).toBeCloseTo(17, 2);
	});

	it('frames the canvas for an item with nothing to measure', () => {
		const empty = open('<g id="layer-1"><g id="a"/><rect id="b" width="5" height="5"/></g>');
		expect(pictureOf(empty, { layerId: 'layer-1', position: 0 }).getAttribute('viewBox')).toBe(
			'0 0 200 100'
		);
	});

	it('is nothing past the layer’s last element', () => {
		expect(built(document(), { layerId: 'layer-1', position: 3 })).toBeUndefined();
	});

	it('is a loose layer itself at its one place', () => {
		const loose = open('<rect id="layer-1" width="5" height="5" opacity="0.2"/>');
		const picture = pictureOf(loose, { layerId: 'layer-1', position: 0 });
		expect(byId(picture, 'layer-1').localName).toBe('rect');
		expect(byId(picture, 'layer-1').hasAttribute('opacity')).toBe(false);
		expect(built(loose, { layerId: 'layer-1', position: 1 })).toBeUndefined();
	});

	it('copies a sibling it refers to into the definitions', () => {
		const linked = open(
			'<g id="layer-1"><path id="star" d="M0 0L5 5"/><use href="#star" x="20"/></g>'
		);
		const picture = pictureOf(linked, { layerId: 'layer-1', position: 1 });
		expect(picture.querySelector('defs > path#star')).not.toBeNull();
		expect(byId(picture, 'layer-1').querySelector('path')).toBeNull();
	});
});

describe('the definitions a picture keeps', () => {
	it('are those it refers to, in turn, and every style sheet; nothing else', () => {
		const document = open(
			'<defs><linearGradient id="g1" href="#g2"/><linearGradient id="g2"/><linearGradient id="g3"/>' +
				'<pattern id="p" width="4" height="4"/><filter id="f"/>' +
				'<style>.dotted { fill: url(#p) }</style></defs>' +
				'<g id="layer-1"><rect class="dotted" fill="url(#g1)" width="5" height="5"/></g>' +
				'<g id="layer-2" filter="url(#f)"/>'
		);
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(idsIn(picture)).toEqual(['g1', 'g2', 'p', 'layer-1']);
		expect(picture.querySelector('style')?.textContent).toContain('url(#p)');
		expect(built(document, { layerId: 'layer-1' })?.sources.size).toBe(0);
	});

	it('copy what another layer holds, and name that layer as a source', () => {
		const document = open(
			'<g id="layer-1"><use href="#star"/></g><g id="layer-2"><path id="star" d="M0 0L5 5"/></g>'
		);
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(picture.querySelector('defs > path#star')).not.toBeNull();
		expect(idsIn(picture)).not.toContain('layer-2');
		expect([...(built(document, { layerId: 'layer-1' })?.sources ?? [])]).toEqual(['layer-2']);
	});

	it('never take in the layer itself, or a group it is in', () => {
		const document = open(
			'<g id="layer-1" draw:kind="group"><g id="layer-2"><use href="#layer-1"/><use href="#layer-2"/></g></g>'
		);
		const picture = pictureOf(document, { layerId: 'layer-2' });
		expect(picture.querySelector('defs')).toBeNull();
	});
});

describe('the text', () => {
	it('holds nothing that runs: the live root is sanitized, and nothing is added', () => {
		const document = open(
			'<script>alert(1)</script><g id="layer-1" onclick="alert(2)"><a href="javascript:alert(3)"><rect width="5" height="5" onload="alert(4)"/></a>' +
				'<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></g>'
		);
		const text = textOf(document, { layerId: 'layer-1' });
		expect(text).not.toMatch(/<script|\son[a-z]+=|javascript:|foreignObject/i);
		expect(text).toContain('<rect');
	});

	it('is the same parts for the same document, and the root is never touched', () => {
		const document = open(
			`<defs><filter id="f"/></defs><g id="layer-1" filter="url(#f)" opacity="0.5"><image href="${PIXELS}"/></g>`
		);
		const before = new XMLSerializer().serializeToString(document.root);
		const once = built(document, { layerId: 'layer-1' })?.parts;
		const twice = built(document, { layerId: 'layer-1' })?.parts;
		expect(twice).toEqual(once);
		expect(new XMLSerializer().serializeToString(document.root)).toBe(before);
	});

	it('is serialized whole where the file holds what reads as a mark', () => {
		const document = open(
			`<g id="layer-1"><desc>\uE0000\uE000</desc><image href="${PIXELS}"/></g>`
		);
		const parts = built(document, { layerId: 'layer-1' })?.parts;
		expect(parts).toHaveLength(1);
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(picture.querySelector('desc')?.textContent).toBe('\uE0000\uE000');
		expect(picture.querySelector('image')?.getAttribute('href')).toBe(PIXELS);
	});

	it('keeps a long value with something to escape in the markup, escaped', () => {
		const name = 'Ink & "wash" <test> '.repeat(80);
		const document = open(`<g id="layer-1"/>`);
		document.layer('layer-1')?.setAttributeNS(DRAWING_NAMESPACE, 'draw:name', name);
		expect(built(document, { layerId: 'layer-1' })?.parts).toHaveLength(1);
		const picture = pictureOf(document, { layerId: 'layer-1' });
		expect(byId(picture, 'layer-1').getAttributeNS(DRAWING_NAMESPACE, 'name')).toBe(name);
	});
});
