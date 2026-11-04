import { type SyntheticEvent, useEffect, useMemo, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import { deleteDrawing, renameDrawing } from '../../store/drawings.js';
import { useDrawing } from '../../store/hooks.js';

/**
 * The SVG as an image: a `blob:` URL in an `<img>`, which the browser renders
 * with no script of the file's running and no reach into the page. The editor
 * (docs/ARCHITECTURE.md §7, "The editor") will put the drawing into the DOM
 * through a sanitizer instead, so it can be worked on; until then this is how
 * a drawing is looked at, and it is how a file from elsewhere will stay shown
 * when it holds something the editor does not take.
 */
const useObjectUrl = (text: string | undefined): string | undefined => {
	const url = useMemo(
		() =>
			text === undefined
				? undefined
				: URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })),
		[text]
	);
	useEffect(
		() => () => {
			if (url !== undefined) URL.revokeObjectURL(url);
		},
		[url]
	);
	return url;
};

/** A field that takes the focus as it appears, the way a prompt would. */
const TitleField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<label>
			<span className="visually-hidden">{t('drawings.title')}</span>
			<input ref={ref} value={value} onChange={(event) => onChange(event.target.value)} />
		</label>
	);
};

type Asking = 'nothing' | 'rename' | 'delete';

export const DrawingView = ({
	id,
	onDeleted,
}: {
	id: string | undefined;
	onDeleted: () => void;
}) => {
	const db = useDb();
	const drawing = useDrawing(id);
	const url = useObjectUrl(drawing?.text);
	const [asking, setAsking] = useState<Asking>('nothing');
	const [title, setTitle] = useState('');

	if (id === undefined || drawing === undefined) {
		return (
			<section className="drawing-view" aria-label={t('shell.panes.drawing')}>
				<p className="pane-empty">{t('drawings.nothingOpen')}</p>
			</section>
		);
	}

	const rename = (event: SyntheticEvent) => {
		event.preventDefault();
		void renameDrawing(db, drawing.id, title).then(() => setAsking('nothing'));
	};

	return (
		<section className="drawing-view" aria-label={t('shell.panes.drawing')}>
			<header className="pane-bar">
				{asking === 'rename' && (
					<form className="inline-form" onSubmit={rename}>
						<TitleField value={title} onChange={setTitle} />
						<div className="inline-actions">
							<button type="submit" className="primary">
								{t('drawings.save')}
							</button>
							<button
								type="button"
								className="ghost"
								onClick={() => setAsking('nothing')}
							>
								{t('common.cancel')}
							</button>
						</div>
					</form>
				)}
				{asking === 'delete' && (
					<div
						className="inline-form"
						role="alertdialog"
						aria-label={t('drawings.delete')}
					>
						<span>{t('drawings.confirmDelete', { title: drawing.title })}</span>
						<div className="inline-actions">
							<button
								type="button"
								className="primary"
								onClick={() => {
									void deleteDrawing(db, drawing.id).then(onDeleted);
								}}
							>
								{t('drawings.delete')}
							</button>
							<button
								type="button"
								className="ghost"
								onClick={() => setAsking('nothing')}
							>
								{t('common.cancel')}
							</button>
						</div>
					</div>
				)}
				{asking === 'nothing' && (
					<>
						<h1 className="drawing-title">{drawing.title}</h1>
						<button
							type="button"
							className="ghost"
							onClick={() => {
								setTitle(drawing.title);
								setAsking('rename');
							}}
						>
							{t('drawings.rename')}
						</button>
						<button type="button" className="ghost" onClick={() => setAsking('delete')}>
							{t('drawings.delete')}
						</button>
					</>
				)}
			</header>
			<div className="drawing-canvas">
				{url !== undefined && (
					<img src={url} alt={t('drawings.preview', { title: drawing.title })} />
				)}
			</div>
		</section>
	);
};
