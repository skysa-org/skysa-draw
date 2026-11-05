import { LAYER_KINDS } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import {
	behaviorFor,
	notAvailableMessage,
	toolById,
	TOOLS,
} from '../../src/drawing/tools/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Tool,
	TOOL_IDS,
	type ToolBehavior,
	type ToolId,
} from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';

/**
 * The tool registry (docs/decisions/0004-the-interface.md): the tools the bar
 * shows, each one tool with one name, and how the viewport finds what one does
 * on a layer. What each tool does on a vector or a raster layer is the
 * business of those modules and their tests; here they are stand-ins, one
 * behavior per tool and kind, so the registry is seen to put each where it
 * belongs. The hand and the zoom are the registry's own, and real.
 */

const doubles = vi.hoisted(() => {
	const behavior = () => ({
		begin: () => undefined,
		move: () => undefined,
		end: () => undefined,
		cancel: () => undefined,
	});
	const both = ['select', 'pencil', 'brush', 'eraser', 'fill', 'eyedropper', 'rectangle'];
	const table = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, behavior()]));
	return {
		// Each kind lacks one the other has, as the node tool is vector's alone
		// and the smudge raster's.
		vector: table([...both, 'ellipse', 'node']),
		raster: table([...both, 'line', 'smudge']),
	};
});
vi.mock('../../src/drawing/tools/vector/index.js', () => ({ vectorBehaviors: doubles.vector }));
vi.mock('../../src/drawing/tools/raster/index.js', () => ({ rasterBehaviors: doubles.raster }));

const noop = (): ToolBehavior => ({
	begin: () => undefined,
	move: () => undefined,
	end: () => undefined,
	cancel: () => undefined,
});

describe('TOOLS', () => {
	it('names tools the catalog knows, each once, in the bar order, which is the groups’', () => {
		const ids = TOOLS.map((tool) => tool.id);
		expect(new Set(ids).size).toBe(ids.length);
		ids.forEach((id) => {
			expect(TOOL_IDS).toContain(id);
		});
		expect(ids).toEqual([
			'select',
			'marquee',
			'lasso',
			'wand',
			'crop',
			'eyedropper',
			'remove',
			'redEye',
			'smudge',
			'brush',
			'pencil',
			'eraser',
			'fill',
			'pen',
			'text',
			'node',
			'rectangle',
			'ellipse',
			'line',
			'hand',
			'zoom',
		]);
	});

	it('has a name in the user words for every tool, not the key', () => {
		TOOLS.forEach((tool) => {
			const name = t(`tools.${tool.id}`);
			expect(name).not.toBe(`tools.${tool.id}`);
			expect(name.length).toBeGreaterThan(0);
		});
	});

	it('shows options that are options, and a cursor', () => {
		const known = Object.keys(DEFAULT_TOOL_OPTIONS);
		TOOLS.forEach((tool) => {
			tool.options.forEach((option) => {
				expect(known).toContain(option);
			});
			expect(new Set(tool.options).size).toBe(tool.options.length);
			expect(typeof tool.cursor).toBe('string');
		});
		expect(toolById('brush')?.options).toEqual([
			'size',
			'opacity',
			'hardness',
			'pressure',
			'smoothing',
			'fill',
		]);
		expect(toolById('select')?.options).toEqual(['autoSelect']);
	});

	it('gives the marquee, the lasso and the magic wand the selection mode, first, as Photoshop’s options bar does', () => {
		expect(toolById('marquee')?.options).toEqual(['areaMode', 'constrain']);
		expect(toolById('lasso')?.options).toEqual(['areaMode']);
		expect(toolById('wand')?.options).toEqual(['areaMode', 'tolerance', 'contiguous']);
		TOOLS.filter((tool) => !['marquee', 'lasso', 'wand'].includes(tool.id)).forEach((tool) => {
			expect(tool.options).not.toContain('areaMode');
		});
	});

	it('lets the select tool alone pick the layer a press acts on, which its Auto-Select does', () => {
		expect(toolById('select')?.pick).toBeDefined();
		TOOLS.filter((tool) => tool.id !== 'select').forEach((tool) => {
			expect(tool.pick).toBeUndefined();
		});
	});

	it("puts each kind's behavior under its tool, one tool for both kinds", () => {
		expect(toolById('pencil')?.behaviors).toEqual({
			vector: doubles.vector.pencil,
			raster: doubles.raster.pencil,
		});
		expect(toolById('pencil')?.behaviors.vector).toBe(doubles.vector.pencil);
		expect(toolById('pencil')?.behaviors.raster).toBe(doubles.raster.pencil);
	});

	it('names a kind only where the tool has a behavior for it', () => {
		expect(Object.keys(toolById('ellipse')?.behaviors ?? {})).toEqual(['vector']);
		expect(Object.keys(toolById('line')?.behaviors ?? {})).toEqual(['raster']);
		expect(Object.keys(toolById('hand')?.behaviors ?? {})).toEqual(['any']);
		TOOLS.forEach((tool) => {
			Object.values(tool.behaviors).forEach((behavior) => {
				expect(behavior).toBeDefined();
			});
		});
	});

	it('gives the hand, the zoom and the crop a behavior for any layer, and none to the rest', () => {
		const anyLayer: readonly ToolId[] = ['hand', 'zoom', 'crop'];
		anyLayer.forEach((id) => {
			expect(toolById(id)?.behaviors.any).toBeDefined();
		});
		expect(toolById('hand')?.behaviors.any).not.toBe(toolById('zoom')?.behaviors.any);
		TOOLS.filter((tool) => !anyLayer.includes(tool.id)).forEach((tool) => {
			expect(tool.behaviors.any).toBeUndefined();
		});
	});

	it('finds every tool the bar shows by its id', () => {
		TOOL_IDS.forEach((id) => {
			expect(toolById(id)?.id).toBe(id);
		});
	});
});

