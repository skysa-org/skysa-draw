import {
	type Dispatch,
	type ReactNode,
	type RefObject,
	useEffect,
	useEffectEvent,
	useReducer,
	useRef,
	useState,
} from 'react';

import { DrawingView } from '../components/drawing/DrawingView.js';
import type { MenuItem } from '../components/ui/Menu.js';
import { Notice } from '../components/ui/Notice.js';
import { Panel } from '../components/ui/Panel.js';
import { PanelHost } from '../components/ui/PanelHost.js';
import {
	LARGE_MIN_WIDTH,
	type SizeClass,
	useMinWidth,
	useSizeClass,
} from '../components/ui/sizeClass.js';
import { ToolBar } from '../components/ui/ToolBar.js';
import { t } from '../i18n/t.js';
import { useDb } from '../store/database.js';
import { renameDrawing } from '../store/drawings.js';
import type { DocumentSnapshot, EditorDocument } from './document/model.js';
import { useDocumentSnapshot } from './document/useDocument.js';
import { type Placing, usePlacePicture } from './document/usePlacePicture.js';
import {
	activeLayerIn,
	type ColorSlot,
	type EditorAction,
	editorReducer,
	type EditorState,
	initialEditorState,
	type PanelId,
	setOption,
} from './editorState.js';
import { ExportDialog } from './export/ExportDialog.js';
import { type EditAction, editActionFor, isTyping, shortcutFor, toolFor } from './keys.js';
import { ColorPanel } from './panels/ColorPanel.js';
import { FeatherDialog } from './panels/FeatherDialog.js';
import { FillDialog } from './panels/FillDialog.js';
import { LayersPanel } from './panels/LayersPanel.js';
import { OptionsStrip } from './panels/OptionsStrip.js';
import { PropertiesPanel } from './panels/PropertiesPanel.js';
import { ToolButtons } from './panels/ToolButtons.js';
import { SELECTION_TOOLS, selectionModeOf, useSelectionActions } from './selectionActions.js';
import { toolById } from './tools/index.js';
import type { Region, Tool } from './tools/types.js';
import { TopBar } from './TopBar.js';
import type { ViewportHandle } from './types.js';
import { useOpenDrawing } from './useOpenDrawing.js';
import { Viewport } from './Viewport.js';
import { regionControl } from './viewport/context.js';
import { isMac } from './viewport/pointer.js';
import { createViewportSelection, useSelectionFacts } from './viewport/selectionState.js';

/**
 * The frame (docs/ARCHITECTURE.md §7, "The interface"; docs/decisions/0004-the-interface.md):
 * the one place that reads the window's size class, and places the same
 * pieces — top bar, tools, options, canvas, panels — where each size has room
 * for them. Compact: the tools along the bottom under one row of options, the
 * layers and the color as sheets. Medium: a rail down the start side, the
 * options over the canvas, the panels a drawer from the end. Expanded: the
 * rail, and a dock the canvas sits beside, layers over properties, open by
 * default from `LARGE_MIN_WIDTH`. The library is the screen before the drawing
 * on compact and a drawer from the top bar elsewhere.
 */

/** How long a line to the user stays. */
const NOTICE_MS = 3_000;

const MAC = isMac();

/** What a key reaches of the frame: the document, the viewport and the state. */
type KeyContext = Readonly<{
	document: EditorDocument | undefined;
	viewport: ViewportHandle | null;
	dispatch: Dispatch<EditorAction>;
}>;

const withDocument = (
	document: EditorDocument | undefined,
	act: (document: EditorDocument) => void
): boolean => {
	if (document === undefined) return false;
	act(document);
	return true;
};

const withViewport = (
	viewport: ViewportHandle | null,
	act: (viewport: ViewportHandle) => void
): boolean => {
	if (viewport === null) return false;
	act(viewport);
	return true;
};

const always = (act: () => void): boolean => {
	act();
	return true;
};

/**
 * The editing keys (`keys.ts`), each saying whether it did anything, so only a
 * handled key is kept from the browser. Escape is not the frame's: what a tool
 * has begun is the viewport's to cancel, and a sheet or a drawer closes itself
 * (`PanelHost`). Delete and the selection's keys are the viewport's, as the
 * selection and the area are, and J with them, which is layer via copy while
 * something is selected; a new layer is asked of it too, as its context menu
 * asks, so the two are one.
 */
