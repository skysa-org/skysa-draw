import { emptyDrawing } from '@skysa/draw-core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import type * as DownloadModule from '../../src/drawing/export/download.js';
import { download } from '../../src/drawing/export/download.js';
import { ExportDialog } from '../../src/drawing/export/ExportDialog.js';
import { t } from '../../src/i18n/t.js';
import { stubWindowWidth } from './support.js';

/**
 * The export dialog (docs/ARCHITECTURE.md §7, "Export") over a real document,
 * with the download taken out, so what would be saved, its name and its type
 * are what the test reads. jsdom has no canvas: where a test renders, the 2D
 * context, `toBlob` and `decode` are stand-ins, as in `render.test.ts`.
 */

vi.mock('../../src/drawing/export/download.js', async (importOriginal) => ({
	...(await importOriginal<typeof DownloadModule>()),
	download: vi.fn(),
}));

const DRAWING_ID = '11111111-2222-4333-8444-555555555555';

const open = (): EditorDocument => {
	const document = openDocument(emptyDrawing({ id: DRAWING_ID, title: 'Floor plan' }));
	if (document === undefined) throw new Error('a drawing opens');
	return document;
};

let contextShown = true;
let release: (() => void) | undefined;

beforeEach(() => {
	contextShown = true;
	release = undefined;
	vi.mocked(download).mockClear();
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
		() =>
			(contextShown
				? { fillStyle: '', fillRect: () => undefined, drawImage: () => undefined }
				: null) as never
	);
	vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => {
		setTimeout(() => callback(new Blob(['pixels'], { type: type ?? 'image/png' })), 0);
	});
	Object.defineProperty(HTMLImageElement.prototype, 'decode', {
		configurable: true,
		writable: true,
		value: () =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
	Reflect.deleteProperty(window, 'matchMedia');
});

const show = (document = open(), onClose = vi.fn()) => {
	render(<ExportDialog document={document} title="Floor plan" open onClose={onClose} />);
	return { document, onClose };
};

const dialog = () => screen.getByRole('dialog', { name: t('exporting.title') });

const exportButton = () => within(dialog()).getByRole('button', { name: t('exporting.export') });

/** Lets the render's picture decode, once it has been asked for. */
const decodeNow = async () => {
	await waitFor(() => expect(release).toBeDefined());
	release?.();
};

