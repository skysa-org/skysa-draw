import { type KeyboardEvent, type MouseEvent, useRef } from 'react';

import type { MenuPoint } from '../../components/ui/ContextMenu.js';
import { GripIcon } from '../../components/ui/icons.js';
import { t } from '../../i18n/t.js';
import type { EditorDocument } from '../document/model.js';
import type { LayerItem } from './layerItems.js';
import { LayerPreview } from './LayerPreview.js';
import { DropLine, flag, rowMenuPoint } from './LayerRow.js';
import type { PointerHandlers } from './useLayerDrag.js';

/**
 * A row of an expanded vector layer's in the layers panel, one per item, under
 * the layer's own (docs/ARCHITECTURE.md §7, "The interface"), as Illustrator
 * lists a layer's objects: a level deeper than the layer, an empty place
 * where a layer's eye is, so the items' previews line up in a column of their
 * own, the item's preview (`LayerPreview`, by its position among the layer's
 * elements) and its name (`layerItems.ts`), in one button, and, where a
 * pointer is coarse, the grip a finger drags it by, in the column of the
 * layers' grips.
 *
 * A press on it selects the item on the canvas, as a click on it there would
 * (`useItemRows`); it is tinted while the item is selected, whatever selected
 * it, and says "Selected" after its name to a screen reader, as a chosen
 * layer's row does. A right-click on it, a long press the browser makes a
 * menu of, or the Menu key opens the item's own menu (`onMenu`), the
 * selection's actions; the grip opens none, since a finger held on it is a
 * drag about to begin. It is dragged as a layer's row is, by its button or
 * its grip, among its layer's items or into another vector layer.
 *
 * On a held layer, locked or hidden, itself or by a group, the row is muted,
 * as a hidden layer's name is, and its button is `aria-disabled`: still in
 * the walk of the arrows, but a press selects nothing and says why, it opens
 * no menu, and it has no grip and is not dragged.
 *
 * It carries its layer's id, as `data-item-of`, so a drag of layers reads it
 * as part of its layer's row and the panel the focus on it as on its layer's,
 * and its position and whether its layer takes items, which a drag of items
 * reads (`itemDrop.ts`).
 */

/** An item's button id, for moving the focus to it. */
const itemPickId = (layerId: string, position: number): string =>
	`layer-item-${layerId}-${String(position)}`;

export const focusItem = (layerId: string, position: number) => {
	window.document.getElementById(itemPickId(layerId, position))?.focus();
};

export type LayerItemRowProps = Readonly<{
	document: EditorDocument;
	layerId: string;
	item: LayerItem;
	/** The layer's depth: the item is a level deeper. */
	depth: number;
	/** Whether the item is among the elements selected on the canvas. */
	selected: boolean;
	/** Whether its layer is held, locked or hidden, itself or by a group: muted, and out of reach. */
	held: boolean;
	/** Among the items being dragged: dimmed. */
	dragged: boolean;
	/** The line of a drop over the row or under it, at its depth. */
	drop: Readonly<{ at: 'before' | 'after'; depth: number; item?: boolean }> | undefined;
	onPick: (event: MouseEvent<HTMLButtonElement>) => void;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
	/** The item's menu, opened at this row. */
	onMenu: (at: MenuPoint) => void;
	/** A drag by the button and by the grip; none on a held layer. */
	pickDrag: PointerHandlers | undefined;
	gripDrag: PointerHandlers | undefined;
}>;

export const LayerItemRow = ({
	document,
	layerId,
	item,
	depth,
	selected,
	held,
	dragged,
	drop,
	onPick,
	onKeyDown,
	onMenu,
	pickDrag,
	gripDrag,
}: LayerItemRowProps) => {
	const pick = useRef<HTMLButtonElement>(null);
	return (
		<li
			className="layer-row layer-item"
			data-item-of={layerId}
			data-position={item.position}
			data-takes-items={flag(!held)}
			data-selected={flag(selected)}
			data-held={flag(held)}
			data-dragged={flag(dragged)}
			style={{ paddingInlineStart: `calc(${String(depth + 1)} * var(--space-l))` }}
			onContextMenu={(event) => {
				event.preventDefault();
				if (event.target instanceof Element && event.target.closest('.layer-grip') !== null)
					return;
				onMenu(rowMenuPoint(event, pick.current));
			}}
		>
			<span className="layer-item-slot" aria-hidden="true" />
			<button
				ref={pick}
				type="button"
				id={itemPickId(layerId, item.position)}
				className="layer-pick"
				aria-disabled={held ? 'true' : undefined}
				onClick={onPick}
				onKeyDown={onKeyDown}
				{...pickDrag}
			>
				<LayerPreview document={document} target={{ layerId, position: item.position }} />
				<span className="layer-name">{item.name}</span>
				{selected && (
					<>
						{' '}
						<span className="visually-hidden">{t('layers.selected')}</span>
					</>
				)}
			</button>
			{/* The keyboard moves an item with Alt and an arrow, so the grip is the pointer's alone. */}
			<span className="layer-grip" aria-hidden="true" {...gripDrag}>
				<GripIcon />
			</span>
			{drop !== undefined && <DropLine drop={drop} />}
		</li>
	);
};
