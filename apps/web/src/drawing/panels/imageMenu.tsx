import { type ReactNode, useState } from 'react';

import type { MenuItem } from '../../components/ui/Menu.js';
import { t } from '../../i18n/t.js';
import {
	type CanvasJob,
	type CanvasTurn,
	resizeCanvas,
	resizeImage,
	revealAll,
	rotateCanvas,
	trimCanvas,
	turnCanvas,
} from '../document/canvasOps.js';
import { canvasBoxOf } from '../document/crop.js';
import type { EditorDocument } from '../document/model.js';
import { layerExtentIn } from '../viewport/layerExtent.js';
import { CanvasSizeDialog } from './CanvasSizeDialog.js';
import { ImageSizeDialog } from './ImageSizeDialog.js';
import { RotateDialog } from './RotateDialog.js';
import { TrimDialog } from './TrimDialog.js';

/**
 * The drawing's Image operations (docs/decisions/0004-the-interface.md), as
 * Photoshop's Image menu has them and in its order, for the top bar's More:
 * Image size…, Canvas size…, Image rotation with its fixed turns and flips
 * and Arbitrary…, Trim…, and Reveal all (`document/canvasOps.ts`). The
 * fixed turns and flips and Reveal all are done at once; the others ask
 * first, each in a dialog of the frame's, a sheet on compact and a drawer
 * elsewhere, kept open only while the drawing it was opened on is the one
 * there. A turn, a flip, a rotation and a new canvas size are one command
 * each; Image size, Trim and Reveal all measure or render first, and say so
 * where that came to nothing: nothing to change, the drawing changed under
 * them, or a picture the browser would not read. While one of those is
 * under way, and while the frame says the items are not to be used (an
 * area being transformed), they are shown disabled. The view fits itself to
 * the new canvas, as after a crop, since it fits again whenever the canvas
 * changes (`Viewport.tsx`).
 */

type ImageDialog = 'imageSize' | 'canvasSize' | 'rotate' | 'trim';

/** What the items do: open a dialog, turn or flip at once, or reveal all. */
export type ImageActions = Readonly<{
	ask: (dialog: ImageDialog) => void;
	turn: (turn: CanvasTurn) => void;
	revealAll: () => void;
}>;

/** Image rotation's three turns, then Arbitrary…, then its two flips, as Photoshop lists them. */
const TURNS: readonly CanvasTurn[] = ['rotate180', 'rotate90cw', 'rotate90ccw'];
const FLIPS: readonly CanvasTurn[] = ['flipHorizontal', 'flipVertical'];

/** The items, in Photoshop's order; all of them disabled while `disabled`. */
export const imageMenuItems = (actions: ImageActions, disabled: boolean): readonly MenuItem[] => {
	const turnItem = (turn: CanvasTurn): MenuItem => ({
		id: turn,
		label: t(`image.turns.${turn}`),
		onSelect: () => actions.turn(turn),
	});
	return [
		{
			id: 'imageSize',
			label: t('image.imageSize'),
			disabled,
			onSelect: () => actions.ask('imageSize'),
		},
		{
			id: 'canvasSize',
			label: t('image.canvasSize'),
			disabled,
			onSelect: () => actions.ask('canvasSize'),
		},
		{
			id: 'rotation',
			label: t('image.rotation'),
			disabled,
			// A submenu's item opens it rather than doing anything of its own.
			onSelect: () => undefined,
			submenu: [
				...TURNS.map(turnItem),
				{
					id: 'arbitrary',
					label: t('image.turns.arbitrary'),
					onSelect: () => actions.ask('rotate'),
				},
				// The flips are a group of their own, as in Photoshop's submenu.
				...FLIPS.map((flip, index) => ({
					...turnItem(flip),
					separatorBefore: index === 0,
				})),
			],
		},
		{ id: 'trim', label: t('image.trim'), disabled, onSelect: () => actions.ask('trim') },
		{
			id: 'revealAll',
			label: t('image.revealAll'),
			disabled,
			onSelect: actions.revealAll,
		},
	];
};

/** What is said of how a job came out, where it changed nothing; `nothing` is its own words for having had nothing to do. */
const saidOf = (outcome: CanvasJob, nothing: string): string | undefined => {
	if (outcome === 'nothing') return nothing;
	if (outcome === 'changed') return t('image.changed');
	if (outcome === 'unrenderable') return t('image.unrenderable');
	return undefined;
};

/**
 * The items for More, and the dialogs they open, for the drawing open.
 * `busy` while the frame has something under way the items are not to
 * interrupt.
 */
export const useImageMenu = ({
	document,
	placement,
	busy,
	notify,
}: Readonly<{
	document: EditorDocument;
	placement: 'sheet' | 'drawer';
	busy: boolean;
	notify: (message: string) => void;
}>): Readonly<{ items: readonly MenuItem[]; dialogs: ReactNode }> => {
	// The dialog asked for, with the drawing it was asked of: another drawing opened closes it.
	const [asking, setAsking] = useState<
		Readonly<{ dialog: ImageDialog; document: EditorDocument }> | undefined
	>(undefined);
	const [running, setRunning] = useState(false);
	const shown = asking?.document === document ? asking.dialog : undefined;
	const close = () => setAsking(undefined);
	const canvas = canvasBoxOf(document.root, document.size);

	/** A job that measures or renders first, one at a time, and what is said of how it came out. */
	const run = (job: (open: EditorDocument) => Promise<CanvasJob>, nothing: string) => {
		setRunning(true);
		void job(document)
			.then(
				(outcome) => {
					const said = saidOf(outcome, nothing);
					if (said !== undefined) notify(said);
				},
				() => notify(t('image.failed'))
			)
			.finally(() => setRunning(false));
	};

	const items = imageMenuItems(
		{
			ask: (dialog) => setAsking({ dialog, document }),
			turn: (turn) => document.execute(turnCanvas(document.root, document.size, turn)),
			revealAll: () =>
				run((open) => revealAll(open, layerExtentIn(open)), t('image.nothing.revealAll')),
		},
		busy || running
	);

	const dialogs = (
		<>
			<ImageSizeDialog
				placement={placement}
				open={shown === 'imageSize'}
				canvas={canvas}
				onApply={(request) =>
					run((open) => resizeImage(open, request), t('image.nothing.imageSize'))
				}
				onClose={close}
			/>
			<CanvasSizeDialog
				placement={placement}
				open={shown === 'canvasSize'}
				canvas={canvas}
				onApply={({ size, anchor }) => {
					// The same size is no step: nothing would move.
					if (size.width === canvas.width && size.height === canvas.height) return;
					document.execute(resizeCanvas(document.root, document.size, size, anchor));
				}}
				onClose={close}
			/>
			<RotateDialog
				placement={placement}
				open={shown === 'rotate'}
				onApply={(degrees) => {
					// A whole turn, or none, is no step: nothing would move.
					if (degrees % 360 === 0) return;
					document.execute(rotateCanvas(document.root, document.size, degrees));
				}}
				onClose={close}
			/>
			<TrimDialog
				placement={placement}
				open={shown === 'trim'}
				onApply={({ basis, sides }) =>
					run(
						(open) => trimCanvas(open, basis, sides, layerExtentIn(open)),
						t('image.nothing.trim')
					)
				}
				onClose={close}
			/>
		</>
	);

	return { items, dialogs };
};
