import { ROOT } from '@skysa/draw-core';
import { useRouterState } from '@tanstack/react-router';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import { createFolder } from '../../store/folders.js';
import { useFolders } from '../../store/hooks.js';
import { AccountPanel, returnPath } from '../account/AccountPanel.js';
import { SourcePanel } from '../sources/SourcePanel.js';

/** A field that takes the focus as it appears, the way a prompt would. */
const NameField = ({
	value,
	invalid,
	onChange,
}: Readonly<{
	value: string;
	invalid: boolean;
	onChange: (value: string) => void;
}>) => {
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
 * The library's first column: the sources at its top (`SourcePanel`), with the
 * account panel of the one showing under them, and then the folders of that
 * source, flat for now: every folder by path, under "All drawings" for the
 * root. Nesting shows as the path.
 *
 * Wherever the library is, so are the sources: the first column of the
 * library on a wide window, the drawer from the editor's top bar while a
 * drawing is open, and the screen before the drawing on a phone.
 */
export const Sidebar = ({
	folderPath,
	enterCode,
	onOpen,
}: Readonly<{
	folderPath: string;
	/** How many times the app's URL has asked for the code field (`useEnterCode`). */
	enterCode?: number;
	onOpen: (path: string) => void;
}>) => {
	const db = useDb();
	const folders = useFolders();
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState('');
	const [refused, setRefused] = useState<string | undefined>(undefined);
	// Back to exactly here from the provider's consent page, minus the outcome
	// of any connect before this one.
	const returnTo = returnPath(useRouterState({ select: (state) => state.location.href }));

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
		<div className="sidebar">
			<SourcePanel
				returnTo={returnTo}
				{...(enterCode === undefined ? {} : { enterCode })}
				account={(slot) => <AccountPanel slot={slot} />}
			/>
			<nav className="folder-nav" aria-label={t('shell.panes.folders')}>
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
						<NameField
							value={name}
							invalid={refused !== undefined}
							onChange={setName}
						/>
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
		</div>
	);
};
