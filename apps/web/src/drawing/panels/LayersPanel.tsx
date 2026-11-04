import type { LayerKind } from '@skysa/draw-core';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { IconButton } from '../../components/ui/IconButton.js';
import {
	AddIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	DeleteIcon,
	DuplicateIcon,
	EyeIcon,
	EyeOffIcon,
	GroupIcon,
	LockIcon,
	RasterIcon,
	UnlockIcon,
	VectorIcon,
} from '../../components/ui/icons.js';
import { Panel } from '../../components/ui/Panel.js';
import { t } from '../../i18n/t.js';
import {
	addLayer,
	duplicateLayer,
	moveLayer,
	removeLayer,
	setLayerHidden,
	setLayerLocked,
} from '../document/commands.js';
import type { DocumentSnapshot, EditorDocument, LayerInfo } from '../document/model.js';
import { layerDisplayName } from '../layerName.js';
import { LayerMenu } from './LayerMenu.js';
import { LayerNameField, LayerProperties } from './LayerProperties.js';

/**
 * The layers panel (docs/ARCHITECTURE.md §3, "Layers"; §7, "The interface"):
 * the layers top first, as every layers panel shows them, each with its eye
 * and its lock, a group's layers under it and a clipped layer marked, and the
 * actions on the active one, the rarer of them in a menu (`LayerMenu`).
 * Every change is a command
 * on the document, so it is undone the same way as a stroke; the panel reads
 * the snapshot the frame gives it and re-renders through it.
 *
 * A row is a list item of three buttons — the eye, the layer itself, the lock
 * — rather than a listbox's option, whose content a screen reader is not
 * told of: the eye and the lock would be lost in it.
 */

const KIND_ICON = { vector: VectorIcon, raster: RasterIcon, group: GroupIcon } as const;

type Row = Readonly<{
	layer: LayerInfo;
	/** Its place in document order, from the bottom: what an unnamed layer from elsewhere is called by. */
	index: number;
}>;

/**
 * The rows top first: the layers under `parentId` in reverse document order,
 * each group followed by what it holds, so a group sits above its layers as a
 * folder does.
 */
const rowsUnder = (layers: readonly LayerInfo[], parentId: string | undefined): readonly Row[] =>
	[...layers.map((layer, index) => ({ layer, index }))]
		.filter(({ layer }) => layer.parentId === parentId)
		.reverse()
		.flatMap((row) => [row, ...rowsUnder(layers, row.layer.id)]);

/** A row's button id, for moving the focus to a neighbor. */
const pickId = (layerId: string): string => `layer-pick-${layerId}`;

const focusPick = (layerId: string) => {
	window.document.getElementById(pickId(layerId))?.focus();
};

/** The arrow keys walk the rows as they are shown: down the list is down the drawing. */
const ROW_STEPS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 };

const LayerActions = ({
	document,
	snapshot,
	active,
	canMoveUp,
	canMoveDown,
	onActivate,
	onNotify,
}: Readonly<{
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	active: LayerInfo | undefined;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onActivate: (id: string) => void;
	onNotify: (message: string) => void;
}>) => {
	const add = (kind: LayerKind) => {
		const made = addLayer(document.root, kind, { above: active?.id });
		document.execute(made);
		onActivate(made.id);
	};
	const duplicate = () => {
		if (active === undefined) return;
		const made = duplicateLayer(document.root, active.id);
		document.execute(made);
		onActivate(made.id);
	};
	const move = (direction: 'up' | 'down') => {
		if (active !== undefined) document.execute(moveLayer(active.id, direction));
	};
	return (
		<>
			<IconButton icon={<AddIcon />} label={t('layers.add')} onClick={() => add('vector')} />
			<IconButton
				icon={<RasterIcon />}
				label={t('layers.addRaster')}
				onClick={() => add('raster')}
			/>
			<IconButton
				icon={<DuplicateIcon />}
				label={t('layers.duplicate')}
				disabled={active === undefined}
				onClick={duplicate}
			/>
			<IconButton
				icon={<ChevronUpIcon />}
				label={t('layers.moveUp')}
				disabled={!canMoveUp}
				onClick={() => move('up')}
			/>
			<IconButton
				icon={<ChevronDownIcon />}
				label={t('layers.moveDown')}
				disabled={!canMoveDown}
				onClick={() => move('down')}
			/>
			<IconButton
				icon={<DeleteIcon />}
				label={t('layers.delete')}
				disabled={active === undefined}
				onClick={() => {
					if (active !== undefined) document.execute(removeLayer(active.id));
				}}
			/>
			<LayerMenu
				document={document}
				snapshot={snapshot}
				active={active}
				onActivate={onActivate}
				onNotify={onNotify}
			/>
		</>
	);
};

