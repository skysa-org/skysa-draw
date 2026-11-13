import '../../styles/fillDialog.css';

import { BLEND_MODES, type BlendMode } from '@skysa/draw-core';
import { cell } from '@skysa/storage';
import { Fragment, useId, useState } from 'react';

import { classes } from '../../components/ui/classes.js';
import { toHex } from '../../components/ui/color.js';
import { ColorField } from '../../components/ui/ColorField.js';
import { DialogForm } from '../../components/ui/DialogForm.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { Select } from '../../components/ui/Select.js';
import { SliderField } from '../../components/ui/SliderField.js';
import { t } from '../../i18n/t.js';
import type { FillContents, FillSpec } from '../tools/raster/areaFill.js';
import type { ToolOptions } from '../tools/types.js';
import { inkOf } from '../tools/vector/svg.js';
import { blendKey } from './blendKey.js';

/**
 * Fill… (docs/decisions/0004-the-interface.md, "The context menu"), as
 * Photoshop's Edit > Fill asks it: the contents, the fill color, the stroke
 * color, a color of the user's own or the picture around the area made
 * again; then the blending, a mode from the layers' own list, an opacity and
 * Preserve transparency. Each color shows its swatch, the one the fill pours
 * (`fillAreaWith`), so a stroke of none shows the fill color it falls back to.
 * Apply, or Enter, fills the area and closes; Cancel, Escape or a tap beside
 * it leave the layer as it was. The focus starts on the contents chosen. The
 * form is every dialog's (`DialogForm`), whose Enter is not the color
 * field's hex's or its picker's.
 *
 * It starts each time at what was last applied, for the page's life, in any
 * drawing, as Photoshop's does: the memory is this module's (`lastApplied`),
 * written on Apply alone, so a Cancel forgets nothing. In a sheet on compact
 * and a drawer elsewhere, as the frame places it.
 */

const CONTENTS: readonly FillContents[] = ['fill', 'stroke', 'color', 'contentAware'];

const CONTENT_WORDS = {
	fill: 'selection.fill.fillColor',
	stroke: 'selection.fill.strokeColor',
	color: 'selection.fill.color',
	contentAware: 'selection.fill.contentAware',
} as const;

const BLEND_OPTIONS: readonly Readonly<{ value: BlendMode; label: string }>[] = BLEND_MODES.map(
	(mode) => ({ value: mode, label: t(blendKey(mode)) })
);

/** What the dialog asks, as the user last applied it. */
type FillChoices = Readonly<{
	contents: FillContents;
	/** Color…'s own; none until one is picked, and it starts at the fill color. */
	color: string | undefined;
	mode: BlendMode;
	/** 0 to 100, as the field shows it, so a typed 12.5 stays 12.5. */
	percent: number;
	preserveTransparency: boolean;
}>;

/** Photoshop's first Fill: the foreground, in normal, at full opacity. */
const FIRST_CHOICES: FillChoices = {
	contents: 'fill',
	color: undefined,
	mode: 'normal',
	percent: 100,
	preserveTransparency: false,
};

/** The choices last applied, for the page's life: where the next Fill… starts. */
const lastApplied = cell<FillChoices>(FIRST_CHOICES);

/** A value typed or dragged, kept to 0 to 100; a field left empty or unreadable keeps the last. */
const percentText = (n: number): string => t('editor.units.percent', { n });

/** The spec the choices make, with the color Color… shows. */
const specOf = (choices: FillChoices, color: string): FillSpec => ({
	contents: choices.contents,
	...(choices.contents === 'color' ? { color } : {}),
	mode: choices.mode,
	opacity: choices.percent / 100,
	preserveTransparency: choices.preserveTransparency,
});

/** The form, mounted while the dialog is open, so each opening starts from what was last applied. */
const FillForm = ({
	options,
	recent,
	onApply,
	onClose,
}: Readonly<{
	options: ToolOptions;
	recent: readonly string[] | undefined;
	onApply: (spec: FillSpec) => void;
	onClose: () => void;
}>) => {
	const group = useId();
	const [choices, setChoices] = useState(() => lastApplied.current);
	const set = (change: Partial<FillChoices>) => setChoices((was) => ({ ...was, ...change }));

	const fillInk = inkOf(options, 'fill');
	const color = choices.color ?? toHex(fillInk) ?? '#000000';
	const swatches: Readonly<Record<FillContents, string | undefined>> = {
		fill: fillInk,
		stroke: inkOf(options, 'stroke'),
		color,
		contentAware: undefined,
	};

	return (
		<DialogForm
			title={t('selection.fill.title')}
			applyLabel={t('selection.fill.apply')}
			onApply={() => {
				lastApplied.current = choices;
				onApply(specOf(choices, color));
			}}
			onClose={onClose}
		>
			<fieldset className="field-group">
				<legend className="field-legend">{t('selection.fill.contents')}</legend>
				{CONTENTS.map((contents) => (
					<Fragment key={contents}>
						<label className="radio-row">
							<input
								type="radio"
								name={group}
								value={contents}
								checked={choices.contents === contents}
								onChange={() => set({ contents })}
							/>
							{/* Drawn in `currentColor`, as the color field's swatch is. */}
							<span
								className={classes(
									'fill-swatch',
									contents === 'contentAware' && 'is-picture'
								)}
								style={{ color: swatches[contents] }}
								aria-hidden="true"
							/>
							<span>{t(CONTENT_WORDS[contents])}</span>
						</label>
						{contents === 'color' && choices.contents === 'color' && (
							<div className="fill-color">
								<ColorField
									layout="stacked"
									label={t('selection.fill.colorValue')}
									hideLabel
									value={color}
									recent={recent}
									onChange={(value) => set({ color: value })}
								/>
							</div>
						)}
					</Fragment>
				))}
			</fieldset>
			<fieldset className="field-group">
				<legend className="field-legend">{t('selection.fill.blending')}</legend>
				<Select
					label={t('selection.fill.mode')}
					value={choices.mode}
					options={BLEND_OPTIONS}
					onChange={(mode) => set({ mode })}
				/>
				<SliderField
					label={t('selection.fill.opacity')}
					fieldLabel={t('selection.fill.opacityValue')}
					value={choices.percent}
					min={0}
					max={100}
					step={1}
					format={percentText}
					onChange={(percent) => set({ percent })}
				/>
				<label className="check-row">
					<input
						type="checkbox"
						checked={choices.preserveTransparency}
						onChange={(event) => set({ preserveTransparency: event.target.checked })}
					/>
					<span>{t('selection.fill.preserveTransparency')}</span>
				</label>
			</fieldset>
		</DialogForm>
	);
};

export const FillDialog = ({
	placement,
	open,
	options,
	recent,
	onApply,
	onClose,
}: Readonly<{
	placement: 'sheet' | 'drawer';
	open: boolean;
	/** The tool options now, for the fill and the stroke colors' swatches. */
	options: ToolOptions;
	/** The colors used lately, offered under Color…. */
	recent?: readonly string[];
	onApply: (spec: FillSpec) => void;
	onClose: () => void;
}>) => (
	<PanelHost
		placement={placement}
		open={open}
		onClose={onClose}
		label={t('selection.fill.title')}
	>
		<FillForm options={options} recent={recent} onApply={onApply} onClose={onClose} />
	</PanelHost>
);