describe('behaviorFor', () => {
	const vector = noop();
	const any = noop();
	const tool: Tool = { id: 'select', options: [], behaviors: { vector, any } };

	it("prefers the layer's kind over any, and falls back to any for a kind not named", () => {
		expect(behaviorFor(tool, 'vector')).toBe(vector);
		expect(behaviorFor(tool, 'raster')).toBe(any);
		expect(behaviorFor(tool, 'group')).toBe(any);
		expect(behaviorFor(tool, undefined)).toBe(any);
	});

	it('is nothing where the tool has neither', () => {
		const only: Tool = { id: 'pencil', options: [], behaviors: { vector } };
		expect(behaviorFor(only, 'raster')).toBeUndefined();
		expect(behaviorFor(only, undefined)).toBeUndefined();
		expect(behaviorFor(toolById('hand') as Tool, undefined)).toBeDefined();
		expect(behaviorFor(toolById('ellipse') as Tool, 'raster')).toBeUndefined();
		expect(behaviorFor(toolById('ellipse') as Tool, 'vector')).toBe(doubles.vector.ellipse);
	});
});

describe('notAvailableMessage', () => {
	const smudge: Tool = { id: 'smudge', options: [], behaviors: {} };

	it('names the tool and the kind of layer, in the user words', () => {
		expect(notAvailableMessage(smudge, 'vector')).toBe(
			'Smudge does not work on a vector layer.'
		);
		expect(notAvailableMessage(smudge, 'raster')).toBe(
			'Smudge does not work on a raster layer.'
		);
		expect(notAvailableMessage(smudge, 'group')).toBe(
			'Smudge does not work on a group. Choose a layer inside it.'
		);
	});

	it('has a line for every kind, and none for no layer', () => {
		LAYER_KINDS.forEach((kind) => {
			expect(notAvailableMessage(smudge, kind)).toContain('Smudge');
		});
		expect(notAvailableMessage(smudge, undefined)).toBeUndefined();
	});
});
