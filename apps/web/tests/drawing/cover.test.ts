import { DRAWING_NAMESPACE } from '@skysa/draw-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCover, liftedOver, PICTURE_WAIT_MS } from '../../src/drawing/viewport/cover.js';

const SVG = 'http://www.w3.org/2000/svg';

/** A root with these children, mounted in a shadow root as the viewport mounts it. */
const drawingOf = (children: string) => {
	const text = `<svg xmlns="${SVG}" xmlns:draw="${DRAWING_NAMESPACE}" viewBox="0 0 100 100">${children}</svg>`;
	const root = new DOMParser().parseFromString(text, 'image/svg+xml')
		.documentElement as unknown as SVGSVGElement;
	const mount = document.createElement('div');
	const host = document.createElement('div');
	document.body.append(mount, host);
	const drawing = mount.attachShadow({ mode: 'open' });
	drawing.append(document.importNode(root, true));
	const live = drawing.firstElementChild as SVGSVGElement;
	return { root: live, drawing, host };
};

const byId = (root: Element, id: string): Element => {
	const found = root.querySelector(`[id="${id}"]`);
	if (found === null) throw new Error(`no ${id}`);
	return found;
};

const liftedIds = (children: string, painted: string): readonly string[] => {
	const { root } = drawingOf(children);
	return liftedOver(root, byId(root, painted)).map((each) => each.id);
};

const raster = (id: string, extra = '') =>
	`<g id="${id}" draw:kind="raster"${extra}><image href="data:image/png;base64,AA==" width="10" height="10"/></g>`;
const vector = (id: string, extra = '') =>
	`<g id="${id}" draw:kind="vector"${extra}><rect width="10" height="10"/></g>`;

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
});

describe('what is lifted over a live stroke', () => {
	it('is every layer painted after the one painted on, in paint order', () => {
		expect(
			liftedIds(`<title>t</title>${raster('a')}${vector('b')}<defs/>${raster('c')}`, 'a')
		).toEqual(['b', 'c']);
		expect(liftedIds(`${raster('a')}${vector('b')}`, 'b')).toEqual([]);
	});

	it('stops under a layer blended with what is under it, which the copy would not have', () => {
		const multiply = ' style="mix-blend-mode: multiply"';
		expect(liftedIds(`${raster('a')}${vector('b', multiply)}${vector('c')}`, 'a')).toEqual([
			'c',
		]);
		expect(liftedIds(`${raster('a')}${vector('b')}${vector('c', multiply)}`, 'a')).toEqual([]);
		// A blend inside a layer reads what is under the layer too.
		const inside = `<g id="b" draw:kind="vector"><rect style="mix-blend-mode: screen" width="1" height="1"/></g>`;
		expect(liftedIds(`${raster('a')}${inside}${vector('c')}`, 'a')).toEqual(['c']);
	});

	it('lifts a layer clipped to the one below only with that one', () => {
		const clip = (id: string, below: string) =>
			`<mask id="clip-${id}" style="mask-type:alpha"><use href="#${below}"/></mask>`;
		const defs = `<defs>${clip('b', 'a')}${clip('c', 'b')}</defs>`;
		const masked = (id: string) => ` mask="url(#clip-${id})"`;
		// b is clipped to a, which is not lifted, and c to b.
		expect(
			liftedIds(
				`${defs}${raster('a')}${vector('b', masked('b'))}${vector('c', masked('c'))}${vector('d')}`,
				'a'
			)
		).toEqual(['d']);
		// c is clipped to b, which is lifted with it.
		expect(
			liftedIds(`${defs}${raster('a')}${vector('b')}${vector('c', masked('c'))}`, 'a')
		).toEqual(['b', 'c']);
	});

	it('reaches out of a group that paints its layers plainly, and not into one that does not', () => {
		const group = (extra: string) =>
			`<g id="g" draw:kind="group"${extra}>${raster('a')}${vector('b')}</g>${vector('d')}`;
		expect(liftedIds(group(''), 'a')).toEqual(['b', 'd']);
		expect(liftedIds(group(' opacity="0.5"'), 'a')).toEqual(['d']);
		expect(liftedIds(group(' filter="url(#f)"'), 'a')).toEqual(['d']);
	});

	it('is nothing where the root takes its layers as one picture', () => {
		const { root } = drawingOf(`${raster('a')}${vector('b')}`);
		root.setAttribute('opacity', '0.5');
		expect(liftedOver(root, byId(root, 'a'))).toEqual([]);
	});
});

