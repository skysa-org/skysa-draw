import { type KeyboardEvent, type MouseEvent, type PointerEvent, useEffect, useRef } from 'react';

import type { MenuPoint } from '../../components/ui/ContextMenu.js';
import { IconButton } from '../../components/ui/IconButton.js';
import {
	ChevronDownIcon,
	EyeIcon,
	EyeOffIcon,
	FolderIcon,
	GripIcon,
	GroupToggleIcon,
	ICONS,
	LockIcon,
	UnlockIcon,
	VectorIcon,
} from '../../components/ui/icons.js';
import { t } from '../../i18n/t.js';
import { setLayerHidden, setLayerLocked } from '../document/commands.js';
import type { EditorDocument, LayerInfo } from '../document/model.js';
import { layerDisplayName } from '../layerName.js';
import { LayerPreview } from './LayerPreview.js';
import { LayerNameField } from './LayerProperties.js';
import type { Row } from './LayerTree.js';

/**
 * A row of the layers panel (`LayersPanel`): a list item of three buttons —
 * the eye, the layer itself, the lock — and, where a pointer is coarse, a
 * grip to drag it by (docs/ARCHITECTURE.md §7, "The interface"). A layer
 * shows its preview where its kind would be (`LayerPreview`), a vector
 * layer's with a small mark of its kind in a corner, so it is told from a
 * raster layer's at a glance; a group shows its folder, as Photoshop's does.
 *
 * A group's folder is its disclosure: a button of its own where a layer's
 * preview is, the folder with a caret that turns; an empty group's folder has
 * no caret and is no button. A vector layer of two or more items is
 * expandable just as a group is, a row for each of its items under it
 * (`LayerItemRow`), and its preview is then its disclosure, with a caret over
 * its other corner that turns as the group's does; with one item or none it
 * is the layer itself, as seen, and its preview is in the layer's button. A
 * button cannot be inside the layer's own, so a disclosure sits before it, as
 * wide as a preview, its target the 44 px every control has, reaching over
 * the gaps beside it; the folder and the preview are one width, so every
 * row's name starts at the same place and no row moves over for a caret.
 *
 * A chosen row is tinted, and the active one, the one the tools act on, has
 * the accent's text as well, so among several chosen it is the one marked
 * twice. A screen reader is told the same in words: the active row is
 * `aria-current`, and while more than one is chosen each chosen row says
 * "Selected" after its name, as the clipped mark is said, since a button has
 * no selected state of its own and the row is not a listbox's option.
 *
 * A right-click on the row, a long press where the browser makes a menu of
 * one, or the Menu key on it opens the layer actions menu at it (`onMenu`);
 * the rename field keeps the browser's menu, for its text, and the grip none,
 * since a finger held on it is a drag about to begin.
 *
 * The row carries what a drop is read from (`layerDrop.ts`) on itself, its
 * id, depth, parent, whether it is a group and collapsed, and a collapsed
 * group's top layer, so the drag measures the rows as drawn.
 */

/** A row's button id, for moving the focus to it. */
const pickId = (layerId: string): string => `layer-pick-${layerId}`;

export const focusPick = (layerId: string | undefined) => {
	if (layerId !== undefined) window.document.getElementById(pickId(layerId))?.focus();
};

/**
 * A row's disclosure: none, for a layer whose preview is in its button; a
 * folder with nothing to show or hide, for an empty group; a group's, or a
 * vector layer's of two or more items, open or shut.
 */
export type Disclosure =
	| 'none'
	| 'empty'
	| Readonly<{
			expanded: boolean;
			/** With Alt, every group inside it too, as Photoshop's does; a vector layer's has nothing inside to do. */
			onToggle: (deep: boolean) => void;
			/** Shut, a group's top layer, which no row shows: what a drop into it goes above. */
			topLayer: string | undefined;
	  }>;

/** What a row shows of a drag: a line over it or under it, at a depth, or itself lit, for into it. */
export type RowDrop =
	Readonly<{ at: 'before' | 'after'; depth: number }> | Readonly<{ at: 'into' }>;

type PointerHandlers = Readonly<{
	onPointerDown: (event: PointerEvent<HTMLElement>) => void;
	onPointerMove: (event: PointerEvent<HTMLElement>) => void;
	onPointerUp: (event: PointerEvent<HTMLElement>) => void;
	onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
	onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
}>;

/**
 * Where a row's menu opens: at the pointer, or under the row's button for the
 * keyboard's Menu key, whose `contextmenu` has no point of its own. The
 * keyboard's is told by its `pointerType`, empty (Pointer Events 3), or, where
 * a browser still sends a plain `MouseEvent`, by its point being none.
 */
