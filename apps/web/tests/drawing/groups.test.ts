import { describe, expect, it } from 'vitest';

import {
	type BarMetrics,
	foldedGroups,
	groupOf,
	groupsFor,
	lengthOf,
	shownOf,
	TOOL_GROUPS,
	type ToolGroup,
} from '../../src/drawing/tools/groups.js';
import { TOOLS } from '../../src/drawing/tools/index.js';
import { TOOL_IDS } from '../../src/drawing/tools/types.js';

/**
 * The tool bar's groups (docs/decisions/0004-the-interface.md, "The tool
 * bar"): Photoshop's, in its order, every tool in one; and which of them fold
 * into one button each where the bar is short of room.
 */

const ids = (groups: readonly ToolGroup[]) =>
	groups.map((group) => `${group.id}:${group.tools.map((tool) => tool.id).join(',')}`);

/** A bar of 44 px tools, 1 px rules and 4 px gaps, with `room` along it. */
const bar = (room: number): BarMetrics => ({ room, tool: 44, rule: 1, gap: 4 });

describe('the groups', () => {
	it('hold every tool once, in the bar’s order', () => {
		const flat = TOOL_GROUPS.flatMap((group) => [...group.tools]);
		expect(flat).toEqual([...TOOL_IDS]);
		expect(TOOLS.map((tool) => tool.id)).toEqual(flat);
	});

	it('are Photoshop’s, in its order', () => {
		expect(TOOL_GROUPS.map((group) => group.id)).toEqual([
			'move',
			'select',
			'crop',
			'retouch',
			'paint',
			'draw',
			'shape',
			'view',
		]);
		expect(groupOf('redEye')).toBe('retouch');
		expect(groupOf('node')).toBe('draw');
		expect(groupOf('zoom')).toBe('view');
	});

	it('show on a layer only the tools that act on it, and drop a group left empty', () => {
		expect(ids(groupsFor('vector', 'select'))).not.toContain('retouch:');
		expect(groupsFor('vector', 'select').map((group) => group.id)).not.toContain('retouch');
		expect(groupsFor('raster', 'brush').map((group) => group.id)).not.toContain('draw');
		expect(ids(groupsFor('group', 'select'))).toEqual([
			'move:select',
			'crop:crop',
			'view:hand,zoom',
		]);
	});

	it('keep the tool in hand in its group on a layer it does nothing on', () => {
		expect(ids(groupsFor('vector', 'redEye'))).toContain('retouch:redEye');
	});

	it('show folded the tool in hand, else the one last used, else the first', () => {
		const paint = groupsFor('raster', 'brush').find(
			(group) => group.id === 'paint'
		) as ToolGroup;
		expect(shownOf(paint, 'eraser', 'pencil').id).toBe('eraser');
		expect(shownOf(paint, 'select', 'pencil').id).toBe('pencil');
		expect(shownOf(paint, 'select', undefined).id).toBe('brush');
		// One last used that is no longer shown is passed over.
		expect(shownOf(paint, 'select', 'node').id).toBe('brush');
	});
});

describe('folding', () => {
	const vector = groupsFor('vector', 'select');

	it('measures the bar: the buttons, a rule between each two groups, and a gap between any two', () => {
		// 18 tools in 7 groups, so 6 rules: 24 items, 23 gaps.
		expect(lengthOf(vector, new Set(), bar(0))).toBe(18 * 44 + 6 * 1 + 23 * 4);
		// Painting folded is one button for four.
		expect(lengthOf(vector, new Set(['paint']), bar(0))).toBe(15 * 44 + 6 * 1 + 20 * 4);
	});

	it('folds nothing before the bar is measured, nor where it all fits', () => {
		expect(foldedGroups(vector, undefined).size).toBe(0);
		expect(foldedGroups(vector, bar(2000)).size).toBe(0);
		expect(foldedGroups(vector, bar(lengthOf(vector, new Set(), bar(0)))).size).toBe(0);
	});

	it('folds the largest first, and of two as large the later, until it fits', () => {
		const full = lengthOf(vector, new Set(), bar(0));
		expect([...foldedGroups(vector, bar(full - 1))]).toEqual(['paint']);
		const lessPaint = lengthOf(vector, new Set(['paint']), bar(0));
		expect([...foldedGroups(vector, bar(lessPaint - 1))]).toEqual(['paint', 'shape']);
		const lessShape = lengthOf(vector, new Set(['paint', 'shape']), bar(0));
		expect([...foldedGroups(vector, bar(lessShape - 1))]).toEqual(['paint', 'shape', 'draw']);
	});

	it('folds every group that can where even that is not enough, and never a group of one', () => {
		const folded = foldedGroups(vector, bar(100));
		expect([...folded].sort()).toEqual(['crop', 'draw', 'paint', 'select', 'shape', 'view']);
		expect(folded.has('move')).toBe(false);
	});

	it('takes less than a pixel over as a rounding, not a tool cut off', () => {
		const full = lengthOf(vector, new Set(), bar(0));
		expect(foldedGroups(vector, bar(full - 0.4)).size).toBe(0);
	});
});
