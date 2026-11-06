import { type KeyboardEvent, type MouseEvent, type PointerEvent, useEffect, useRef } from 'react';

import type { MenuPoint } from '../../components/ui/ContextMenu.js';
import { IconButton } from '../../components/ui/IconButton.js';
import {
	EyeIcon,
	EyeOffIcon,
	FolderIcon,
	GripIcon,
	GroupToggleIcon,
	LockIcon,
	RasterIcon,
	UnlockIcon,
	VectorIcon,
} from '../../components/ui/icons.js';
import { t } from '../../i18n/t.js';
import { setLayerHidden, setLayerLocked } from '../document/commands.js';
import type { EditorDocument } from '../document/model.js';
import { layerDisplayName } from '../layerName.js';
import { LayerNameField } from './LayerProperties.js';
import type { Row } from './LayerTree.js';

/**
 * A row of the layers panel (`LayersPanel`): a list item of three buttons —
 * the eye, the layer itself, the lock — and, where a pointer is coarse, a
 * grip to drag it by (docs/ARCHITECTURE.md §7, "The interface"). A group's
 * folder is its disclosure: a button of its own where a layer's kind is, the
 * folder with a caret that turns, so a group's name lines up with a layer's
 * and no row moves over for it; an empty group's folder has no caret and is
 * no button. A button cannot be inside the layer's own,
 * so it sits before it, as wide as the kind's icon, its target the 44 px
 * every control has, reaching over the gaps beside it.
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

const KIND_ICON = { vector: VectorIcon, raster: RasterIcon } as const;

/** A row's button id, for moving the focus to it. */
const pickId = (layerId: string): string => `layer-pick-${layerId}`;

export const focusPick = (layerId: string | undefined) => {
	if (layerId !== undefined) window.document.getElementById(pickId(layerId))?.focus();
};

/** A row's disclosure: none, for a layer; a folder with nothing to show or hide, for an empty group; a group's, open or shut. */
export type Disclosure =
	| 'none'
	| 'empty'
	| Readonly<{
			expanded: boolean;
			/** With Alt, every group inside it too, as Photoshop's does. */
			onToggle: (deep: boolean) => void;
			/** Shut, the group's top layer, which no row shows: what a drop into it goes above. */
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
const rowMenuPoint = (event: MouseEvent<HTMLElement>, button: HTMLElement | null): MenuPoint => {
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
const flag = (on: boolean): '' | undefined => (on ? '' : undefined);

/**
 * A group's folder, which opens and shuts it; an empty group's, which has
 * nothing to open, without its caret and not a button; nothing for a layer,
 * whose kind is in its button.
 */
const DisclosureSlot = ({ disclosure }: Readonly<{ disclosure: Disclosure }>) => {
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
			icon={<GroupToggleIcon open={disclosure.expanded} className="layer-kind-icon" />}
			label={disclosure.expanded ? t('layers.collapse') : t('layers.expand')}
			expanded={disclosure.expanded}
			className="layer-disclosure"
			// Alt does every group inside it too, as Photoshop's does.
			onClick={(event) => disclosure.onToggle(event.altKey)}
		/>
	);
};

/** A clipped layer's arrow, before its kind, as Photoshop draws it. */
const ClipMark = () => (
	<span className="layer-clip-mark" aria-hidden="true">
		↳
	</span>
);

/**
 * What the layer's own button holds: its clip mark and its kind, a layer's,
 * since a group's are before the button with its folder; its name; and what
 * is said of it.
 */
const PickContent = ({ row, saySelected }: Readonly<{ row: Row; saySelected: boolean }>) => {
	const { layer, index } = row;
	const clipped = layer.clipped === true;
	const KindIcon = layer.kind === 'group' ? undefined : KIND_ICON[layer.kind];
	return (
		<>
			{clipped && KindIcon !== undefined && <ClipMark />}
			{KindIcon !== undefined && <KindIcon className="layer-kind-icon" />}
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
	const shut = typeof disclosure === 'object' && !disclosure.expanded ? disclosure : undefined;
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
			{layer.kind === 'group' && layer.clipped === true && <ClipMark />}
			<DisclosureSlot disclosure={disclosure} />
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
					<PickContent row={row} saySelected={sayChosen && isChosen} />
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
			{drop !== undefined && drop.at !== 'into' && (
				<span
					className="layer-drop-line"
					data-at={drop.at}
					aria-hidden="true"
					style={{ insetInlineStart: `calc(${drop.depth} * var(--space-l))` }}
				/>
			)}
		</li>
	);
};
