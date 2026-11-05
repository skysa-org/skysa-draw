import type { EditorDocument, LayerInfo } from '../document/model.js';
import type {
	Region,
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
	region: Observable<Region | undefined>;
	host: HTMLElement;
	fit: () => void;
	actualSize: () => void;
	setColor: ToolContext['setColor'];
	notify: ToolContext['notify'];
	/** None where the viewport has no frame to ask for a tool (`viewport/toolHandover.ts`). */
	useTool?: ToolContext['useTool'];
	/** None where the viewport has no frame to tell. */
	setOptions?: ToolContext['setOptions'];
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

/** The area as a tool works it. */
export const regionControl = (region: Observable<Region | undefined>): RegionControl => ({
	get path() {
		return region.get()?.path;
	},
	get region() {
		return region.get();
	},
	set: (path) => {
		region.set(path === undefined ? undefined : { path, inverted: false, feather: 0 });
	},
	update: (change) => {
		const now = region.get();
		if (now !== undefined) region.set({ ...now, ...change });
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
	setColor: deps.setColor,
	notify: deps.notify,
	...(deps.useTool === undefined ? {} : { useTool: deps.useTool }),
	...(deps.setOptions === undefined ? {} : { setOptions: deps.setOptions }),
});