export const rowMenuPoint = (
	event: MouseEvent<HTMLElement>,
	button: HTMLElement | null
): MenuPoint => {
	const { pointerType } = event.nativeEvent as Partial<
		Pick<globalThis.PointerEvent, 'pointerType'>
	>;
	const keyboard =
		typeof pointerType === 'string'
			? pointerType === ''
			: event.clientX === 0 && event.clientY === 0;
	return keyboard
		? underButton(button ?? event.currentTarget)
		: { x: event.clientX, y: event.clientY };
};

/** Under a row's button, from its start: where the keyboard opens the row's menu. */
export const underButton = (button: Element): MenuPoint => {
	const box = button.getBoundingClientRect();
	const rtl = getComputedStyle(button).direction === 'rtl';
	return { x: rtl ? box.right : box.left, y: box.bottom };
};

/** A data attribute that is there or not, as the row's CSS reads it. */
export const flag = (on: boolean): '' | undefined => (on ? '' : undefined);

/** The marks' icons, small, on chips of the panel's own background, so they read over any picture. */
const MARK_PX = 12;

/** A vector layer's mark, over its preview's end corner. */
const VectorMark = () => (
	<span className="layer-preview-chip layer-preview-mark">
		<VectorIcon size={MARK_PX} />
	</span>
);

/**
 * An expandable vector layer's caret, over its preview's start corner: toward
 * the end of the line while its items are hidden, mirrored with the line
 * where it runs right to left, and down while they show, as a group's turns.
 */
const CaretMark = ({ open }: Readonly<{ open: boolean }>) => {
	const Caret = open ? ChevronDownIcon : ICONS.chevronRight;
	return (
		<span className="layer-preview-chip layer-preview-caret" data-open={flag(open)}>
			<Caret size={MARK_PX} />
		</span>
	);
};

/** A layer's preview with its marks: a vector layer's kind, and its caret where it is expandable. */
const RowPreview = ({
	document,
	layer,
	open,
}: Readonly<{ document: EditorDocument; layer: LayerInfo; open?: boolean }>) => (
	<LayerPreview document={document} target={{ layerId: layer.id }}>
		{open !== undefined && <CaretMark open={open} />}
		{layer.kind === 'vector' && <VectorMark />}
	</LayerPreview>
);

/** What a disclosure is called, open or shut: a group's, or a vector layer's for its items. */
const disclosureLabel = (kind: LayerInfo['kind'], expanded: boolean): string => {
	if (kind === 'group') return expanded ? t('layers.collapse') : t('layers.expand');
	return expanded ? t('layers.collapseItems') : t('layers.expandItems');
};

/**
 * A group's folder, which opens and shuts it, or an expandable vector layer's
 * preview, which shows and hides its items; an empty group's folder, which
 * has nothing to open, without its caret and not a button; nothing for a
 * layer whose preview is in its button.
 */
const DisclosureSlot = ({
	document,
	layer,
	disclosure,
}: Readonly<{ document: EditorDocument; layer: LayerInfo; disclosure: Disclosure }>) => {
	if (disclosure === 'none') return null;
	if (disclosure === 'empty') {
		return (
			<span className="layer-folder">
				<FolderIcon className="layer-kind-icon" />
			</span>
		);
	}
	return (
		<IconButton
			icon={
				layer.kind === 'group' ? (
					<GroupToggleIcon open={disclosure.expanded} className="layer-kind-icon" />
				) : (
					<RowPreview document={document} layer={layer} open={disclosure.expanded} />
				)
			}
			label={disclosureLabel(layer.kind, disclosure.expanded)}
			expanded={disclosure.expanded}
			className="layer-disclosure"
			// Alt does every group inside it too, as Photoshop's does.
			onClick={(event) => disclosure.onToggle(event.altKey)}
		/>
	);
};

/** A clipped layer's arrow, before its preview or its folder, as Photoshop draws it. */
const ClipMark = () => (
	<span className="layer-clip-mark" aria-hidden="true">
		↳
	</span>
);

/** A line where a drop would go, over a row or under it, drawn in from the left as deep as the place. */
export const DropLine = ({
	drop,
}: Readonly<{ drop: Readonly<{ at: 'before' | 'after'; depth: number }> }>) => (
	<span
		className="layer-drop-line"
		data-at={drop.at}
		aria-hidden="true"
		style={{ insetInlineStart: `calc(${drop.depth} * var(--space-l))` }}
	/>
);

/**
 * What the layer's own button holds: its clip mark and its preview, where
 * they are not before the button with a disclosure; its name; and what is
 * said of it.
 */
