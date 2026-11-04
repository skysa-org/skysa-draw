import { MoreIcon } from '../../components/ui/icons.js';
import { Menu, type MenuItem } from '../../components/ui/Menu.js';
import { t } from '../../i18n/t.js';
import { clipStateOf, clipToBelow, layerBelow, releaseClip } from '../document/clip.js';
import { groupLayer, ungroupLayer, ungroupProblem } from '../document/groups.js';
import { layerById } from '../document/layers.js';
import {
	type LayerJob,
	mergeDown,
	mergeProblem,
	rasterizeLayer,
	rasterizeProblem,
} from '../document/merge.js';
import type { DocumentSnapshot, EditorDocument, LayerInfo } from '../document/model.js';

/**
 * What else can be done to the active layer (docs/ARCHITECTURE.md §3,
 * "Layers"; docs/decisions/0003-layers.md), in a menu at the layers panel's
 * head: put it in a group, undo a group, merge it with the layer below, make
 * it pixels, clip it to the layer below. An item that cannot apply to this
 * layer at all is there and disabled; one that could but will not, a merge of
 * a hidden layer, says why when it is chosen.
 */

/** What a merge or a rasterize that did nothing tells the user. */
const JOB_NOTICES: Readonly<Record<LayerJob, (() => string) | undefined>> = {
	done: undefined,
	nothing: undefined,
	unrenderable: () => t('layers.renderFailed'),
	changed: () => t('layers.renderChanged'),
};

export const LayerMenu = ({
	document,
	snapshot,
	active,
	onActivate,
	onNotify,
}: Readonly<{
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	active: LayerInfo | undefined;
	onActivate: (id: string) => void;
	onNotify: (message: string) => void;
}>) => {
	const root = document.root;
	const id = active?.id;
	const element = id === undefined ? undefined : layerById(root, id);
	const tell = (job: LayerJob) => {
		const notice = JOB_NOTICES[job]?.();
		if (notice !== undefined) onNotify(notice);
	};

	const group = () => {
		if (id === undefined) return;
		const made = groupLayer(root, id);
		document.execute(made);
		onActivate(made.id);
	};

	const ungroup = () => {
		if (id === undefined) return;
		if (ungroupProblem(root, id) === 'styled') {
			onNotify(t('layers.ungroupStyled'));
			return;
		}
		// The group's top layer is the one active after it, as it was at the top of the group.
		const top = snapshot.layers.filter((layer) => layer.parentId === id).at(-1);
		document.execute(ungroupLayer(root, id));
		if (top !== undefined) onActivate(top.id);
	};

	const merge = () => {
		if (id === undefined) return;
		const problem = mergeProblem(root, id);
		if (problem === 'hidden') onNotify(t('layers.mergeHidden'));
		if (problem === 'locked') onNotify(t('layers.mergeLocked'));
		if (problem !== undefined) return;
		const below = layerBelow(root, id)?.getAttribute('id') ?? undefined;
		void mergeDown(document, id).then((job) => {
			if (job === 'done' && below !== undefined) onActivate(below);
			tell(job);
		});
	};

	const rasterize = () => {
		if (id === undefined) return;
		if (rasterizeProblem(root, id) === 'locked') {
			onNotify(t('layers.rasterizeLocked'));
			return;
		}
		void rasterizeLayer(document, id).then(tell);
	};

	const clip = () => {
		if (id === undefined || element === undefined) return;
		const state = clipStateOf(root, element);
		if (state === 'foreign') {
			onNotify(t('layers.clipForeign'));
			return;
		}
		document.execute(state === 'clipped' ? releaseClip(root, id) : clipToBelow(root, id));
	};

	const clipped = active?.clipped === true;
	const hasBelow = id !== undefined && layerBelow(root, id) !== undefined;
	const items: readonly MenuItem[] = [
		{ id: 'group', label: t('layers.group'), disabled: id === undefined, onSelect: group },
		{
			id: 'ungroup',
			label: t('layers.ungroup'),
			disabled: active?.kind !== 'group',
			onSelect: ungroup,
		},
		{
			id: 'merge',
			label: t('layers.mergeDown'),
			disabled: id === undefined || mergeProblem(root, id) === 'bottom',
			onSelect: merge,
		},
		{
			id: 'rasterize',
			label: t('layers.rasterize'),
			disabled: id === undefined || rasterizeProblem(root, id) === 'raster',
			onSelect: rasterize,
		},
		{
			id: 'clip',
			label: clipped ? t('layers.unclip') : t('layers.clip'),
			disabled: !clipped && !hasBelow,
			onSelect: clip,
		},
	];
	return <Menu label={t('layers.actions')} icon={<MoreIcon />} items={items} align="end" />;
};
