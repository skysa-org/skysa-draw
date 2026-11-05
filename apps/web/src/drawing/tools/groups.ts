import type { LayerKind } from '@skysa/draw-core';

import { availableOn, toolById } from './index.js';
import type { Tool, ToolId } from './types.js';

/**
 * The tool bar's groups (docs/decisions/0004-the-interface.md, "The tool
 * bar"), in Photoshop's order and gathered as Photoshop gathers them: the
 * move tool; the tools that select; cropping and sampling; retouching;
 * painting; the pen, type and path selection; the shapes; and the view's.
 * A light rule parts each from the next. Where the bar has the room, every
 * tool of every group is a button; where it has not, a group folds into one
 * button, the tool last used in it, with the rest in its menu, as a slot of
 * Photoshop's tool bar has them.
 *
 * Every tool is in one group, and the bar's order is theirs (`TOOLS`, which a
 * test holds to this).
 */
export const TOOL_GROUPS = [
	{ id: 'move', tools: ['select'] },
	{ id: 'select', tools: ['marquee', 'lasso', 'wand'] },
	{ id: 'crop', tools: ['crop', 'eyedropper'] },
	{ id: 'retouch', tools: ['remove', 'redEye', 'smudge'] },
	{ id: 'paint', tools: ['brush', 'pencil', 'eraser', 'fill'] },
	{ id: 'draw', tools: ['pen', 'text', 'node'] },
	{ id: 'shape', tools: ['rectangle', 'ellipse', 'line'] },
	{ id: 'view', tools: ['hand', 'zoom'] },
] as const satisfies readonly Readonly<{ id: string; tools: readonly ToolId[] }>[];

export type ToolGroupId = (typeof TOOL_GROUPS)[number]['id'];

/** A group as the bar shows it: the tools of it that are shown. */
export type ToolGroup = Readonly<{ id: ToolGroupId; tools: readonly Tool[] }>;

/** The group a tool is in. */
export const groupOf = (id: ToolId): ToolGroupId | undefined =>
	TOOL_GROUPS.find((group) => group.tools.some((each) => each === id))?.id;

/**
 * The groups as the bar shows them with the active layer of `kind`: of each,
 * the tools that act on it (`availableOn`), and the one in hand whatever it
 * acts on; a group left with none is not there, nor its rule.
 */
export const groupsFor = (kind: LayerKind | undefined, inHand: ToolId): readonly ToolGroup[] =>
	TOOL_GROUPS.map((group) => ({
		id: group.id,
		tools: group.tools
			.map(toolById)
			.filter((each): each is Tool => each !== undefined)
			.filter((each) => each.id === inHand || availableOn(each, kind)),
	})).filter((group) => group.tools.length > 0);

/**
 * The tool a folded group shows: the one in hand, where it is of the group;
 * else the one last used of it, while it is still shown; else its first.
 */
export const shownOf = (group: ToolGroup, inHand: ToolId, last: ToolId | undefined): Tool =>
	group.tools.find((each) => each.id === inHand) ??
	group.tools.find((each) => each.id === last) ??
	(group.tools[0] as Tool);

/** What the bar measures, in CSS pixels along it: the room for the tools, a tool, a rule, and the gap between any two. */
export type BarMetrics = Readonly<{ room: number; tool: number; rule: number; gap: number }>;

/** How long the groups are along the bar, those in `folded` as one button each, with a rule between each two. */
export const lengthOf = (
	groups: readonly ToolGroup[],
	folded: ReadonlySet<ToolGroupId>,
	metrics: BarMetrics
): number => {
	const buttons = groups.reduce(
		(sum, group) => sum + (folded.has(group.id) ? 1 : group.tools.length),
		0
	);
	const rules = Math.max(0, groups.length - 1);
	const items = buttons + rules;
	return buttons * metrics.tool + rules * metrics.rule + Math.max(0, items - 1) * metrics.gap;
};

/** Less than a pixel over is a rounding of the layout, not a tool cut off. */
const SLACK_PX = 0.5;

/**
 * The groups to fold so the bar holds every tool: none where they all fit,
 * and none before the bar has been measured; else one at a time, the largest
 * first, and of two as large the later in the bar, until they fit, which
 * keeps the most buttons out; else every group that can fold, and the bar
 * scrolls what is still over. A group of one has nothing to fold.
 */
export const foldedGroups = (
	groups: readonly ToolGroup[],
	metrics: BarMetrics | undefined
): ReadonlySet<ToolGroupId> => {
	if (metrics === undefined) return new Set();
	const order = groups
		.map((group, index) => ({ id: group.id, size: group.tools.length, index }))
		.filter((group) => group.size > 1)
		.sort((a, b) => b.size - a.size || b.index - a.index)
		.map((group) => group.id);
	const tries = [...order.map((_, count) => new Set(order.slice(0, count))), new Set(order)];
	return (
		tries.find((folded) => lengthOf(groups, folded, metrics) <= metrics.room + SLACK_PX) ??
		new Set(order)
	);
};
