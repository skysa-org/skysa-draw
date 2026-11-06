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
import { canvasBoxOf } from './document/crop.js';
import type { DocumentSnapshot, EditorDocument } from './document/model.js';
import { useDocumentSnapshot } from './document/useDocument.js';
import { type Placing, usePlacePicture } from './document/usePlacePicture.js';
import { useEditorKeys } from './editorKeys.js';
import {
	activeLayerIn,
	type ColorSlot,
	type EditorAction,
	editorReducer,
	type EditorState,
	initialEditorState,
	type PanelId,
	selectedLayersIn,
	setOption,
} from './editorState.js';
import { ExportDialog } from './export/ExportDialog.js';
import { shortcutFor } from './keys.js';
import { ColorPanel } from './panels/ColorPanel.js';
import { FillDialog } from './panels/FillDialog.js';
import { useImageMenu } from './panels/imageMenu.js';
import { LayersPanel } from './panels/LayersPanel.js';
import { ModifyDialog } from './panels/ModifyDialog.js';
import { OptionsStrip } from './panels/OptionsStrip.js';
import { PropertiesPanel } from './panels/PropertiesPanel.js';
import { ToolButtons } from './panels/ToolButtons.js';
import { SELECTION_TOOLS, selectionModeOf, useSelectionActions } from './selectionActions.js';
import { arrangedIds, type Arrangement } from './tools/common/align.js';
import { arrangedCount } from './tools/common/arrange.js';
import { toolById } from './tools/index.js';
import type { AreaModify } from './tools/raster/areaOps.js';
import type { Region, Tool } from './tools/types.js';
import { TopBar } from './TopBar.js';
import type { ViewportHandle } from './types.js';
import { useOpenDrawing } from './useOpenDrawing.js';
import { Viewport } from './Viewport.js';
import { NO_SELECTION } from './viewport/context.js';
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

/**
 * The top bar's Undo or Redo: a step of Transform selection's own while one
 * is on, as Ctrl or ⌘ Z is then, and of the drawing's history otherwise.
 */