const PickContent = ({
	document,
	row,
	withPreview,
	saySelected,
}: Readonly<{
	document: EditorDocument;
	row: Row;
	withPreview: boolean;
	saySelected: boolean;
}>) => {
	const { layer, index } = row;
	const clipped = layer.clipped === true;
	return (
		<>
			{clipped && withPreview && <ClipMark />}
			{withPreview && <RowPreview document={document} layer={layer} />}
			<span className="layer-name">{layerDisplayName(layer, index)}</span>
			{clipped && <span className="visually-hidden">{t('layers.clipped')}</span>}
			{saySelected && (
				<>
					{' '}
					<span className="visually-hidden">{t('layers.selected')}</span>
				</>
			)}
		</>
	);
};

export const LayerRow = ({
	document,
	row,
	isActive,
	isChosen,
	sayChosen,
	renaming,
	dragged,
	drop,
	disclosure,
	onPick,
	onRename,
	onRenamed,
	onKeyDown,
	onMenu,
	pickDrag,
	gripDrag,
}: Readonly<{
	document: EditorDocument;
	row: Row;
	isActive: boolean;
	isChosen: boolean;
	/** Whether to say "Selected" after the name: while more than one layer is chosen. */
	sayChosen: boolean;
	renaming: boolean;
	/** Among the layers being dragged: dimmed. */
	dragged: boolean;
	drop: RowDrop | undefined;
	disclosure: Disclosure;
	onPick: (event: MouseEvent<HTMLButtonElement>) => void;
	onRename: () => void;
	onRenamed: () => void;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
	/** The layer actions menu, opened at this row. */
	onMenu: (at: MenuPoint) => void;
	pickDrag: PointerHandlers;
	gripDrag: PointerHandlers;
}>) => {
	const { layer, index } = row;
	const shut =
		layer.kind === 'group' && typeof disclosure === 'object' && !disclosure.expanded
			? disclosure
			: undefined;
	// The preview is in the layer's button unless it is the layer's disclosure; a group has its folder.
	const withPreview = layer.kind !== 'group' && disclosure === 'none';
	const pick = useRef<HTMLButtonElement>(null);
	const wasRenaming = useRef(false);
	// Back to the row once the name is in, where the field took the focus
	// away with it; a rename ended by a press elsewhere leaves the focus there.
	useEffect(() => {
		const ended = wasRenaming.current && !renaming;
		wasRenaming.current = renaming;
		if (ended && window.document.activeElement === window.document.body) pick.current?.focus();
	}, [renaming]);
	return (
		<li
			className="layer-row"
			data-layer-id={layer.id}
			data-depth={layer.depth}
			data-parent-id={layer.parentId}
			data-group={flag(layer.kind === 'group')}
			data-collapsed={flag(shut !== undefined)}
			data-top-layer={shut?.topLayer}
			data-active={flag(isActive)}
			data-selected={flag(isChosen)}
			data-hidden={flag(layer.hidden)}
			data-dragged={flag(dragged)}
			data-drop={drop?.at === 'into' ? 'into' : undefined}
			style={{ paddingInlineStart: `calc(${layer.depth} * var(--space-l))` }}
			onContextMenu={(event) => {
				if (renaming) return;
				event.preventDefault();
				if (event.target instanceof Element && event.target.closest('.layer-grip') !== null)
					return;
				onMenu(rowMenuPoint(event, pick.current));
			}}
		>
			<IconButton
				icon={layer.hidden ? <EyeOffIcon /> : <EyeIcon />}
				label={layer.hidden ? t('layers.show') : t('layers.hide')}
				onClick={() => document.execute(setLayerHidden(layer.id, !layer.hidden))}
			/>
			{layer.clipped === true && !withPreview && <ClipMark />}
			<DisclosureSlot document={document} layer={layer} disclosure={disclosure} />
			{renaming ? (
				<LayerNameField
					document={document}
					layer={layer}
					indexFromBottom={index}
					takeFocus
					onDone={onRenamed}
				/>
			) : (
				<button
					ref={pick}
					type="button"
					id={pickId(layer.id)}
					className="layer-pick"
					aria-current={isActive ? 'true' : undefined}
					onClick={onPick}
					onDoubleClick={onRename}
					onKeyDown={onKeyDown}
					{...pickDrag}
				>
					<PickContent
						document={document}
						row={row}
						withPreview={withPreview}
						saySelected={sayChosen && isChosen}
					/>
				</button>
			)}
			<IconButton
				icon={layer.locked ? <LockIcon /> : <UnlockIcon />}
				label={layer.locked ? t('layers.unlock') : t('layers.lock')}
				onClick={() => document.execute(setLayerLocked(layer.id, !layer.locked))}
			/>
			{/* The keyboard moves a layer with Alt and an arrow, so the grip is the pointer's alone. */}
			<span className="layer-grip" aria-hidden="true" {...gripDrag}>
				<GripIcon />
			</span>
			{drop !== undefined && drop.at !== 'into' && <DropLine drop={drop} />}
		</li>
	);
};
