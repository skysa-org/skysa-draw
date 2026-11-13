import { cell } from '@skysa/storage';
import { useState } from 'react';

import { DialogForm } from '../../components/ui/DialogForm.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { Toggle } from '../../components/ui/Toggle.js';
import { t } from '../../i18n/t.js';
import type { Anchor, Size } from '../document/canvasOps.js';
import { AnchorGrid } from './AnchorGrid.js';
import {
	fieldText,
	isSide,
	numberIn,
	type Side,
	SizeFields,
	SizeLine,
	type SizeText,
	sizeText,
} from './SizeFields.js';

/**
 * Canvas size… (docs/decisions/0004-the-interface.md), as Photoshop's Image >
 * Canvas Size asks it: the canvas's size now, then a width and a height in
 * pixels, which start at it, Relative, and the anchor (`AnchorGrid`). With
 * Relative on, the fields say how much to add or take away, and start at 0,
 * with the size that makes said under them; turned on or off, what the
 * fields hold is said the other way, so nothing typed is lost. The drawing
 * stays where the anchor says and nothing drawn moves or is scaled
 * (`resizeCanvas`). There is no color for the new area, as Photoshop has:
 * it is transparent, as a new drawing is. Apply, or Enter, asks for the
 * size and closes; Cancel, Escape or a tap beside it leave the drawing as it
 * was. The focus starts on the width, its text selected.
 *
 * Relative and the anchor start each time at what was last applied, for the
 * page's life, and the sizes at the canvas's: the memory is this module's
 * (`lastApplied`), written on Apply alone. In a sheet on compact and a drawer
 * elsewhere, as the frame places it.
 */

/** What Apply asks for: the canvas's new size, and where the drawing stays in it. */
export type CanvasSizeRequest = Readonly<{ size: Size; anchor: Anchor }>;

/** What the dialog keeps from one opening to the next. */
type CanvasChoices = Readonly<{ relative: boolean; anchor: Anchor }>;

/** The choices last applied, for the page's life: Photoshop's first, the sizes themselves, from the center. */
const lastApplied = cell<CanvasChoices>({ relative: false, anchor: 'center' });

/** Apply's: where the next opening starts. */
const remember = (choices: CanvasChoices): void => {
	lastApplied.current = choices;
};

const NO_CHANGE: SizeText = { width: '0', height: '0' };

/** The form, mounted while the dialog is open, so each opening starts from the canvas as it is. */
const CanvasSizeForm = ({
	canvas,
	onApply,
	onClose,
}: Readonly<{
	canvas: Size;
	onApply: (request: CanvasSizeRequest) => void;
	onClose: () => void;
}>) => {
	const [choices, setChoices] = useState(() => lastApplied.current);
	const [text, setText] = useState(() =>
		lastApplied.current.relative ? NO_CHANGE : sizeText(canvas)
	);
	const { relative } = choices;
	/** The side the field for `side` makes: what it says, or the canvas's with it added. */
	const sideOf = (side: Side): number | undefined => {
		const n = numberIn(text[side]);
		return n === undefined || !relative ? n : canvas[side] + n;
	};
	const width = sideOf('width');
	const height = sideOf('height');
	const valid = { width: isSide(width), height: isSide(height) };

	/** What the field for `side` says the other way, Relative turned to `on`; where it says nothing, the canvas's. */
	const turned = (side: Side, on: boolean): string => {
		const n = numberIn(text[side]);
		if (n === undefined) return on ? '0' : fieldText(canvas[side]);
		return fieldText(on ? n - canvas[side] : canvas[side] + n);
	};
	const setRelative = (on: boolean) => {
		setText({ width: turned('width', on), height: turned('height', on) });
		setChoices((was) => ({ ...was, relative: on }));
	};

	return (
		<DialogForm
			title={t('image.canvasDialog.title')}
			applyLabel={t('image.fields.apply')}
			canApply={valid.width && valid.height}
			onApply={() => {
				if (!isSide(width) || !isSide(height)) return;
				remember(choices);
				onApply({ size: { width, height }, anchor: choices.anchor });
			}}
			onClose={onClose}
		>
			<SizeLine words="current" size={canvas} />
			<SizeFields
				text={text}
				invalid={{ width: !valid.width, height: !valid.height }}
				signed={relative}
				onChange={(side, value) => setText((was) => ({ ...was, [side]: value }))}
			/>
			{relative && isSide(width) && isSide(height) && (
				<SizeLine words="next" size={{ width, height }} />
			)}
			<div className="image-toggles">
				<Toggle
					label={t('image.canvasDialog.relative')}
					pressed={relative}
					onChange={setRelative}
				/>
			</div>
			<AnchorGrid
				value={choices.anchor}
				onChange={(anchor) => setChoices((was) => ({ ...was, anchor }))}
			/>
		</DialogForm>
	);
};

export const CanvasSizeDialog = ({
	placement,
	open,
	canvas,
	onApply,
	onClose,
}: Readonly<{
	placement: 'sheet' | 'drawer';
	open: boolean;
	/** The canvas's size now, in the drawing's pixels, where the fields start. */
	canvas: Size;
	onApply: (request: CanvasSizeRequest) => void;
	onClose: () => void;
}>) => (
	<PanelHost
		placement={placement}
		open={open}
		onClose={onClose}
		label={t('image.canvasDialog.title')}
	>
		<CanvasSizeForm canvas={canvas} onApply={onApply} onClose={onClose} />
	</PanelHost>
);
