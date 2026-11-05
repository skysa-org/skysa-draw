import type { LayerKind } from '@skysa/draw-core';
import { Fragment, type RefObject, useLayoutEffect, useRef, useState } from 'react';

import { ContextMenu, type MenuPoint } from '../../components/ui/ContextMenu.js';
import { ICONS } from '../../components/ui/icons.js';
import type { MenuItem } from '../../components/ui/Menu.js';
import { type Orientation, ToolBarRule } from '../../components/ui/ToolBar.js';
import { ToolButton } from '../../components/ui/ToolButton.js';
import { t } from '../../i18n/t.js';
import { shortcutLabel } from '../keys.js';
import {
	type BarMetrics,
	foldedGroups,
	groupOf,
	groupsFor,
	shownOf,
	type ToolGroup,
	type ToolGroupId,
} from '../tools/groups.js';
import { availableOn } from '../tools/index.js';
import type { Tool, ToolId } from '../tools/types.js';

/**
 * The tools in the tool bar, in their groups (docs/decisions/
 * 0004-the-interface.md, "The tool bar"; `tools/groups.ts`): every tool a
 * button where the bar has the room, a light rule between each group and the
 * next; where it has not, groups folded one at a time into one button each,
 * the tool last used in the group, with a mark in its corner and the group's
 * tools in its menu, which a long press, a right-click or the menu key opens,
 * as Photoshop's tool bar has its slots. A tool's own key still picks it,
 * folded or not.
 *
 * The bar is measured, not the window (docs/decisions/0004-the-interface.md:
 * a component never reads the viewport): the room is what the frame leaves
 * this box along the bar, which takes what is left of the bar and scrolls
 * what is still over.
 */

/** Between a folded tool and its menu, in CSS pixels. */
const MENU_GAP_PX = 4;

/** Along the bar: across a bar that runs across, down one that runs down. */
const along = (orientation: Orientation, box: DOMRect | HTMLElement) =>
	box instanceof HTMLElement
		? orientation === 'horizontal'
			? box.offsetWidth
			: box.offsetHeight
		: orientation === 'horizontal'
			? box.width
			: box.height;

/** What a bar of tools has room for, from its box as laid out now; none before it has a tool. */
const measure = (box: HTMLElement, orientation: Orientation): BarMetrics | undefined => {
	const tool = box.querySelector<HTMLElement>('.tool-button');
	if (tool === null) return undefined;
	const rule = box.querySelector<HTMLElement>('.toolbar-rule');
	const style = getComputedStyle(box);
	const gap = Number.parseFloat(orientation === 'horizontal' ? style.columnGap : style.rowGap);
	return {
		room: orientation === 'horizontal' ? box.clientWidth : box.clientHeight,
		tool: along(orientation, tool),
		// A rule is a hairline; one not there now is measured when it is.
		rule: rule === null ? 1 : along(orientation, rule),
		gap: Number.isFinite(gap) ? gap : 0,
	};
};

/**
 * The bar's room, measured before it is painted and again whenever the box
 * changes size; none where the browser cannot say, as jsdom cannot, and then
 * nothing folds.
 */