describe('the cover', () => {
	it('shows the layers over the one painted on, on a copy, and clears them in the drawing beside its root', () => {
		const { root, drawing, host } = drawingOf(`${vector('a')}${vector('b')}${vector('c')}`);
		const before = new XMLSerializer().serializeToString(root);
		const cover = createCover();
		cover.lift('a', { root, drawing, host, canvas: null });
		const copy = host.shadowRoot?.querySelector('svg');
		expect(copy).not.toBeNull();
		expect(copy?.querySelector<SVGElement>('[id="a"]')?.style.getPropertyValue('opacity')).toBe(
			'0'
		);
		expect(
			copy?.querySelector<SVGElement>('[id="a"]')?.style.getPropertyPriority('opacity')
		).toBe('important');
		expect(copy?.querySelector<SVGElement>('[id="b"]')?.style.getPropertyValue('opacity')).toBe(
			''
		);
		expect(copy?.querySelector<SVGElement>('[id="c"]')?.style.getPropertyValue('opacity')).toBe(
			''
		);
		const rule = drawing.querySelector('style');
		expect(rule?.textContent).toBe('[id="b"], [id="c"] { opacity: 0 !important; }');
		expect(host.style.visibility).toBe('');
		// The document is not touched.
		expect(new XMLSerializer().serializeToString(root)).toBe(before);
		cover.lift(undefined);
		expect(host.shadowRoot?.querySelector('svg')).toBeNull();
		expect(drawing.querySelector('style')).toBeNull();
		expect(new XMLSerializer().serializeToString(root)).toBe(before);
	});

	it('keeps what it lifted for the same layer, and lifts anew for another', () => {
		const { root, drawing, host } = drawingOf(`${vector('a')}${vector('b')}${vector('c')}`);
		const cover = createCover();
		cover.lift('a', { root, drawing, host, canvas: null });
		const copy = host.shadowRoot?.querySelector('svg');
		cover.lift('a', { root, drawing, host, canvas: null });
		expect(host.shadowRoot?.querySelector('svg')).toBe(copy);
		cover.lift('b', { root, drawing, host, canvas: null });
		expect(host.shadowRoot?.querySelectorAll('svg')).toHaveLength(1);
		expect(drawing.querySelectorAll('style')).toHaveLength(1);
		expect(drawing.querySelector('style')?.textContent).toBe(
			'[id="c"] { opacity: 0 !important; }'
		);
	});

	it('lifts nothing where nothing is over the layer, or there is no such layer', () => {
		const { root, drawing, host } = drawingOf(`${vector('a')}${vector('b')}`);
		const cover = createCover();
		cover.lift('b', { root, drawing, host, canvas: null });
		cover.lift('missing', { root, drawing, host, canvas: null });
		expect(host.shadowRoot?.querySelector('svg') ?? null).toBeNull();
		expect(drawing.querySelector('style')).toBeNull();
	});

	it('waits for the pictures it lifts before it shows them in place of the drawing’s', () => {
		const { root, drawing, host } = drawingOf(`${vector('a')}${raster('b')}${raster('c')}`);
		const canvas = document.createElement('canvas');
		const cover = createCover();
		cover.lift('a', { root, drawing, host, canvas });
		// The live canvas waits with the copy, so its paint is never over them meanwhile.
		expect(host.style.visibility).toBe('hidden');
		expect(canvas.style.visibility).toBe('hidden');
		expect(drawing.querySelector('style')).toBeNull();
		const pictures = [...(host.shadowRoot?.querySelectorAll('image') ?? [])];
		expect(pictures).toHaveLength(2);
		pictures[0]?.dispatchEvent(new Event('load'));
		expect(drawing.querySelector('style')).toBeNull();
		pictures[1]?.dispatchEvent(new Event('error'));
		expect(host.style.visibility).toBe('');
		expect(canvas.style.visibility).toBe('');
		expect(drawing.querySelector('style')).not.toBeNull();
	});

	it('shows them anyway after a while, and not at all once put back', () => {
		vi.useFakeTimers();
		const { root, drawing, host } = drawingOf(`${vector('a')}${raster('b')}`);
		const cover = createCover();
		cover.lift('a', { root, drawing, host, canvas: null });
		vi.advanceTimersByTime(PICTURE_WAIT_MS);
		expect(host.style.visibility).toBe('');
		expect(drawing.querySelector('style')).not.toBeNull();
		cover.lift(undefined);
		cover.lift('a', { root, drawing, host, canvas: null });
		cover.lift(undefined);
		vi.advanceTimersByTime(PICTURE_WAIT_MS);
		expect(drawing.querySelector('style')).toBeNull();
		expect(host.style.visibility).toBe('');
	});
});
