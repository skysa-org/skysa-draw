import { slugify } from '@skysa/draw-core';
import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import { ColorField } from '../../components/ui/ColorField.js';
import { Panel } from '../../components/ui/Panel.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { Select } from '../../components/ui/Select.js';
import { useSizeClass } from '../../components/ui/sizeClass.js';
import { type MessageKey, t } from '../../i18n/t.js';
import type { EditorDocument } from '../document/model.js';
import { canvasBox } from './box.js';
import { download, fileName } from './download.js';
import {
	DEFAULT_BACKGROUND,
	EXPORT_MAX_SIDE,
	exportBlob,
	type ExportFormat,
	exportSize,
} from './render.js';

/**
 * The export dialog (docs/ARCHITECTURE.md §7, "Export"): the format, the
 * scale with the pixels it makes, a JPEG's background and the file's name,
 * in a sheet on a compact window and a drawer elsewhere. The file is made on
 * this device and saved to it; nothing of it reaches the API.
 */

const FORMAT_KEYS = {
	png: 'exporting.formats.png',
	jpeg: 'exporting.formats.jpeg',
	webp: 'exporting.formats.webp',
	svg: 'exporting.formats.svg',
} as const satisfies Record<ExportFormat, MessageKey>;

const FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp', 'svg'];

const FORMAT_OPTIONS = FORMATS.map((format) => ({ value: format, label: t(FORMAT_KEYS[format]) }));

/** The extension shown after the name: the one the file is given where the browser makes what was asked. */
const EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
	png: 'png',
	jpeg: 'jpg',
	webp: 'webp',
	svg: 'svg',
};

/** The scales offered, as the select holds them: pixels a user unit. */
const SCALES = ['0.5', '1', '2', '3', '4'] as const;

type Scale = (typeof SCALES)[number];

const SCALE_OPTIONS = SCALES.map((scale) => ({
	value: scale,
	label: t('exporting.scaleOption', { n: Number(scale) }),
}));

/** What the user chose, kept while the drawing is open, so a second export starts where the first left off. */
type Choices = Readonly<{ format: ExportFormat; scale: Scale; background: string }>;

const FIRST_CHOICES: Choices = { format: 'png', scale: '1', background: DEFAULT_BACKGROUND };

/** The form, mounted while the dialog is open: its name, its busy state and its failure are each opening's own. */
const ExportForm = ({
	document,
	title,
	choices,
	onChoose,
	onClose,
}: Readonly<{
	document: EditorDocument;
	title: string;
	choices: Choices;
	onChoose: (choices: Choices) => void;
	onClose: () => void;
}>) => {
	const nameId = useId();
	const [name, setName] = useState(() => slugify(title));
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	// Closed while it rendered: the result is dropped, and nothing is saved.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const { format, scale, background } = choices;
	const size = exportSize(canvasBox(document), Number(scale));

	const finish = (blob: Blob | undefined) => {
		if (!mounted.current) return;
		setBusy(false);
		if (blob === undefined) {
			setFailed(true);
			return;
		}
		download(blob, fileName(name, title, blob.type));
		onClose();
	};

	const onSubmit = (event: SyntheticEvent) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setFailed(false);
		const behind = format === 'jpeg' ? background : undefined;
		void exportBlob(document, format, Number(scale), behind).then(finish, () =>
			finish(undefined)
		);
	};

	return (
		<Panel title={t('exporting.title')} onClose={onClose} className="export-panel">
			<form className="export-form" onSubmit={onSubmit} aria-busy={busy}>
				<Select
					label={t('exporting.format')}
					value={format}
					options={FORMAT_OPTIONS}
					onChange={(next) => onChoose({ ...choices, format: next })}
				/>
				{format === 'svg' ? (
					<p className="export-note">{t('exporting.svgNote')}</p>
				) : (
					<>
						<Select
							label={t('exporting.scale')}
							value={scale}
							options={SCALE_OPTIONS}
							onChange={(next) => onChoose({ ...choices, scale: next })}
						/>
						<p className="export-size">
							{t('exporting.size', { width: size.width, height: size.height })}
						</p>
						{size.capped && (
							<p className="export-note">
								{t('exporting.capped', { max: EXPORT_MAX_SIDE })}
							</p>
						)}
					</>
				)}
				{format === 'jpeg' && (
					<ColorField
						label={t('exporting.background')}
						value={background}
						onChange={(next) => onChoose({ ...choices, background: next })}
					/>
				)}
				<div className="export-name">
					<label htmlFor={nameId} className="field-label">
						{t('exporting.name')}
					</label>
					<input
						id={nameId}
						type="text"
						value={name}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						onChange={(event) => setName(event.target.value)}
					/>
					<span className="export-extension">.{EXTENSIONS[format]}</span>
				</div>
				{failed && (
					<p role="alert" className="form-error">
						{t('exporting.failed')}
					</p>
				)}
				<div className="export-actions">
					<button type="button" onClick={onClose}>
						{t('common.cancel')}
					</button>
					<button type="submit" className="primary" disabled={busy}>
						{busy ? t('exporting.busy') : t('exporting.export')}
					</button>
				</div>
			</form>
		</Panel>
	);
};

/**
 * The dialog, for the frame's More menu. `title` is the drawing's, whose slug
 * the file is named by until the user names it otherwise. Closing it while it
 * renders drops the render: nothing is saved.
 */
export const ExportDialog = ({
	document,
	title,
	open,
	onClose,
}: Readonly<{ document: EditorDocument; title: string; open: boolean; onClose: () => void }>) => {
	const sizeClass = useSizeClass();
	const [choices, setChoices] = useState<Choices>(FIRST_CHOICES);
	return (
		<PanelHost
			placement={sizeClass === 'compact' ? 'sheet' : 'drawer'}
			open={open}
			onClose={onClose}
			label={t('exporting.title')}
		>
			<ExportForm
				document={document}
				title={title}
				choices={choices}
				onChoose={setChoices}
				onClose={onClose}
			/>
		</PanelHost>
	);
};
