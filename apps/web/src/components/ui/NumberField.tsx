import '../../styles/dialogs.css';

import { useId } from 'react';

/**
 * A number typed (docs/ARCHITECTURE.md §7, "The interface"): a size in
 * pixels, an angle in degrees. Its name before the field and its unit after
 * it, which is the field's description, so a screen reader says the unit
 * after the name and the value. The text is the dialog's, as typed, so a
 * field emptied to type another number stays empty rather than snapping back
 * to the last one; what it is worth, and whether it is valid, is the
 * dialog's to read, and a field it calls `invalid` says so in its border and
 * to a screen reader. A `signed` field takes a minus, which a phone's decimal
 * keypad has no key for, and so is given the keyboard with one.
 */
export const NumberField = ({
	label,
	value,
	onChange,
	unit,
	min,
	max,
	invalid = false,
	signed = false,
}: Readonly<{
	label: string;
	/** The text in the field. */
	value: string;
	onChange: (text: string) => void;
	unit?: string;
	min?: number;
	max?: number;
	invalid?: boolean;
	signed?: boolean;
}>) => {
	const id = useId();
	const unitId = `${id}-unit`;
	return (
		<div className="number-field">
			<label htmlFor={id} className="field-label">
				{label}
			</label>
			<input
				id={id}
				type="number"
				inputMode={signed ? undefined : 'decimal'}
				step="any"
				min={min}
				max={max}
				value={value}
				aria-invalid={invalid || undefined}
				aria-describedby={unit === undefined ? undefined : unitId}
				onChange={(event) => onChange(event.target.value)}
			/>
			{unit !== undefined && (
				<span id={unitId} className="number-field-unit">
					{unit}
				</span>
			)}
		</div>
	);
};
