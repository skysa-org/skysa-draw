import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';

import { attributeCommand, compound } from './commands.js';
import { setDefinition } from './definitions.js';
import { definitionById, freeIdFrom, soleReference } from './dom.js';
import { drawingPrefixOf, idsIn, layerById, styleValue } from './layers.js';
import type { Command } from './model.js';

/**
 * Adjustments (docs/decisions/0003-layers.md: "adjustments are SVG's own
 * filters … so they stay editable and a flattened export is a render"): a
 * stack of SVG's own filter primitives on one layer, non-destructive, in a
 * `<filter id="adjust-<layer id>">` in the root's `<defs>` that the layer
 * names with `filter="url(#adjust-…)"`. Any renderer draws them; the app
 * reads them back from its own attributes on each primitive:
 *
 * ```xml
 * <filter id="adjust-layer-3" color-interpolation-filters="sRGB" x="-50%" y="-50%" width="200%" height="200%">
 *   <feComponentTransfer draw:adjust="brightness" draw:amount="20">
 *     <feFuncR type="linear" slope="1.2" intercept="0"/>…
 *   </feComponentTransfer>
 *   <feGaussianBlur draw:adjust="blur" draw:radius="4" stdDeviation="4"/>
 * </filter>
 * ```
 *
 * One primitive per adjustment, in the order they apply, each taking the one
 * before it as its input. `draw:adjust` names the adjustment and
 * `draw:<parameter>` holds each of its parameters as the panel shows it;
 * SVG's own attributes are written from those every time and never read, so
 * a parameter SVG cannot say exactly (a contrast is a slope and an intercept)
 * comes back as it was set. A filter of the file's own, or one with anything
 * in it the app did not write, is another tool's, shown as such and left
 * alone.
 */

export const ADJUSTMENT_KINDS = [
	'brightness',
	'contrast',
	'hue',
	'saturation',
	'blur',
	'invert',
	'grayscale',
	'shadow',
] as const;

export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** How a parameter's number reads beside its slider. */
type ParameterUnit = 'percent' | 'degrees' | 'units';

export type AdjustmentParameter = Readonly<{
	/** The local name of its `draw:` attribute, and its catalog key under `layers.adjustments.parameters`. */
	name: 'amount' | 'angle' | 'radius' | 'dx' | 'dy' | 'blur' | 'opacity';
	min: number;
	max: number;
	step: number;
	/** What a new adjustment starts at. */
	initial: number;
	unit: ParameterUnit;
}>;

const percent = (initial: number, min = -100): AdjustmentParameter => ({
	name: 'amount',
	min,
	max: 100,
	step: 1,
	initial,
	unit: 'percent',
});

const length = (
	name: AdjustmentParameter['name'],
	initial: number,
	min: number
): AdjustmentParameter => ({ name, min, max: 100, step: 0.5, initial, unit: 'units' });

/** Each adjustment's parameters, in the order the panel shows them. */
export const ADJUSTMENT_PARAMETERS: Readonly<
	Record<AdjustmentKind, readonly AdjustmentParameter[]>
> = {
	brightness: [percent(0)],
	contrast: [percent(0)],
	hue: [{ name: 'angle', min: -180, max: 180, step: 1, initial: 0, unit: 'degrees' }],
	saturation: [percent(0)],
	blur: [length('radius', 4, 0)],
	invert: [percent(100, 0)],
	grayscale: [percent(100, 0)],
	shadow: [
		length('dx', 4, -100),
		length('dy', 4, -100),
		length('blur', 4, 0),
		{ ...percent(50, 0), name: 'opacity' },
	],
};

export type Adjustment = Readonly<{
	kind: AdjustmentKind;
	/** By parameter name; every parameter of the kind is here. */
	values: Readonly<Partial<Record<AdjustmentParameter['name'], number>>>;
}>;

/**
 * A layer's filter as the panel sees it: the app's adjustments, in order, or
 * a filter from another tool.
 */
export type LayerAdjustments =
	| Readonly<{ own: true; filterId: string; list: readonly Adjustment[] }>
	| Readonly<{ own: false }>;

const FILTER_PREFIX = 'adjust-';

const isKind = (value: string | null): value is AdjustmentKind =>
	value !== null && (ADJUSTMENT_KINDS as readonly string[]).includes(value);

