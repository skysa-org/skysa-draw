import { type SyntheticEvent, useEffect, useRef, useState } from 'react';

import { IconButton } from '../components/ui/IconButton.js';
import { BackIcon, LibraryIcon, MoreIcon, RedoIcon, UndoIcon } from '../components/ui/icons.js';
import { Menu, type MenuItem } from '../components/ui/Menu.js';
import type { SizeClass } from '../components/ui/sizeClass.js';
import { t } from '../i18n/t.js';
import type { SavingState } from './useOpenDrawing.js';

/**
 * The bar over the canvas on every size (docs/ARCHITECTURE.md §7, "The
 * interface"): the way back to the library, the title, undo and redo, and the
 * rest under More; on medium and expanded the zoom and whether the drawing is
 * saved as well, which on compact are under More and nowhere, so that back,
 * title, undo, redo and More fit a phone. Renaming and deleting happen here,
 * in the bar, where the title is; placing a picture and exporting are under
 * More, as a File menu has them, then the Image operations, as Photoshop's
 * Image menu has them (`panels/imageMenu.tsx`), each kind a group of its own.
 */

type TopBarProps = Readonly<{
	title: string;
	sizeClass: SizeClass;
	/** Compact: the library is the screen before the drawing. */
	onBack: () => void;
	/** Medium and expanded: the library is a drawer from here. */
	onOpenLibrary: () => void;
	canUndo: boolean;
	canRedo: boolean;
	onUndo: () => void;
	onRedo: () => void;
	saving: SavingState;
	/** The zoom, as a whole percentage. */
	zoomPercent: number;
	/** Fit, actual size, in and out: a menu of their own, or under More on compact. */
	zoomItems: readonly MenuItem[];
	onRename: (title: string) => Promise<void>;
	/** Deletes the drawing; the frame leaves the editor after it. */
	onDelete: () => Promise<void>;
	/** Opens the export dialog; absent while there is no drawing to export. */
	onExport?: () => void;
	/** Asks for a picture to place as a new layer; absent while there is no drawing to place it in. */
	onPlacePicture?: () => void;
	/** Image size…, Canvas size… and the rest, between Export and Rename; none while there is no drawing to change. */
	imageItems?: readonly MenuItem[];
}>;

type Asking = 'nothing' | 'rename' | 'delete';

/** A field that takes the focus as it appears, the way a prompt would. */
const TitleField = ({
	value,
	onChange,
	onCancel,
}: Readonly<{ value: string; onChange: (value: string) => void; onCancel: () => void }>) => {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<label className="top-bar-field">
			<span className="visually-hidden">{t('drawings.title')}</span>
			<input
				ref={ref}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
					// The field's, not the editor's: Escape here leaves the name as it was.
					event.preventDefault();
					event.stopPropagation();
					onCancel();
				}}
			/>
		</label>
	);
};

/** `items` as a group of their own in a menu: a rule before the first. */
const group = (items: readonly MenuItem[]): readonly MenuItem[] =>
	items.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item));

const statusText = (saving: SavingState): string => {
	if (saving === 'saving') return t('editor.saving');
	if (saving === 'saved') return t('editor.saved');
	return '';
};

/** Rename's form, in place of the title. */
const RenameForm = ({
	title,
	onRename,
	onDone,
}: Readonly<{
	title: string;
	onRename: (title: string) => Promise<void>;
	onDone: () => void;
}>) => {
	const [draft, setDraft] = useState(title);
	const submit = (event: SyntheticEvent) => {
		event.preventDefault();
		// The bar goes back to the title whether or not the store took the name:
		// a drawing deleted meanwhile has nothing left to rename.
		void onRename(draft).then(onDone, onDone);
	};
	return (
		<form className="inline-form" onSubmit={submit}>
			<TitleField value={draft} onChange={setDraft} onCancel={onDone} />
			<div className="inline-actions">
				<button type="submit" className="primary">
					{t('drawings.save')}
				</button>
				<button type="button" className="ghost" onClick={onDone}>
					{t('common.cancel')}
				</button>
			</div>
		</form>
	);
};

