import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import {
	MATHML_NAMESPACE,
	parseDrawing,
	sanitizeDrawing,
	XHTML_NAMESPACE,
	XLINK_NAMESPACE,
	XMLNS_NAMESPACE,
} from '../../src/drawing/document/sanitize.js';
import { serializeDrawing } from '../../src/drawing/document/serialize.js';
import { drawingFixture as fixture } from '../fixtures/drawing/fixtures.js';

/**
 * What the sanitizer takes out of a drawing and what it keeps
 * (docs/ARCHITECTURE.md §9, "SVG is script's way in"; §7, "The editor"). This
 * file is the list §9 points at: every way script gets into a page through an
 * SVG is here and must go, and everything a drawing from this app, Inkscape or
 * Illustrator needs is here and must stay.
 */

const INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape';
const SODIPODI = 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd';

const DECLARATIONS = [
	`xmlns="${SVG_NAMESPACE}"`,
	`xmlns:xlink="${XLINK_NAMESPACE}"`,
	`xmlns:draw="${DRAWING_NAMESPACE}"`,
	`xmlns:html="${XHTML_NAMESPACE}"`,
	`xmlns:inkscape="${INKSCAPE}"`,
	`xmlns:sodipodi="${SODIPODI}"`,
].join(' ');

const parsed = (text: string): XMLDocument => {
	const document = parseDrawing(text);
	if (document === undefined) throw new Error('the test drawing parses');
	return document;
};

/** The root of `body` in a drawing that declares the usual namespaces, sanitized. */
const sanitized = (body: string, rootAttributes = ''): Element => {
	const document = parsed(`<svg ${DECLARATIONS} ${rootAttributes}>${body}</svg>`);
	sanitizeDrawing(document);
	return document.documentElement;
};

const serialize = (node: Node): string => new XMLSerializer().serializeToString(node);

/** The text nodes under `node` that are only whitespace. */
const spacesIn = (node: Node): readonly Text[] =>
	[...node.childNodes].flatMap((child) =>
		child instanceof Text ? (child.data.trim() === '' ? [child] : []) : spacesIn(child)
	);

/** The text with its whitespace-only text nodes gone, so a removed line's indentation does not count. */
const withoutSpacing = (text: string): string => {
	const document = parsed(text);
	spacesIn(document.documentElement).forEach((space) => space.remove());
	return serialize(document.documentElement);
};

const sanitizedText = (text: string): string => {
	const document = parsed(text);
	sanitizeDrawing(document);
	return serialize(document.documentElement);
};

/** Sanitized and written as the editor writes a drawing, for opening again. */
const sanitizedDrawing = (text: string): string => {
	const document = parsed(text);
	sanitizeDrawing(document);
	return serializeDrawing(document.documentElement, '');
};

describe('parseDrawing', () => {
	it('parses an SVG document', () => {
		const document = parseDrawing(`<svg xmlns="${SVG_NAMESPACE}"><g/></svg>`);
		expect(document?.documentElement.localName).toBe('svg');
	});

	it('refuses text that is not well-formed', () => {
		expect(parseDrawing(`<svg xmlns="${SVG_NAMESPACE}"><g></svg>`)).toBeUndefined();
	});

	it('refuses a root that is not svg, or not in the SVG namespace', () => {
		expect(parseDrawing(`<html xmlns="${XHTML_NAMESPACE}"/>`)).toBeUndefined();
		expect(parseDrawing('<svg/>')).toBeUndefined();
		expect(parseDrawing(`<svg xmlns="urn:not-svg"/>`)).toBeUndefined();
	});
});

