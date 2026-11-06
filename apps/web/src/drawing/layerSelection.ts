/**
 * The layers chosen in the layers panel (docs/ARCHITECTURE.md §7, "The
 * interface"), with the keys users know from Photoshop and every file
 * manager: a click chooses one layer alone; Ctrl, or ⌘ on a Mac, with a click
 * adds a layer to the choice or takes it out; Shift with a click chooses every
 * row from the anchor, the last layer clicked without Shift, to the one
 * clicked; Ctrl or ⌘ with Shift adds that range to the choice. Shift with an
 * arrow key grows or shrinks the range as Shift with a click does. The active
 * layer, the one the tools act on, is always among the chosen: the one last
 * clicked, or, where that one was taken out, the topmost one left. The choice
 * is never empty while the drawing has a layer.
 *
 * Every function is pure, over `order`: the panel's rows' layer ids as they
 * are shown, top first, a group's layers under it, and none for the layers of
 * a collapsed group, so a range never reaches into one. A layer `order` no longer
 * has, one deleted under the choice, drops out of it; an anchor it no longer
 * has is read as the active layer, as a fresh range starts there.
 */

export type LayerSelection = Readonly<{
	/** The layer the tools act on; one of `selected`. */
	active: string | undefined;
	/** Every chosen layer, in `order`'s order, top first. */
	selected: readonly string[];
	/** Where a Shift-click's range starts: the last layer clicked without Shift. */
	anchor: string | undefined;
}>;

/** What a click or a key says about the choice: toggle one, or take a range. */
export type ChoiceKeys = Readonly<{
	/** Ctrl on Windows and Linux, ⌘ on a Mac. */
	toggle: boolean;
	/** Shift. */
	range: boolean;
}>;

/** The keys held with a click or a key press, read as `ChoiceKeys`; ⌘ on a Mac, Ctrl elsewhere. */
export const choiceKeysOf = (
	event: Readonly<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>,
	isMac: boolean
): ChoiceKeys => ({ toggle: isMac ? event.metaKey : event.ctrlKey, range: event.shiftKey });

/** The ids among `ids` in `order`'s order, once each: a choice is always kept top first. */
const inOrder = (order: readonly string[], ids: Iterable<string>): readonly string[] => {
	const wanted = new Set(ids);
	return order.filter((id) => wanted.has(id));
};

/** Every row from `from` to `to`, both included, either way round, top first. */
const rangeOf = (order: readonly string[], from: string, to: string): readonly string[] => {
	const ends = [order.indexOf(from), order.indexOf(to)];
	return order.slice(Math.min(...ends), Math.max(...ends) + 1);
};

/** Where a range starts: the anchor, where `order` still has it, else the active layer, else `fallback`. */
const anchorIn = (current: LayerSelection, order: readonly string[], fallback: string): string =>
	[current.anchor, current.active].find(
		(id): id is string => id !== undefined && order.includes(id)
	) ?? fallback;

/** One layer, chosen alone, active, and the anchor of the next range. */
const alone = (id: string): LayerSelection => ({ active: id, selected: [id], anchor: id });

/** The choice after a click on `id` with `keys` held. */
export const clickSelection = (
	current: LayerSelection,
	order: readonly string[],
	id: string,
	keys: ChoiceKeys
): LayerSelection => {
	if (!order.includes(id)) return current;
	const chosen = inOrder(order, current.selected);
	if (keys.range) {
		const anchor = anchorIn(current, order, id);
		const range = rangeOf(order, anchor, id);
		const selected = keys.toggle ? inOrder(order, [...chosen, ...range]) : range;
		return { active: id, selected, anchor };
	}
	if (!keys.toggle) return alone(id);
	if (!chosen.includes(id))
		return { active: id, selected: inOrder(order, [...chosen, id]), anchor: id };
	// The last one chosen stays chosen: the choice is never empty.
	const left = chosen.filter((each) => each !== id);
	if (left.length === 0) return alone(id);
	const active =
		current.active !== undefined && left.includes(current.active) ? current.active : left[0];
	return { active, selected: left, anchor: id };
};

/**
 * The choice after an arrow key: the row `step` away from the active one, up
 * for -1 and down for 1, made active, and chosen alone, or, with `extend`
 * (Shift), with every row back to the anchor, so the range grows away from
 * the anchor and shrinks back toward it. At the end of the rows, nothing
 * changes.
 */
export const stepSelection = (
	current: LayerSelection,
	order: readonly string[],
	step: -1 | 1,
	extend: boolean
): LayerSelection => {
	const at = current.active === undefined ? -1 : order.indexOf(current.active);
	const next = at === -1 ? undefined : order[at + step];
	if (current.active === undefined || next === undefined) return current;
	if (!extend) return alone(next);
	const anchor = anchorIn(current, order, current.active);
	return { active: next, selected: rangeOf(order, anchor, next), anchor };
};

/**
 * Every layer chosen, Ctrl or ⌘ A in the panel, the active one kept active,
 * or the top one where none is, and the anchor where the active one is.
 */
export const everyLayer = (
	order: readonly string[],
	active: string | undefined
): LayerSelection => {
	const kept = active !== undefined && order.includes(active) ? active : order[0];
	return { active: kept, selected: order, anchor: kept };
};
