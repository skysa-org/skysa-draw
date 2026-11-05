import { t } from '../../i18n/t.js';
import { addLayer, duplicateLayer } from '../document/commands.js';
import { type CanvasBox, canvasBoxOf, cropCanvas } from '../document/crop.js';
import type { LayerVia } from '../document/layerVia.js';
import type { EditorDocument, LayerInfo } from '../document/model.js';
import { type SelectionActionId, selectionModeOf } from '../selectionActions.js';
import { areaPolygons, rectPath } from '../tools/raster/area.js';
import { canFillArea, fillAreaWith, type FillSpec } from '../tools/raster/areaFill.js';
import type { AreaModify } from '../tools/raster/areaOps.js';
import { clearArea, fillArea, layerViaArea } from '../tools/raster/index.js';
import type { ToolContext, ToolId } from '../tools/types.js';
import type { Point } from '../tools/vector/geometry.js';
import { deleteSelection } from '../tools/vector/index.js';
import {
	hideSelection,
	layerViaSelection,
	selectedBox,
	selectEveryElement,
	selectOtherElements,
} from '../tools/vector/region.js';
import { NO_SELECTION } from './context.js';
import type { ViewportSelection } from './selectionState.js';

/**
 * What the selection's actions do (`selectionActions.ts`;
 * docs/decisions/0004-the-interface.md, "The context menu"), for the context
 * menu, the selection bar and the keys alike, so a key does what its item
 * does. The viewport builds this on every render, with what it holds: the
 * selection, the tools' context and whether a stroke is under way. Each
 * action says whether it did anything, so a key that did nothing is left to
 * the browser; one that cannot be done here says why, as a tool does.
 *
 * Fill… asks the frame for its dialog, whose Apply comes back through
 * `fillWith`; the two fills a key does at once, with the fill color and with
 * the stroke color, are the raster tools' `fillAreaWith` in normal at full
 * opacity, the first through `fillArea`, which is that.
 */

export type SelectionCommandDeps = Readonly<{
	document: EditorDocument;
	layer: LayerInfo | undefined;
	/** The canvas in the drawing's user units: what select all selects. */
	canvas: CanvasBox;
	toolId: ToolId;
	selection: ViewportSelection;
	/** Whether a stroke is under way: nothing that changes the drawing is done during one. */
	busy: () => boolean;
	context: () => ToolContext | undefined;
	overlay: () => SVGSVGElement | null;
	notify: (message: string) => void;
	/** A layer was made that the user now works on. */
	activate: (id: string) => void;
	/**
	 * Fill… was asked for, on a layer the fill may change: the frame's dialog
	 * opens. None where the viewport has no frame to ask, and Fill… does
	 * nothing then.
	 */
	fill?: () => void;
	/**
	 * Modify… was asked for: the frame's dialog opens, which expands,
	 * contracts, smooths, borders or feathers the area
	 * (`tools/raster/areaOps.ts`), at `way` where one was asked for: Shift F6
	 * asks for Feather. None where the viewport has no frame to ask, and
	 * Modify… does nothing.
	 */
	modify?: (way?: AreaModify) => void;
	/**
	 * Transform selection, the viewport's: `start` puts a box and handles on
	 * the area's outline, `apply` keeps what they did, `cancel` puts the
	 * outline back. Each says whether it did anything.
	 */
	transform: Readonly<{
		start: () => boolean;
		apply: () => boolean;
		cancel: () => boolean;
	}>;
}>;

export type SelectionCommands = Readonly<{
	run: (action: SelectionActionId) => boolean;
	/** The area filled as Fill…'s dialog says, on the active raster layer: whether it was the area's to do. */
	fillWith: (spec: FillSpec) => boolean;
	/** The middle of what is selected, in user units, for a menu the keyboard opens; none for nothing, or an inverted area. */
	center: () => Point | undefined;
}>;

/**
 * The box around an area's outline; none for an outline with no corners. By
 * `reduce`, not `Math.min(...)`, which a magic wand's outline of more than a
 * hundred thousand corners would take past the engine's argument limit.
 */
const areaBounds = (path: string): CanvasBox | undefined => {
	const points = areaPolygons(path).flat();
	const [first] = points;
	if (first === undefined) return undefined;
	const edges = points.reduce(
		(box, p) => ({
			left: Math.min(box.left, p.x),
			top: Math.min(box.top, p.y),
			right: Math.max(box.right, p.x),
			bottom: Math.max(box.bottom, p.y),
		}),
		{ left: first.x, top: first.y, right: first.x, bottom: first.y }
	);
	return {
		x: edges.left,
		y: edges.top,
		width: edges.right - edges.left,
		height: edges.bottom - edges.top,
	};
};

