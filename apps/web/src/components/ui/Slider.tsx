import { useId } from 'react';

import { classes } from './classes.js';

/**
 * A number in a range (docs/ARCHITECTURE.md §7, "The interface"): a brush's
 * size, a layer's opacity. The native range input, which the arrow keys move
 * on every platform, in a hit area `--target` tall; the value is read out
 * beside it, through `format` when the number alone would not say what it is.
 *
 * The input is named by the label alone, and says its value as the read-out
 * does (`aria-valuetext`): the read-out itself is hidden from a screen reader,
 * since an `<output>` is a live region, and one that spoke at every step of a
 * drag would talk over everything else.
 */
export const Slider = ({
	label,
	value,
	min,
	max,
	step,
	onChange,
	format,
	disabled,
	hideLabel,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	onChange: (value: number) => void;
	format?: (value: number) => string;
	disabled?: boolean;
	hideLabel?: boolean;
}) => {
	const id = useId();
	const shown = format === undefined ? String(value) : format(value);
	return (
		<div className={classes('slider', disabled === true && 'is-disabled')}>
			<label htmlFor={id} className={hideLabel === true ? 'visually-hidden' : 'field-label'}>
				{label}
			</label>
			<input
				id={id}
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				aria-valuetext={format === undefined ? undefined : shown}
				disabled={disabled}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
			<output htmlFor={id} aria-hidden="true">
				{shown}
			</output>
		</div>
	);
};
