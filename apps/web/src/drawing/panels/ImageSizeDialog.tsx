import { cell } from '@skysa/draw-core';
import { useState } from 'react';

import { DialogForm } from '../../components/ui/DialogForm.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { Toggle } from '../../components/ui/Toggle.js';
import { t } from '../../i18n/t.js';
import type { Size } from '../document/canvasOps.js';
import {
	fieldText,
	isSide,
	numberIn,
	otherSide,
	SIDE,
	type Side,
	SizeFields,
	SizeLine,
	sizeText,
} from './SizeFields.js';

/**
 * Image size… (docs/decisions/0004-the-interface.md), as Photoshop's Image >
 * Image Size asks it: the canvas's size now, then a width and a height in
 * pixels, which start at it, linked by Constrain proportions, on at first as
 * Photoshop's link is, and Resample, on at first, which makes a raster
 * layer's pixels again at the new size rather than stretching them
 * (`resizeImage`). Linked, a side typed sets the other in the canvas's own
 * proportions, to the nearest pixel, and the link turned on sets the height
 * from the width. Apply, or Enter, asks for the size and closes; Cancel,
 * Escape or a tap beside it leave the drawing as it was. The focus starts on
 * the width, its text selected.
 *
 * The link and Resample start each time at what was last applied, for the
 * page's life, as Photoshop's do, and the sizes at the canvas's: the memory
 * is this module's (`lastApplied`), written on Apply alone. In a sheet on
 * compact and a drawer elsewhere, as the frame places it.
 */

/** What Apply asks for: the new size, and whether raster layers are resampled to it. */
export type ImageSizeRequest = Size & Readonly<{ resample: boolean }>;

/** What the dialog keeps from one opening to the next. */
type SizeChoices = Readonly<{ constrain: boolean; resample: boolean }>;

/** The choices last applied, for the page's life: Photoshop's first, both on, until then. */
const lastApplied = cell<SizeChoices>({ constrain: true, resample: true });

/** The form, mounted while the dialog is open, so each opening starts from the canvas as it is. */
const ImageSizeForm = ({
	canvas,
	onApply,
	onClose,
}: Readonly<{
	canvas: Size;
	onApply: (request: ImageSizeRequest) => void;
	onClose: () => void;
}>) => {
	const [choices, setChoices] = useState(() => lastApplied.current);
	const [text, setText] = useState(() => sizeText(canvas));
	const width = numberIn(text.width);
	const height = numberIn(text.height);
	const valid = { width: isSide(width), height: isSide(height) };

	/** The other side, for `side` at `n`, in the canvas's proportions, a whole pixel and no fewer than one. */
	const linked = (side: Side, n: number): string => {
		const ratio = canvas[side] > 0 ? canvas[otherSide(side)] / canvas[side] : 1;
		return fieldText(Math.max(SIDE.min, Math.round(n * ratio)));
	};
	const change = (side: Side, value: string) => {
		const n = numberIn(value);
		const follows =
			choices.constrain && isSide(n) ? { [otherSide(side)]: linked(side, n) } : {};
		setText((was) => ({ ...was, [side]: value, ...follows }));
	};
	const link = (constrain: boolean) => {
		setChoices((was) => ({ ...was, constrain }));
		if (constrain && isSide(width))
			setText((was) => ({ ...was, height: linked('width', width) }));
	};

	return (
		<DialogForm
			title={t('image.sizeDialog.title')}
			applyLabel={t('image.fields.apply')}
			canApply={valid.width && valid.height}
			onApply={() => {
				if (!isSide(width) || !isSide(height)) return;
				lastApplied.current = choices;
				onApply({ width, height, resample: choices.resample });
			}}
			onClose={onClose}
		>
			<SizeLine words="current" size={canvas} />
			<SizeFields
				text={text}
				invalid={{ width: !valid.width, height: !valid.height }}
				onChange={change}
			/>
			<div className="image-toggles">
				<Toggle
					label={t('image.sizeDialog.constrain')}
					pressed={choices.constrain}
					onChange={link}
				/>
				<Toggle
					label={t('image.sizeDialog.resample')}
					pressed={choices.resample}
					onChange={(resample) => setChoices((was) => ({ ...was, resample }))}
				/>
			</div>
		</DialogForm>
	);
};

export const ImageSizeDialog = ({
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
	onApply: (request: ImageSizeRequest) => void;
	onClose: () => void;
}>) => (
	<PanelHost
		placement={placement}
		open={open}
		onClose={onClose}
		label={t('image.sizeDialog.title')}
	>
		<ImageSizeForm canvas={canvas} onApply={onApply} onClose={onClose} />
	</PanelHost>
);
