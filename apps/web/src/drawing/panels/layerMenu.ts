import type { Apply } from '../../components/ui/Applying.js';
import type { MenuItem } from '../../components/ui/Menu.js';
import { t } from '../../i18n/t.js';
import { canStepLayers, groupLayers, outermostLayers, stepLayers } from '../document/arrange.js';
import { clipStateOf, clipToBelow, layerBelow, releaseClip } from '../document/clip.js';
import { compound } from '../document/commands.js';
import { ungroupLayer, ungroupProblem } from '../document/groups.js';
import { layerById } from '../document/layers.js';
import {
	type LayerJob,
	mergeDown,
	mergeProblem,
	rasterizeLayer,
	rasterizeProblem,
} from '../document/merge.js';
import type { DocumentSnapshot, EditorDocument, LayerInfo } from '../document/model.js';
import type { LayerSelection } from '../layerSelection.js';

/**
 * What else can be done to the layers chosen (docs/ARCHITECTURE.md §3,
 * "Layers"; docs/decisions/0003-layers.md): the layer actions menu, at the
 * layers panel's head and on a right-click on a row. Put them in a group
 * together, undo every group among them; move them a step up or down among
 * their siblings, the way to reorder them without a drag; and, to the active
 * layer alone, merge it with the layer below, make it pixels, clip it to the
 * layer below, which are not offered while more than one layer is chosen,
 * since each acts on one layer and the one below it.
 *
 * Only what applies to the layers chosen is listed; what does not is left
 * out, not shown disabled (docs/decisions/0004-the-interface.md, "The layers
 * panel's menu"). One that applies but will not be done, a merge of a hidden
 * layer, is listed, and says why when it is chosen.
 *
 * A merge draws two layers into one picture the size of the canvas and
 * reads it back, which holds the page a while where one is a large raster
 * layer, and is done under the frame's indicator, which shows once it takes
 * a while (`components/ui/Applying.tsx`). A rasterize draws one, which took
 * a frame or two even across the whole canvas, and the rest change a few
 * attributes or move a few elements: those are done plainly.
 */

/** What a merge or a rasterize that did nothing tells the user. */
const JOB_NOTICES: Readonly<Record<LayerJob, (() => string) | undefined>> = {
	done: undefined,
	nothing: undefined,
	unrenderable: () => t('layers.renderFailed'),
	changed: () => t('layers.renderChanged'),
};

export type LayerMenuContext = Readonly<{
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	active: LayerInfo | undefined;
	/** The layers chosen, top first, the active one among them. */
	chosen: readonly string[];
	/** Every layer's id as the rows would show them with no group collapsed, top first. */
	order: readonly string[];
	onActivate: (id: string) => void;
	onSelectLayers: (selection: LayerSelection) => void;
	/** A group just made, shown expanded, so what went into it is seen. */
	onShowGroups: (ids: readonly string[]) => void;
	onNotify: (message: string) => void;
	/** The frame's indicator, for a merge (`useApply`). */
	apply: Apply;
}>;

/** An item, where it applies; none where it does not. */
const where = (applies: boolean, item: MenuItem): readonly MenuItem[] => (applies ? [item] : []);

/** The sections of the menu, each after a rule, those with nothing in them left out. */
const sectioned = (sections: readonly (readonly MenuItem[])[]): readonly MenuItem[] =>
	sections.flatMap((section) =>
		section.map((item, at) => (at === 0 ? { ...item, separatorBefore: true } : item))
	);

export const layerMenuItems = ({
	document,
	snapshot,
	active,
	chosen,
	order,
	onActivate,
	onSelectLayers,
	onShowGroups,
	onNotify,
	apply,
}: LayerMenuContext): readonly MenuItem[] => {
	const root = document.root;
	const id = active?.id;
	const element = id === undefined ? undefined : layerById(root, id);
	const several = chosen.length > 1;
	const tell = (job: LayerJob) => {
		const notice = JOB_NOTICES[job]?.();
		if (notice !== undefined) onNotify(notice);
	};

	const group = () => {
		if (chosen.length === 0) return;
		const made = groupLayers(root, chosen);
		document.execute(made);
		onShowGroups([made.id]);
		onActivate(made.id);
	};

	// The groups among the chosen, a group inside another chosen one going
	// with it rather than coming apart on its own.
	const groups = outermostLayers(root, chosen).filter(
		(each) => snapshot.layers.find((layer) => layer.id === each)?.kind === 'group'
	);

	const ungroup = () => {
		const styled = groups.filter((each) => ungroupProblem(root, each) === 'styled');
		const freeing = groups.filter((each) => !styled.includes(each));
		if (styled.length > 0) {
			onNotify(
				groups.length === 1
					? t('layers.ungroupStyled')
					: t('layers.ungroupStyledSome', { count: styled.length })
			);
		}
		if (freeing.length === 0) return;
		// What the groups held is chosen after, the topmost of it active, as it
		// was at the top of its group.
		const freed = order.filter((each) =>
			snapshot.layers.some(
				(layer) => layer.id === each && freeing.includes(layer.parentId ?? '')
			)
		);
		document.execute(
			compound(
				'layers.ungroup',
				freeing.map((each) => ungroupLayer(root, each))
			)
		);
		const top = freed[0];
		if (top !== undefined) onSelectLayers({ active: top, selected: freed, anchor: top });
	};

	const merge = () => {
		if (id === undefined) return;
		const problem = mergeProblem(root, id);
		if (problem === 'hidden') onNotify(t('layers.mergeHidden'));
		if (problem === 'locked') onNotify(t('layers.mergeLocked'));
		if (problem !== undefined) return;
		const below = layerBelow(root, id)?.getAttribute('id') ?? undefined;
		void apply(() => mergeDown(document, id), t('layers.merging')).then((job) => {
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
	return sectioned([
		[
			...where(chosen.length > 0, { id: 'group', label: t('layers.group'), onSelect: group }),
			...where(groups.length > 0, {
				id: 'ungroup',
				label: t('layers.ungroup'),
				onSelect: ungroup,
			}),
		],
		[
			...where(canStepLayers(root, chosen, 'up'), {
				id: 'up',
				label: t('layers.moveUp'),
				onSelect: () => document.execute(stepLayers(root, chosen, 'up')),
			}),
			...where(canStepLayers(root, chosen, 'down'), {
				id: 'down',
				label: t('layers.moveDown'),
				onSelect: () => document.execute(stepLayers(root, chosen, 'down')),
			}),
		],
		[
			...where(!several && id !== undefined && mergeProblem(root, id) !== 'bottom', {
				id: 'merge',
				label: t('layers.mergeDown'),
				onSelect: merge,
			}),
			...where(!several && id !== undefined && rasterizeProblem(root, id) !== 'raster', {
				id: 'rasterize',
				label: t('layers.rasterize'),
				onSelect: rasterize,
			}),
			...where(!several && (clipped || hasBelow), {
				id: 'clip',
				label: clipped ? t('layers.unclip') : t('layers.clip'),
				onSelect: clip,
			}),
		],
	]);
};
