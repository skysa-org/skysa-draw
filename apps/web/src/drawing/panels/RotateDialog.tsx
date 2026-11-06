import { cell } from '@skysa/draw-core';
import { useState } from 'react';

import { DialogForm } from '../../components/ui/DialogForm.js';
import { NumberField } from '../../components/ui/NumberField.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { type RadioChoice, RadioRows } from '../../components/ui/RadioRows.js';
import { t } from '../../i18n/t.js';
import { fieldText, numberIn } from './SizeFields.js';

/**
 * Image rotation's Arbitrary… (docs/decisions/0004-the-interface.md), as
 * Photoshop's Rotate Canvas asks it: an angle in degrees, and which way,
 * clockwise or counterclockwise. The canvas turns by it and grows to hold
 * what was on it (`rotateCanvas`). A negative angle turns the other way, and
 * the angle is kept to Photoshop's range, less than a whole turn either way.
 * Apply, or Enter, asks for the turn and closes; Cancel, Escape or a tap
 * beside it leave the drawing as it was. The focus starts on the angle, its
 * text selected.
 *
 * It starts each time at what was last applied, for the page's life, as
 * Photoshop's does: the memory is this module's (`lastApplied`), written on
 * Apply alone. In a sheet on compact and a drawer elsewhere, as the frame
 * places it.
 */

type Direction = 'clockwise' | 'counterclockwise';

/** What the dialog keeps from one opening to the next. */
type RotateChoices = Readonly<{ angle: number; direction: Direction }>;

/** The most of a turn either way: Photoshop's. */
const MOST_DEGREES = 359.99;

/** The choices last applied, for the page's life: Photoshop's first, no turn, clockwise. */
const lastApplied = cell<RotateChoices>({ angle: 0, direction: 'clockwise' });

const DIRECTIONS: readonly RadioChoice<Direction>[] = [
	{ value: 'clockwise', label: t('image.rotateDialog.clockwise') },
	{ value: 'counterclockwise', label: t('image.rotateDialog.counterclockwise') },
];

/** Whether `n` is an angle the dialog takes. */
const isAngle = (n: number | undefined): n is number =>
	n !== undefined && Math.abs(n) <= MOST_DEGREES;

/** The form, mounted while the dialog is open, so each opening starts from what was last applied. */
const RotateForm = ({
	onApply,
	onClose,
}: Readonly<{ onApply: (degrees: number) => void; onClose: () => void }>) => {
	const [direction, setDirection] = useState(() => lastApplied.current.direction);
	const [text, setText] = useState(() => fieldText(lastApplied.current.angle));
	const angle = numberIn(text);
	const valid = isAngle(angle);

	return (
		<DialogForm
			title={t('image.rotateDialog.title')}
			applyLabel={t('image.fields.apply')}
			canApply={valid}
			onApply={() => {
				if (!isAngle(angle)) return;
				lastApplied.current = { angle, direction };
				// Clockwise is positive, as the drawing's `rotate()` turns.
				onApply(direction === 'clockwise' ? angle : -angle);
			}}
			onClose={onClose}
		>
			<NumberField
				label={t('image.rotateDialog.angle')}
				unit={t('image.fields.degrees')}
				value={text}
				invalid={!valid}
				signed
				min={-MOST_DEGREES}
				max={MOST_DEGREES}
				onChange={setText}
			/>
			<RadioRows
				legend={t('image.rotateDialog.direction')}
				choices={DIRECTIONS}
				value={direction}
				onChange={setDirection}
			/>
		</DialogForm>
	);
};

export const RotateDialog = ({
	placement,
	open,
	onApply,
	onClose,
}: Readonly<{
	placement: 'sheet' | 'drawer';
	open: boolean;
	/** The turn, in degrees, clockwise where positive. */
	onApply: (degrees: number) => void;
	onClose: () => void;
}>) => (
	<PanelHost
		placement={placement}
		open={open}
		onClose={onClose}
		label={t('image.rotateDialog.title')}
	>
		<RotateForm onApply={onApply} onClose={onClose} />
	</PanelHost>
);
