import { cell } from '@skysa/draw-core';
import { useState } from 'react';

import { DialogForm } from '../../components/ui/DialogForm.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { type RadioChoice, RadioRows } from '../../components/ui/RadioRows.js';
import { Toggle } from '../../components/ui/Toggle.js';
import { t } from '../../i18n/t.js';
import type { Sides, TrimBasis } from '../document/canvasOps.js';

/**
 * Trim… (docs/decisions/0004-the-interface.md), as Photoshop's Image > Trim
 * asks it: what is cut away, the transparent pixels, or pixels of the top
 * left's color, or of the bottom right's; and from which sides, the top,
 * the bottom, the left and the right, all of them at first (`trimCanvas`).
 * With no side chosen there is nothing to cut, and Apply is disabled. Apply,
 * or Enter, asks for the trim and closes; Cancel, Escape or a tap beside it
 * leave the drawing as it was. The focus starts on the basis chosen.
 *
 * It starts each time at what was last applied, for the page's life, as
 * Photoshop's does: the memory is this module's (`lastApplied`), written on
 * Apply alone. In a sheet on compact and a drawer elsewhere, as the frame
 * places it.
 */

/** What Apply asks for: what is cut away, and from where. */
export type TrimRequest = Readonly<{ basis: TrimBasis; sides: Sides }>;

const BASES: readonly RadioChoice<TrimBasis>[] = [
	{ value: 'transparent', label: t('image.trimDialog.bases.transparent') },
	{ value: 'topLeft', label: t('image.trimDialog.bases.topLeft') },
	{ value: 'bottomRight', label: t('image.trimDialog.bases.bottomRight') },
];

/** In Photoshop's order, which lays them out as two columns, the top over the bottom and the left over the right. */
const SIDES: readonly (keyof Sides)[] = ['top', 'bottom', 'left', 'right'];

/** The choices last applied, for the page's life: Photoshop's first, transparent pixels from every side. */
const lastApplied = cell<TrimRequest>({
	basis: 'transparent',
	sides: { top: true, bottom: true, left: true, right: true },
});

/** The form, mounted while the dialog is open, so each opening starts from what was last applied. */
const TrimForm = ({
	onApply,
	onClose,
}: Readonly<{ onApply: (request: TrimRequest) => void; onClose: () => void }>) => {
	const [choices, setChoices] = useState(() => lastApplied.current);
	const { sides } = choices;
	return (
		<DialogForm
			title={t('image.trimDialog.title')}
			applyLabel={t('image.fields.apply')}
			canApply={SIDES.some((side) => sides[side])}
			onApply={() => {
				lastApplied.current = choices;
				onApply(choices);
			}}
			onClose={onClose}
		>
			<RadioRows
				legend={t('image.trimDialog.basedOn')}
				choices={BASES}
				value={choices.basis}
				onChange={(basis) => setChoices((was) => ({ ...was, basis }))}
			/>
			<fieldset className="field-group">
				<legend className="field-legend">{t('image.trimDialog.trimAway')}</legend>
				<div className="trim-sides">
					{SIDES.map((side) => (
						<Toggle
							key={side}
							label={t(`image.trimDialog.sides.${side}`)}
							pressed={sides[side]}
							onChange={(on) =>
								setChoices((was) => ({
									...was,
									sides: { ...was.sides, [side]: on },
								}))
							}
						/>
					))}
				</div>
			</fieldset>
		</DialogForm>
	);
};

export const TrimDialog = ({
	placement,
	open,
	onApply,
	onClose,
}: Readonly<{
	placement: 'sheet' | 'drawer';
	open: boolean;
	onApply: (request: TrimRequest) => void;
	onClose: () => void;
}>) => (
	<PanelHost
		placement={placement}
		open={open}
		onClose={onClose}
		label={t('image.trimDialog.title')}
	>
		<TrimForm onApply={onApply} onClose={onClose} />
	</PanelHost>
);
