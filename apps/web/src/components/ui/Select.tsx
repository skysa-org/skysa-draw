/**
 * One of a few named choices (docs/ARCHITECTURE.md §7, "The interface"): a
 * blend mode, an export format. The native select, which every platform opens
 * in the way its users know, in a hit area `--target` tall.
 */
export const Select = <T extends string>({
	label,
	value,
	options,
	onChange,
	hideLabel,
}: {
	label: string;
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (value: T) => void;
	hideLabel?: boolean;
}) => (
	<label className="select">
		<span className={hideLabel === true ? 'visually-hidden' : 'field-label'}>{label}</span>
		<select
			value={value}
			onChange={(event) => {
				// The option, rather than the event's string, so the value given
				// back is one of the caller's own.
				const chosen = options.find((option) => option.value === event.target.value);
				if (chosen !== undefined) onChange(chosen.value);
			}}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	</label>
);