/** Delete's question, in place of the title. */
const DeleteQuestion = ({
	title,
	onDelete,
	onDone,
}: Readonly<{ title: string; onDelete: () => Promise<void>; onDone: () => void }>) => (
	<div className="inline-form" role="alertdialog" aria-label={t('drawings.delete')}>
		<span>{t('drawings.confirmDelete', { title })}</span>
		<div className="inline-actions">
			<button
				type="button"
				className="primary"
				onClick={() => {
					void onDelete();
				}}
			>
				{t('drawings.delete')}
			</button>
			<button type="button" className="ghost" onClick={onDone}>
				{t('common.cancel')}
			</button>
		</div>
	</div>
);

export const TopBar = ({
	title,
	sizeClass,
	onBack,
	onOpenLibrary,
	canUndo,
	canRedo,
	onUndo,
	onRedo,
	saving,
	zoomPercent,
	zoomItems,
	onRename,
	onDelete,
	onExport,
	onPlacePicture,
	imageItems = [],
}: TopBarProps) => {
	const [asking, setAsking] = useState<Asking>('nothing');
	const compact = sizeClass === 'compact';
	const done = () => setAsking('nothing');

	const items: readonly MenuItem[] = [
		{
			id: 'place',
			label: t('editor.placePicture'),
			disabled: onPlacePicture === undefined,
			onSelect: () => onPlacePicture?.(),
		},
		{
			id: 'export',
			label: t('editor.export'),
			disabled: onExport === undefined,
			onSelect: () => onExport?.(),
		},
		...group(imageItems),
		...group([
			{ id: 'rename', label: t('drawings.rename'), onSelect: () => setAsking('rename') },
			{
				id: 'delete',
				label: t('drawings.delete'),
				onSelect: () => setAsking('delete'),
				danger: true,
			},
		]),
		...group(compact ? zoomItems : []),
	];
	const zoomLabel = t('editor.zoom.level', { percent: zoomPercent });

	return (
		<header className="top-bar">
			{compact ? (
				<IconButton icon={<BackIcon />} label={t('editor.back')} onClick={onBack} />
			) : (
				<IconButton
					icon={<LibraryIcon />}
					label={t('editor.library')}
					onClick={onOpenLibrary}
				/>
			)}
			{asking === 'rename' && <RenameForm title={title} onRename={onRename} onDone={done} />}
			{asking === 'delete' && (
				<DeleteQuestion title={title} onDelete={onDelete} onDone={done} />
			)}
			{asking === 'nothing' && (
				// A double-click on the title renames it, as a file's name in a
				// desktop editor's title bar does; More's Rename is the way from the keyboard.
				<h1
					className="top-bar-title"
					title={t('drawings.renameHint')}
					onDoubleClick={() => setAsking('rename')}
				>
					{title}
				</h1>
			)}
			{/* Always there, so a screen reader hears it change; empty on compact,
			    where the bar has no room for it. */}
			<span role="status" className="top-bar-status">
				{compact ? '' : statusText(saving)}
			</span>
			{asking === 'nothing' && (
				<>
					<IconButton
						icon={<UndoIcon />}
						label={t('editor.undo')}
						onClick={onUndo}
						disabled={!canUndo}
					/>
					<IconButton
						icon={<RedoIcon />}
						label={t('editor.redo')}
						onClick={onRedo}
						disabled={!canRedo}
					/>
					{!compact && (
						<Menu
							label={zoomLabel}
							icon={<span className="top-bar-zoom">{zoomLabel}</span>}
							items={zoomItems}
							align="end"
						/>
					)}
					<Menu label={t('editor.more')} icon={<MoreIcon />} items={items} align="end" />
				</>
			)}
		</header>
	);
};
