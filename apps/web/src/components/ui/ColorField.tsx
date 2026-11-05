import { type KeyboardEvent, useId, useState } from 'react';

import { t } from '../../i18n/t.js';
import { classes } from './classes.js';
import { isNone, isValidHex, toHex } from './color.js';

/** What the picker shows before it has ever had a color. */
const DEFAULT_HEX = '#000000';

/** What was typed, with the `#` a hex is so often typed without. */
const withHash = (text: string): string => (text.startsWith('#') ? text : `#${text}`);

/**
 * How a color is laid out (`ui.css`): `inline`, its name then its row on one
 * line, as a bar and a form of inline fields have it; `stacked`, as a panel's
 * and a dialog's groups are (`field-group`), its name over its row, the hex
 * as wide as the row leaves it, and the colors used lately under the row.
 * Either way the row is never broken.
 */
export type ColorFieldLayout = 'inline' | 'stacked';

/** What the label is: hidden from the eye, a field's name beside it, or a group's over it. */
const labelClass = (layout: ColorFieldLayout, hideLabel: boolean | undefined): string => {
	if (hideLabel === true) return 'visually-hidden';
	return layout === 'stacked' ? 'field-legend' : 'field-label';
};

/**
 * A color (docs/ARCHITECTURE.md §7, "The interface"): a fill, a stroke. The
 * native picker as the swatch, named by the field's label; a field for the hex
 * beside it, which takes a typed color on Enter or on leaving it and goes
 * back to the color it had on Escape or on anything that is not one; `None`
 * where a fill or a stroke may be absent; and the colors used lately as a
 * row of swatches. `value` is a CSS color as the drawing has it, or `none`;
 * what goes back is always `#rrggbb` or `none`.
 */
export const ColorField = ({
	label,
	value,
	onChange,
	allowNone,
	recent,
	hideLabel,
	layout = 'inline',
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	allowNone?: boolean;
	recent?: readonly string[];
	hideLabel?: boolean;
	layout?: ColorFieldLayout;
}) => {
	const pickerId = useId();
	const none = isNone(value);
	const hex = toHex(value);
	// The color the picker goes on showing while the value is `none`: the
	// last one it had, so that None and back is a round trip. Adjusted as the
	// value changes, during the render that sees it change.
	const [held, setHeld] = useState(hex ?? DEFAULT_HEX);
	if (hex !== undefined && hex !== held) setHeld(hex);
	// What has been typed into the hex field and not yet committed.
	const [draft, setDraft] = useState<string | undefined>(undefined);

	const commit = (text: string) => {
		setDraft(undefined);
		const typed = withHash(text.trim());
		if (!isValidHex(typed)) return;
		const next = toHex(typed);
		if (next !== undefined && next !== hex) onChange(next);
	};

	const onHexKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			commit(event.currentTarget.value);
		}
		// Taken only when there is a draft to drop: otherwise Escape is the
		// sheet's or the drawer's the field is in.
		if (event.key === 'Escape' && draft !== undefined) {
			event.preventDefault();
			setDraft(undefined);
		}
	};

	return (
		<div className={classes('color-field', `color-field-${layout}`)}>
			<label htmlFor={pickerId} className={labelClass(layout, hideLabel)}>
				{label}
			</label>
			{/* One row, never broken: the swatch, the hex and None. */}
			<div className="color-field-row">
				{/* The swatch is drawn in `currentColor` under a picker that cannot be seen but takes the press. */}
				<span
					className={classes('color-swatch', none && 'is-none')}
					style={{ color: hex ?? held }}
				>
					<input
						id={pickerId}
						type="color"
						value={hex ?? held}
						onChange={(event) => commit(event.target.value)}
					/>
				</span>
				<input
					type="text"
					className="color-hex"
					aria-label={t('ui.hex', { label })}
					inputMode="text"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					maxLength={7}
					value={draft ?? (none ? '' : (hex ?? value))}
					placeholder={none ? t('ui.none') : undefined}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={onHexKeyDown}
					onBlur={(event) => {
						if (draft !== undefined) commit(event.target.value);
					}}
				/>
				{allowNone === true && (
					<button
						type="button"
						className="color-none"
						aria-pressed={none}
						onClick={() => onChange(none ? held : 'none')}
					>
						{t('ui.none')}
					</button>
				)}
			</div>
			{recent !== undefined && recent.length > 0 && (
				<div className="color-recent" role="group" aria-label={t('ui.recentColors')}>
					{recent.map((color) => {
						const swatch = toHex(color) ?? color;
						return (
							<button
								key={color}
								type="button"
								className="color-recent-swatch"
								// The swatch is drawn in `currentColor`, so the color is the one style set here.
								style={{ color: swatch }}
								aria-label={t('ui.recentColor', { hex: swatch })}
								aria-pressed={swatch === hex}
								onClick={() => onChange(swatch)}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
};