const LayerRow = ({
	document,
	row,
	isActive,
	renaming,
	onActivate,
	onRename,
	onRenamed,
	onKeyDown,
}: Readonly<{
	document: EditorDocument;
	row: Row;
	isActive: boolean;
	renaming: boolean;
	onActivate: () => void;
	onRename: () => void;
	onRenamed: () => void;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}>) => {
	const { layer, index } = row;
	const KindIcon = KIND_ICON[layer.kind];
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
			data-active={isActive ? '' : undefined}
			data-hidden={layer.hidden ? '' : undefined}
			style={{ paddingInlineStart: `calc(${layer.depth} * var(--space-l))` }}
		>
			<IconButton
				icon={layer.hidden ? <EyeOffIcon /> : <EyeIcon />}
				label={layer.hidden ? t('layers.show') : t('layers.hide')}
				onClick={() => document.execute(setLayerHidden(layer.id, !layer.hidden))}
			/>
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
					onClick={onActivate}
					onDoubleClick={onRename}
					onKeyDown={onKeyDown}
				>
					{layer.clipped === true && (
						<span className="layer-clip-mark" aria-hidden="true">
							↳
						</span>
					)}
					<KindIcon className="layer-kind-icon" />
					<span className="layer-name">{layerDisplayName(layer, index)}</span>
					{layer.clipped === true && (
						<span className="visually-hidden">{t('layers.clipped')}</span>
					)}
				</button>
			)}
			<IconButton
				icon={layer.locked ? <LockIcon /> : <UnlockIcon />}
				label={layer.locked ? t('layers.unlock') : t('layers.lock')}
				onClick={() => document.execute(setLayerLocked(layer.id, !layer.locked))}
			/>
		</li>
	);
};

export const LayersPanel = ({
	document,
	snapshot,
	activeLayerId,
	onActivate,
	withProperties,
	onClose,
	onNotify = () => undefined,
}: Readonly<{
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	activeLayerId: string | undefined;
	onActivate: (id: string) => void;
	/** The active layer's properties under the list: in the sheet and the drawer, where there is no properties panel. */
	withProperties: boolean;
	onClose?: () => void;
	/** A line to the user, already in their words: why a merge or a clip did nothing. */
	onNotify?: (message: string) => void;
}>) => {
	const [renaming, setRenaming] = useState<string | undefined>(undefined);
	const layers = snapshot.layers;
	const activeIndex = layers.findIndex((layer) => layer.id === activeLayerId);
	const active = layers[activeIndex];
	// Up and down are among the layer's siblings: a layer does not leave its
	// group by being moved.
	const siblings = layers.filter((layer) => layer.parentId === active?.parentId);
	const place = active === undefined ? -1 : siblings.indexOf(active);
	const rows = rowsUnder(layers, undefined);

	/** The keys of a list of layers, on the row that has the focus. */
	const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
		const row = rows[at];
		if (row === undefined) return;
		const step = ROW_STEPS[event.key];
		const neighbor = step === undefined ? undefined : rows[at + step];
		if (neighbor !== undefined) {
			event.preventDefault();
			onActivate(neighbor.layer.id);
			focusPick(neighbor.layer.id);
			return;
		}
		if (event.key === 'F2') {
			event.preventDefault();
			setRenaming(row.layer.id);
			return;
		}
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			document.execute(removeLayer(row.layer.id));
		}
	};

	return (
		<Panel
			title={t('layers.title')}
			actions={
				<LayerActions
					document={document}
					snapshot={snapshot}
					active={active}
					canMoveUp={active !== undefined && place < siblings.length - 1}
					canMoveDown={active !== undefined && place > 0}
					onActivate={onActivate}
					onNotify={onNotify}
				/>
			}
			onClose={onClose}
			className="layers-panel"
		>
			<ul className="layer-list" aria-label={t('layers.title')}>
				{rows.map((row, at) => (
					<LayerRow
						key={row.layer.id}
						document={document}
						row={row}
						isActive={row.layer.id === activeLayerId}
						renaming={renaming === row.layer.id}
						onActivate={() => onActivate(row.layer.id)}
						onRename={() => setRenaming(row.layer.id)}
						onRenamed={() => setRenaming(undefined)}
						onKeyDown={(event) => onRowKeyDown(event, at)}
					/>
				))}
			</ul>
			{withProperties && active !== undefined && (
				<LayerProperties document={document} layer={active} indexFromBottom={activeIndex} />
			)}
		</Panel>
	);
};