describe('ExportDialog', () => {
	it('renders nothing while closed', () => {
		render(
			<ExportDialog document={open()} title="Floor plan" open={false} onClose={vi.fn()} />
		);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('shows the format, the scale with its pixels, the name and the two buttons', () => {
		show();
		const within_ = within(dialog());
		expect(within_.getByRole('combobox', { name: t('exporting.format') })).toHaveProperty(
			'value',
			'png'
		);
		expect(within_.getByRole('combobox', { name: t('exporting.scale') })).toHaveProperty(
			'value',
			'1'
		);
		expect(within_.getByText('1,600 × 1,000 px')).toBeTruthy();
		expect(within_.getByRole('textbox', { name: t('exporting.name') })).toHaveProperty(
			'value',
			'floor-plan'
		);
		expect(within_.getByText('.png')).toBeTruthy();
		expect(within_.getByRole('button', { name: t('common.cancel') })).toBeTruthy();
		expect(exportButton()).toBeTruthy();
		// A drawer, as on any window that is not compact.
		expect(dialog().classList.contains('panel-drawer')).toBe(true);
	});

	it('computes the pixels for the scale chosen', async () => {
		show();
		const user = userEvent.setup();
		await user.selectOptions(screen.getByRole('combobox', { name: t('exporting.scale') }), '3');
		expect(screen.getByText('4,800 × 3,000 px')).toBeTruthy();
		await user.selectOptions(
			screen.getByRole('combobox', { name: t('exporting.scale') }),
			'0.5'
		);
		expect(screen.getByText('800 × 500 px')).toBeTruthy();
	});

	it('offers a background for JPEG alone, and no scale for SVG', async () => {
		show();
		const user = userEvent.setup();
		expect(screen.queryByLabelText(t('exporting.background'))).toBeNull();
		await user.selectOptions(
			screen.getByRole('combobox', { name: t('exporting.format') }),
			'jpeg'
		);
		expect(screen.getByLabelText(t('exporting.background'))).toBeTruthy();
		expect(screen.getByText('.jpg')).toBeTruthy();
		await user.selectOptions(
			screen.getByRole('combobox', { name: t('exporting.format') }),
			'svg'
		);
		expect(screen.queryByRole('combobox', { name: t('exporting.scale') })).toBeNull();
		expect(screen.queryByText(/ px$/)).toBeNull();
		expect(screen.getByText(t('exporting.svgNote'))).toBeTruthy();
	});

	it('saves the SVG as the drawing’s own text, named by its title, and closes', async () => {
		const { document, onClose } = show();
		const user = userEvent.setup();
		await user.selectOptions(
			screen.getByRole('combobox', { name: t('exporting.format') }),
			'svg'
		);
		await user.click(exportButton());
		await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
		const [blob, name] = vi.mocked(download).mock.calls[0] ?? [];
		expect(name).toBe('floor-plan.svg');
		expect(blob?.type).toBe('image/svg+xml');
		await expect(blob?.text()).resolves.toBe(document.text());
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('is busy while it renders, then saves a PNG under the name typed', async () => {
		const { onClose } = show();
		const user = userEvent.setup();
		const name = screen.getByRole('textbox', { name: t('exporting.name') });
		await user.clear(name);
		await user.type(name, 'Site plan.png');
		await user.click(exportButton());
		const busy = within(dialog()).getByRole('button', { name: t('exporting.busy') });
		expect(busy).toHaveProperty('disabled', true);
		expect(download).not.toHaveBeenCalled();
		await decodeNow();
		await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
		const [blob, saved] = vi.mocked(download).mock.calls[0] ?? [];
		expect(saved).toBe('Site plan.png');
		expect(blob?.type).toBe('image/png');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('starts the focus on the format, and exports on Enter from it, busy while it renders', async () => {
		const { onClose } = show();
		const format = within(dialog()).getByRole('combobox', { name: t('exporting.format') });
		await waitFor(() => expect(document.activeElement).toBe(format));
		fireEvent.keyDown(format, { key: 'Enter' });
		expect(within(dialog()).getByRole('button', { name: t('exporting.busy') })).toHaveProperty(
			'disabled',
			true
		);
		expect(dialog().querySelector('form')?.getAttribute('aria-busy')).toBe('true');
		expect(onClose).not.toHaveBeenCalled();
		await decodeNow();
		await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('names the file by the title again where the name is left empty', async () => {
		show();
		const user = userEvent.setup();
		await user.clear(screen.getByRole('textbox', { name: t('exporting.name') }));
		await user.selectOptions(
			screen.getByRole('combobox', { name: t('exporting.format') }),
			'webp'
		);
		await user.click(exportButton());
		await decodeNow();
		await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
		expect(vi.mocked(download).mock.calls[0]?.[1]).toBe('floor-plan.webp');
	});

	it('says so where the drawing could not be rendered, and saves nothing', async () => {
		contextShown = false;
		const { onClose } = show();
		await userEvent.setup().click(exportButton());
		expect(await screen.findByRole('alert')).toHaveProperty(
			'textContent',
			t('exporting.failed')
		);
		expect(download).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(exportButton()).toHaveProperty('disabled', false);
	});

	it('says when the scale asks for more pixels than an export has', async () => {
		const document = openDocument(
			emptyDrawing({ id: DRAWING_ID, size: { width: 5000, height: 2500 } })
		);
		if (document === undefined) throw new Error('a drawing opens');
		show(document);
		await userEvent
			.setup()
			.selectOptions(screen.getByRole('combobox', { name: t('exporting.scale') }), '4');
		expect(screen.getByText('16,384 × 8,192 px')).toBeTruthy();
		expect(screen.getByText(t('exporting.capped', { max: 16_384 }))).toBeTruthy();
	});

	it('drops a render it was closed during: nothing is saved', async () => {
		const document = open();
		const onClose = vi.fn();
		const { rerender } = render(
			<ExportDialog document={document} title="Floor plan" open onClose={onClose} />
		);
		await userEvent.setup().click(exportButton());
		rerender(
			<ExportDialog document={document} title="Floor plan" open={false} onClose={onClose} />
		);
		await decodeNow();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(download).not.toHaveBeenCalled();
	});

	it('keeps the choices for the next time it opens, and the name follows the title', async () => {
		const document = open();
		const onClose = vi.fn();
		const { rerender } = render(
			<ExportDialog document={document} title="Floor plan" open onClose={onClose} />
		);
		await userEvent
			.setup()
			.selectOptions(screen.getByRole('combobox', { name: t('exporting.format') }), 'jpeg');
		rerender(
			<ExportDialog document={document} title="Floor plan" open={false} onClose={onClose} />
		);
		rerender(<ExportDialog document={document} title="Site plan" open onClose={onClose} />);
		expect(screen.getByRole('combobox', { name: t('exporting.format') })).toHaveProperty(
			'value',
			'jpeg'
		);
		expect(screen.getByRole('textbox', { name: t('exporting.name') })).toHaveProperty(
			'value',
			'site-plan'
		);
	});

	it('is a sheet on a compact window', () => {
		stubWindowWidth('compact');
		show();
		expect(dialog().classList.contains('panel-sheet')).toBe(true);
	});
});

describe('the file saved', () => {
	const actual = () =>
		vi.importActual<typeof DownloadModule>('../../src/drawing/export/download.js');

	it('is named by what was typed, less what a file system refuses, with the type’s extension', async () => {
		const { fileName } = await actual();
		expect(fileName('floor-plan', 'Floor plan', 'image/png')).toBe('floor-plan.png');
		expect(fileName('Site plan', 'Floor plan', 'image/jpeg')).toBe('Site plan.jpg');
		expect(fileName('plan.PNG', 'Floor plan', 'image/png')).toBe('plan.png');
		expect(fileName('a/b:c', 'Floor plan', 'image/webp')).toBe('a b c.webp');
		expect(fileName('.hidden', 'Floor plan', 'image/svg+xml')).toBe('hidden.svg');
		expect(fileName('   ', 'Floor plan', 'image/png')).toBe('floor-plan.png');
		// A WebP the browser could only make as PNG is not named .webp.
		expect(fileName('plan.webp', 'Floor plan', 'image/png')).toBe('plan.png');
	});

	it('is saved through a link to a blob: URL, clicked, taken away, and the URL let go after', async () => {
		const { download: save } = await actual();
		vi.useFakeTimers();
		try {
			const revoke = vi.spyOn(URL, 'revokeObjectURL');
			vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved');
			const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
				const link = click.mock.contexts.at(-1) as HTMLAnchorElement;
				expect(link.isConnected).toBe(true);
				expect(link.getAttribute('href')).toBe('blob:saved');
				expect(link.getAttribute('download')).toBe('floor-plan.png');
			});
			save(new Blob(['pixels'], { type: 'image/png' }), 'floor-plan.png');
			expect(click).toHaveBeenCalledTimes(1);
			expect((click.mock.contexts[0] as HTMLAnchorElement).isConnected).toBe(false);
			expect(revoke).not.toHaveBeenCalled();
			vi.runAllTimers();
			expect(revoke).toHaveBeenCalledWith('blob:saved');
		} finally {
			vi.useRealTimers();
		}
	});
});
