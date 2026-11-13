import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import { LOCAL_CONNECTION_ID } from '../../store/db.js';
import { createDrawing } from '../../store/drawings.js';
import { useDrawings } from '../../store/hooks.js';
import { keeping } from '../../store/keeping.js';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The drawings in the open folder, newest change first, and the way to make one. */
export const DrawingList = ({
	folderPath,
	openId,
	onOpen,
}: {
	folderPath: string;
	openId: string | undefined;
	onOpen: (id: string) => void;
}) => {
	const db = useDb();
	const drawings = useDrawings(folderPath);

	return (
		<section className="drawing-list" aria-label={t('shell.panes.drawings')}>
			<div className="pane-bar">
				<button
					type="button"
					className="primary"
					onClick={() => {
						void createDrawing(db, { title: t('drawings.untitled'), folderPath }).then(
							(made) => {
								// A drawing in the device's own library exists nowhere else:
								// the moment the browser can be asked to keep it, prompt
								// and all, once per device (`store/keeping.ts`).
								if (made.connectionId === LOCAL_CONNECTION_ID) {
									void keeping.ask(db, 'first-drawing');
								}
								onOpen(made.id);
							}
						);
					}}
				>
					{t('drawings.new')}
				</button>
			</div>
			{drawings !== undefined && drawings.length === 0 && (
				<p className="pane-empty">{t('drawings.none')}</p>
			)}
			<ul>
				{(drawings ?? []).map((drawing) => (
					<li key={drawing.id}>
						<button
							type="button"
							className="drawing-row"
							aria-current={drawing.id === openId ? 'true' : undefined}
							onClick={() => onOpen(drawing.id)}
						>
							<span className="drawing-row-title">{drawing.title}</span>
							<span className="drawing-row-when">
								{t('drawings.changed', { when: when.format(drawing.updatedAt) })}
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
};
