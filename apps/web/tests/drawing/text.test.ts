import { DEFAULT_DRAWING_SIZE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Command, EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import { editActionFor, isHandKey, isTyping, toolFor } from '../../src/drawing/keys.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import { createText } from '../../src/drawing/tools/vector/text.js';
import { t } from '../../src/i18n/t.js';

/**
 * The text tool (docs/decisions/0004-the-interface.md) against a fake editor,
 * as the other vector tools are tested (`vector.test.ts`): a real SVG
 * document, a document whose `execute` applies a command at once and keeps
 * its label, and the commands module mocked to the contract the tools rely
 * on. The field is a real textarea in a real host in jsdom, which lays nothing
 * out and has no fonts: where the field is placed is checked as the numbers
 * set on it, not as pixels seen.
 */

vi.mock('../../src/drawing/document/commands.js', () => ({
	editLayer: (id: string, label: string, mutate: (layer: SVGGraphicsElement) => void) => ({
		label,
		bytes: 0,
		apply: (root: SVGSVGElement) => {
			const layer = root.ownerDocument.getElementById(id);
			if (layer !== null) mutate(layer as unknown as SVGGraphicsElement);
		},
		revert: () => undefined,
	}),
	wrapLooseLayer: (root: SVGSVGElement, id: string) => ({
		id: 'layer-9',
		label: 'layers.wrap',
		bytes: 0,
		apply: () => {
			const loose = root.ownerDocument.getElementById(id);
			if (loose === null) return;
			const g = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
			g.setAttribute('id', 'layer-9');
			loose.replaceWith(g);
			g.appendChild(loose);
		},
		revert: () => undefined,
	}),
}));

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const noop = (): undefined => undefined;

const layerInfo = (id: string, overrides: Partial<LayerInfo> = {}): LayerInfo => ({
	id,
	kind: 'vector',
	name: undefined,
	hidden: false,
	locked: false,
	opacity: 1,
	blend: 'normal',
	depth: 0,
	parentId: undefined,
	loose: false,
	...overrides,
});

/** A new drawing whose one vector layer, `layer-1`, holds `markup`. */
const createDrawing = (markup = '') => {
	const parsed = new DOMParser().parseFromString(emptyDrawing({ id: 'd-1' }), 'image/svg+xml');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	const layer = parsed.getElementById('layer-1');
	if (layer === null) throw new Error('an empty drawing starts with layer-1');
	if (markup !== '') {
		const fragment = new DOMParser().parseFromString(
			`<g xmlns="${SVG_NAMESPACE}">${markup}</g>`,
			'image/svg+xml'
		).documentElement;
		[...fragment.childNodes].forEach((node) =>
			layer.appendChild(parsed.importNode(node, true))
		);
	}
	return { root, layer };
};

/** Hosts made in a test, taken out of the page after it. */
const hosts: HTMLElement[] = [];

afterEach(() => {
	hosts.splice(0).forEach((host) => host.remove());
});

/** A focusable element in the page, as the viewport's own is. */
const createHost = (): HTMLElement => {
	const host = document.createElement('div');
	host.setAttribute('tabindex', '0');
	document.body.append(host);
	hosts.push(host);
	return host;
};

type View = Readonly<{ scale: number; tx: number; ty: number; ratio: number }>;

type FakeSetup = Readonly<{
	layers?: LayerInfo[];
	active?: LayerInfo | undefined;
	options?: Partial<ToolOptions>;
	view?: View;
	host?: HTMLElement;
}>;

const createFake = (root: SVGSVGElement, setup: FakeSetup = {}) => {
	const layers = setup.layers ?? [layerInfo('layer-1')];
	const active = 'active' in setup ? setup.active : layers[0];
	const view = setup.view ?? { scale: 1, tx: 0, ty: 0, ratio: 1 };
	const labels: string[] = [];
	const notices: string[] = [];
	const editor: EditorDocument = {
		root,
		prolog: '',
		size: DEFAULT_DRAWING_SIZE,
		snapshot: () => ({
			layers,
			size: DEFAULT_DRAWING_SIZE,
			canUndo: false,
			canRedo: false,
			dirty: false,
			version: 0,
		}),
		text: () => new XMLSerializer().serializeToString(root),
		layer: (id) =>
			(root.ownerDocument.getElementById(id) as unknown as SVGGraphicsElement | null) ??
			undefined,
		execute: (command: Command) => {
			labels.push(command.label);
			command.apply(root);
		},
		undo: noop,
		redo: noop,
		subscribe: () => noop,
		pending: noop,
		settle: () => Promise.resolve(),
	};
	const host = setup.host ?? createHost();
	const context: ToolContext = {
		document: editor,
		layer: active,
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: {
			canvas: document.createElement('canvas'),
			toScreen: (x, y) => [
				(x * view.scale + view.tx) * view.ratio,
				(y * view.scale + view.ty) * view.ratio,
			],
			pixelRatio: view.ratio,
		},
		viewport: { scale: view.scale, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		region: { path: undefined, set: noop },
		host,
		selection: { elements: [], set: noop, clear: noop },
		setColour: noop,
		notify: (message) => notices.push(message),
	};
	return { context, labels, notices, host };
};

const at = (x: number, y: number): PointerSample => ({
	x,
	y,
	pressure: 0.5,
	tiltX: 0,
	tiltY: 0,
	pointerType: 'mouse',
	time: 0,
	shiftKey: false,
	altKey: false,
	primaryKey: false,
});

/** A click: the pointer down and up at one point. */
const click = (tool: ReturnType<typeof createText>, context: ToolContext, x: number, y: number) => {
	tool.begin(context, at(x, y));
	tool.end(context, at(x, y));
};

const fieldIn = (host: HTMLElement): HTMLTextAreaElement | null => host.querySelector('textarea');

const openField = (host: HTMLElement): HTMLTextAreaElement => {
	const field = fieldIn(host);
	if (field === null) throw new Error('no field is open');
	return field;
};

/** What a user typing would leave in the field: its value, and the input event. */
const type = (field: HTMLTextAreaElement, value: string): void => {
	field.value = value;
	fireEvent.input(field);
};

const textsIn = (layer: Element): Element[] =>
	[...layer.children].filter((child) => child.localName === 'text');

describe('the text tool on a vector layer', () => {
	it('opens a focused, labelled field where the click was, in the size and colour the text will have', () => {
		const { root } = createDrawing();
		const { context, host, labels } = createFake(root, {
			options: { fontSize: 40, fill: '#ff0000' },
			view: { scale: 2, tx: 30, ty: 20, ratio: 2 },
		});
		click(createText(), context, 100, 50);
		const field = openField(host);
		expect(field.parentElement).toBe(host);
		expect(document.activeElement).toBe(field);
		expect(field.getAttribute('aria-label')).toBe(t('text.field'));
		expect(field.getAttribute('class')).toBe('text-field');
		// 40 units at a scale of 2; the click at 100 × 2 + 30 CSS pixels across,
		// and the first baseline at 50 × 2 + 20 down, 0.95 em below the top.
		expect(field.style.fontSize).toBe('80px');
		expect(field.style.left).toBe('230px');
		expect(Number.parseFloat(field.style.top)).toBeCloseTo(120 - 0.95 * 80);
		expect(field.style.color).toBe('rgb(255, 0, 0)');
		expect(field.style.lineHeight).toBe('1.2');
		expect(field.value).toBe('');
		expect(labels).toEqual([]);
	});

	it('sets a text smaller than a phone will type in at the floor, and scales it down to size', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root, {
			options: { fontSize: 20 },
			view: { scale: 0.4, tx: 0, ty: 0, ratio: 1 },
		});
		click(createText(), context, 10, 10);
		const field = openField(host);
		expect(field.style.fontSize).toBe('16px');
		expect(field.style.transform).toBe('scale(0.5)');
	});

	it('writes what is typed on Escape as one <text>, at the click, in the options, through one command', () => {
		const { root, layer } = createDrawing();
		const { context, host, labels } = createFake(root, {
			options: { fontSize: 32, fill: '#123456' },
		});
		click(createText(), context, 120.456, 80.004);
		const field = openField(host);
		type(field, 'Hello  world');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		const [text, ...others] = textsIn(layer);
		expect(others).toEqual([]);
		expect(text?.getAttribute('x')).toBe('120.46');
		expect(text?.getAttribute('y')).toBe('80');
		expect(text?.getAttribute('font-size')).toBe('32');
		expect(text?.getAttribute('font-family')).toBe('sans-serif');
		expect(text?.getAttribute('fill')).toBe('#123456');
		expect(text?.getAttributeNS(XML_NS, 'space')).toBe('preserve');
		expect(text?.textContent).toBe('Hello  world');
		expect(text?.children).toHaveLength(0);
		expect(fieldIn(host)).toBeNull();
		// The canvas has the focus back, for the keys.
		expect(document.activeElement).toBe(host);
	});

	it('writes each line after the first as a tspan at the same x, a line height down', () => {
		const { root, layer } = createDrawing();
		const { context, host } = createFake(root);
		click(createText(), context, 10, 20);
		type(openField(host), 'one\ntwo\n\nfour\n\n');
		fireEvent.keyDown(openField(host), { key: 'Enter', ctrlKey: true });
		const [text] = textsIn(layer);
		const serialized = new XMLSerializer().serializeToString(text as Element);
		// A blank line is the next line's extra line height; blank lines at the end draw nothing.
		expect(serialized).toContain(
			'>one<tspan x="10" dy="1.2em">two</tspan><tspan x="10" dy="2.4em">four</tspan></text>'
		);
	});

	it('finishes on Ctrl or ⌘ with Enter, and leaves a bare Enter to the field', () => {
		const { root, layer } = createDrawing();
		const { context, host } = createFake(root);
		click(createText(), context, 10, 20);
		const field = openField(host);
		type(field, 'a');
		expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true);
		expect(fieldIn(host)).toBe(field);
		fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
		expect(fieldIn(host)).toBeNull();
		expect(textsIn(layer)).toHaveLength(1);
	});

	it('leaves Escape to an input method that is composing', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root);
		click(createText(), context, 10, 20);
		fireEvent.keyDown(openField(host), { key: 'Escape', isComposing: true });
		expect(fieldIn(host)).not.toBeNull();
	});

	it('writes nothing for a field left empty or blank, and leaves no field', () => {
		const { root, layer } = createDrawing();
		const { context, host, labels } = createFake(root);
		const tool = createText();
		click(tool, context, 10, 20);
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		click(tool, context, 10, 20);
		type(openField(host), '  \n ');
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(labels).toEqual([]);
		expect(textsIn(layer)).toEqual([]);
		expect(fieldIn(host)).toBeNull();
	});

	it('stores < and & as words, never as markup', () => {
		const { root, layer } = createDrawing();
		const { context, host } = createFake(root);
		click(createText(), context, 10, 20);
		type(openField(host), '<b onclick="x()">&amp; 1 < 2</b>');
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		const [text] = textsIn(layer);
		expect(text?.children).toHaveLength(0);
		expect(text?.textContent).toBe('<b onclick="x()">&amp; 1 < 2</b>');
		expect(new XMLSerializer().serializeToString(text as Element)).toContain(
			'&lt;b onclick="x()"&gt;&amp;amp; 1 &lt; 2&lt;/b&gt;'
		);
	});

	it('finishes when the focus goes elsewhere, but not when the window loses it', () => {
		const { root, layer } = createDrawing();
		const { context, host } = createFake(root);
		click(createText(), context, 10, 20);
		const field = openField(host);
		type(field, 'kept');
		// The window blurred: the field stays the active element.
		field.dispatchEvent(new FocusEvent('blur'));
		expect(fieldIn(host)).toBe(field);
		field.blur();
		expect(fieldIn(host)).toBeNull();
		expect(textsIn(layer).map((text) => text.textContent)).toEqual(['kept']);
		// The focus went where the user took it, not back to the canvas.
		expect(document.activeElement).toBe(document.body);
	});

	it('finishes on the next click on the canvas, which opens no other field', () => {
		const { root, layer } = createDrawing();
		const { context, host, labels } = createFake(root);
		const tool = createText();
		click(tool, context, 10, 20);
		type(openField(host), 'first');
		click(tool, context, 300, 300);
		expect(fieldIn(host)).toBeNull();
		expect(labels).toEqual(['tools.text']);
		click(tool, context, 300, 300);
		expect(fieldIn(host)).not.toBeNull();
		expect(textsIn(layer)).toHaveLength(1);
	});

	it('finishes the field on cancel, and writes it once', () => {
		const { root, layer } = createDrawing();
		const { context, host } = createFake(root);
		const tool = createText();
		click(tool, context, 10, 20);
		type(openField(host), 'typed');
		tool.cancel(context);
		expect(fieldIn(host)).toBeNull();
		expect(textsIn(layer).map((text) => text.textContent)).toEqual(['typed']);
		tool.cancel(context);
		expect(textsIn(layer)).toHaveLength(1);
	});

	it('opens the field as the pointer lifts, and none for a press a second finger cancelled', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root);
		const tool = createText();
		tool.begin(context, at(10, 20));
		expect(fieldIn(host)).toBeNull();
		tool.cancel(context);
		tool.end(context, at(10, 20));
		expect(fieldIn(host)).toBeNull();
		tool.begin(context, at(10, 20));
		tool.end(context, at(10, 20));
		expect(fieldIn(host)).not.toBeNull();
	});

	it('writes in the layer’s own units, and sizes the field as the layer scales it', () => {
		const { root, layer } = createDrawing();
		layer.setAttribute('transform', 'translate(100 0) scale(2)');
		const { context, host } = createFake(root, { options: { fontSize: 10 } });
		click(createText(), context, 300, 50);
		const field = openField(host);
		expect(field.style.fontSize).toBe('20px');
		type(field, 'scaled');
		fireEvent.keyDown(field, { key: 'Escape' });
		const [text] = textsIn(layer);
		expect(text?.getAttribute('x')).toBe('100');
		expect(text?.getAttribute('y')).toBe('25');
		expect(text?.getAttribute('font-size')).toBe('10');
	});

	it('fills with the stroke colour, else black, where the fill is none', () => {
		const { root, layer } = createDrawing();
		const { context, host } = createFake(root, {
			options: { fill: 'none', stroke: '#00ff00' },
		});
		click(createText(), context, 10, 20);
		type(openField(host), 'seen');
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(textsIn(layer)[0]?.getAttribute('fill')).toBe('#00ff00');
	});

	it('edits a text of the layer in the same field, keeping its id and its other attributes', () => {
		const { root, layer } = createDrawing(
			'<rect x="0" y="0" width="500" height="500"/>' +
				'<text id="t-1" x="40" y="60" font-size="20" fill="#0000ff" class="title" transform="translate(5 5)">old<tspan x="40" dy="1.2em">words</tspan></text>'
		);
		const { context, host, labels } = createFake(root, {
			view: { scale: 1, tx: 0, ty: 0, ratio: 1 },
		});
		click(createText(), context, 50, 60);
		const field = openField(host);
		expect(field.value).toBe('old\nwords');
		expect(field.style.fontSize).toBe('20px');
		expect(field.style.left).toBe('45px');
		expect(field.style.color).toBe('rgb(0, 0, 255)');
		type(field, 'new\nlines here');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		const [text, ...others] = textsIn(layer);
		expect(others).toEqual([]);
		expect(text?.getAttribute('id')).toBe('t-1');
		expect(text?.getAttribute('class')).toBe('title');
		expect(text?.getAttribute('transform')).toBe('translate(5 5)');
		expect(text?.getAttribute('font-size')).toBe('20');
		expect(text?.getAttribute('fill')).toBe('#0000ff');
		expect(text?.getAttributeNS(XML_NS, 'space')).toBe('preserve');
		expect(new XMLSerializer().serializeToString(text as Element)).toContain(
			'>new<tspan x="40" dy="1.2em">lines here</tspan></text>'
		);
	});

	it('reads the lines Inkscape writes, a tspan placed at its own x and y for each', () => {
		const { root } = createDrawing(
			'<text x="40" y="60" style="font-size:20px">\n  <tspan x="40" y="60">first   line</tspan>\n  <tspan x="40" y="84"><tspan font-weight="bold">bold</tspan> second</tspan>\n</text>'
		);
		const { context, host } = createFake(root);
		click(createText(), context, 45, 55);
		expect(openField(host).value).toBe('first line\nbold second');
	});

	it('writes nothing for an edit that changed nothing', () => {
		const { root } = createDrawing('<text x="40" y="60" font-size="20">same</text>');
		const { context, host, labels } = createFake(root);
		click(createText(), context, 45, 55);
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(labels).toEqual([]);
	});

	it('takes away a text whose words were all deleted', () => {
		const { root, layer } = createDrawing(
			'<text x="40" y="60" font-size="20">gone</text><rect x="0" y="0" width="1" height="1"/>'
		);
		const { context, host, labels } = createFake(root);
		click(createText(), context, 45, 55);
		type(openField(host), '');
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		expect(textsIn(layer)).toEqual([]);
		expect(layer.querySelector('rect')).not.toBeNull();
	});

	it('wraps a loose text in a layer of its own before it edits it', () => {
		const { root, layer } = createDrawing();
		layer.remove();
		const loose = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'text');
		loose.setAttribute('id', 'layer-1');
		loose.setAttribute('x', '10');
		loose.setAttribute('y', '30');
		loose.append(root.ownerDocument.createTextNode('loose'));
		root.appendChild(loose);
		const info = layerInfo('layer-1', { loose: true });
		const { context, host, labels } = createFake(root, { layers: [info], active: info });
		click(createText(), context, 12, 25);
		expect(openField(host).value).toBe('loose');
		type(openField(host), 'wrapped');
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(labels).toEqual(['layers.wrap', 'tools.text']);
		const g = root.ownerDocument.getElementById('layer-9');
		expect(g?.firstElementChild?.textContent).toBe('wrapped');
	});

	it('says why and opens no field on a locked or a hidden layer, or with none', () => {
		const { root } = createDrawing();
		const cases: [LayerInfo | undefined, string][] = [
			[layerInfo('layer-1', { locked: true }), t('layers.locked', { name: 'Layer 1' })],
			[layerInfo('layer-1', { hidden: true }), t('layers.hidden', { name: 'Layer 1' })],
			[undefined, t('layers.noneActive')],
		];
		cases.forEach(([active, message]) => {
			const { context, host, notices } = createFake(root, {
				layers: active === undefined ? [] : [active],
				active,
			});
			click(createText(), context, 10, 20);
			expect(notices).toEqual([message]);
			expect(fieldIn(host)).toBeNull();
		});
	});

	it('keeps a pointer in the field from the canvas, so it begins no stroke', () => {
		const onPointerDown = vi.fn();
		const { container } = render(createElement('div', { onPointerDown, tabIndex: 0 }));
		const host = container.firstElementChild as HTMLElement;
		const { root } = createDrawing();
		const { context } = createFake(root, { host });
		click(createText(), context, 10, 20);
		const field = openField(host);
		fireEvent.pointerDown(field);
		fireEvent.pointerUp(field);
		expect(onPointerDown).not.toHaveBeenCalled();
		// The canvas does hear a pointer on itself.
		fireEvent.pointerDown(host);
		expect(onPointerDown).toHaveBeenCalledOnce();
	});

	it('keeps the focus in the field when the canvas is pressed, and lets a press in the field place the caret', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root);
		click(createText(), context, 10, 20);
		const field = openField(host);
		expect(fireEvent.mouseDown(host)).toBe(false);
		expect(fireEvent.mouseDown(field)).toBe(true);
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(fireEvent.mouseDown(host)).toBe(true);
	});

	it('is typing to the keys the editor maps: no tool letter, no Delete, and Space is a space', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root);
		click(createText(), context, 10, 20);
		const field = openField(host);
		const key = (name: string) => ({
			key: name,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			altKey: false,
			target: field,
		});
		expect(isTyping(field)).toBe(true);
		expect(toolFor(key('t'), false)).toBeUndefined();
		expect(toolFor(key('v'), false)).toBeUndefined();
		expect(editActionFor(key('Delete'), false)).toBeUndefined();
		expect(editActionFor(key('x'), false)).toBeUndefined();
		expect(editActionFor(key(']'), false)).toBeUndefined();
		expect(isHandKey(key(' '))).toBe(false);
	});
});