describe('what the sanitizer removes', () => {
	it('removes <script>, with what is in it', () => {
		const root = sanitized(
			`<script>alert(1)</script><script xlink:href="https://evil.example/x.js"/><g/>`
		);
		expect(root.getElementsByTagNameNS(SVG_NAMESPACE, 'script')).toHaveLength(0);
		expect(root.textContent).not.toContain('alert');
	});

	it('removes an XHTML <script> inside the drawing', () => {
		const root = sanitized(`<g><html:script src="https://evil.example/x.js"/></g>`);
		expect(root.getElementsByTagNameNS(XHTML_NAMESPACE, 'script')).toHaveLength(0);
	});

	it('removes every on* attribute, however it is cased', () => {
		const root = sanitized(
			`<g id="a" onclick="alert(1)" ONMOUSEOVER="alert(2)"><rect onload="alert(3)" onError="alert(4)" width="1"/></g>`,
			`onload="alert(0)"`
		);
		const handlers = [root, ...root.querySelectorAll('*')].flatMap((element) =>
			[...element.attributes].filter((attribute) =>
				attribute.localName.toLowerCase().startsWith('on')
			)
		);
		expect(handlers).toHaveLength(0);
		expect(root.querySelector('rect')?.getAttribute('width')).toBe('1');
	});

	it.each([
		['href', 'javascript:alert(1)'],
		['href', 'JavaScript:alert(1)'],
		['href', '  javascript:alert(1)'],
		['href', 'java&#x09;script:alert(1)'],
		['href', 'java&#x0A;script:alert(1)'],
		['href', '&#106;avascript:alert(1)'],
		['href', '&#x0D;&#x20;javascript:alert(1)'],
		['xlink:href', 'javascript:alert(1)'],
		['xlink:href', 'jav&#x0D;ascript:alert(1)'],
		['href', 'vbscript:msgbox(1)'],
		['href', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
		['xlink:href', 'data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;'],
	])('removes %s="%s" from a link', (name, value) => {
		const root = sanitized(`<a ${name}="${value}"><text>x</text></a>`);
		const link = root.querySelector('a');
		expect(link).not.toBeNull();
		expect(link?.hasAttribute('href')).toBe(false);
		expect(link?.hasAttributeNS(XLINK_NAMESPACE, 'href')).toBe(false);
		expect(link?.textContent).toBe('x');
	});

	it('removes an image href that is a data: URL of anything but a picture', () => {
		const root = sanitized(
			`<image href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;" width="1" height="1"/>` +
				`<image xlink:href="javascript:alert(1)" width="1" height="1"/>`
		);
		const images = [...root.querySelectorAll('image')];
		expect(images).toHaveLength(2);
		images.forEach((image) => {
			expect(image.hasAttribute('href')).toBe(false);
			expect(image.hasAttributeNS(XLINK_NAMESPACE, 'href')).toBe(false);
		});
	});

	it('removes <foreignObject>, with what is in it', () => {
		const root = sanitized(
			`<foreignObject width="10" height="10"><html:div onclick="alert(1)">html</html:div><html:iframe src="https://evil.example/"/></foreignObject>`
		);
		expect(root.getElementsByTagNameNS(SVG_NAMESPACE, 'foreignObject')).toHaveLength(0);
		expect(root.getElementsByTagNameNS(XHTML_NAMESPACE, '*')).toHaveLength(0);
		expect(root.textContent).not.toContain('html');
	});

	it.each([
		['href', 'https://evil.example/sprite.svg#icon'],
		['href', 'sprite.svg#icon'],
		['xlink:href', 'data:image/svg+xml;base64,PHN2Zy8+#x'],
		['href', ''],
	])('removes a <use> with %s="%s", which reaches outside the document', (name, value) => {
		const root = sanitized(`<use ${name}="${value}"/>`);
		expect(root.getElementsByTagNameNS(SVG_NAMESPACE, 'use')).toHaveLength(0);
	});

	it('removes a <use> whose href is local but whose xlink:href is not', () => {
		const root = sanitized(`<use href="#a" xlink:href="https://evil.example/x.svg#b"/>`);
		expect(root.getElementsByTagNameNS(SVG_NAMESPACE, 'use')).toHaveLength(0);
	});

	it('removes <animate> and <set> that would change a link', () => {
		const root = sanitized(
			`<a href="#x"><animate attributeName="href" values="javascript:alert(1)"/>` +
				`<set attributeName="xlink:href" to="javascript:alert(1)"/>` +
				`<animate attributeName="HREF" values="javascript:alert(1)"/><text>x</text></a>`
		);
		expect(root.getElementsByTagNameNS(SVG_NAMESPACE, 'animate')).toHaveLength(0);
		expect(root.getElementsByTagNameNS(SVG_NAMESPACE, 'set')).toHaveLength(0);
	});

	it('keeps <a>, and checks its link', () => {
		const root = sanitized(
			`<a href="https://example.com/"><text>safe</text></a><a href="javascript:alert(1)"><text>bad</text></a>`
		);
		const [safe, bad] = [...root.querySelectorAll('a')];
		expect(safe?.getAttribute('href')).toBe('https://example.com/');
		expect(bad?.hasAttribute('href')).toBe(false);
	});

	it('judges an attribute by its namespace, not its prefix: draw: bound to XLink is a link', () => {
		const root = sanitized(
			`<a xmlns:draw="${XLINK_NAMESPACE}" draw:href="javascript:alert(1)"><text>x</text></a>`
		);
		expect(root.querySelector('a')?.hasAttributeNS(XLINK_NAMESPACE, 'href')).toBe(false);
	});

	it('does not keep a link because a foreign attribute is named the same in another case', () => {
		const root = sanitized(
			`<a xmlns:Foo="${XLINK_NAMESPACE}" xmlns:foo="urn:example:inert" Foo:href="javascript:alert(1)" foo:href="kept?"><text>x</text></a>`
		);
		expect(root.querySelector('a')?.hasAttributeNS(XLINK_NAMESPACE, 'href')).toBe(false);
	});

	it('removes SVG and XHTML elements inside a foreign one, and its handlers and links', () => {
		const root = sanitized(
			`<metadata><x:note xmlns:x="urn:example:inert" onclick="alert(1)" xlink:href="javascript:alert(2)">note<script>alert(3)</script><html:img src="x" onerror="alert(4)"/></x:note></metadata>`
		);
		const note = root.getElementsByTagNameNS('urn:example:inert', 'note')[0];
		expect(note).toBeDefined();
		expect(note?.textContent).toBe('note');
		expect(note?.hasAttribute('onclick')).toBe(false);
		expect(note?.hasAttributeNS(XLINK_NAMESPACE, 'href')).toBe(false);
		expect(root.getElementsByTagNameNS(SVG_NAMESPACE, 'script')).toHaveLength(0);
		expect(root.getElementsByTagNameNS(XHTML_NAMESPACE, 'img')).toHaveLength(0);
	});

	it('removes a foreign element that was inside something removed whole', () => {
		const root = sanitized(
			`<foreignObject><x:note xmlns:x="urn:example:inert">gone</x:note></foreignObject>`
		);
		expect(root.getElementsByTagNameNS('urn:example:inert', 'note')).toHaveLength(0);
	});

	it('removes MathML, which no drawing needs', () => {
		const root = sanitized(`<g><math xmlns="${MATHML_NAMESPACE}"><mi>x</mi></math></g>`);
		expect(root.getElementsByTagNameNS(MATHML_NAMESPACE, '*')).toHaveLength(0);
	});

	it('removes processing instructions in the body', () => {
		const root = sanitized(`<g><?xml-stylesheet href="evil.css"?></g>`);
		expect(serialize(root)).not.toContain('<?');
	});

	it('removes a script an internal entity would put in', () => {
		const document = parsed(
			`<!DOCTYPE svg [<!ENTITY payload "<script>alert(1)</script>">]><svg xmlns="${SVG_NAMESPACE}"><g>&payload;</g></svg>`
		);
		sanitizeDrawing(document);
		expect(document.getElementsByTagNameNS(SVG_NAMESPACE, 'script')).toHaveLength(0);
	});
});

describe('what the sanitizer keeps', () => {
	it('keeps the root namespaces and draw:id', () => {
		const root = sanitized('<g/>', 'draw:id="7f1b8c2e-1"');
		expect(root.getAttribute('xmlns')).toBe(SVG_NAMESPACE);
		expect(root.getAttributeNS(XMLNS_NAMESPACE, 'draw')).toBe(DRAWING_NAMESPACE);
		expect(root.getAttributeNS(XMLNS_NAMESPACE, 'xlink')).toBe(XLINK_NAMESPACE);
		expect(root.getAttributeNS(DRAWING_NAMESPACE, 'id')).toBe('7f1b8c2e-1');
	});

	it('keeps draw:kind, draw:name and draw:locked on any element', () => {
		const root = sanitized(
			`<g id="a" draw:kind="raster" draw:name="Sky" draw:locked="true"><path d="M0 0" draw:name="Line"/></g>`
		);
		const layer = root.querySelector('g');
		expect(layer?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe('raster');
		expect(layer?.getAttributeNS(DRAWING_NAMESPACE, 'name')).toBe('Sky');
		expect(layer?.getAttributeNS(DRAWING_NAMESPACE, 'locked')).toBe('true');
		expect(root.querySelector('path')?.getAttributeNS(DRAWING_NAMESPACE, 'name')).toBe('Line');
	});

	it('keeps the app’s attributes under another prefix, by their namespace', () => {
		const document = parsed(
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:sk="${DRAWING_NAMESPACE}" sk:id="abc"><g sk:kind="vector" sk:name="Ink" sk:locked="true"/></svg>`
		);
		sanitizeDrawing(document);
		const layer = document.querySelector('g');
		expect(document.documentElement.getAttributeNS(DRAWING_NAMESPACE, 'id')).toBe('abc');
		expect(layer?.getAttributeNS(DRAWING_NAMESPACE, 'kind')).toBe('vector');
		expect(layer?.getAttributeNS(DRAWING_NAMESPACE, 'name')).toBe('Ink');
		expect(layer?.getAttributeNS(DRAWING_NAMESPACE, 'locked')).toBe('true');
		expect(serialize(document.documentElement)).toContain('sk:name="Ink"');
	});

	it('keeps xlink:href on <image> and on a local <use>', () => {
		const root = sanitized(
			`<symbol id="s"><rect width="1" height="1"/></symbol><use xlink:href="#s"/><use href="#s"/><image xlink:href="photo-3f9a1c2b.jpg" width="1" height="1"/>`
		);
		expect(root.querySelector('image')?.getAttributeNS(XLINK_NAMESPACE, 'href')).toBe(
			'photo-3f9a1c2b.jpg'
		);
		const uses = [...root.getElementsByTagNameNS(SVG_NAMESPACE, 'use')];
		expect(uses).toHaveLength(2);
		expect(uses[0]?.getAttributeNS(XLINK_NAMESPACE, 'href')).toBe('#s');
		expect(uses[1]?.getAttribute('href')).toBe('#s');
	});

	it.each([
		['a data: PNG', 'data:image/png;base64,iVBORw0KGgo='],
		['a relative file beside the drawing', 'photo-3f9a1c2b.jpg'],
		['an https picture', 'https://example.com/photo.jpg'],
		['a data: SVG picture', 'data:image/svg+xml;base64,PHN2Zy8+'],
	])('keeps an <image> of %s', (_label, href) => {
		const root = sanitized(`<image href="${href}" x="0" y="0" width="10" height="10"/>`);
		expect(root.querySelector('image')?.getAttribute('href')).toBe(href);
	});

	it('keeps a filter’s <feImage> of a data: picture', () => {
		const root = sanitized(
			`<filter id="f"><feImage href="data:image/png;base64,iVBORw0KGgo="/></filter>`
		);
		expect(root.getElementsByTagNameNS(SVG_NAMESPACE, 'feImage')[0]?.getAttribute('href')).toBe(
			'data:image/png;base64,iVBORw0KGgo='
		);
	});

	it('keeps <style> with its text, <title> and <desc>', () => {
		const root = sanitized(
			`<title>Harbor</title><desc>A boat</desc><style>.water { fill: #1d4ed8; }</style><g/>`
		);
		expect(root.querySelector('title')?.textContent).toBe('Harbor');
		expect(root.querySelector('desc')?.textContent).toBe('A boat');
		expect(root.querySelector('style')?.textContent).toBe('.water { fill: #1d4ed8; }');
	});

	it('keeps <metadata> and the RDF in it', () => {
		const root = sanitized(
			`<metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cc="http://creativecommons.org/ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format><dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/></cc:Work></rdf:RDF></metadata>`
		);
		const work = root.getElementsByTagNameNS('http://creativecommons.org/ns#', 'Work')[0];
		expect(work?.getAttributeNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'about')).toBe(
			''
		);
		expect(
			root.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'format')[0]
				?.textContent
		).toBe('image/svg+xml');
	});

	it('keeps Inkscape’s elements and attributes, which are inert', () => {
		const root = sanitized(
			`<sodipodi:namedview id="nv" pagecolor="#ffffff" inkscape:zoom="0.7"><inkscape:page x="0" y="0" width="10" height="10"/></sodipodi:namedview><g inkscape:label="Sky" inkscape:groupmode="layer" id="layer1"><path d="M0 0" sodipodi:nodetypes="cc"/></g>`
		);
		const view = root.getElementsByTagNameNS(SODIPODI, 'namedview')[0];
		expect(view?.getAttribute('pagecolor')).toBe('#ffffff');
		expect(view?.getAttributeNS(INKSCAPE, 'zoom')).toBe('0.7');
		expect(root.getElementsByTagNameNS(INKSCAPE, 'page')).toHaveLength(1);
		const layer = root.querySelector('g');
		expect(layer?.getAttributeNS(INKSCAPE, 'label')).toBe('Sky');
		expect(layer?.getAttributeNS(INKSCAPE, 'groupmode')).toBe('layer');
		expect(root.querySelector('path')?.getAttributeNS(SODIPODI, 'nodetypes')).toBe('cc');
	});

	it('keeps a foreign element where it was among its siblings', () => {
		const root = sanitized(`<g id="a"/><sodipodi:namedview id="nv"/><g id="b"/>`);
		expect([...root.children].map((child) => child.getAttribute('id'))).toEqual([
			'a',
			'nv',
			'b',
		]);
	});

	it('keeps definitions: gradients, filters, masks, clips, patterns, symbols and markers', () => {
		const root = sanitized(
			`<defs><linearGradient id="lg" x1="0" x2="1" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="red"/></linearGradient>` +
				`<radialGradient id="rg"><stop offset="1"/></radialGradient>` +
				`<filter id="f"><feGaussianBlur stdDeviation="2"/><feColorMatrix type="saturate" values="0"/><feOffset dx="1"/><feBlend mode="multiply" in2="SourceGraphic"/></filter>` +
				`<mask id="m" maskUnits="userSpaceOnUse"><rect width="1" height="1" fill="#fff"/></mask>` +
				`<clipPath id="c" clipPathUnits="userSpaceOnUse"><circle r="1"/></clipPath>` +
				`<pattern id="p" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1"/></pattern>` +
				`<symbol id="s" viewBox="0 0 1 1"><path d="M0 0"/></symbol>` +
				`<marker id="mk" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0 0"/></marker></defs>`
		);
		const names = [...root.querySelectorAll('defs *')].map((element) => element.localName);
		expect(names).toEqual([
			'linearGradient',
			'stop',
			'radialGradient',
			'stop',
			'filter',
			'feGaussianBlur',
			'feColorMatrix',
			'feOffset',
			'feBlend',
			'mask',
			'rect',
			'clipPath',
			'circle',
			'pattern',
			'rect',
			'symbol',
			'path',
			'marker',
			'path',
		]);
		expect(root.querySelector('linearGradient')?.getAttribute('gradientUnits')).toBe(
			'userSpaceOnUse'
		);
		expect(root.querySelector('marker')?.getAttribute('markerWidth')).toBe('4');
	});

	it('keeps what SVG says about a layer: style, display, opacity, transform, id, class, mask, clip, filter', () => {
		const root = sanitized(
			`<g id="layer-1" class="layer" style="mix-blend-mode: multiply" display="none" opacity="0.5" transform="translate(10,20) rotate(5)" mask="url(#m)" clip-path="url(#c)" filter="url(#f)"/>`
		);
		const layer = root.querySelector('g');
		expect(layer?.getAttribute('id')).toBe('layer-1');
		expect(layer?.getAttribute('class')).toBe('layer');
		expect(layer?.getAttribute('style')).toBe('mix-blend-mode: multiply');
		expect(layer?.getAttribute('display')).toBe('none');
		expect(layer?.getAttribute('opacity')).toBe('0.5');
		expect(layer?.getAttribute('transform')).toBe('translate(10,20) rotate(5)');
		expect(layer?.getAttribute('mask')).toBe('url(#m)');
		expect(layer?.getAttribute('clip-path')).toBe('url(#c)');
		expect(layer?.getAttribute('filter')).toBe('url(#f)');
	});

	it('keeps text and tspan, with xml:space', () => {
		const root = sanitized(
			`<text xml:space="preserve" x="1" y="2">Hello <tspan font-weight="bold">harbor</tspan></text>`
		);
		expect(root.querySelector('text')?.textContent).toBe('Hello harbor');
		expect(root.querySelector('text')?.getAttribute('xml:space')).toBe('preserve');
		expect(root.querySelector('tspan')?.getAttribute('font-weight')).toBe('bold');
	});

	it('keeps viewBox and preserveAspectRatio, in their case', () => {
		const root = sanitized(
			`<image href="a.png" width="1" height="1" preserveAspectRatio="none"/>`,
			`viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid meet"`
		);
		expect(root.getAttribute('viewBox')).toBe('0 0 1600 1000');
		expect(root.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
		expect(root.querySelector('image')?.getAttribute('preserveAspectRatio')).toBe('none');
	});
});

describe('whole files', () => {
	it('keeps an Inkscape drawing whole', () => {
		const text = fixture('inkscape.svg');
		expect(sanitizedText(text)).toBe(serialize(parsed(text).documentElement));
	});

	it('takes exactly the hostile parts out of a hostile drawing', () => {
		expect(withoutSpacing(sanitizedText(fixture('hostile.svg')))).toBe(
			withoutSpacing(fixture('hostile.expected.svg'))
		);
	});

	it.each(['inkscape.svg', 'hostile.svg'])(
		'is idempotent on %s, as the editor writes it',
		(name) => {
			const once = sanitizedDrawing(fixture(name));
			expect(sanitizedDrawing(once)).toBe(once);
		}
	);
});
