import { DEFAULT_DRAWING_SIZE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import type { Command, EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehavior,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import { createNode } from '../../src/drawing/tools/vector/node.js';
import { t } from '../../src/i18n/t.js';

/**
 * The node tool (docs/decisions/0004-the-interface.md) against a fake editor,
 * as the other vector tools are tested (`vector.test.ts`): a real SVG
 * document, a document whose `execute` applies a command at once and
 * remembers its label, and the commands mocked to the contract the tools rely
 * on. jsdom has no `getBBox()`; the node tool finds paths by their own
 * geometry and needs none.
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

const noop = (): undefined => undefined;

const svg = (owner: Document, name: string, attributes: Record<string, string>): Element => {
	const element = owner.createElementNS(SVG_NAMESPACE, name);
	Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
	return element;
};

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

/** A new drawing, whose one vector layer, `layer-1`, is given `children`. */
const createDrawing = (children: Record<string, string>[] = []) => {
	const parsed = new DOMParser().parseFromString(emptyDrawing({ id: 'd-1' }), 'image/svg+xml');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	const layer = parsed.getElementById('layer-1');
	if (layer === null) throw new Error('an empty drawing starts with layer-1');
	children.forEach(({ tag = 'path', ...attributes }) =>
		layer.appendChild(svg(parsed, tag, attributes))
	);
	return { root, layer, owner: parsed };
};

const createFake = (root: SVGSVGElement, layers: LayerInfo[], active: LayerInfo | undefined) => {
	const labels: string[] = [];
	const notices: string[] = [];
	const onExecute: { current: (() => void) | undefined } = { current: undefined };
	const selected: { current: readonly Element[] } = { current: [] };
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
			onExecute.current?.();
			command.apply(root);
		},
		undo: noop,
		redo: noop,
		subscribe: () => noop,
		pending: noop,
		settle: () => Promise.resolve(),
	};
	const context: ToolContext = {
		document: editor,
		layer: active,
		options: DEFAULT_TOOL_OPTIONS,
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: {
			canvas: document.createElement('canvas'),
			toScreen: (x, y) => [x, y],
			pixelRatio: 1,
		},
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		region: { path: undefined, region: undefined, set: noop, update: noop },
		host: document.createElement('div'),
		selection: {
			get elements() {
				return selected.current;
			},
			set: (elements) => {
				selected.current = elements;
			},
			clear: () => {
				selected.current = [];
			},
		},
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	return { context, labels, notices, onExecute };
};

const at = (x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample => ({
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
	...extra,
});

const click = (
	node: ToolBehavior,
	context: ToolContext,
	x: number,
	y: number,
	extra: Partial<PointerSample> = {}
): void => {
	node.begin(context, at(x, y, extra));
	node.end(context, at(x, y, extra));
};

const drag = (
	node: ToolBehavior,
	context: ToolContext,
	from: readonly [number, number],
	to: readonly [number, number],
	extra: Partial<PointerSample> = {}
): void => {
	node.begin(context, at(from[0], from[1], extra));
	node.move(context, at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, extra));
	node.move(context, at(to[0], to[1], extra));
	node.end(context, at(to[0], to[1], extra));
};

/** A drawing whose layer holds `children`, the node tool, and a fake editor with that layer active. */
const setUp = (children: Record<string, string>[]) => {
	const drawing = createDrawing(children);
	const info = layerInfo('layer-1');
	return { ...drawing, ...createFake(drawing.root, [info], info), node: createNode() };
};

const anchorsShown = (context: ToolContext): number =>
	context.overlay.querySelectorAll('[data-anchor]').length;

const handlesShown = (context: ToolContext): number =>
	context.overlay.querySelectorAll('[data-handle]').length;

describe('the node tool', () => {
	it('shows a path’s anchors when it is clicked', () => {
		const { context, labels, node } = setUp([{ d: 'M 0 0 L 100 0 L 100 100', fill: 'none' }]);
		click(node, context, 50, 2);
		expect(anchorsShown(context)).toBe(3);
		expect(labels).toEqual([]);
	});

	it('moves an anchor by one command that rewrites d, with the live element put back before it', () => {
		const { context, labels, layer, node, onExecute } = setUp([
			{ id: 'p1', d: 'M 0 0 L 100 0 L 100 100', fill: 'none' },
		]);
		const path = layer.firstElementChild;
		const seen: (string | null | undefined)[] = [];
		onExecute.current = () => seen.push(path?.getAttribute('d'));
		click(node, context, 50, 2);
		node.begin(context, at(100, 0));
		node.move(context, at(110, 5));
		// The drag shows on the element while it lasts.
		expect(path?.getAttribute('d')).toBe('M 0 0 L 110 5 L 100 100');
		node.end(context, at(120, 10));
		expect(labels).toEqual(['tools.node']);
		expect(seen).toEqual(['M 0 0 L 100 0 L 100 100']);
		expect(layer.firstElementChild).toBe(path);
		expect(path?.getAttribute('d')).toBe('M 0 0 L 120 10 L 100 100');
		expect(path?.getAttribute('id')).toBe('p1');
	});

	it('puts the element back and writes nothing when the drag is canceled', () => {
		const { context, labels, layer, node } = setUp([{ d: 'M 0 0 L 100 0', fill: 'none' }]);
		click(node, context, 50, 1);
		node.begin(context, at(100, 0));
		node.move(context, at(130, 30));
		node.cancel(context);
		node.end(context, at(130, 30));
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 100 0');
		expect(labels).toEqual([]);
	});

	it('makes a path of a rectangle on its first edit, its id and other attributes kept', () => {
		const { context, labels, layer, node, onExecute } = setUp([
			{
				tag: 'rect',
				id: 'r1',
				x: '10',
				y: '10',
				width: '80',
				height: '40',
				fill: '#ff0000',
				class: 'box',
			},
		]);
		layer.firstElementChild?.appendChild(svg(layer.ownerDocument, 'title', {}));
		const seen: (string | undefined)[] = [];
		onExecute.current = () => seen.push(layer.firstElementChild?.localName);
		// Inside its fill.
		click(node, context, 50, 30);
		expect(anchorsShown(context)).toBe(4);
		node.begin(context, at(90, 10));
		node.move(context, at(95, 5));
		// A path stands in for the rectangle while the drag lasts.
		expect(layer.firstElementChild?.localName).toBe('path');
		node.end(context, at(100, 0));
		expect(labels).toEqual(['tools.node']);
		expect(seen).toEqual(['rect']);
		expect(layer.children.length).toBe(1);
		const path = layer.firstElementChild;
		expect(path?.localName).toBe('path');
		expect(path?.getAttribute('d')).toBe('M 10 10 L 100 0 L 90 50 L 10 50 Z');
		expect([...(path?.attributes ?? [])].map((attribute) => attribute.name)).toEqual([
			'id',
			'd',
			'fill',
			'class',
		]);
		expect(path?.getAttribute('id')).toBe('r1');
		expect(path?.firstElementChild?.localName).toBe('title');
	});

	it('leaves a shape a shape when it is only clicked', () => {
		const { context, labels, layer, node } = setUp([
			{ tag: 'circle', cx: '50', cy: '50', r: '20', fill: '#000' },
		]);
		click(node, context, 50, 50);
		click(node, context, 70, 50);
		expect(labels).toEqual([]);
		expect(layer.firstElementChild?.localName).toBe('circle');
	});

	it('puts a point into a segment that is clicked, and chooses it', () => {
		const { context, labels, layer, node } = setUp([{ d: 'M 0 0 L 100 0', fill: 'none' }]);
		click(node, context, 50, 1);
		click(node, context, 30, 2);
		expect(labels).toEqual(['tools.node']);
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 30 0 L 100 0');
		expect(anchorsShown(context)).toBe(3);
		expect(
			context.overlay.querySelectorAll('[data-anchor][style*="fill: var(--accent"]').length
		).toBe(1);
	});

	it('puts a smooth point into a curve, which keeps its shape, and drags it at once', () => {
		const { context, labels, layer, node } = setUp([
			{ d: 'M 0 0 C 0 -20 40 -20 40 0', fill: 'none' },
		]);
		click(node, context, 0, 0);
		click(node, context, 20, -15);
		expect(layer.firstElementChild?.getAttribute('d')).toBe(
			'M 0 0 C 0 -10 10 -15 20 -15 C 30 -15 40 -10 40 0'
		);
		drag(node, context, [20, -15], [20, -25]);
		expect(labels).toEqual(['tools.node', 'tools.node']);
		expect(layer.firstElementChild?.getAttribute('d')).toBe(
			'M 0 0 C 0 -10 10 -25 20 -25 C 30 -25 40 -10 40 0'
		);
	});

	it('takes a point out on an Alt-click, and the path with its last segment', () => {
		const { context, labels, layer, node } = setUp([
			{ d: 'M 0 0 L 50 0 L 100 0', fill: 'none' },
		]);
		click(node, context, 25, 1);
		click(node, context, 50, 0, { altKey: true });
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 100 0');
		click(node, context, 100, 0, { altKey: true });
		expect(labels).toEqual(['tools.node', 'tools.node']);
		expect(layer.children.length).toBe(0);
		expect(anchorsShown(context)).toBe(0);
	});

	it('pulls handles out of a corner with an Alt-drag', () => {
		const { context, layer, node } = setUp([{ d: 'M 0 0 L 50 0 L 100 0', fill: 'none' }]);
		click(node, context, 25, 1);
		drag(node, context, [50, 0], [60, 10], { altKey: true });
		expect(layer.firstElementChild?.getAttribute('d')).toBe(
			'M 0 0 C 0 0 40 -10 50 0 C 60 10 100 0 100 0'
		);
	});

	it('turns the opposite handle of a smooth point, and leaves it where Alt breaks the mirror', () => {
		const wave = 'M 0 0 C 0 -20 40 -20 40 0 C 40 20 80 20 80 0';
		const smooth = setUp([{ d: wave, fill: 'none' }]);
		click(smooth.node, smooth.context, 60, 15);
		// The anchor chosen, its handles and its neighbors' show.
		click(smooth.node, smooth.context, 40, 0);
		expect(handlesShown(smooth.context)).toBe(4);
		drag(smooth.node, smooth.context, [40, 20], [60, 20]);
		expect(smooth.layer.firstElementChild?.getAttribute('d')).toBe(
			'M 0 0 C 0 -20 20 -20 40 0 C 60 20 80 20 80 0'
		);

		const broken = setUp([{ d: wave, fill: 'none' }]);
		click(broken.node, broken.context, 60, 15);
		click(broken.node, broken.context, 40, 0);
		drag(broken.node, broken.context, [40, 20], [60, 20], { altKey: true });
		expect(broken.layer.firstElementChild?.getAttribute('d')).toBe(
			'M 0 0 C 0 -20 40 -20 40 0 C 60 20 80 20 80 0'
		);
	});

	it('chooses several anchors with Shift and drags them together', () => {
		const { context, labels, layer, node } = setUp([
			{ d: 'M 0 0 L 50 0 L 100 0', fill: 'none' },
		]);
		click(node, context, 25, 1);
		click(node, context, 0, 0);
		click(node, context, 100, 0, { shiftKey: true });
		drag(node, context, [100, 0], [100, 10]);
		expect(labels).toEqual(['tools.node']);
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 10 L 50 0 L 100 10');
	});

	it('lets go on a click on nothing, and says what to do when nothing was chosen', () => {
		const { context, notices, node } = setUp([{ d: 'M 0 0 L 100 0', fill: 'none' }]);
		click(node, context, 300, 300);
		expect(notices).toEqual([t('paths.chooseAPath')]);
		click(node, context, 50, 1);
		expect(anchorsShown(context)).toBe(2);
		click(node, context, 300, 300);
		expect(anchorsShown(context)).toBe(0);
		expect(notices).toEqual([t('paths.chooseAPath')]);
	});

	it('picks the topmost path whose outline is under the pointer, over a fill beneath it', () => {
		const { context, layer, node } = setUp([
			{ id: 'line', d: 'M 0 50 L 100 50', fill: 'none', stroke: '#000' },
			{ id: 'cover', d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z', fill: 'none' },
		]);
		click(node, context, 50, 51);
		drag(node, context, [0, 50], [0, 60]);
		expect(layer.querySelector('#line')?.getAttribute('d')).toBe('M 0 60 L 100 50');
	});

	it('edits a path where it is drawn, in a moved layer and a group, writing its own units', () => {
		const { context, layer, owner, node } = setUp([]);
		layer.setAttribute('transform', 'translate(100 0)');
		const group = svg(owner, 'g', { transform: 'translate(0 10)' });
		const path = svg(owner, 'path', { d: 'M 0 0 L 10 0', transform: 'scale(2)', fill: 'none' });
		group.appendChild(path);
		layer.appendChild(group);
		click(node, context, 110, 11);
		drag(node, context, [120, 10], [130, 20]);
		expect(path.getAttribute('d')).toBe('M 0 0 L 15 5');
		expect(path.getAttribute('transform')).toBe('scale(2)');
	});

	it('wraps a loose element in a layer before editing it', () => {
		const { root, owner } = createDrawing();
		const loose = svg(owner, 'line', { id: 'l1', x1: '0', y1: '0', x2: '100', y2: '0' });
		root.appendChild(loose);
		const info = layerInfo('l1', { loose: true });
		const { context, labels } = createFake(root, [layerInfo('layer-1'), info], info);
		const node = createNode();
		click(node, context, 50, 1);
		drag(node, context, [100, 0], [100, 20]);
		expect(labels).toEqual(['layers.wrap', 'tools.node']);
		const wrapped = owner.getElementById('layer-9');
		expect(wrapped?.firstElementChild?.localName).toBe('path');
		expect(wrapped?.firstElementChild?.getAttribute('id')).toBe('l1');
		expect(wrapped?.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 100 20');
	});

	it('says so on a locked layer and changes nothing', () => {
		const { root, layer } = createDrawing([{ d: 'M 0 0 L 100 0', fill: 'none' }]);
		const locked = layerInfo('layer-1', { locked: true });
		const { context, labels, notices } = createFake(root, [locked], locked);
		const node = createNode();
		click(node, context, 50, 1);
		expect(notices).toEqual([t('layers.locked', { name: 'Layer 1' })]);
		expect(labels).toEqual([]);
		expect(anchorsShown(context)).toBe(0);
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 100 0');
	});

	it('shows the marks again after the overlay was emptied, and follows an undo that replaced the layer', () => {
		const { context, layer, node } = setUp([{ d: 'M 0 0 L 100 0', fill: 'none' }]);
		click(node, context, 50, 1);
		context.overlay.replaceChildren();
		node.hover?.(context, at(0, 0));
		expect(anchorsShown(context)).toBe(2);
		const copy = layer.cloneNode(true) as Element;
		(copy.firstElementChild as Element).setAttribute('d', 'M 0 0 L 50 0 L 100 0');
		layer.replaceWith(copy);
		node.hover?.(context, at(0, 0));
		expect(anchorsShown(context)).toBe(3);
	});
});

describe('the node tool handed an element to edit', () => {
	const editOf = (node: ToolBehavior) => {
		const { edit } = node;
		if (edit === undefined) throw new Error('the node tool takes an element handed to it');
		return edit;
	};

	it('shows the anchors of a path or a shape it is handed, chosen as a click would, and changes nothing', () => {
		const { context, labels, layer, node } = setUp([
			{ d: 'M 0 0 L 100 0 L 100 100', fill: 'none' },
			{ tag: 'rect', x: '200', y: '200', width: '40', height: '20' },
		]);
		const [path, rect] = [...layer.children];
		if (path === undefined || rect === undefined) throw new Error('the layer has both');
		editOf(node)(context, { element: path, at: { x: 50, y: 0 } });
		expect(anchorsShown(context)).toBe(3);
		editOf(node)(context, { element: rect, at: { x: 210, y: 210 } });
		expect(anchorsShown(context)).toBe(4);
		// And it is the chosen one: a drag of its corner moves it.
		drag(node, context, [200, 200], [190, 190]);
		expect(labels).toEqual(['tools.node']);
		expect(layer.lastElementChild?.localName).toBe('path');
		expect(rect.isConnected).toBe(false);
		expect(path.getAttribute('d')).toBe('M 0 0 L 100 0 L 100 100');
	});

	it('shows nothing for an element of another layer, or one with no points, and says why on a locked layer', () => {
		const { context, notices, owner, root, layer, node } = setUp([
			{ tag: 'text', x: '0', y: '10' },
		]);
		const other = svg(owner, 'g', { id: 'layer-2' });
		const elsewhere = svg(owner, 'path', { d: 'M 0 0 L 10 0' });
		other.appendChild(elsewhere);
		root.appendChild(other);
		const text = layer.firstElementChild;
		if (text === null) throw new Error('the layer has a text');
		editOf(node)(context, { element: text, at: { x: 0, y: 10 } });
		editOf(node)(context, { element: elsewhere, at: { x: 5, y: 0 } });
		expect(anchorsShown(context)).toBe(0);
		const locked = layerInfo('layer-1', { locked: true });
		const fake = createFake(root, [locked], locked);
		editOf(node)(fake.context, { element: text, at: { x: 0, y: 10 } });
		expect(fake.notices).toEqual([t('layers.locked', { name: 'Layer 1' })]);
		expect(notices).toEqual([]);
	});
});
