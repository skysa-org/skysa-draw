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
import { classes } from '../components/ui/classes.js';
import { isNone } from '../components/ui/colour.js';
import { ColourIcon, ICONS, LayersIcon } from '../components/ui/icons.js';
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
import { ToolButton } from '../components/ui/ToolButton.js';
import { t } from '../i18n/t.js';
import { useDb } from '../store/database.js';
import { renameDrawing } from '../store/drawings.js';
import { addLayer, duplicateLayer } from './document/commands.js';
import type { DocumentSnapshot, EditorDocument } from './document/model.js';
import { useDocumentSnapshot } from './document/useDocument.js';
import {
	activeLayerIn,
	type ColourSlot,
	type EditorAction,
	editorReducer,
	type EditorState,
	initialEditorState,
	type PanelId,
	setOption,
} from './editorState.js';
import {
	type EditAction,
	editActionFor,
	isTyping,
	primaryKeyLabel,
	shortcutLabel,
	toolFor,
} from './keys.js';
import { ColourPanel } from './panels/ColourPanel.js';
import { LayersPanel } from './panels/LayersPanel.js';
import { OptionsStrip } from './panels/OptionsStrip.js';
import { PropertiesPanel } from './panels/PropertiesPanel.js';
import { toolById, TOOLS } from './tools/index.js';
import type { Tool } from './tools/types.js';
import { TopBar } from './TopBar.js';
import type { ViewportHandle } from './types.js';
import { useOpenDrawing } from './useOpenDrawing.js';
import { Viewport } from './Viewport.js';
import { isMac } from './viewport/pointer.js';

/**
 * The frame (docs/ARCHITECTURE.md §7, "The interface"; docs/decisions/0004-the-interface.md):
 * the one place that reads the window's size class, and places the same
 * pieces — top bar, tools, options, canvas, panels — where each size has room
 * for them. Compact: the tools along the bottom under one row of options, the
 * layers and the colour as sheets. Medium: a rail down the start side, the
 * options over the canvas, the panels a drawer from the end. Expanded: the
 * rail, and a dock the canvas sits beside, layers over properties, open by
 * default from `LARGE_MIN_WIDTH`. The library is the screen before the drawing
 * on compact and a drawer from the top bar elsewhere.
 */

/** How long a line to the user stays. */
const NOTICE_MS = 3_000;

const MAC = isMac();
const PRIMARY = primaryKeyLabel(MAC);

/** A key with the primary key held, as each platform writes one: `⌘0`, `Ctrl+0`. */
const chord = (key: string): string => (MAC ? `${PRIMARY}${key}` : `${PRIMARY}+${key}`);

/** What a key reaches of the frame: the document, the viewport and the state. */
type KeyContext = Readonly<{
	document: EditorDocument | undefined;
	viewport: ViewportHandle | null;
	activeLayerId: string | undefined;
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
 * (`PanelHost`). Delete is not yet either: the selection is the viewport's,
 * and it has no command for it.
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
	sizeUp: ({ dispatch }) => always(() => dispatch({ type: 'adjustSize', steps: 1 })),
	sizeDown: ({ dispatch }) => always(() => dispatch({ type: 'adjustSize', steps: -1 })),
	swapColours: ({ dispatch }) => always(() => dispatch({ type: 'swapColours' })),
	newLayer: ({ document, activeLayerId, dispatch }) =>
		withDocument(document, (open) => {
			const made = addLayer(open.root, 'vector', { above: activeLayerId });
			open.execute(made);
			dispatch({ type: 'setActiveLayer', id: made.id });
		}),
	duplicate: ({ document, activeLayerId, dispatch }) => {
		if (document === undefined || activeLayerId === undefined) return false;
		const made = duplicateLayer(document.root, activeLayerId);
		document.execute(made);
		dispatch({ type: 'setActiveLayer', id: made.id });
		return true;
	},
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
	activeLayerId: string | undefined,
	dispatch: Dispatch<EditorAction>
) => {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || isTyping(event.target)) return;
			const nextTool = toolFor(event, MAC);
			if (nextTool !== undefined) {
				// A key for a tool not built yet does nothing, rather than leaving
				// the frame holding a tool the viewport has no behaviour for.
				if (toolById(nextTool) === undefined) return;
				event.preventDefault();
				dispatch({ type: 'setTool', toolId: nextTool });
				return;
			}
			const action = editActionFor(event, MAC);
			if (action === undefined) return;
			const context = { document, viewport: viewport.current, activeLayerId, dispatch };
			if (EDIT_ACTIONS[action](context)) event.preventDefault();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [document, viewport, activeLayerId, dispatch]);
};