const clampTo = (parameter: AdjustmentParameter, value: number): number =>
	Math.min(parameter.max, Math.max(parameter.min, value));

/** A new adjustment of `kind`, at its parameters' starting values. */
export const newAdjustment = (kind: AdjustmentKind): Adjustment => ({
	kind,
	values: Object.fromEntries(
		ADJUSTMENT_PARAMETERS[kind].map((parameter) => [parameter.name, parameter.initial])
	),
});

/** A parameter's value, or where it starts for one not given. */
export const parameterValue = (adjustment: Adjustment, parameter: AdjustmentParameter): number =>
	adjustment.values[parameter.name] ?? parameter.initial;

/** One of the app's primitives read back, or nothing for one it did not write. */
const adjustmentOf = (primitive: Element): Adjustment | undefined => {
	const kind = primitive.getAttributeNS(DRAWING_NAMESPACE, 'adjust');
	if (!isKind(kind)) return undefined;
	const values = ADJUSTMENT_PARAMETERS[kind].map((parameter) => {
		const written = Number(primitive.getAttributeNS(DRAWING_NAMESPACE, parameter.name) ?? '');
		const value = Number.isFinite(written) ? clampTo(parameter, written) : parameter.initial;
		return [parameter.name, value] as const;
	});
	return { kind, values: Object.fromEntries(values) };
};

/**
 * The layer's filter: none, the app's adjustments, or another tool's. A
 * `filter` in `style` beats the attribute and is CSS, not the app's, so it is
 * another tool's too.
 */
export const adjustmentsOf = (root: Element, layer: Element): LayerAdjustments | undefined => {
	if (styleValue(layer, 'filter') !== undefined) return { own: false };
	const value = layer.getAttribute('filter');
	if (value === null || value.trim() === '' || value.trim() === 'none') return undefined;
	const id = soleReference(value);
	const filter = id === undefined ? undefined : definitionById(root, id, 'filter');
	if (id === undefined || filter === undefined || !id.startsWith(FILTER_PREFIX)) {
		return { own: false };
	}
	const read = [...filter.children].map(adjustmentOf);
	const list = read.filter((each): each is Adjustment => each !== undefined);
	return list.length === read.length ? { own: true, filterId: id, list } : { own: false };
};

/** A number as an attribute: a few places, no float noise, no `-0`. */
const written = (value: number): string => String(Number(value.toFixed(4)) + 0);

type Built = Readonly<{
	name: string;
	attributes: Readonly<Record<string, string>>;
	/** Each of red, green and blue, for a component transfer. */
	channels?: Readonly<Record<string, string>>;
}>;

const linear = (slope: number, intercept: number): Built => ({
	name: 'feComponentTransfer',
	attributes: {},
	channels: { type: 'linear', slope: written(slope), intercept: written(intercept) },
});

const saturate = (value: number): Built => ({
	name: 'feColorMatrix',
	attributes: { type: 'saturate', values: written(value) },
});

/**
 * SVG's own primitive for each adjustment, from the parameters as the panel
 * holds them: the CSS filter functions' definitions, which every browser and
 * every other tool draws alike.
 * https://drafts.fxtf.org/filter-effects/#ShorthandEquivalents
 */
const BUILD: Readonly<
	Record<AdjustmentKind, (value: (name: AdjustmentParameter['name']) => number) => Built>
> = {
	brightness: (value) => linear(1 + value('amount') / 100, 0),
	contrast: (value) => {
		const slope = 1 + value('amount') / 100;
		return linear(slope, 0.5 - 0.5 * slope);
	},
	hue: (value) => ({
		name: 'feColorMatrix',
		attributes: { type: 'hueRotate', values: written(value('angle')) },
	}),
	saturation: (value) => saturate(1 + value('amount') / 100),
	blur: (value) => ({
		name: 'feGaussianBlur',
		attributes: { stdDeviation: written(value('radius')) },
	}),
	invert: (value) => {
		const amount = value('amount') / 100;
		return {
			name: 'feComponentTransfer',
			attributes: {},
			channels: { type: 'table', tableValues: `${written(amount)} ${written(1 - amount)}` },
		};
	},
	grayscale: (value) => saturate(1 - value('amount') / 100),
	shadow: (value) => ({
		name: 'feDropShadow',
		attributes: {
			dx: written(value('dx')),
			dy: written(value('dy')),
			stdDeviation: written(value('blur')),
			'flood-color': '#000000',
			'flood-opacity': written(value('opacity') / 100),
		},
	}),
};

