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
import { HIDDEN_TEXT_MARK, hideText } from '../../src/drawing/tools/vector/textHide.js';
import { shadowOf } from '../../src/drawing/viewport/shadow.js';
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
			const layer = root.querySelector(`[id="${id}"]`);
			if (layer !== null) mutate(layer as unknown as SVGGraphicsElement);
		},
		revert: () => undefined,
	}),
	wrapLooseLayer: (root: SVGSVGElement, id: string) => ({
		id: 'layer-9',
		label: 'layers.wrap',
		bytes: 0,
		apply: () => {
			const loose = root.querySelector(`[id="${id}"]`);
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
		// From the root, not the page: a root in a shadow root is not the page's to find by id.
		layer: (id) =>
			(root.querySelector(`[id="${id}"]`) as unknown as SVGGraphicsElement | null) ??
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
		region: { path: undefined, region: undefined, set: noop, update: noop },
		host,
		selection: { elements: [], set: noop, clear: noop },
		setColor: noop,
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
	it('opens a focused, labeled field where the click was, in the size and color the text will have', () => {
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

	it('opens the field as the pointer lifts, and none for a press a second finger canceled', () => {
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

	it('fills with the stroke color, else black, where the fill is none', () => {
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

/** Where the tool's options are set, as the options strip marks it: a slider, a button and a hex field. */
const createOptions = () => {
	const region = document.createElement('div');
	region.setAttribute('data-tool-options', '');
	const slider = document.createElement('input');
	slider.setAttribute('type', 'range');
	const button = document.createElement('button');
	button.setAttribute('type', 'button');
	const hex = document.createElement('input');
	hex.setAttribute('type', 'text');
	region.append(slider, button, hex);
	document.body.append(region);
	hosts.push(region);
	return { region, slider, button, hex };
};

/** Something on the page that is not the canvas and not the options. */
const createElsewhere = (): HTMLButtonElement => {
	const button = document.createElement('button');
	button.setAttribute('type', 'button');
	document.body.append(button);
	hosts.push(button);
	return button;
};

/** The context the viewport hands the tool once the options changed. */
const withOptions = (context: ToolContext, options: Partial<ToolOptions>): ToolContext => ({
	...context,
	options: { ...context.options, ...options },
});

const behaviorOf = (tool: ReturnType<typeof createText>) => {
	const { optionsChanged, edit } = tool;
	if (optionsChanged === undefined || edit === undefined)
		throw new Error('the text tool has both');
	return { optionsChanged, edit };
};

describe('the text tool’s field and the tool’s options', () => {
	it('stays open with its selection while the focus is in the options, and finishes when it goes anywhere else', () => {
		const { root, layer } = createDrawing();
		const { context, host, labels } = createFake(root);
		const { slider, hex } = createOptions();
		click(createText(), context, 10, 20);
		const field = openField(host);
		type(field, 'Hello world');
		field.setSelectionRange(6, 11, 'backward');
		slider.focus();
		expect(fieldIn(host)).toBe(field);
		expect(labels).toEqual([]);
		// Tab on to another control of the options: still open.
		hex.focus();
		expect(fieldIn(host)).toBe(field);
		expect([field.selectionStart, field.selectionEnd]).toEqual([6, 11]);
		createElsewhere().focus();
		expect(fieldIn(host)).toBeNull();
		expect(textsIn(layer).map((text) => text.textContent)).toEqual(['Hello world']);
	});

	it('gives the focus back, selection and all, when a slider is let go or a button pressed', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root);
		const { slider, button } = createOptions();
		click(createText(), context, 10, 20);
		const field = openField(host);
		type(field, 'Hello world');
		field.setSelectionRange(0, 5, 'forward');
		fireEvent.pointerDown(slider);
		slider.focus();
		fireEvent.change(slider);
		expect(document.activeElement).toBe(field);
		expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([
			0,
			5,
			'forward',
		]);
		fireEvent.pointerDown(button);
		button.focus();
		fireEvent.click(button);
		expect(document.activeElement).toBe(field);
		expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
	});

	it('keeps the focus in a control worked by keys until Enter, which gives it back', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root);
		const { slider, hex } = createOptions();
		click(createText(), context, 10, 20);
		const field = openField(host);
		type(field, 'stepped');
		field.setSelectionRange(2, 4);
		slider.focus();
		fireEvent.keyDown(slider, { key: 'ArrowRight' });
		fireEvent.change(slider);
		expect(document.activeElement).toBe(slider);
		hex.focus();
		fireEvent.keyDown(hex, { key: '3' });
		fireEvent.change(hex);
		expect(document.activeElement).toBe(hex);
		fireEvent.keyDown(hex, { key: 'Enter' });
		expect(document.activeElement).toBe(hex);
		fireEvent.keyUp(hex, { key: 'Enter' });
		expect(document.activeElement).toBe(field);
		expect([field.selectionStart, field.selectionEnd]).toEqual([2, 4]);
		expect(fieldIn(host)).toBe(field);
	});

	it('stays open for a press in the options that takes no focus, as in Safari', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root);
		const { button } = createOptions();
		click(createText(), context, 10, 20);
		const field = openField(host);
		fireEvent.pointerDown(button);
		field.blur();
		expect(fieldIn(host)).toBe(field);
		fireEvent.click(button);
		expect(document.activeElement).toBe(field);
	});

	it('finishes on a press elsewhere while the focus is in the options, and leaves a press on the canvas to the tool', () => {
		const { root, layer } = createDrawing();
		const elsewhere = createFake(root);
		const { slider } = createOptions();
		const tool = createText();
		click(tool, elsewhere.context, 10, 20);
		type(openField(elsewhere.host), 'first');
		slider.focus();
		fireEvent.pointerDown(document.body);
		expect(fieldIn(elsewhere.host)).toBeNull();
		expect(elsewhere.labels).toEqual(['tools.text']);

		click(tool, elsewhere.context, 10, 60);
		type(openField(elsewhere.host), 'second');
		slider.focus();
		fireEvent.pointerDown(elsewhere.host);
		expect(fieldIn(elsewhere.host)).not.toBeNull();
		// The press on the canvas only finishes the field, and opens no other.
		click(tool, elsewhere.context, 300, 300);
		expect(fieldIn(elsewhere.host)).toBeNull();
		expect(textsIn(layer).map((text) => text.textContent)).toEqual(['first', 'second']);
	});

	it('shows a size and a color chosen while typing a new text, and writes it in them', () => {
		const { root, layer } = createDrawing();
		const { context, host, labels } = createFake(root, {
			options: { fontSize: 40, fill: '#ff0000' },
			view: { scale: 2, tx: 0, ty: 0, ratio: 1 },
		});
		const tool = createText();
		click(tool, context, 10, 20);
		const field = openField(host);
		type(field, 'Bigger');
		behaviorOf(tool).optionsChanged(withOptions(context, { fontSize: 64, fill: '#00ff00' }));
		expect(fieldIn(host)).toBe(field);
		expect(field.style.fontSize).toBe('128px');
		expect(Number.parseFloat(field.style.top)).toBeCloseTo(40 - 0.95 * 128);
		expect(field.style.color).toBe('rgb(0, 255, 0)');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		const [text] = textsIn(layer);
		expect(text?.getAttribute('font-size')).toBe('64');
		expect(text?.getAttribute('fill')).toBe('#00ff00');
	});

	it('rewrites an edited text’s size in the same command as its words, throughout, keeping everything else', () => {
		const { root, layer } = createDrawing(
			'<text id="t-1" x="40" y="60" fill="#0000ff" class="title" style="font-size:20px;letter-spacing:1px">old<tspan x="40" dy="1.2em" font-size="12" style="fill:red">words</tspan></text>'
		);
		const { context, host, labels } = createFake(root);
		const tool = createText();
		click(tool, context, 45, 55);
		const field = openField(host);
		expect(field.style.fontSize).toBe('20px');
		behaviorOf(tool).optionsChanged(withOptions(context, { fontSize: 30 }));
		expect(field.style.fontSize).toBe('30px');
		// The color was not changed: the field keeps the text's own.
		expect(field.style.color).toBe('rgb(0, 0, 255)');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		const [text] = textsIn(layer);
		expect(text?.getAttribute('font-size')).toBe('30');
		expect(text?.getAttribute('style')).toBe('letter-spacing:1px');
		expect(text?.getAttribute('fill')).toBe('#0000ff');
		expect(text?.getAttribute('class')).toBe('title');
		expect(text?.getAttribute('id')).toBe('t-1');
		const tspan = text?.querySelector('tspan');
		expect(tspan?.hasAttribute('font-size')).toBe(false);
		expect(tspan?.getAttribute('style')).toBe('fill:red');
		// The words were not changed, so their markup is the file's own.
		expect(tspan?.textContent).toBe('words');
		expect(tspan?.getAttribute('dy')).toBe('1.2em');
	});

	it('rewrites an edited text’s fill and its words in one command, taking the fill out of its style', () => {
		const { root, layer } = createDrawing(
			'<text x="40" y="60" font-size="20" style="fill:#0000ff">old</text>'
		);
		const { context, host, labels } = createFake(root);
		const tool = createText();
		click(tool, context, 45, 55);
		const field = openField(host);
		type(field, 'new');
		behaviorOf(tool).optionsChanged(withOptions(context, { fill: '#123456' }));
		expect(field.style.color).toBe('rgb(18, 52, 86)');
		expect(field.style.fontSize).toBe('20px');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		const [text] = textsIn(layer);
		expect(text?.getAttribute('fill')).toBe('#123456');
		expect(text?.hasAttribute('style')).toBe(false);
		expect(text?.getAttribute('font-size')).toBe('20');
		expect(text?.textContent).toBe('new');
	});

	it('writes nothing for an edited text whose size was changed back to its own', () => {
		const { root } = createDrawing('<text x="40" y="60" font-size="20">same</text>');
		const { context, host, labels } = createFake(root);
		const tool = createText();
		click(tool, context, 45, 55);
		const { optionsChanged } = behaviorOf(tool);
		optionsChanged(withOptions(context, { fontSize: 33 }));
		optionsChanged(withOptions(context, { fontSize: 20 }));
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(labels).toEqual([]);
	});

	it('takes up no options with no field open, or for a field on another canvas', () => {
		const { root } = createDrawing();
		const { context, host } = createFake(root, { options: { fontSize: 40 } });
		const tool = createText();
		const { optionsChanged } = behaviorOf(tool);
		optionsChanged(withOptions(context, { fontSize: 10 }));
		click(tool, context, 10, 20);
		const field = openField(host);
		const other = createFake(root, { options: { fontSize: 10 } });
		optionsChanged(other.context);
		expect(field.style.fontSize).toBe('40px');
	});
});

describe('the text tool handed a text to edit', () => {
	afterEach(() => {
		Reflect.deleteProperty(document, 'caretPositionFromPoint');
	});

	it('opens the field on that text, its caret at the end where the browser cannot say where the press fell', () => {
		const { root, layer } = createDrawing(
			'<text x="40" y="60" font-size="20" fill="#0000ff">Hello</text>'
		);
		const { context, host, labels } = createFake(root);
		const tool = createText();
		const [text] = textsIn(layer);
		if (text === undefined) throw new Error('the drawing has a text');
		behaviorOf(tool).edit(context, { element: text, at: { x: 50, y: 55 } });
		const field = openField(host);
		expect(field.value).toBe('Hello');
		expect(document.activeElement).toBe(field);
		expect([field.selectionStart, field.selectionEnd]).toEqual([5, 5]);
		type(field, 'Hello there');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		expect(textsIn(layer).map((each) => each.textContent)).toEqual(['Hello there']);
	});

	it('puts the caret where the press was, as the browser reads the point', () => {
		const { root, layer } = createDrawing('<text x="40" y="60" font-size="20">Hello</text>');
		const { context, host } = createFake(root, {
			view: { scale: 2, tx: 10, ty: 20, ratio: 2 },
		});
		const caretPositionFromPoint = vi.fn((x: number, y: number) => ({
			offsetNode: host.querySelector('textarea'),
			offset: x > 0 && y > 0 ? 2 : 0,
		}));
		Object.defineProperty(document, 'caretPositionFromPoint', {
			configurable: true,
			value: caretPositionFromPoint,
		});
		const [text] = textsIn(layer);
		if (text === undefined) throw new Error('the drawing has a text');
		behaviorOf(createText()).edit(context, { element: text, at: { x: 50, y: 55 } });
		const field = openField(host);
		// 50 × 2 + 10 and 55 × 2 + 20 CSS pixels from the canvas's corner, which jsdom puts at the page's.
		expect(caretPositionFromPoint).toHaveBeenCalledWith(110, 130);
		expect([field.selectionStart, field.selectionEnd]).toEqual([2, 2]);
	});

	it('opens nothing for an element that is not a text of the active layer', () => {
		const { root, layer } = createDrawing('<rect x="0" y="0" width="10" height="10"/>');
		const { context, host } = createFake(root);
		const { edit } = behaviorOf(createText());
		const rect = layer.querySelector('rect');
		if (rect === null) throw new Error('the drawing has a rect');
		edit(context, { element: rect, at: { x: 5, y: 5 } });
		const stray = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'text');
		root.appendChild(stray);
		edit(context, { element: stray, at: { x: 5, y: 5 } });
		expect(fieldIn(host)).toBeNull();
	});
});

describe('the options an edited text shows', () => {
	/** A context whose `setOptions` is a spy, as the viewport's is when the frame holds the options. */
	const withSetOptions = (context: ToolContext) => {
		const setOptions = vi.fn<NonNullable<ToolContext['setOptions']>>();
		return { context: { ...context, setOptions }, setOptions };
	};

	it('puts the text’s own size and plain fill in the options as its field opens, and writes nothing for that', () => {
		const { root } = createDrawing(
			'<text x="40" y="60" font-size="20" fill="#00F">Hello</text>'
		);
		const fake = createFake(root, { options: { fontSize: 48, fill: '#ff0000' } });
		const { context, setOptions } = withSetOptions(fake.context);
		const tool = createText();
		click(tool, context, 45, 55);
		expect(setOptions).toHaveBeenCalledExactlyOnceWith({ fontSize: 20, fill: '#0000ff' });
		const field = openField(fake.host);
		// The viewport tells the tool of the options it set, which are no change of the user's.
		behaviorOf(tool).optionsChanged(withOptions(context, { fontSize: 20, fill: '#0000ff' }));
		expect(field.style.fontSize).toBe('20px');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(fake.labels).toEqual([]);
	});

	it('gives the size in the layer’s units for a text its own transform scales, and writes the user’s back in the text’s own', () => {
		const { root, layer } = createDrawing(
			'<text x="10" y="20" font-size="10" transform="scale(2)">Hi</text>'
		);
		layer.setAttribute('transform', 'scale(3)');
		const fake = createFake(root);
		const { context, setOptions } = withSetOptions(fake.context);
		const tool = createText();
		click(tool, context, 65, 115);
		expect(setOptions).toHaveBeenCalledWith({ fontSize: 20, fill: '#000000' });
		const { optionsChanged } = behaviorOf(tool);
		const own = withOptions(context, { fontSize: 20, fill: '#000000' });
		optionsChanged(own);
		const field = openField(fake.host);
		expect(field.style.fontSize).toBe('60px');
		// The user's own change: a size of 30 in the layer's units is 15 in the text's.
		optionsChanged(withOptions(own, { fontSize: 30 }));
		expect(field.style.fontSize).toBe('90px');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(fake.labels).toEqual(['tools.text']);
		expect(textsIn(layer)[0]?.getAttribute('font-size')).toBe('15');
		expect(textsIn(layer)[0]?.hasAttribute('fill')).toBe(false);
	});

	it('leaves the fill out where it is not a plain color, and sets nothing for a new text', () => {
		const { root, layer } = createDrawing(
			'<text x="40" y="60" font-size="12.345" fill="url(#g)">Shaded</text>'
		);
		const fake = createFake(root);
		const { context, setOptions } = withSetOptions(fake.context);
		const tool = createText();
		click(tool, context, 45, 55);
		expect(setOptions).toHaveBeenCalledExactlyOnceWith({ fontSize: 12.35 });
		fireEvent.keyDown(openField(fake.host), { key: 'Escape' });
		click(tool, context, 300, 300);
		expect(setOptions).toHaveBeenCalledOnce();
		expect(textsIn(layer)[0]?.getAttribute('font-size')).toBe('12.345');
	});

	it('puts them in the options for a text handed to it too', () => {
		const { root, layer } = createDrawing('<text x="40" y="60" font-size="18">Hello</text>');
		const fake = createFake(root);
		const { context, setOptions } = withSetOptions(fake.context);
		const [text] = textsIn(layer);
		if (text === undefined) throw new Error('the drawing has a text');
		behaviorOf(createText()).edit(context, { element: text, at: { x: 45, y: 55 } });
		expect(setOptions).toHaveBeenCalledExactlyOnceWith({ fontSize: 18, fill: '#000000' });
	});
});

describe('the text a field is open on', () => {
	/** The drawing's root mounted as the viewport mounts it: in a shadow root on an element of the host. */
	const mountIn = (host: HTMLElement, root: SVGSVGElement): ShadowRoot => {
		const mount = document.createElement('div');
		host.append(mount);
		const shadow = shadowOf(mount);
		shadow.append(root);
		return shadow;
	};

	const ruleIn = (shadow: ShadowRoot): Element | null =>
		shadow.querySelector(`[${HIDDEN_TEXT_MARK}]`);

	/** What the rule hides: what its selectors match in the shadow root. */
	const hiddenBy = (shadow: ShadowRoot): Element[] => {
		const rule = ruleIn(shadow)?.textContent ?? '';
		return rule === '' ? [] : [...shadow.querySelectorAll(rule.slice(0, rule.indexOf(' {')))];
	};

	/** The fake's document telling its listeners of each change, as the editor's does. */
	const withChanges = (context: ToolContext) => {
		const listeners = new Set<() => void>();
		const tell = (): void => {
			[...listeners].forEach((listener) => {
				listener();
			});
		};
		const changing: EditorDocument = {
			...context.document,
			execute: (command) => {
				context.document.execute(command);
				tell();
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
		/** A change the field did not make, as an undo or a redo would be. */
		const change = (mutate: () => void): void => {
			mutate();
			tell();
		};
		return { context: { ...context, document: changing }, listeners, change };
	};

	const TWO_TEXTS =
		'<rect x="0" y="0" width="10" height="10"/>' +
		'<text id="t-1" x="40" y="60" font-size="20">old<tspan x="40" dy="1.2em">words</tspan></text>' +
		'<text id="t-2" x="300" y="300" font-size="20">other</text>';

	const setUp = (markup = TWO_TEXTS) => {
		const drawing = createDrawing(markup);
		const fake = createFake(drawing.root);
		const shadow = mountIn(fake.host, drawing.root);
		const [first, second] = textsIn(drawing.layer);
		if (first === undefined || second === undefined)
			throw new Error('the drawing has two texts');
		return { ...drawing, ...fake, shadow, first, second, tool: createText() };
	};

	it('is hidden under the field by a rule beside the drawing, it and its lines and nothing else', () => {
		const { root, context, host, shadow, first, second, tool, labels } = setUp();
		const before = context.document.text();
		click(tool, context, 50, 60);
		expect(openField(host).value).toBe('old\nwords');
		const style = ruleIn(shadow);
		expect(style?.nextSibling).toBe(root);
		expect(style?.textContent).toContain('visibility: hidden !important');
		expect(hiddenBy(shadow)).toEqual([first, first.firstElementChild]);
		expect(getComputedStyle(first).visibility).toBe('hidden');
		expect(getComputedStyle(second).visibility).toBe('visible');
		// Nothing in the drawing says so: its text is what it was, as a save now would read it.
		expect(root.querySelector(`[${HIDDEN_TEXT_MARK}]`)).toBeNull();
		expect(context.document.text()).toBe(before);
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(ruleIn(shadow)).toBeNull();
		expect(getComputedStyle(first).visibility).toBe('visible');
		expect(labels).toEqual([]);
		expect(context.document.text()).toBe(before);
	});

	it('hides nothing for a new text', () => {
		const { context, host, shadow, tool } = setUp();
		click(tool, context, 200, 100);
		expect(fieldIn(host)).not.toBeNull();
		expect(ruleIn(shadow)).toBeNull();
	});

	it.each<
		[
			string,
			(
				tool: ReturnType<typeof createText>,
				context: ToolContext,
				field: HTMLTextAreaElement
			) => void,
		]
	>([
		['Escape', (_, __, field) => fireEvent.keyDown(field, { key: 'Escape' })],
		[
			'Ctrl with Enter',
			(_, __, field) => fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true }),
		],
		['the focus going elsewhere', (_, __, field) => field.blur()],
		['a press on the canvas', (tool, context) => click(tool, context, 200, 100)],
		['a cancel, as a switch of tools gives', (tool, context) => tool.cancel(context)],
	])('is shown again when the field closes by %s, and the edit written', (_, close) => {
		const { context, host, shadow, first, tool, labels } = setUp();
		click(tool, context, 50, 60);
		const field = openField(host);
		type(field, 'new');
		expect(hiddenBy(shadow)).toContain(first);
		close(tool, context, field);
		expect(fieldIn(host)).toBeNull();
		expect(ruleIn(shadow)).toBeNull();
		expect(labels).toEqual(['tools.text']);
		expect(context.document.text()).not.toContain('visibility');
	});

	it('is shown again, and the field finished, when the drawing leaves the viewport', async () => {
		const { root, context, host, shadow, tool, labels } = setUp();
		click(tool, context, 50, 60);
		type(openField(host), 'new');
		root.remove();
		await Promise.resolve();
		expect(fieldIn(host)).toBeNull();
		expect(ruleIn(shadow)).toBeNull();
		expect(labels).toEqual(['tools.text']);
		// A new root in the same shadow root has nothing of the last one's hidden.
		const next = createDrawing(TWO_TEXTS);
		shadow.append(next.root);
		await Promise.resolve();
		expect(ruleIn(shadow)).toBeNull();
	});

	it('moves to a text handed to the tool while a field is open', () => {
		const { context, host, shadow, second, tool } = setUp();
		click(tool, context, 50, 60);
		behaviorOf(tool).edit(context, { element: second, at: { x: 310, y: 295 } });
		expect(openField(host).value).toBe('other');
		expect(hiddenBy(shadow)).toEqual([second]);
		expect(shadow.querySelectorAll(`[${HIDDEN_TEXT_MARK}]`)).toHaveLength(1);
	});

	it('follows the text through a change that moves it, and writes it where it now is', () => {
		const fake = setUp();
		const { context, change } = withChanges(fake.context);
		const { root, host, shadow, tool, first, second, labels } = fake;
		click(tool, context, 50, 60);
		expect(hiddenBy(shadow)).toEqual([first, first.firstElementChild]);
		// A child that draws nothing put first moves its place among the children,
		// and the rect taken away its place among the layer's elements.
		change(() => {
			fake.layer.prepend(root.ownerDocument.createElementNS(SVG_NAMESPACE, 'title'));
			fake.layer.querySelector('rect')?.remove();
		});
		expect(ruleIn(shadow)?.textContent).toContain(' > :nth-child(2), ');
		expect(hiddenBy(shadow)).toEqual([first, first.firstElementChild]);
		type(openField(host), 'moved');
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		expect(first.textContent).toBe('moved');
		expect(second.textContent).toBe('other');
	});

	it('follows the text into a copy of its layer an undo puts in its place, even one that moves it', () => {
		const fake = setUp();
		const { context, change } = withChanges(fake.context);
		const { host, shadow, tool, labels } = fake;
		click(tool, context, 50, 60);
		// The layer as it was before a text was taken from in front of this one.
		const copy = fake.layer.cloneNode(true) as Element;
		const before = copy.ownerDocument.createElementNS(SVG_NAMESPACE, 'text');
		before.append('restored');
		copy.insertBefore(before, copy.querySelector('text'));
		change(() => {
			fake.layer.replaceWith(copy);
		});
		const [restored, copied, other] = textsIn(copy);
		expect(restored).toBe(before);
		expect(hiddenBy(shadow)).toEqual([copied, copied?.firstElementChild]);
		type(openField(host), 'kept');
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(labels).toEqual(['tools.text']);
		expect(textsIn(copy).map((text) => text.textContent)).toEqual([
			'restored',
			'kept',
			other?.textContent,
		]);
	});

	it('shows nothing hidden and writes nothing once the text is gone, over another or in its place', () => {
		const fake = setUp();
		const { context, change } = withChanges(fake.context);
		const { host, shadow, tool, first, second, labels } = fake;
		click(tool, context, 50, 60);
		type(openField(host), 'lost');
		change(() => {
			first.remove();
		});
		expect(ruleIn(shadow)).toBeNull();
		expect(fieldIn(host)).not.toBeNull();
		fireEvent.keyDown(openField(host), { key: 'Escape' });
		expect(fieldIn(host)).toBeNull();
		expect(labels).toEqual([]);
		expect(textsIn(fake.layer)).toEqual([second]);
		expect(second.textContent).toBe('other');
	});

	it('stops listening to the document once the field closes', () => {
		const fake = setUp();
		const { context, listeners } = withChanges(fake.context);
		click(fake.tool, context, 50, 60);
		expect(listeners.size).toBe(1);
		fireEvent.keyDown(openField(fake.host), { key: 'Escape' });
		expect(listeners.size).toBe(0);
	});

	it('hides a text of a layer nested in a group, by its own layer’s id', () => {
		const { root, layer } = createDrawing(
			'<rect x="0" y="0" width="10" height="10"/><text x="40" y="60" font-size="20">nested</text>'
		);
		const group = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
		group.setAttribute('id', 'group-1');
		layer.replaceWith(group);
		group.append(root.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect'), layer);
		const info = layerInfo('layer-1', { parentId: 'group-1', depth: 1 });
		const { context, host } = createFake(root, {
			layers: [layerInfo('group-1', { kind: 'group' }), info],
			active: info,
		});
		const shadow = mountIn(host, root);
		click(createText(), context, 50, 55);
		expect(openField(host).value).toBe('nested');
		expect(ruleIn(shadow)?.textContent).toMatch(/^\[id="layer-1"\] > :nth-child\(2\), /);
		expect(hiddenBy(shadow)).toEqual(textsIn(layer));
	});

	it('names an element deeper in its layer child by child, and a layer’s id however it is spelled', () => {
		const { root, layer } = createDrawing(
			'<rect/><g><rect/><text>deep</text></g><text>shallow</text>'
		);
		layer.setAttribute('id', 'a "quoted" \\ id');
		const shadow = mountIn(createHost(), root);
		const deep = layer.querySelector('g > text');
		if (deep === null) throw new Error('the drawing has a text in a group');
		const hidden = hideText(root, noop);
		hidden.hide({ layer, element: deep });
		expect(ruleIn(shadow)?.textContent).toContain(' > :nth-child(2) > :nth-child(2), ');
		expect(hiddenBy(shadow)).toEqual([deep]);
		// A loose layer is its own element: the rule is its id alone.
		hidden.hide({ layer, element: layer });
		expect(hiddenBy(shadow)).toEqual([layer, ...layer.querySelectorAll('*')]);
		expect(shadow.querySelectorAll(`[${HIDDEN_TEXT_MARK}]`)).toHaveLength(1);
		hidden.hide(undefined);
		expect(ruleIn(shadow)).toBeNull();
		hidden.hide({ layer, element: deep });
		hidden.remove();
		expect(ruleIn(shadow)).toBeNull();
		// Nothing once removed, whatever it is told.
		hidden.hide({ layer, element: deep });
		expect(ruleIn(shadow)).toBeNull();
	});

	it('hides nothing where the root is not in a shadow root', () => {
		const { root, layer } = createDrawing('<text x="40" y="60" font-size="20">Hello</text>');
		const [text] = textsIn(layer);
		if (text === undefined) throw new Error('the drawing has a text');
		hideText(root, noop).hide({ layer, element: text });
		expect(document.querySelector(`[${HIDDEN_TEXT_MARK}]`)).toBeNull();
		const { context, host } = createFake(root);
		click(createText(), context, 50, 55);
		expect(openField(host).value).toBe('Hello');
		expect(document.querySelector(`[${HIDDEN_TEXT_MARK}]`)).toBeNull();
	});
});