/** A notice stays `NOTICE_MS` from the last time it was said. */
const useNoticeTimeout = (notice: EditorState['notice'], dispatch: Dispatch<EditorAction>) => {
	useEffect(() => {
		if (notice === undefined) return undefined;
		const timer = setTimeout(() => dispatch({ type: 'clearNotice' }), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice, dispatch]);
};

/** The fill as a mark on the colour button; none is a struck-through one. */
const Swatch = ({ colour }: Readonly<{ colour: string }>) => (
	<span
		className={classes('swatch', isNone(colour) && 'swatch-none')}
		// The swatch is drawn in `currentColor` (`ui.css`), so the colour is the one style set here.
		style={isNone(colour) ? undefined : { color: colour }}
		aria-hidden="true"
	/>
);

type ToolButtonsProps = Readonly<{
	tool: Tool;
	fill: string;
	colourOpen: boolean;
	layersOpen: boolean;
	dispatch: Dispatch<EditorAction>;
	onLayers: () => void;
}>;

/**
 * The tools, then the colour and the layers, which stay at the bar's far end
 * while the tools scroll past them on a narrow bar (`editor.css`).
 */
const ToolButtons = ({
	tool,
	fill,
	colourOpen,
	layersOpen,
	dispatch,
	onLayers,
}: ToolButtonsProps) => (
	<>
		{TOOLS.map((each) => {
			const Icon = ICONS[each.id];
			return (
				<ToolButton
					key={each.id}
					icon={<Icon />}
					label={t(`tools.${each.id}`)}
					shortcut={shortcutLabel(each.id)}
					pressed={each.id === tool.id}
					onClick={() => dispatch({ type: 'setTool', toolId: each.id })}
				/>
			);
		})}
		<span className="tool-group-end">
			<ToolButton
				icon={<ColourIcon />}
				label={t('editor.colour.title')}
				pressed={colourOpen}
				badge={<Swatch colour={fill} />}
				onClick={() => dispatch({ type: 'togglePanel', panel: 'colour' })}
			/>
			<ToolButton
				icon={<LayersIcon />}
				label={t('layers.title')}
				pressed={layersOpen}
				onClick={onLayers}
			/>
		</span>
	</>
);

type FramePanelsProps = Readonly<{
	sizeClass: SizeClass;
	panel: PanelId | undefined;
	dockShown: boolean;
	onCloseDock: () => void;
	onClosePanel: () => void;
	/** The layers panel, with the close of whatever holds it. */
	layers: (onClose: () => void) => ReactNode;
	colour: ReactNode;
	properties: ReactNode;
}>;

/**
 * Where the panels go. Expanded: the layers over the properties in the dock,
 * and the colour, which is picked and put away rather than kept beside the
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
	colour,
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
					open={panel === 'colour'}
					onClose={onClosePanel}
					label={t('editor.colour.title')}
				>
					{colour}
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
			label={panel === 'colour' ? t('editor.colour.title') : t('layers.title')}
		>
			{panel === 'colour' ? colour : layers(onClosePanel)}
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
}>;

/** The frame with a drawing open in it. */
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
}: FrameProps) => {
	const wide = useMinWidth(LARGE_MIN_WIDTH);
	const compact = sizeClass === 'compact';
	const expanded = sizeClass === 'expanded';
	const dockShown = expanded && (state.dockOpen ?? wide);
	const setColour = (which: ColourSlot, value: string) =>
		dispatch({ type: 'setColour', which, value });
	const closePanel = () => dispatch({ type: 'closePanel' });
	const closeDock = () => dispatch({ type: 'setDockOpen', open: false });
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
			colourOpen={state.panel === 'colour'}
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
			<div className="editor-canvas">
				<Viewport
					ref={viewport}
					document={document}
					tool={tool}
					options={state.options}
					layerId={activeLayerId}
					onColour={setColour}
					onNotify={(message) => dispatch({ type: 'notify', message })}
					onScale={onScale}
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
				colour={
					<ColourPanel
						options={state.options}
						recent={state.recentColours}
						onColour={setColour}
						onSwap={() => dispatch({ type: 'swapColours' })}
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
	const viewport = useRef<ViewportHandle>(null);
	const activeLayerId = activeLayerIn(snapshot?.layers ?? [], state.activeLayerId);

	useEditorKeys(document, viewport, activeLayerId, dispatch);
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
	const closeLibrary = () => dispatch({ type: 'setLibraryOpen', open: false });
	const zoomItems: readonly MenuItem[] = [
		{
			id: 'fit',
			label: t('editor.zoom.fit'),
			shortcut: chord('0'),
			onSelect: () => viewport.current?.fit(),
		},
		{
			id: 'actual',
			label: t('editor.zoom.actual'),
			shortcut: chord('1'),
			onSelect: () => viewport.current?.actualSize(),
		},
		{
			id: 'in',
			label: t('editor.zoom.in'),
			shortcut: chord('+'),
			onSelect: () => viewport.current?.zoomIn(),
		},
		{
			id: 'out',
			label: t('editor.zoom.out'),
			shortcut: chord('-'),
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
			/>
			{libraryDrawer}
		</>
	);
};