const useBarMetrics = (
	box: RefObject<HTMLDivElement | null>,
	orientation: Orientation
): BarMetrics | undefined => {
	const [metrics, setMetrics] = useState<BarMetrics | undefined>(undefined);
	useLayoutEffect(() => {
		const element = box.current;
		if (element === null || typeof ResizeObserver !== 'function') return undefined;
		const update = () => {
			setMetrics(measure(element, orientation));
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => {
			observer.disconnect();
		};
	}, [box, orientation]);
	return metrics;
};

/**
 * The tool last used of each group, so that a folded group shows it after
 * the hand has gone to another group's, as Photoshop's slot keeps the tool
 * last chosen in it. Kept as the tool in hand changes, during the render that
 * sees it change.
 */
const useLastOfGroups = (inHand: ToolId): Readonly<Partial<Record<ToolGroupId, ToolId>>> => {
	const [last, setLast] = useState<Readonly<Partial<Record<ToolGroupId, ToolId>>>>({});
	const group = groupOf(inHand);
	if (group !== undefined && last[group] !== inHand) setLast({ ...last, [group]: inHand });
	return last;
};

/**
 * Where a folded tool's menu opens: beside the button, toward the canvas, in
 * a bar that runs down; from the button's start in one that runs across, over
 * it where there is no room under it, as at the foot of the window
 * (`ContextMenu`).
 */
const menuPointFor = (button: HTMLElement, orientation: Orientation): MenuPoint => {
	const box = button.getBoundingClientRect();
	const rtl = getComputedStyle(button).direction === 'rtl';
	if (orientation === 'horizontal') return { x: rtl ? box.right : box.left, y: box.top };
	return { x: rtl ? box.left - MENU_GAP_PX : box.right + MENU_GAP_PX, y: box.top };
};

type Choose = (id: ToolId) => void;

/** One tool as a button: pressed in hand, faded where it does nothing on the active layer. */
const ToolFor = ({
	tool,
	inHand,
	layerKind,
	onChoose,
	onMenu,
}: Readonly<{
	tool: Tool;
	inHand: ToolId;
	layerKind: LayerKind | undefined;
	onChoose: Choose;
	onMenu?: (button: HTMLButtonElement) => void;
}>) => {
	const Icon = ICONS[tool.id];
	return (
		<ToolButton
			icon={<Icon />}
			label={t(`tools.${tool.id}`)}
			shortcut={shortcutLabel(tool.id)}
			pressed={tool.id === inHand}
			unavailable={!availableOn(tool, layerKind)}
			onClick={() => onChoose(tool.id)}
			onMenu={onMenu}
		/>
	);
};

/**
 * A folded group's menu: its tools as shown (`groupsFor`), each by its icon,
 * name and key, the one in hand checked.
 */
const menuItems = (group: ToolGroup, inHand: ToolId, onChoose: Choose): readonly MenuItem[] =>
	group.tools.map((tool) => {
		const Icon = ICONS[tool.id];
		return {
			id: tool.id,
			label: t(`tools.${tool.id}`),
			icon: <Icon />,
			shortcut: shortcutLabel(tool.id),
			checked: tool.id === inHand,
			onSelect: () => onChoose(tool.id),
		};
	});

type Open = Readonly<{ group: ToolGroupId; at: MenuPoint }>;

export const ToolGroups = ({
	inHand,
	layerKind,
	orientation,
	onChoose,
}: Readonly<{
	inHand: ToolId;
	/** The active layer's kind, which the tools shown are fitted to; none with no layer. */
	layerKind: LayerKind | undefined;
	/** Which way the bar runs, which is the way the groups are measured and their rules drawn. */
	orientation: Orientation;
	onChoose: Choose;
}>) => {
	const box = useRef<HTMLDivElement>(null);
	const metrics = useBarMetrics(box, orientation);
	const last = useLastOfGroups(inHand);
	const [open, setOpen] = useState<Open | undefined>(undefined);
	const groups = groupsFor(layerKind, inHand);
	const folded = foldedGroups(groups, metrics);
	const openGroup = groups.find((group) => group.id === open?.group);
	return (
		<div ref={box} className="tool-groups">
			{groups.map((group, index) => (
				<Fragment key={group.id}>
					{index > 0 && <ToolBarRule orientation={orientation} />}
					{folded.has(group.id) ? (
						<ToolFor
							tool={shownOf(group, inHand, last[group.id])}
							inHand={inHand}
							layerKind={layerKind}
							onChoose={onChoose}
							onMenu={(button) =>
								setOpen({ group: group.id, at: menuPointFor(button, orientation) })
							}
						/>
					) : (
						group.tools.map((tool) => (
							<ToolFor
								key={tool.id}
								tool={tool}
								inHand={inHand}
								layerKind={layerKind}
								onChoose={onChoose}
							/>
						))
					)}
				</Fragment>
			))}
			<ContextMenu
				label={openGroup === undefined ? '' : t(`tools.groups.${openGroup.id}`)}
				items={openGroup === undefined ? [] : menuItems(openGroup, inHand, onChoose)}
				// Open only while its group is still folded: a bar grown to hold
				// the group's tools has no need of its menu.
				at={openGroup !== undefined && folded.has(openGroup.id) ? open?.at : undefined}
				onClose={() => setOpen(undefined)}
			/>
		</div>
	);
};