const CHANNELS = ['feFuncR', 'feFuncG', 'feFuncB'] as const;

const svgElement = (
	root: SVGSVGElement,
	name: string,
	attributes: Readonly<Record<string, string>>
): Element => {
	const element = root.ownerDocument.createElementNS(SVG_NAMESPACE, name);
	Object.entries(attributes).forEach(([attribute, value]) =>
		element.setAttribute(attribute, value)
	);
	return element;
};

const primitiveFor = (root: SVGSVGElement, adjustment: Adjustment): Element => {
	const parameters = ADJUSTMENT_PARAMETERS[adjustment.kind];
	const value = (name: AdjustmentParameter['name']): number => {
		const parameter = parameters.find((each) => each.name === name);
		return parameter === undefined ? 0 : parameterValue(adjustment, parameter);
	};
	const built = BUILD[adjustment.kind](value);
	const prefix = drawingPrefixOf(root);
	const primitive = root.ownerDocument.createElementNS(SVG_NAMESPACE, built.name);
	primitive.setAttributeNS(DRAWING_NAMESPACE, `${prefix}:adjust`, adjustment.kind);
	parameters.forEach((parameter) =>
		primitive.setAttributeNS(
			DRAWING_NAMESPACE,
			`${prefix}:${parameter.name}`,
			written(parameterValue(adjustment, parameter))
		)
	);
	Object.entries(built.attributes).forEach(([attribute, text]) =>
		primitive.setAttribute(attribute, text)
	);
	const channels = built.channels;
	if (channels !== undefined) {
		primitive.append(...CHANNELS.map((channel) => svgElement(root, channel, channels)));
	}
	return primitive;
};

/**
 * The region the filter draws in, past the layer's box on every side, so a
 * blur or a shadow is not cut off at the layer's edge as the default 10% would
 * cut it.
 */
const REGION = { x: '-50%', y: '-50%', width: '200%', height: '200%' } as const;

const filterFor = (root: SVGSVGElement, id: string, list: readonly Adjustment[]): Element => {
	const filter = svgElement(root, 'filter', {
		id,
		'color-interpolation-filters': 'sRGB',
		...REGION,
	});
	filter.append(...list.map((adjustment) => primitiveFor(root, adjustment)));
	return filter;
};

/** Whether anything but `layer` uses the filter: a duplicate of the layer shares it. */
const sharedBeyond = (root: Element, layer: Element, id: string): boolean =>
	[...root.querySelectorAll('[filter]')].some(
		(element) => element !== layer && soleReference(element.getAttribute('filter')) === id
	);

/**
 * The layer's adjustments set to `list`, as one step: the filter rebuilt in
 * its place, or made, or, for an empty list, taken away with the attribute. A
 * filter the layer shares with a duplicate of it is left to the duplicate,
 * and this layer gets one of its own. Nothing, costing nothing, on a layer
 * with another tool's filter.
 */
export const setAdjustments = (
	root: SVGSVGElement,
	layerId: string,
	list: readonly Adjustment[],
	label: string
): Command => {
	const layer = layerById(root, layerId);
	const current = layer === undefined ? undefined : adjustmentsOf(root, layer);
	if (layer === undefined || current?.own === false) return compound(label, []);
	const ownId = current?.filterId;
	const shared = ownId !== undefined && sharedBeyond(root, layer, ownId);
	if (list.length === 0) {
		if (ownId === undefined) return compound(label, []);
		return compound(label, [
			attributeCommand(layerId, label, (_root, target) => target.removeAttribute('filter')),
			...(shared ? [] : [setDefinition(ownId, 'filter', undefined)]),
		]);
	}
	const id =
		ownId !== undefined && !shared
			? ownId
			: freeIdFrom(`${FILTER_PREFIX}${layerId}`, idsIn(root));
	return compound(label, [
		setDefinition(id, 'filter', (live) => filterFor(live, id, list)),
		attributeCommand(layerId, label, (_root, target) =>
			target.setAttribute('filter', `url(#${id})`)
		),
	]);
};
