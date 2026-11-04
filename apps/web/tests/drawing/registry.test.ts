import { LAYER_KINDS } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import {
	behaviourFor,
	notAvailableMessage,
	toolById,
	TOOLS,
} from '../../src/drawing/tools/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Tool,
	TOOL_IDS,
	type ToolBehaviour,
} from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';

/**
 * The tool registry (docs/decisions/0004-the-interface.md): the tools the bar
 * shows, each one tool with one name, and how the viewport finds what one does
 * on a layer. What each tool does on a vector or a raster layer is the
 * business of those modules and their tests; here they are stand-ins, one
 * behaviour per tool and kind, so the registry is seen to put each where it
 * belongs. The hand and the zoom are the registry's own, and real.
 */

const doubles = vi.hoisted(() => {
	const behaviour = () => ({
		begin: () => undefined,
		move: () => undefined,
		end: () => undefined,
		cancel: () => undefined,
	});
	const both = ['select', 'pencil', 'brush', 'eraser', 'fill', 'eyedropper', 'rectangle'];
	const table = (ids: readonly string[]) =>
		Object.fromEntries(ids.map((id) => [id, behaviour()]));
	return {
		// Each kind lacks one the other has, as the node tool is vector's alone
		// and the smudge raster's.
		vector: table([...both, 'ellipse', 'node']),
		raster: table([...both, 'line', 'smudge']),
	};
});
vi.mock('../../src/drawing/tools/vector/index.js', () => ({ vectorBehaviours: doubles.vector }));
vi.mock('../../src/drawing/tools/raster/index.js', () => ({ rasterBehaviours: doubles.raster }));

const noop = (): ToolBehaviour => ({
	begin: () => undefined,
	move: () => undefined,
	end: () => undefined,
	cancel: () => undefined,
});

describe('TOOLS', () => {
	it('names tools the catalog knows, each once, in the bar order', () => {
		const ids = TOOLS.map((tool) => tool.id);
		expect(new Set(ids).size).toBe(ids.length);
		ids.forEach((id) => {
			expect(TOOL_IDS).toContain(id);
		});
		expect(ids).toEqual([
			'select',
			'node',
			'marquee',
			'lasso',
			'hand',
			'zoom',
			'crop',
			'pencil',
			'brush',
			'eraser',
			'smudge',
			'fill',
			'eyedropper',
			'pen',
			'text',
			'rectangle',
			'ellipse',
			'line',
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
		expect(toolById('select')?.options).toEqual([]);
	});

	it("puts each kind's behaviour under its tool, one tool for both kinds", () => {
		expect(toolById('pencil')?.behaviours).toEqual({
			vector: doubles.vector.pencil,
			raster: doubles.raster.pencil,
		});
		expect(toolById('pencil')?.behaviours.vector).toBe(doubles.vector.pencil);
		expect(toolById('pencil')?.behaviours.raster).toBe(doubles.raster.pencil);
	});

	it('names a kind only where the tool has a behaviour for it', () => {
		expect(Object.keys(toolById('ellipse')?.behaviours ?? {})).toEqual(['vector']);
		expect(Object.keys(toolById('line')?.behaviours ?? {})).toEqual(['raster']);
		expect(Object.keys(toolById('hand')?.behaviours ?? {})).toEqual(['any']);
		TOOLS.forEach((tool) => {
			Object.values(tool.behaviours).forEach((behaviour) => {
				expect(behaviour).toBeDefined();
			});
		});
	});

	it('gives the hand and the zoom a behaviour for any layer, and none to the rest', () => {
		expect(toolById('hand')?.behaviours.any).toBeDefined();
		expect(toolById('zoom')?.behaviours.any).toBeDefined();
		expect(toolById('hand')?.behaviours.any).not.toBe(toolById('zoom')?.behaviours.any);
		TOOLS.filter((tool) => tool.id !== 'hand' && tool.id !== 'zoom').forEach((tool) => {
			expect(tool.behaviours.any).toBeUndefined();
		});
	});

	it('finds every tool the bar shows by its id', () => {
		TOOL_IDS.forEach((id) => {
			expect(toolById(id)?.id).toBe(id);
		});
	});
});

describe('behaviourFor', () => {
	const vector = noop();
	const any = noop();
	const tool: Tool = { id: 'select', options: [], behaviours: { vector, any } };

	it("prefers the layer's kind over any, and falls back to any for a kind not named", () => {
		expect(behaviourFor(tool, 'vector')).toBe(vector);
		expect(behaviourFor(tool, 'raster')).toBe(any);
		expect(behaviourFor(tool, 'group')).toBe(any);
		expect(behaviourFor(tool, undefined)).toBe(any);
	});

	it('is nothing where the tool has neither', () => {
		const only: Tool = { id: 'pencil', options: [], behaviours: { vector } };
		expect(behaviourFor(only, 'raster')).toBeUndefined();
		expect(behaviourFor(only, undefined)).toBeUndefined();
		expect(behaviourFor(toolById('hand') as Tool, undefined)).toBeDefined();
		expect(behaviourFor(toolById('ellipse') as Tool, 'raster')).toBeUndefined();
		expect(behaviourFor(toolById('ellipse') as Tool, 'vector')).toBe(doubles.vector.ellipse);
	});
});

describe('notAvailableMessage', () => {
	const smudge: Tool = { id: 'smudge', options: [], behaviours: {} };

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