const EDIT_ACTIONS: Readonly<Record<EditAction, (context: KeyContext) => boolean>> = {
	undo: ({ document }) => withDocument(document, (open) => open.undo()),
	redo: ({ document }) => withDocument(document, (open) => open.redo()),
	fit: ({ viewport }) => withViewport(viewport, (view) => view.fit()),
	actualSize: ({ viewport }) => withViewport(viewport, (view) => view.actualSize()),
	zoomIn: ({ viewport }) => withViewport(viewport, (view) => view.zoomIn()),
	zoomOut: ({ viewport }) => withViewport(viewport, (view) => view.zoomOut()),
	delete: () => false,
	escape: () => false,
	// The selection's, which the viewport works.
	selectAll: () => false,
	deselect: () => false,
	selectInverse: () => false,
	feather: () => false,
	layerViaCut: () => false,
	fillArea: () => false,
	fillAreaStroke: () => false,
	fillDialog: () => false,
	duplicate: () => false,
	sizeUp: ({ dispatch }) => always(() => dispatch({ type: 'adjustSize', steps: 1 })),
	sizeDown: ({ dispatch }) => always(() => dispatch({ type: 'adjustSize', steps: -1 })),
	swapColors: ({ dispatch }) => always(() => dispatch({ type: 'swapColors' })),
	resetColors: ({ dispatch }) => always(() => dispatch({ type: 'resetColors' })),
	newLayer: ({ viewport }) => viewport?.perform('newLayer') ?? false,
};

/**
 * Keys on every size (docs/decisions/0004-the-interface.md): a letter per
 * tool, and the editing keys, from the one map in `keys.ts`. A key something
 * else has handled already — a sheet's Escape, a layer row's Delete — is left
 * alone, and so is one typed into a field.
 */
const useEditorKeys = (
	document: EditorDocument | undefined,
	viewport: RefObject<ViewportHandle | null>,
	dispatch: Dispatch<EditorAction>
) => {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || isTyping(event.target)) return;
			const nextTool = toolFor(event, MAC);
			if (nextTool !== undefined) {
				// A key for a tool not built yet does nothing, rather than leaving
				// the frame holding a tool the viewport has no behavior for.
				if (toolById(nextTool) === undefined) return;
				event.preventDefault();
				dispatch({ type: 'setTool', toolId: nextTool });
				return;
			}
			const action = editActionFor(event, MAC);
			if (action === undefined) return;
			const context = { document, viewport: viewport.current, dispatch };
			if (EDIT_ACTIONS[action](context)) event.preventDefault();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [document, viewport, dispatch]);
};

