import { describe, expect, it } from 'vitest';

import {
	BLEND_MODES,
	GRAPHICS_ELEMENTS,
	isBlendMode,
	isGraphicsElement,
	LAYER_ATTRIBUTES,
	LAYER_KINDS,
	layerId,
	layerNumber,
	RASTER_MAX_SIDE,
} from '../../src/drawing/layers.js';

describe('layerId', () => {
	it('numbers a layer from 1', () => {
		expect(layerId(1)).toBe('layer-1');
		expect(layerId(12)).toBe('layer-12');
	});

	it('refuses a number no layer has', () => {
		expect(() => layerId(0)).toThrow(RangeError);
		expect(() => layerId(1.5)).toThrow(RangeError);
		expect(() => layerId(-1)).toThrow(RangeError);
		expect(() => layerId(Number.NaN)).toThrow(RangeError);
	});
});

describe('layerNumber', () => {
	it('reads the number out of an id this app gave', () => {
		expect(layerNumber('layer-12')).toBe(12);
		expect(layerNumber(layerId(1))).toBe(1);
		expect(layerNumber(layerId(1234))).toBe(1234);
	});

	it('is nothing for any other id, including one that nearly matches', () => {
		expect(layerNumber('layer-0')).toBeUndefined();
		expect(layerNumber('layer-01')).toBeUndefined();
		expect(layerNumber('Layer_1')).toBeUndefined();
		expect(layerNumber('layer-')).toBeUndefined();
		expect(layerNumber('x')).toBeUndefined();
		expect(layerNumber('')).toBeUndefined();
	});
});

describe('BLEND_MODES', () => {
	it('is the sixteen modes every editor offers, each once, normal first', () => {
		expect(BLEND_MODES).toHaveLength(16);
		expect(new Set(BLEND_MODES).size).toBe(16);
		expect(BLEND_MODES[0]).toBe('normal');
	});

	it('is what isBlendMode admits, and nothing else', () => {
		expect(BLEND_MODES.every(isBlendMode)).toBe(true);
		expect(isBlendMode('normal ')).toBe(false);
		expect(isBlendMode('plus-lighter')).toBe(false);
		expect(isBlendMode('Multiply')).toBe(false);
		expect(isBlendMode('')).toBe(false);
	});
});

describe('LAYER_KINDS', () => {
	it('is vector, raster and group', () => {
		expect(LAYER_KINDS).toEqual(['vector', 'raster', 'group']);
	});
});

describe('LAYER_ATTRIBUTES', () => {
	it('names the kind, the name and the lock: only what SVG cannot say itself', () => {
		expect(LAYER_ATTRIBUTES).toEqual({ kind: 'kind', name: 'name', locked: 'locked' });
	});
});

describe('isGraphicsElement', () => {
	it('is true of an element that draws, by its exact local name', () => {
		expect(isGraphicsElement('g')).toBe(true);
		expect(isGraphicsElement('path')).toBe(true);
		expect(isGraphicsElement('image')).toBe(true);
		expect(GRAPHICS_ELEMENTS.every(isGraphicsElement)).toBe(true);
	});

	it('is false of the elements that only define or describe, and of another case', () => {
		expect(isGraphicsElement('defs')).toBe(false);
		expect(isGraphicsElement('title')).toBe(false);
		expect(isGraphicsElement('style')).toBe(false);
		expect(isGraphicsElement('clipPath')).toBe(false);
		expect(isGraphicsElement('G')).toBe(false);
	});
});

describe('RASTER_MAX_SIDE', () => {
	it('is a whole number of pixels', () => {
		expect(Number.isInteger(RASTER_MAX_SIDE)).toBe(true);
		expect(RASTER_MAX_SIDE).toBeGreaterThan(0);
	});
});
