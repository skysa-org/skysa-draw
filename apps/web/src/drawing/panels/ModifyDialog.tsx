import { cell } from '@skysa/storage';
import { useId, useState } from 'react';

import { useApply } from '../../components/ui/Applying.js';
import { DialogForm } from '../../components/ui/DialogForm.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { SliderField } from '../../components/ui/SliderField.js';
import { t } from '../../i18n/t.js';
import {
	type AreaModify,
	MODIFY_LIMITS,
	modifyArea,
	modifyRadius,
} from '../tools/raster/areaOps.js';
import type { Region } from '../tools/types.js';
import type { Box } from '../tools/vector/geometry.js';

/**
 * Modify… (docs/decisions/0004-the-interface.md, "The context menu"):
 * Photoshop's Select > Modify in one dialog rather than five. The five ways
 * are rows to press, as Fill…'s contents are, each with a line on what it
 * does; then the radius, a slider for the hand and a number field for the
 * exact value, in the drawing's units, named as Photoshop names it in that
 * way's own dialog, and kept to that way's range. Apply, or Enter, makes the
 * area `modifyArea` makes of it on the drawing's canvas and closes, none where
 * nothing is left; Cancel, Escape or a tap beside it leave the area as it
 * was. The focus starts on the way chosen. The form is every dialog's
 * (`DialogForm`).
 *
 * It starts each time at what was last applied, for the page's life, as
 * Photoshop's dialogs do, or at the way it was opened for (Shift F6 opens it
 * at Feather): the memory is this module's (`lastApplied`), written on Apply
 * alone, so a Cancel forgets nothing. One radius serves the four ways that
 * change the outline, and a way with a smaller range shows it at that range's
 * end without forgetting it, so going back to the way before finds it as it
 * was. Feather's is the area's own feather, which it sets rather than changes
 * by, as the area holds one: 0 is a hard edge. In a sheet on compact and a
 * drawer elsewhere, as the frame places it.
 *
 * The four ways that change the outline work through every corner of it,
 * which on a large area of many corners, a magic wand's, holds the page a
 * while: the dialog closes at once, and the area is made and set under the
 * frame's indicator (`components/ui/Applying.tsx`), which shows once that
 * takes a while. Feather only sets the area's own feather, and is done
 * plainly.
 */

/**
 * In the order the dialog lists them: the two that grow and shrink, the two
 * that reshape, then the edge's fade, last as in Photoshop's submenu.
 */
const WAYS: readonly AreaModify[] = ['expand', 'contract', 'smooth', 'border', 'feather'];

const WORDS = {
	expand: {
		name: 'selection.modify.expand.name',
		hint: 'selection.modify.expand.hint',
		radius: 'selection.modify.expand.radius',
		radiusValue: 'selection.modify.expand.radiusValue',
	},
	contract: {
		name: 'selection.modify.contract.name',
		hint: 'selection.modify.contract.hint',
		radius: 'selection.modify.contract.radius',
		radiusValue: 'selection.modify.contract.radiusValue',
	},
	smooth: {
		name: 'selection.modify.smooth.name',
		hint: 'selection.modify.smooth.hint',
		radius: 'selection.modify.smooth.radius',
		radiusValue: 'selection.modify.smooth.radiusValue',
	},
	border: {
		name: 'selection.modify.border.name',
		hint: 'selection.modify.border.hint',
		radius: 'selection.modify.border.radius',
		radiusValue: 'selection.modify.border.radiusValue',
	},
	feather: {
		name: 'selection.modify.feather.name',
		hint: 'selection.modify.feather.hint',
		radius: 'selection.modify.feather.radius',
		radiusValue: 'selection.modify.feather.radiusValue',
	},
} as const;

/** What the dialog asks, as the user last applied it. */
type ModifyChoices = Readonly<{
	how: AreaModify;
	/**
	 * The four outline ways' radius, in user units, as the user last set it,
	 * which a way with a smaller range shows at its end.
	 */
	radius: number;
}>;