/** A notice stays `NOTICE_MS` from the last time it was said. */
const useNoticeTimeout = (notice: EditorState['notice'], dispatch: Dispatch<EditorAction>) => {
	useEffect(() => {
		if (notice === undefined) return undefined;
		const timer = setTimeout(() => dispatch({ type: 'clearNotice' }), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice, dispatch]);
};

type FramePanelsProps = Readonly<{
	sizeClass: SizeClass;
	panel: PanelId | undefined;
	dockShown: boolean;
	onCloseDock: () => void;
	onClosePanel: () => void;
	/** The layers panel, with the close of whatever holds it. */
	layers: (onClose: () => void) => ReactNode;
	color: ReactNode;
	properties: ReactNode;
}>;

/**
 * Where the panels go. Expanded: the layers over the properties in the dock,
 * and the color, which is picked and put away rather than kept beside the
 * canvas, in a drawer. Compact and medium: one panel at a time, in a sheet or
 * a drawer, with the layer's properties inside the layers panel.
 */
const FramePanels = ({
	sizeClass,
	panel,
	dockShown,
	onCloseDock,
	onClosePanel,
	layers,
	color,
	properties,
}: FramePanelsProps) => {
	if (sizeClass === 'expanded') {
		return (
			<>
				<div className="editor-dock">
					<PanelHost
						placement="dock"
						open={dockShown}
						onClose={onCloseDock}
						label={t('editor.panes.dock')}
					>
						{layers(onCloseDock)}
						{properties}
					</PanelHost>
				</div>
				<PanelHost
					placement="drawer"
					side="end"
					open={panel === 'color'}
					onClose={onClosePanel}
					label={t('editor.color.title')}
				>
					{color}
				</PanelHost>
			</>
		);
	}
	return (
		<PanelHost
			placement={sizeClass === 'compact' ? 'sheet' : 'drawer'}
			side="end"
			open={panel !== undefined}
			onClose={onClosePanel}
			label={panel === 'color' ? t('editor.color.title') : t('layers.title')}
		>
			{panel === 'color' ? color : layers(onClosePanel)}
		</PanelHost>
	);
};

type FrameProps = Readonly<{
	sizeClass: SizeClass;
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	tool: Tool;
	state: EditorState;
	dispatch: Dispatch<EditorAction>;
	activeLayerId: string | undefined;
	notice: string | undefined;
	topBar: ReactNode;
	viewport: RefObject<ViewportHandle | null>;
	onScale: (scale: number) => void;
	/** A picture dropped on the canvas is placed as a new layer. */
	placing: Placing;
}>;

/**
 * The frame with a drawing open in it. It holds the selection the viewport
 * works (`viewport/selectionState.ts`), so that while something is selected
 * under a tool that selects, the options strip shows the actions the
 * viewport's context menu shows: one list (`selectionActions.ts`), done by the
 * viewport through its handle. Feather… and Fill… each open a dialog of the
 * frame's, kept open only while the area it was opened for is the one there;
 * Fill…'s Apply is the viewport's, through its handle.
 */
const Frame = ({
	sizeClass,
	document,
	snapshot,
	tool,
	state,
	dispatch,
	activeLayerId,
	notice,
	topBar,
	viewport,
	onScale,
	placing,
}: FrameProps) => {
	const wide = useMinWidth(LARGE_MIN_WIDTH);
	const compact = sizeClass === 'compact';
	const expanded = sizeClass === 'expanded';
	const dockShown = expanded && (state.dockOpen ?? wide);
	const setColor = (which: ColorSlot, value: string) =>
		dispatch({ type: 'setColor', which, value });
	const closePanel = () => dispatch({ type: 'closePanel' });
	const notify = (message: string) => dispatch({ type: 'notify', message });
	const closeDock = () => dispatch({ type: 'setDockOpen', open: false });
	const [selection] = useState(createViewportSelection);
	const facts = useSelectionFacts(selection, snapshot, activeLayerId);
	const [feathering, setFeathering] = useState<Region | undefined>(undefined);
	const [filling, setFilling] = useState<Region | undefined>(undefined);
	// Through the handle, when an item is chosen: the viewport does it.
	const items = useSelectionActions(facts, (action) => viewport.current?.perform(action), MAC);
	const selecting = SELECTION_TOOLS.has(tool.id) && selectionModeOf(facts) !== 'nothing';
	const toggleLayers = () =>
		dispatch(
			expanded
				? { type: 'setDockOpen', open: !dockShown }
				: { type: 'togglePanel', panel: 'layers' }
		);

	const tools = (
		<ToolButtons
			tool={tool}
			fill={state.options.fill}
			stroke={state.options.stroke}
			editing={state.panel === 'color' ? state.colorSlot : undefined}
			compact={compact}
			layersOpen={expanded ? dockShown : state.panel === 'layers'}
			dispatch={dispatch}
			onLayers={toggleLayers}
		/>
	);
	const options = (
		<OptionsStrip
			tool={tool}
			options={state.options}
			onChange={(key, value) => dispatch(setOption(key, value))}
			actions={selecting ? items : []}
		/>
	);
	const layers = (onClose: () => void) => (
		<LayersPanel
			document={document}
			snapshot={snapshot}
			activeLayerId={activeLayerId}
			onActivate={(id) => dispatch({ type: 'setActiveLayer', id })}
			withProperties={!expanded}
			onClose={onClose}
			onNotify={notify}
		/>
	);

	// The options come before the canvas where they are drawn over it, and
	// after it on compact, so that the order read is the order seen.
	return (
		<main className="editor" data-size={sizeClass}>
			{topBar}
			{!compact && (
				<ToolBar
					orientation="vertical"
					label={t('editor.panes.tools')}
					className="editor-rail"
				>
					{tools}
				</ToolBar>
			)}
			{!compact && options}
			<div className="editor-canvas" onDragOver={placing.onDragOver} onDrop={placing.onDrop}>
				<Viewport
					ref={viewport}
					document={document}
					tool={tool}
					options={state.options}
					layerId={activeLayerId}
					selection={selection}
					onColor={setColor}
					onNotify={notify}
					onScale={onScale}
					onActivateLayer={(id) => dispatch({ type: 'setActiveLayer', id })}
					onFeather={() => setFeathering(selection.region.get())}
					onFill={() => setFilling(selection.region.get())}
					onTool={(toolId) => dispatch({ type: 'setTool', toolId })}
					onOptions={(change) => dispatch({ type: 'setOptions', change })}
				/>
				<Notice message={notice} />
			</div>
			{compact && options}
			{compact && (
				<ToolBar
					orientation="horizontal"
					label={t('editor.panes.tools')}
					className="editor-tools"
				>
					{tools}
				</ToolBar>
			)}
			<FramePanels
				sizeClass={sizeClass}
				panel={state.panel}
				dockShown={dockShown}
				onCloseDock={closeDock}
				onClosePanel={closePanel}
				layers={layers}
				color={
					<ColorPanel
						options={state.options}
						recent={state.recentColors}
						onColor={setColor}
						editing={state.colorSlot}
						onSwap={() => dispatch({ type: 'swapColors' })}
						onReset={() => dispatch({ type: 'resetColors' })}
						onClose={closePanel}
					/>
				}
				properties={
					<PropertiesPanel
						document={document}
						snapshot={snapshot}
						activeLayerId={activeLayerId}
					/>
				}
			/>
			<FeatherDialog
				placement={compact ? 'sheet' : 'drawer'}
				open={feathering !== undefined && feathering === facts.region}
				feather={facts.region?.feather ?? 0}
				onApply={(feather) => regionControl(selection.region).update({ feather })}
				onClose={() => setFeathering(undefined)}
			/>
			<FillDialog
				placement={compact ? 'sheet' : 'drawer'}
				open={filling !== undefined && filling === facts.region}
				options={state.options}
				recent={state.recentColors}
				onApply={(spec) => viewport.current?.fillArea(spec)}
				onClose={() => setFilling(undefined)}
			/>
		</main>
	);
};

/**
 * The frame with nothing to draw on: the drawing still loading, or a file the
 * editor cannot open, shown as the browser draws it and never rewritten
 * (docs/ARCHITECTURE.md §7, "Still an image"), with no tools.
 */
const StillFrame = ({
	sizeClass,
	title,
	text,
	notice,
	topBar,
}: Readonly<{
	sizeClass: SizeClass;
	title: string;
	text: string | undefined;
	notice: string | undefined;
	topBar: ReactNode;
}>) => (
	<main className="editor editor-still" data-size={sizeClass}>
		{topBar}
		<section className="editor-canvas" aria-label={t('editor.panes.canvas')}>
			{text !== undefined && <DrawingView text={text} title={title} />}
			<Notice message={notice} />
		</section>
	</main>
);

/**
 * A link to a drawing this device does not have: never had, deleted, or not
 * yet arrived by sync. Said once the store has answered, not while it is
 * asked, with the way back to the library.
 */
const NotFound = ({ onBack }: Readonly<{ onBack: () => void }>) => (
	<main className="editor editor-missing">
		<p>{t('editor.notFound')}</p>
		<button type="button" className="primary" onClick={onBack}>
			{t('editor.back')}
		</button>
	</main>
);

type EditorProps = Readonly<{
	/** The drawing's id. */
	id: string;
	/** Leaves the editor: compact's Back, and after the drawing is deleted. */
	onBack: () => void;
	/**
	 * Moves the editor to another drawing: the one the unsaved edits were kept
	 * in when this one was deleted elsewhere.
	 */
	onReplaced: (id: string) => void;
	/** The folders and the drawings, in a drawer on medium and expanded. */
	library: ReactNode;
}>;

export const Editor = ({ id, onBack, onReplaced, library }: EditorProps) => {
	const sizeClass = useSizeClass();
	const db = useDb();
	const { row, missing, document, unreadable, saving, keptCopy, replacement, flush, remove } =
		useOpenDrawing(id);
	const snapshot = useDocumentSnapshot(document);
	const [state, dispatch] = useReducer(editorReducer, initialEditorState);
	const [scale, setScale] = useState(1);
	const [exporting, setExporting] = useState(false);
	const viewport = useRef<ViewportHandle>(null);
	const pictureField = useRef<HTMLInputElement>(null);
	const activeLayerId = activeLayerIn(snapshot?.layers ?? [], state.activeLayerId);
	const placing = usePlacePicture(
		document,
		activeLayerId,
		(placed) => dispatch({ type: 'setActiveLayer', id: placed }),
		(message) => dispatch({ type: 'notify', message })
	);

	useEditorKeys(document, viewport, dispatch);
	useNoticeTimeout(state.notice, dispatch);

	// Another drawing opened from the library: the drawer has done its job.
	useEffect(() => {
		dispatch({ type: 'setLibraryOpen', open: false });
	}, [id]);

	// The drawing changed elsewhere under unsaved edits, which were kept as a
	// copy beside it: the user is told where they went.
	useEffect(() => {
		if (keptCopy === undefined) return;
		dispatch({ type: 'notify', message: t('editor.keptCopy', { title: keptCopy.title }) });
	}, [keptCopy]);

	// The drawing was deleted elsewhere under unsaved edits, which became a
	// drawing of their own: the editor moves to it, and says so. The notice is
	// the frame's, so it is still there when the drawing opens.
	const moveTo = useEffectEvent(onReplaced);
	useEffect(() => {
		if (replacement === undefined) return;
		dispatch({
			type: 'notify',
			message: t('editor.keptDeleted', { title: replacement.title }),
		});
		moveTo(replacement.id);
	}, [replacement]);

	const title = row?.title ?? '';
	// Placing a picture and exporting need a drawing open to work on.
	const fileActions =
		document === undefined
			? {}
			: {
					onExport: () => setExporting(true),
					onPlacePicture: () => pictureField.current?.click(),
				};
	const closeLibrary = () => dispatch({ type: 'setLibraryOpen', open: false });
	const zoomItems: readonly MenuItem[] = [
		{
			id: 'fit',
			label: t('editor.zoom.fit'),
			shortcut: shortcutFor('fit', MAC),
			onSelect: () => viewport.current?.fit(),
		},
		{
			id: 'actual',
			label: t('editor.zoom.actual'),
			shortcut: shortcutFor('actualSize', MAC),
			onSelect: () => viewport.current?.actualSize(),
		},
		{
			id: 'in',
			label: t('editor.zoom.in'),
			shortcut: shortcutFor('zoomIn', MAC),
			onSelect: () => viewport.current?.zoomIn(),
		},
		{
			id: 'out',
			label: t('editor.zoom.out'),
			shortcut: shortcutFor('zoomOut', MAC),
			onSelect: () => viewport.current?.zoomOut(),
		},
	];
	const topBar = (
		<TopBar
			title={title}
			sizeClass={sizeClass}
			onBack={onBack}
			onOpenLibrary={() => dispatch({ type: 'setLibraryOpen', open: true })}
			canUndo={snapshot?.canUndo ?? false}
			canRedo={snapshot?.canRedo ?? false}
			onUndo={() => document?.undo()}
			onRedo={() => document?.redo()}
			saving={saving}
			zoomPercent={Math.round(scale * 100)}
			zoomItems={zoomItems}
			onRename={async (next) => {
				// The row is renamed from the text it holds, so what the editor
				// holds goes in first; the renamed text then reopens, with
				// nothing unsaved.
				await flush();
				await renameDrawing(db, id, next);
			}}
			onDelete={async () => {
				// Through the open drawing, so that the edits not yet saved go
				// with it rather than being kept as a drawing of their own.
				await remove();
				onBack();
			}}
			{...fileActions}
		/>
	);
	const libraryDrawer = sizeClass !== 'compact' && (
		<PanelHost
			placement="drawer"
			side="start"
			open={state.libraryOpen}
			onClose={closeLibrary}
			label={t('editor.library')}
		>
			<Panel title={t('editor.library')} onClose={closeLibrary} className="library-panel">
				{library}
			</Panel>
		</PanelHost>
	);
	const tool = toolById(state.toolId);

	if (missing) return <NotFound onBack={onBack} />;

	if (
		row === undefined ||
		document === undefined ||
		snapshot === undefined ||
		tool === undefined
	) {
		return (
			<>
				<StillFrame
					sizeClass={sizeClass}
					title={title}
					text={unreadable ? row?.text : undefined}
					notice={unreadable ? t('editor.unreadable') : undefined}
					topBar={topBar}
				/>
				{libraryDrawer}
			</>
		);
	}

	return (
		<>
			<Frame
				sizeClass={sizeClass}
				document={document}
				snapshot={snapshot}
				tool={tool}
				state={state}
				dispatch={dispatch}
				activeLayerId={activeLayerId}
				notice={state.notice?.message}
				topBar={topBar}
				viewport={viewport}
				onScale={setScale}
				placing={placing}
			/>
			{libraryDrawer}
			<ExportDialog
				document={document}
				title={title}
				open={exporting}
				onClose={() => setExporting(false)}
			/>
			{/* "Place picture…" opens this; the picture becomes a layer above the active one. */}
			<input
				ref={pictureField}
				type="file"
				accept="image/*"
				hidden
				tabIndex={-1}
				aria-label={t('editor.pictureFile')}
				onChange={(event) => {
					const file = event.target.files?.[0];
					// Emptied, so the same file chosen again is a change again.
					event.target.value = '';
					if (file !== undefined) placing.place(file);
				}}
			/>
		</>
	);
};
