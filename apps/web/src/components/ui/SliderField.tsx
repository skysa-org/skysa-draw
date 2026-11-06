import '../../styles/dialogs.css';

import { Slider } from './Slider.js';

/** A number held to the range, as a field that types one past it shows it. */
const within =
	(min: number, max: number) =>
	(value: number): number =>
		Math.min(max, Math.max(min, value));

/**
 * A number in a range in a dialog (docs/decisions/0004-the-interface.md, "The
 * context menu"): Fill…'s opacity, Modify…'s radius. A `Slider` to drag, and
 * beside it a number field to type in, which says the value in place of the
 * slider's own read-out, since that would only be squeezed under it. What is
 * typed is held to the range by `clamp`, or by `min` and `max` alone; what is
 * not a number keeps the value as it was.
 */
export const SliderField = ({
	label,
	fieldLabel,
	value,
	min,
	max,
	step,
	format,
	clamp = within(min, max),
	onChange,
}: Readonly<{
	label: string;
	/** The number field's name, for a screen reader: the slider's, said as a value. */
	fieldLabel: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	format?: (value: number) => string;
	clamp?: (value: number) => number;
	onChange: (value: number) => void;
}>) => (
	<div className="slider-field">
		<Slider
			label={label}
			value={value}
			min={min}
			max={max}
			step={step}
			format={format}
			onChange={onChange}
		/>
		<input
			type="number"
			inputMode="decimal"
			className="slider-field-input"
			aria-label={fieldLabel}
			min={min}
			max={max}
			step="any"
			value={value}
			onChange={(event) => {
				const typed = event.target.valueAsNumber;
				onChange(Number.isFinite(typed) ? clamp(typed) : value);
			}}
		/>
	</div>
);
