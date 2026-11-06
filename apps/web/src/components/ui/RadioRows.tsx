import '../../styles/dialogs.css';

import { useId } from 'react';

/** One of the rows: what it chooses, and its name. */
export type RadioChoice<T extends string> = Readonly<{ value: T; label: string }>;

/**
 * One of a few choices in a dialog (docs/ARCHITECTURE.md §7, "The
 * interface"), as Photoshop's dialogs ask them: a group under its name, of
 * native radios, each a whole row a target tall to press, so the arrow keys
 * move the choice as they do in any radio group, and Space makes it.
 */
export const RadioRows = <T extends string>({
	legend,
	choices,
	value,
	onChange,
}: Readonly<{
	legend: string;
	choices: readonly RadioChoice<T>[];
	value: T;
	onChange: (value: T) => void;
}>) => {
	const name = useId();
	return (
		<fieldset className="field-group">
			<legend className="field-legend">{legend}</legend>
			{choices.map((choice) => (
				<label key={choice.value} className="radio-row">
					<input
						type="radio"
						name={name}
						value={choice.value}
						checked={choice.value === value}
						onChange={() => onChange(choice.value)}
					/>
					<span>{choice.label}</span>
				</label>
			))}
		</fieldset>
	);
};
