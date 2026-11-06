import { type KeyboardEvent, type MouseEvent, useRef } from 'react';

import type { MenuPoint } from '../../components/ui/ContextMenu.js';
import { t } from '../../i18n/t.js';
import type { EditorDocument } from '../document/model.js';
import type { LayerItem } from './layerItems.js';
import { LayerPreview } from './LayerPreview.js';
import { DropLine, flag, rowMenuPoint } from './LayerRow.js';

/**
 * A row of an expanded vector layer's in the layers panel, one per item, under
 * the layer's own (docs/ARCHITECTURE.md §7, "The interface"), as Illustrator
 * lists a layer's objects: a level deeper than the layer, an empty place
 * where a layer's eye is, so the items' previews line up in a column of their
 * own, the item's preview (`LayerPreview`, by its position among the layer's
 * elements) and its name (`layerItems.ts`), in one button.
 *
 * A press on it selects the item on the canvas, as a click on it there would
 * (`LayersPanel`); it is tinted while the item is selected, whatever selected
 * it, and says "Selected" after its name to a screen reader, as a chosen
 * layer's row does. It is not dragged and takes no drop: a drop over it is
 * under its layer (`layerDrop.ts`), and the line that shows that is drawn
 * under the last of the layer's items, which is where the gap is. A
 * right-click on it, a long press the browser makes a menu of, or the Menu
 * key opens its layer's actions menu (`onMenu`), as the layer's row does.
 *
 * It carries its layer's id, as `data-item-of`, so the drag reads it as part
 * of its layer's row, and the panel the focus on it as on its layer's.
 */

/** An item's button id, for moving the focus to it. */
const itemPickId = (layerId: string, position: number): string =>
	`layer-item-${layerId}-${String(position)}`;

export const focusItem = (layerId: string, position: number) => {
	window.document.getElementById(itemPickId(layerId, position))?.focus();
};

export const LayerItemRow = ({
	document,
	layerId,
	item,
	depth,
	selected,
	hidden,
	dropAfter,
	onPick,
	onKeyDown,
	onMenu,
}: Readonly<{
	document: EditorDocument;
	layerId: string;
	item: LayerItem;
	/** The layer's depth: the item is a level deeper. */
	depth: number;
	/** Whether the item is among the elements selected on the canvas. */
	selected: boolean;
	/** Whether its layer is hidden: its name is muted, as the layer's is. */
	hidden: boolean;
	/** The line of a drop under the last row, at its depth, where this is the last row. */
	dropAfter: number | undefined;
	onPick: (event: MouseEvent<HTMLButtonElement>) => void;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
	/** The layer's actions menu, opened at this row. */
	onMenu: (at: MenuPoint) => void;
}>) => {
	const pick = useRef<HTMLButtonElement>(null);
	return (
		<li
			className="layer-row layer-item"
			data-item-of={layerId}
			data-selected={flag(selected)}
			data-hidden={flag(hidden)}
			style={{ paddingInlineStart: `calc(${String(depth + 1)} * var(--space-l))` }}
			onContextMenu={(event) => {
				event.preventDefault();
				onMenu(rowMenuPoint(event, pick.current));
			}}
		>
			<span className="layer-item-slot" aria-hidden="true" />
			<button
				ref={pick}
				type="button"
				id={itemPickId(layerId, item.position)}
				className="layer-pick"
				onClick={onPick}
				onKeyDown={onKeyDown}
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
			{dropAfter !== undefined && <DropLine drop={{ at: 'after', depth: dropAfter }} />}
		</li>
	);
};
