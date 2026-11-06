import type { LayerKind } from '@skysa/draw-core';

import { IconButton } from '../../components/ui/IconButton.js';
import {
	AddIcon,
	DeleteIcon,
	DuplicateIcon,
	FolderIcon,
	RasterIcon,
	VectorIcon,
} from '../../components/ui/icons.js';
import { Menu } from '../../components/ui/Menu.js';
import { t } from '../../i18n/t.js';
import { duplicateLayers, outermostLayers, removeLayers } from '../document/arrange.js';
import { addLayer } from '../document/commands.js';
import type { DocumentSnapshot, EditorDocument, LayerInfo } from '../document/model.js';
import type { LayerSelection } from '../layerSelection.js';
import { LayerMenu } from './LayerMenu.js';

/**
 * The layers panel's head (`LayersPanel`; docs/ARCHITECTURE.md §7, "The
 * interface"): New, a menu of a vector layer, a raster layer and a group,
 * each made above the active layer, as Photoshop's Layer › New is; and the
 * actions on the layers chosen, together, each one command: duplicate,
 * delete, and the rarer ones in `LayerMenu`. Dragging a row is how a layer
 * moves, and Move up and Move down are in `LayerMenu` for whoever does not drag.
 */
export const LayerActions = ({
	document,
	snapshot,
	active,
	chosen,
	order,
	onActivate,
	onSelectLayers,
	onShowGroups,
	onNotify,
}: Readonly<{
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	active: LayerInfo | undefined;
	/** The layers chosen, top first, the active one among them. */
	chosen: readonly string[];
	/** Every layer's id as the rows would show them with no group collapsed, top first. */
	order: readonly string[];
	onActivate: (id: string) => void;
	onSelectLayers: (selection: LayerSelection) => void;
	/** Groups just made, shown expanded, so what went into them is seen. */
	onShowGroups: (ids: readonly string[]) => void;
	onNotify: (message: string) => void;
}>) => {
	const root = document.root;
	const count = Math.max(1, chosen.length);
	const add = (kind: LayerKind) => {
		const made = addLayer(root, kind, { above: active?.id });
		document.execute(made);
		onActivate(made.id);
	};
	// The copies are chosen after, as the originals were: the copy of the
	// active one active, or the topmost copy where that one was inside a group
	// copied whole.
	const duplicate = () => {
		if (chosen.length === 0) return;
		const originals = outermostLayers(root, chosen);
		const made = duplicateLayers(root, chosen);
		document.execute(made);
		onShowGroups(made.ids);
		const copy = made.ids[originals.indexOf(active?.id ?? '')] ?? made.ids.at(-1);
		if (copy === undefined) return;
		// The copies lie apart, none inside another, so top first is paint order turned round.
		onSelectLayers({ active: copy, selected: [...made.ids].reverse(), anchor: copy });
	};
	return (
		<>
			<Menu
				label={t('layers.new')}
				icon={<AddIcon />}
				items={[
					{
						id: 'vector',
						label: t('layers.newVector'),
						icon: <VectorIcon />,
						onSelect: () => add('vector'),
					},
					{
						id: 'raster',
						label: t('layers.newRaster'),
						icon: <RasterIcon />,
						onSelect: () => add('raster'),
					},
					{
						id: 'group',
						label: t('layers.newGroup'),
						icon: <FolderIcon />,
						onSelect: () => add('group'),
					},
				]}
			/>
			<IconButton
				icon={<DuplicateIcon />}
				label={t('layers.duplicateChosen', { count })}
				disabled={chosen.length === 0}
				onClick={duplicate}
			/>
			<IconButton
				icon={<DeleteIcon />}
				label={t('layers.deleteChosen', { count })}
				disabled={chosen.length === 0}
				onClick={() => document.execute(removeLayers(root, chosen))}
			/>
			<LayerMenu
				document={document}
				snapshot={snapshot}
				active={active}
				chosen={chosen}
				order={order}
				onActivate={onActivate}
				onSelectLayers={onSelectLayers}
				onShowGroups={onShowGroups}
				onNotify={onNotify}
			/>
		</>
	);
};
