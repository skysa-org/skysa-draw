import { ROOT } from '@skysa/draw-core';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import { createFolder } from '../../store/folders.js';
import { useFolders } from '../../store/hooks.js';

/** A field that takes the focus as it appears, the way a prompt would. */
const NameField = ({
	value,
	invalid,
	onChange,
}: {
	value: string;
	invalid: boolean;
	onChange: (value: string) => void;
}) => {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);
	return (
		<label>
			<span className="visually-hidden">{t('folders.name')}</span>
			<input
				ref={ref}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				aria-invalid={invalid}
			/>
		</label>
	);
};

/**
 * The folders, flat for now: every folder of the connection, by path, under
 * "All drawings" for the root. Nesting shows as the path.
 */
export const Sidebar = ({
	folderPath,
	onOpen,
}: {
	folderPath: string;
	onOpen: (path: string) => void;
}) => {
	const db = useDb();
	const folders = useFolders();
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState('');
	const [refused, setRefused] = useState<string | undefined>(undefined);

	const submit = (event: SyntheticEvent) => {
		event.preventDefault();
		void createFolder(db, name, { unnamed: t('folders.unnamed') }).then((made) => {
			if (made === undefined) {
				setRefused(t('folders.exists', { name: name.trim() }));
				return;
			}
			setName('');
			setRefused(undefined);
			setAdding(false);
			onOpen(made.path);
		});
	};

	return (
		<nav className="sidebar" aria-label={t('shell.panes.folders')}>
			<ul className="folder-list">
				<li>
					<button
						type="button"
						className="folder-row"
						aria-current={folderPath === ROOT ? 'page' : undefined}
						onClick={() => onOpen(ROOT)}
					>
						{t('folders.all')}
					</button>
				</li>
				{(folders ?? []).map((folder) => (
					<li key={folder.id}>
						<button
							type="button"
							className="folder-row"
							aria-current={folderPath === folder.path ? 'page' : undefined}
							onClick={() => onOpen(folder.path)}
						>
							{folder.path}
						</button>
					</li>
				))}
			</ul>
			{adding ? (
				<form className="inline-form" onSubmit={submit}>
					<NameField value={name} invalid={refused !== undefined} onChange={setName} />
					{refused !== undefined && (
						<p className="form-error" role="alert">
							{refused}
						</p>
					)}
					<div className="inline-actions">
						<button type="submit" className="primary">
							{t('folders.create')}
						</button>
						<button
							type="button"
							className="ghost"
							onClick={() => {
								setAdding(false);
								setRefused(undefined);
							}}
						>
							{t('common.cancel')}
						</button>
					</div>
				</form>
			) : (
				<button type="button" className="ghost" onClick={() => setAdding(true)}>
					{t('folders.new')}
				</button>
			)}
		</nav>
	);
};