/** What the open dialog holds: the choices, and the feather it would set. */
type FormChoices = ModifyChoices & Readonly<{ feather: number }>;

/** The first opening: Expand, by the least it takes. */
const FIRST_CHOICES: ModifyChoices = { how: 'expand', radius: MODIFY_LIMITS.expand.min };

/** The choices last applied, for the page's life: where the next Modify… starts. */
const lastApplied = cell<ModifyChoices>(FIRST_CHOICES);

/** A value typed, kept to the way's range; a field left empty or unreadable keeps the last. */
const px = (n: number): string => t('editor.units.px', { n });

/** The form, mounted while the dialog is open, so each opening starts from what was last applied. */
const ModifyForm = ({
	region,
	way,
	canvas,
	onApply,
	onClose,
}: Readonly<{
	region: Region | undefined;
	way: AreaModify | undefined;
	canvas: Box;
	onApply: (region: Region | undefined) => void;
	onClose: () => void;
}>) => {
	const group = useId();
	const apply = useApply();
	const [choices, setChoices] = useState<FormChoices>(() => ({
		...lastApplied.current,
		how: way ?? lastApplied.current.how,
		feather: region?.feather ?? 0,
	}));

	const { how } = choices;
	const feathering = how === 'feather';
	const radius = modifyRadius(how, feathering ? choices.feather : choices.radius);
	const setRadius = (value: number) =>
		setChoices((was) => (feathering ? { ...was, feather: value } : { ...was, radius: value }));

	return (
		<DialogForm
			title={t('selection.modify.title')}
			applyLabel={t('selection.modify.apply')}
			onApply={() => {
				lastApplied.current = { how, radius: feathering ? choices.radius : radius };
				if (region === undefined) return;
				const made = () => onApply(modifyArea(region, how, radius, canvas));
				if (feathering) made();
				else void apply(made, t('selection.modify.working'));
			}}
			onClose={onClose}
		>
			<fieldset className="field-group">
				<legend className="visually-hidden">{t('selection.modify.ways')}</legend>
				{WAYS.map((way) => (
					<label key={way} className="radio-row modify-way">
						<input
							type="radio"
							name={group}
							value={way}
							checked={how === way}
							aria-labelledby={`${group}-${way}`}
							aria-describedby={`${group}-${way}-hint`}
							onChange={() => setChoices((was) => ({ ...was, how: way }))}
						/>
						<span className="modify-words">
							<span id={`${group}-${way}`}>{t(WORDS[way].name)}</span>
							<span id={`${group}-${way}-hint`} className="modify-hint">
								{t(WORDS[way].hint)}
							</span>
						</span>
					</label>
				))}
			</fieldset>
			<SliderField
				label={t(WORDS[how].radius)}
				fieldLabel={t(WORDS[how].radiusValue)}
				value={radius}
				min={MODIFY_LIMITS[how].min}
				max={MODIFY_LIMITS[how].max}
				step={1}
				format={px}
				clamp={(value) => modifyRadius(how, value)}
				onChange={setRadius}
			/>
		</DialogForm>
	);
};

export const ModifyDialog = ({
	placement,
	open,
	region,
	way,
	canvas,
	onApply,
	onClose,
}: Readonly<{
	placement: 'sheet' | 'drawer';
	open: boolean;
	/** The area the dialog was opened on, which Apply modifies. */
	region: Region | undefined;
	/** The way it opens at, where it was asked for one (Shift F6, Feather); else the last applied. */
	way?: AreaModify;
	/** The drawing's canvas in user units, which an inverted area is the rest of. */
	canvas: Box;
	/** The area Apply made, or none when nothing of it is left. */
	onApply: (region: Region | undefined) => void;
	onClose: () => void;
}>) => (
	<PanelHost
		placement={placement}
		open={open}
		onClose={onClose}
		label={t('selection.modify.title')}
	>
		<ModifyForm region={region} way={way} canvas={canvas} onApply={onApply} onClose={onClose} />
	</PanelHost>
);
