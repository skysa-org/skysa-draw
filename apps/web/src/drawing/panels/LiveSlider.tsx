import { useEffect, useEffectEvent, useRef, useState } from 'react';

import { Slider } from '../../components/ui/Slider.js';

/**
 * A slider whose drag is a preview and whose release is one change: an
 * opacity, an adjustment's parameter. `onPreview` follows every step of the
 * drag, which the caller shows without recording (`usePreview`); `onCommit`
 * comes once, when the input's `change` fires, at the pointer's release or a
 * key's step, with the value it ended at. The value shown is the drag's
 * while it lasts, and the caller's otherwise.
 *
 * React's `onChange` on a range input is the native `input` event, so the
 * release is heard as the native `change`, on the window, after React has
 * handled the same event, so a commit always comes after the preview of its
 * value.
 */
export const LiveSlider = ({
	label,
	value,
	min,
	max,
	step,
	format,
	onPreview,
	onCommit,
}: Readonly<{
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	format?: (value: number) => string;
	onPreview: (value: number) => void;
	onCommit: (value: number) => void;
}>) => {
	const [draft, setDraft] = useState<number | undefined>(undefined);
	const box = useRef<HTMLDivElement>(null);
	const commit = useEffectEvent((next: number) => {
		setDraft(undefined);
		onCommit(next);
	});
	useEffect(() => {
		const onChange = (event: Event) => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement) || box.current?.contains(target) !== true) {
				return;
			}
			commit(Number(target.value));
		};
		window.addEventListener('change', onChange);
		return () => window.removeEventListener('change', onChange);
	}, []);
	return (
		<div ref={box} className="live-slider">
			<Slider
				label={label}
				value={draft ?? value}
				min={min}
				max={max}
				step={step}
				format={format}
				onChange={(next) => {
					setDraft(next);
					onPreview(next);
				}}
			/>
		</div>
	);
};