/** Where two boxes overlap; none where they do not, or only along an edge. */
const overlap = (a: CanvasBox, b: CanvasBox): CanvasBox | undefined => {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const width = Math.min(a.x + a.width, b.x + b.width) - x;
	const height = Math.min(a.y + a.height, b.y + b.height) - y;
	return width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

const middleOf = (box: CanvasBox | undefined): Point | undefined =>
	box === undefined ? undefined : { x: box.x + box.width / 2, y: box.y + box.height / 2 };

/** The actions that change a raster layer's pixels, by the name the user knows each by. */
type PixelAction = 'fillDialog' | 'fill' | 'fillWithStroke' | 'layerViaCopy' | 'layerViaCut';

const ACTION_NAMES: Readonly<Record<LayerVia, 'layerViaCopy' | 'layerViaCut'>> = {
	copy: 'layerViaCopy',
	cut: 'layerViaCut',
};

/**
 * A hook in name only, so that what it is given may reach the viewport's
 * refs: nothing here reads one while rendering, only when an action runs.
 */
export const useSelectionCommands = (deps: SelectionCommandDeps): SelectionCommands => {
	const { document, layer, selection, notify } = deps;
	const mode = () =>
		selectionModeOf({
			region: selection.region.get(),
			elements: selection.elements.get().length,
			layer,
			canUndo: false,
			canRedo: false,
		});

	/** Said of an action that changes pixels, asked of a layer that has none. */
	const rasterOnly = (action: PixelAction): true => {
		notify(t('selection.rasterOnly', { action: t(`selection.actions.${action}`) }));
		return true;
	};

	const deselect = (): boolean => {
		selection.region.set(undefined);
		selection.elements.set(NO_SELECTION);
		const overlay = deps.overlay();
		if (overlay !== null) hideSelection(overlay);
		return true;
	};

	/**
	 * On a vector layer, its elements, as in Illustrator and Figma, since
	 * nothing paints inside an area there; on any other, the whole canvas as
	 * the area, as in Photoshop.
	 */
	const selectAll = (): boolean => {
		const context = deps.context();
		if (layer?.kind === 'vector' && context !== undefined) {
			selectEveryElement(context, deps.toolId === 'select');
			return true;
		}
		const whole = rectPath(deps.canvas);
		selection.region.set(
			whole === undefined ? undefined : { path: whole, inverted: false, feather: 0 }
		);
		return true;
	};

	/** The layer's other elements, or the canvas outside the area's outline. */
	const selectInverse = (): boolean => {
		if (mode() === 'elements') {
			const context = deps.context();
			return context !== undefined && selectOtherElements(context, deps.toolId === 'select');
		}
		const region = selection.region.get();
		if (region === undefined) return false;
		// An inverse with no outline is the whole canvas (`combineAreas`), so
		// its inverse is nothing selected, not an outline of nothing.
		selection.region.set(
			region.inverted && region.path === ''
				? undefined
				: { ...region, inverted: !region.inverted }
		);
		return true;
	};

	/**
	 * Modify…: the frame's dialog, where there is an area and no stroke under
	 * way, at `way` where one was asked for.
	 */
	const modify = (way?: AreaModify): boolean => {
		if (selection.region.get() === undefined || deps.busy() || deps.modify === undefined) {
			return false;
		}
		deps.modify(way);
		return true;
	};

	/**
	 * The area's pixels into a new raster layer (`layerViaArea`, the raster
	 * tools'), which, once made, is the active one and the area is dropped,
	 * as Photoshop leaves it. Where none is made, `layerViaArea` has said why
	 * (a locked layer for a cut, a hidden one, an area that held nothing), and
	 * the area stays.
	 */
	const layerViaPixels = (context: ToolContext, how: LayerVia): boolean => {
		if (context.layer?.kind !== 'raster') return rasterOnly(ACTION_NAMES[how]);
		const work = layerViaArea(context, how);
		if (work === undefined) return false;
		void work.then(
			(made) => {
				if (made === undefined) return;
				selection.region.set(undefined);
				deps.activate(made);
			},
			() => undefined
		);
		return true;
	};

	const layerVia = (how: LayerVia): boolean => {
		const current = mode();
		if (current === 'nothing' || deps.busy()) return false;
		const context = deps.context();
		if (context === undefined) return false;
		if (current === 'area') return layerViaPixels(context, how);
		const made = layerViaSelection(context, how);
		if (made !== undefined) deps.activate(made);
		return true;
	};

	/**
	 * `act` with the tools' context, where there is an area and no stroke
	 * under way, on a raster layer; a layer of another kind says it has no
	 * pixels for `action`.
	 */
	const onAreaPixels = (action: PixelAction, act: (context: ToolContext) => boolean): boolean => {
		if (selection.region.get() === undefined || deps.busy()) return false;
		const context = deps.context();
		if (context === undefined) return false;
		if (layer?.kind !== 'raster') return rasterOnly(action);
		return act(context);
	};

	/** Fill…'s Apply: the area filled as the dialog says. */
	const fillWith = (spec: FillSpec): boolean =>
		onAreaPixels('fillDialog', (context) => fillAreaWith(context, spec));

	/** Fill…: the frame's dialog, where the layer is one the fill may change; a locked or a hidden one says so instead. */
	const fillDialog = (): boolean =>
		onAreaPixels('fillDialog', (context) => {
			if (deps.fill === undefined) return false;
			if (canFillArea(context)) deps.fill();
			return true;
		});

	/** Ctrl or ⌘ Backspace: the stroke color at once, as Photoshop's fill with the background color. */
	const fillWithStroke = (): boolean =>
		onAreaPixels('fillWithStroke', (context) =>
			fillAreaWith(context, {
				contents: 'stroke',
				mode: 'normal',
				opacity: 1,
				preserveTransparency: false,
			})
		);

	/** With an area selected on a raster layer and no stroke under way: its pixels cleared. */
	const clear = (): boolean => {
		if (selection.region.get() === undefined || deps.busy()) return false;
		if (layer?.kind !== 'raster') return false;
		const context = deps.context();
		return context !== undefined && clearArea(context);
	};

	/** With something selected on a vector layer and no stroke under way: it deleted. */
	const deleteElements = (): boolean => {
		if (selection.elements.get().length === 0 || deps.busy()) return false;
		if (layer?.kind !== 'vector') return false;
		const context = deps.context();
		if (context === undefined) return false;
		deleteSelection(context);
		hideSelection(context.overlay);
		return true;
	};

	/**
	 * The canvas cut down to the box around the area, as much of it as is on
	 * the canvas (`cropCanvas`): the crop tool's command, so nothing is
	 * resampled and the view refits. The area stays, as in Photoshop. An
	 * inverted area has no box of its own and is not cropped to.
	 */
	const crop = (): boolean => {
		const region = selection.region.get();
		if (region === undefined || region.inverted || deps.busy()) return false;
		const from = canvasBoxOf(document.root, document.size);
		const bounds = areaBounds(region.path);
		const box = bounds === undefined ? undefined : overlap(bounds, from);
		if (box === undefined) {
			notify(t('selection.cropOutside'));
			return true;
		}
		document.execute(cropCanvas(box, from));
		return true;
	};

	const newLayer = (): boolean => {
		const made = addLayer(document.root, 'vector', { above: layer?.id });
		document.execute(made);
		deps.activate(made.id);
		return true;
	};

	const duplicate = (): boolean => {
		if (layer === undefined) return false;
		const made = duplicateLayer(document.root, layer.id);
		document.execute(made);
		deps.activate(made.id);
		return true;
	};

	const ACTIONS: Readonly<Record<SelectionActionId, () => boolean>> = {
		deselect,
		selectInverse,
		// Shift F6, Photoshop's Feather: Modify… opened at it.
		feather: () => modify('feather'),
		modify: () => modify(),
		transformSelection: () => deps.transform.start(),
		applyTransform: () => deps.transform.apply(),
		cancelTransform: () => deps.transform.cancel(),
		layerViaCopy: () => layerVia('copy'),
		layerViaCut: () => layerVia('cut'),
		fillDialog,
		// Alt Backspace: the fill color at once, as Photoshop's fill with the foreground color.
		fill: () => onAreaPixels('fill', fillArea),
		fillWithStroke,
		clear,
		crop,
		// Delete is the elements', and with none the area's pixels.
		delete: () => deleteElements() || clear(),
		selectAll,
		undo: () => {
			document.undo();
			return true;
		},
		redo: () => {
			document.redo();
			return true;
		},
		newLayer,
		duplicateLayer: duplicate,
	};

	const center = (): Point | undefined => {
		if (mode() === 'elements') {
			const context = deps.context();
			return middleOf(context === undefined ? undefined : selectedBox(context));
		}
		const region = selection.region.get();
		if (region === undefined || region.inverted) return undefined;
		return middleOf(areaBounds(region.path));
	};

	return { run: (action) => ACTIONS[action](), fillWith, center };
};
