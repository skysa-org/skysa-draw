import { type SyntheticEvent, useId, useState } from 'react';

import { Panel } from '../../components/ui/Panel.js';
import { PanelHost } from '../../components/ui/PanelHost.js';
import { Slider } from '../../components/ui/Slider.js';
import { t } from '../../i18n/t.js';

/**
 * Feather… (docs/decisions/0004-the-interface.md, "The context menu"): how
 * far the area's edge fades, on either side of its outline, in the drawing's
 * units, as Photoshop's Feather Selection asks it; 0 is a hard edge. A slider
 * for the hand and a number field for the exact value, the two one value,
 * starting at the area's own. Apply sets it on the area, which is not part of
 * the history; Cancel, Escape or a tap beside it leave the area as it was. In
 * a sheet on compact and a drawer elsewhere, as the frame places it.
 */

/** The widest feather offered, in user units: Photoshop's own limit. */
export const FEATHER_MAX = 250;

/** A value typed or dragged, kept to the range; a field left empty or unreadable keeps the last. */
const clampFeather = (value: number, fallback: number): number =>
	Number.isFinite(value) ? Math.min(FEATHER_MAX, Math.max(0, value)) : fallback;

const px = (n: number): string => t('editor.units.px', { n });

/** The form, mounted while the dialog is open, so each opening starts from the area's feather. */
const FeatherForm = ({
	feather,
	onApply,
	onClose,
}: Readonly<{ feather: number; onApply: (feather: number) => void; onClose: () => void }>) => {
	const hintId = useId();
	const [radius, setRadius] = useState(() => clampFeather(feather, 0));

	const onSubmit = (event: SyntheticEvent) => {
		event.preventDefault();
		onApply(radius);
		onClose();
	};

	return (
		<Panel title={t('selection.feather.title')} onClose={onClose} className="feather-panel">
			<form className="feather-form" onSubmit={onSubmit} aria-describedby={hintId}>
				<p id={hintId} className="feather-hint">
					{t('selection.feather.hint')}
				</p>
				<div className="feather-radius">
					<Slider
						label={t('selection.feather.radius')}
						value={radius}
						min={0}
						max={FEATHER_MAX}
						step={1}
						format={px}
						onChange={setRadius}
					/>
					<input
						type="number"
						inputMode="decimal"
						className="feather-field"
						aria-label={t('selection.feather.radiusValue')}
						min={0}
						max={FEATHER_MAX}
						step="any"
						value={radius}
						onChange={(event) =>
							setRadius(clampFeather(event.target.valueAsNumber, radius))
						}
					/>
				</div>
				<div className="feather-actions">
					<button type="button" onClick={onClose}>
						{t('common.cancel')}
					</button>
					<button type="submit" className="primary">
						{t('selection.feather.apply')}
					</button>
				</div>
			</form>
		</Panel>
	);
};

export const FeatherDialog = ({
	placement,
	open,
	feather,
	onApply,
	onClose,
}: Readonly<{
	placement: 'sheet' | 'drawer';
	open: boolean;
	/** The area's feather now, which the dialog starts at. */
	feather: number;
	onApply: (feather: number) => void;
	onClose: () => void;
}>) => (
	<PanelHost
		placement={placement}
		open={open}
		onClose={onClose}
		label={t('selection.feather.title')}
	>
		<FeatherForm feather={feather} onApply={onApply} onClose={onClose} />
	</PanelHost>
);
