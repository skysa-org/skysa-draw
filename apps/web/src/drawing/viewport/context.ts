import type { EditorDocument, LayerInfo } from '../document/model.js';
import type {
	RegionControl,
	ScreenCanvas,
	SelectionControl,
	ToolContext,
	ToolOptions,
	ViewportControl,
} from '../tools/types.js';
import type { Observable } from './observable.js';
import { panBy, toScreen, type View, zoomAbout } from './transform.js';

/**
 * What the viewport gives a tool (docs/ARCHITECTURE.md §7, "Tools"): one
 * object for one stroke, begin to end. The view changes under a stroke, by the
 * tool's own hand or a second finger's, so nothing here copies it: `scale`,
 * `toScreen` and `elements` read the live value each time they are asked.
 */
type ContextDeps = Readonly<{
	document: EditorDocument;
	layer: LayerInfo | undefined;
	options: ToolOptions;
	overlay: SVGSVGElement;
	canvas: HTMLCanvasElement;
	/** Read when asked: a window moved to another screen changes it. */
	pixelRatio: () => number;
	view: Observable<View>;
	selection: Observable<readonly Element[]>;
	region: Observable<string | undefined>;
	host: HTMLElement;
	fit: () => void;
	actualSize: () => void;
	setColour: ToolContext['setColour'];
	notify: ToolContext['notify'];
}>;

/** No elements, one array, so clearing a cleared selection is not a change. */
export const NO_SELECTION: readonly Element[] = [];

const viewportControl = (
	view: Observable<View>,
	fit: () => void,
	actualSize: () => void
): ViewportControl => ({
	get scale() {
		return view.get().scale;
	},
	zoomBy: (factor, aboutX, aboutY) => {
		view.set(zoomAbout(view.get(), factor, aboutX, aboutY));
	},
	panBy: (dx, dy) => {
		view.set(panBy(view.get(), dx, dy));
	},
	fit,
	actualSize,
});

const screenCanvas = (
	canvas: HTMLCanvasElement,
	view: Observable<View>,
	pixelRatio: () => number
): ScreenCanvas => ({
	canvas,
	toScreen: (x, y) => {
		const ratio = pixelRatio();
		const [sx, sy] = toScreen(view.get(), x, y);
		return [sx * ratio, sy * ratio];
	},
	get pixelRatio() {
		return pixelRatio();
	},
});

const selectionControl = (selection: Observable<readonly Element[]>): SelectionControl => ({
	get elements() {
		return selection.get();
	},
	set: (elements) => {
		selection.set(elements.length === 0 ? NO_SELECTION : [...elements]);
	},
	clear: () => {
		selection.set(NO_SELECTION);
	},
});

const regionControl = (region: Observable<string | undefined>): RegionControl => ({
	get path() {
		return region.get();
	},
	set: (path) => {
		region.set(path);
	},
});

export const createToolContext = (deps: ContextDeps): ToolContext => ({
	document: deps.document,
	layer: deps.layer,
	options: deps.options,
	overlay: deps.overlay,
	screen: screenCanvas(deps.canvas, deps.view, deps.pixelRatio),
	viewport: viewportControl(deps.view, deps.fit, deps.actualSize),
	selection: selectionControl(deps.selection),
	region: regionControl(deps.region),
	host: deps.host,
	setColour: deps.setColour,
	notify: deps.notify,
});
