import { cell } from '@skysa/draw-core';
import { type RefObject, type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import { Panel } from '../../components/ui/Panel.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { Slider } from '../../components/ui/Slider.js';
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
 * Photoshop's Select > Modify less Feather…, which has its own, in one dialog
 * rather than four. The four ways are rows to press, as Fill…'s contents are,
 * each with a line on what it does; then the radius, a slider for the hand
 * and a number field for the exact value, as Feather… has it, in the drawing's
 * units, named as Photoshop names it in that way's own dialog, and kept to
 * that way's range. Apply, or Enter, makes the area `modifyArea` makes of it
 * on the drawing's canvas and closes, none where nothing is left; Cancel,
 * Escape or a tap beside it leave the area as it was. The focus starts on the
 * way chosen.
 *
 * It starts each time at what was last applied, for the page's life, as
 * Photoshop's dialogs do: the memory is this module's (`lastApplied`), written
 * on Apply alone, so a Cancel forgets nothing. One radius serves the four, and
 * a way with a smaller range shows it at that range's end without forgetting
 * it, so going back to the way before finds it as it was. In a sheet on
 * compact and a drawer elsewhere, as the frame places it.
 */

/** In the order the dialog lists them: the two that grow and shrink, then the two that reshape. */
const WAYS: readonly AreaModify[] = ['expand', 'contract', 'smooth', 'border'];

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
} as const;

/** What the dialog asks, as the user last applied it. */
type ModifyChoices = Readonly<{
	how: AreaModify;
	/** In user units, as the user last set it, which a way with a smaller range shows at its end. */
	radius: number;
}>;

/** The first opening: Expand, by the least it takes. */
const FIRST_CHOICES: ModifyChoices = { how: 'expand', radius: MODIFY_LIMITS.expand.min };

/** The choices last applied, for the page's life: where the next Modify… starts. */
const lastApplied = cell<ModifyChoices>(FIRST_CHOICES);

/** A value typed, kept to the way's range; a field left empty or unreadable keeps the last. */
const clampRadius = (how: AreaModify, value: number, fallback: number): number =>
	Number.isFinite(value) ? modifyRadius(how, value) : fallback;

const px = (n: number): string => t('editor.units.px', { n });

/**
 * Enter applies from any control but a button, whose Enter is its own press,
 * and the focus goes to the way chosen once the sheet or the drawer has taken
 * it as it opens, which it does after the form's own effects have run: as
 * Fill… has them. Native listeners, since the form itself is not a control to
 * hang a key handler on.
 */
const useFormKeys = (form: RefObject<HTMLFormElement | null>): void => {
	useEffect(() => {
		const element = form.current;
		if (element === null) return undefined;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
			if (event.target instanceof HTMLButtonElement) return;
			event.preventDefault();
			element.requestSubmit();
		};
		element.addEventListener('keydown', onKeyDown);
		queueMicrotask(() => {
			if (!element.isConnected) return;
			element.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
		});
		return () => element.removeEventListener('keydown', onKeyDown);
	}, [form]);
};

/** The form, mounted while the dialog is open, so each opening starts from what was last applied. */
const ModifyForm = ({
	region,
	canvas,
	onApply,
	onClose,
}: Readonly<{
	region: Region | undefined;
	canvas: Box;
	onApply: (region: Region | undefined) => void;
	onClose: () => void;
}>) => {
	const group = useId();
	const form = useRef<HTMLFormElement>(null);
	const [choices, setChoices] = useState(() => lastApplied.current);
	useFormKeys(form);

	const { how } = choices;
	const radius = modifyRadius(how, choices.radius);
	const setRadius = (value: number) => setChoices((was) => ({ ...was, radius: value }));

	const onSubmit = (event: SyntheticEvent) => {
		event.preventDefault();
		lastApplied.current = { how, radius };
		if (region !== undefined) onApply(modifyArea(region, how, radius, canvas));
		onClose();
	};

	return (
		<Panel title={t('selection.modify.title')} onClose={onClose} className="modify-panel">
			<form ref={form} className="modify-form" onSubmit={onSubmit}>
				<fieldset className="modify-ways">
					<legend className="visually-hidden">{t('selection.modify.ways')}</legend>
					{WAYS.map((way) => (
						<label key={way} className="modify-way">
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
				<div className="modify-radius">
					<Slider
						label={t(WORDS[how].radius)}
						value={radius}
						min={MODIFY_LIMITS[how].min}
						max={MODIFY_LIMITS[how].max}
						step={1}
						format={px}
						onChange={setRadius}
					/>
					<input
						type="number"
						inputMode="decimal"
						className="modify-field"
						aria-label={t(WORDS[how].radiusValue)}
						min={MODIFY_LIMITS[how].min}
						max={MODIFY_LIMITS[how].max}
						step="any"
						value={radius}
						onChange={(event) =>
							setRadius(clampRadius(how, event.target.valueAsNumber, radius))
						}
					/>
				</div>
				<div className="modify-actions">
					<button type="button" onClick={onClose}>
						{t('common.cancel')}
					</button>
					<button type="submit" className="primary">
						{t('selection.modify.apply')}
					</button>
				</div>
			</form>
		</Panel>
	);
};

export const ModifyDialog = ({
	placement,
	open,
	region,
	canvas,
	onApply,
	onClose,
}: Readonly<{
	placement: 'sheet' | 'drawer';
	open: boolean;
	/** The area the dialog was opened on, which Apply modifies. */
	region: Region | undefined;
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
		<ModifyForm region={region} canvas={canvas} onApply={onApply} onClose={onClose} />
	</PanelHost>
);