const step = (
	viewport: ViewportHandle | null,
	document: EditorDocument | undefined,
	way: 'undo' | 'redo'
): void => {
	if (viewport?.[way]() !== true) document?.[way]();
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
	/** The top bar, with the Image operations' items in its More. */
	topBar: (imageItems: readonly MenuItem[]) => ReactNode;
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
 * viewport through its handle. Modify…, which Shift F6 opens at Feather, and
 * Fill… each open a dialog of the frame's, kept open only while the area it
 * was opened for is the one there; Modify…'s Apply sets the area, which is
 * not part of the history, and Fill…'s is the viewport's, through its
 * handle. A Modify… that would leave nothing of the area keeps it, and says
 * so. The Image operations under the top bar's More open dialogs of the
 * frame's too (`panels/imageMenu.tsx`), and are disabled while the area is
 * being transformed.
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
	// The layers chosen in the panel, as far as the document still has them.
	const chosen = selectedLayersIn(snapshot.layers, state.selectedLayerIds, activeLayerId);
	// The area Modify… was opened on, and the way it was asked at: Shift F6's Feather.
	const [modifying, setModifying] = useState<
		Readonly<{ region: Region | undefined; way?: AreaModify }> | undefined
	>(undefined);
	const [filling, setFilling] = useState<Region | undefined>(undefined);
	// Where the frame's dialogs go: Modify…, Fill… and the Image operations'.
	const dialogPlacement = compact ? 'sheet' : 'drawer';
	const image = useImageMenu({
		document,
		placement: dialogPlacement,
		busy: facts.transforming === true,
		notify,
	});
	// Through the handle, when an item is chosen: the viewport does it.
	const items = useSelectionActions(facts, (action) => viewport.current?.perform(action), MAC);
	// A transform begun from the context menu shows its Apply and Cancel
	// whatever tool is in hand, since nothing else ends it but a change.
	const selecting =
		facts.transforming === true ||
		(SELECTION_TOOLS.has(tool.id) && selectionModeOf(facts) !== 'nothing');
	const toggleLayers = () =>
		dispatch(
			expanded
				? { type: 'setDockOpen', open: !dockShown }
				: { type: 'togglePanel', panel: 'layers' }
		);

	const tools = (
		<ToolButtons
			tool={tool}
			layerKind={facts.layer?.kind}
			orientation={compact ? 'horizontal' : 'vertical'}
			fill={state.options.fill}
			stroke={state.options.stroke}
			colorsOpen={state.panel === 'color'}
			layersOpen={expanded ? dockShown : state.panel === 'layers'}
			dispatch={dispatch}
			onLayers={toggleLayers}
		/>
	);
	// The move tool's alignment, for the layers it would move, done by the viewport.
	const align =
		tool.id === 'select'
			? {
					count: arrangedCount(
						arrangedIds(document.root, chosen, activeLayerId),
						facts.elements
					),
					onArrange: (arrangement: Arrangement) => viewport.current?.arrange(arrangement),
				}
			: undefined;
	const options = (
		<OptionsStrip
			tool={tool}
			options={state.options}
			onChange={(key, value) => dispatch(setOption(key, value))}
			actions={selecting ? items : []}
			align={align}
			transforming={facts.transforming === true}
		/>
	);
	const layers = (onClose: () => void) => (
		<LayersPanel
			document={document}
			snapshot={snapshot}
			activeLayerId={activeLayerId}
			selectedLayerIds={chosen}
			layerAnchor={state.layerAnchor}
			onActivate={(id) => dispatch({ type: 'setActiveLayer', id })}
			onSelectLayers={(choice) => dispatch({ type: 'selectLayers', selection: choice })}
			collapsedGroupIds={state.collapsedGroupIds}
			onCollapseGroups={(ids) => dispatch({ type: 'setCollapsedGroups', ids })}
			expandedLayerIds={state.expandedLayerIds}
			onExpandLayers={(ids) => dispatch({ type: 'setExpandedLayers', ids })}
			selectedElements={selection.elements}
			// An item's row selects on the canvas: its layer active, a tool that selects in hand.
			onSelectElements={(id, elements) => {
				dispatch({ type: 'selectInLayer', id });
				selection.elements.set(elements.length === 0 ? NO_SELECTION : elements);
			}}
			withProperties={!expanded}
			onClose={onClose}
			onNotify={notify}
		/>
	);

	// The options come before the canvas where they are drawn over it, and
	// after it on compact, so that the order read is the order seen.
	return (
		<main className="editor" data-size={sizeClass}>
			{topBar(image.items)}
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
					selectedLayerIds={chosen}
					selection={selection}
					onColor={setColor}
					onNotify={notify}
					onScale={onScale}
					onActivateLayer={(id) => dispatch({ type: 'setActiveLayer', id })}
					onSelectLayers={(choice) =>
						dispatch({ type: 'selectLayers', selection: choice })
					}
					onModify={(way) => setModifying({ region: selection.region.get(), way })}
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
			<ModifyDialog
				placement={dialogPlacement}
				open={modifying !== undefined && modifying.region === facts.region}
				region={modifying?.region}
				way={modifying?.way}
				canvas={canvasBoxOf(document.root, document.size)}
				onApply={(region) => {
					// An area is not a step of the history, so one modified to nothing
					// is kept as it was rather than lost for good.
					if (region === undefined) {
						notify(t('selection.modify.nothingLeft'));
						return;
					}
					selection.region.set(region);
				}}
				onClose={() => setModifying(undefined)}
			/>
			<FillDialog
				placement={dialogPlacement}
				open={filling !== undefined && filling === facts.region}
				options={state.options}
				recent={state.recentColors}
				onApply={(spec) => viewport.current?.fillArea(spec)}
				onClose={() => setFilling(undefined)}
			/>
			{image.dialogs}
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

	useEditorKeys(document, viewport, dispatch, state.toolId);
	useNoticeTimeout(state.notice, dispatch);

	// Another drawing opened from the library: the drawer has done its job,
	// and the groups collapsed and the layers expanded were the last drawing's.
	useEffect(() => {
		dispatch({ type: 'setLibraryOpen', open: false });
		dispatch({ type: 'setCollapsedGroups', ids: [] });
		dispatch({ type: 'setExpandedLayers', ids: [] });
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
	const topBar = (imageItems: readonly MenuItem[] = []) => (
		<TopBar
			title={title}
			sizeClass={sizeClass}
			onBack={onBack}
			onOpenLibrary={() => dispatch({ type: 'setLibraryOpen', open: true })}
			canUndo={snapshot?.canUndo ?? false}
			canRedo={snapshot?.canRedo ?? false}
			onUndo={() => step(viewport.current, document, 'undo')}
			onRedo={() => step(viewport.current, document, 'redo')}
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
			imageItems={imageItems}
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
					topBar={topBar()}
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
