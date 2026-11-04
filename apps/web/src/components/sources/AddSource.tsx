import { type ComponentProps, type ReactNode, type RefObject, useEffect, useRef } from 'react';

import { t } from '../../i18n/t.js';
import { ConnectChoice } from './connect/ConnectChoice.js';
import { useAdding } from './useAdding.js';
import type { useSourceChoices } from './useSourceChoices.js';

/** What the control that opens it is told, to draw itself by. */
interface AddButton {
	readonly adding: boolean;
	readonly toggle: () => void;
	/** Nothing connected yet: the control has words, and the menu asks for a provider. */
	readonly first: boolean;
	/** Whether there is any provider to offer, which is whether the menu can open. */
	readonly offering: boolean;
	/** What connecting is called here (`connectLabel`). */
	readonly label: string;
}

/**
 * What the `+` opens, hung under it. Closes on Escape and on a press anywhere
 * outside it, which is the whole of what a popover this small owes anyone:
 * the controls inside are ordinary controls, a form among them, so it is a
 * group and not a menu, and arrows do not move in it.
 *
 * `frame` is the element around both the popover and the control that opened
 * it, and it is what "inside" means. A press on the control is not a press
 * outside: the control closes the popover itself, and letting this close it
 * first had the control's own press open it straight back up. And Escape is
 * heard from the control as well as from the popover, since the control is
 * where the focus is when it has just been opened with the keyboard. A
 * question asked inside (`ConnectButton`'s) hears Escape first, and keeps it.
 */
const Popover = ({
	children,
	label,
	frame,
	onClose,
}: Readonly<{
	children: ReactNode;
	label: string;
	frame: RefObject<HTMLElement | null>;
	onClose: () => void;
}>) => {
	useEffect(() => {
		const element = frame.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
			// The control that opened it, which is the frame's first: the
			// focus was in what has just gone.
			element.querySelector<HTMLElement>('button')?.focus();
		};
		const onPress = (event: PointerEvent) => {
			if (event.target instanceof Node && element.contains(event.target)) return;
			onClose();
		};
		element.addEventListener('keydown', onKey);
		// Capturing, so a press on something that stops its own event is
		// still a press outside.
		document.addEventListener('pointerdown', onPress, true);
		return () => {
			element.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', onPress, true);
		};
	}, [frame, onClose]);

	return (
		<div className="source-add-menu" role="group" aria-label={label}>
			{children}
		</div>
	);
};

/**
 * The way to connect another account: the `+` and the popover it opens, with
 * the operator's gate and a button per provider (`ConnectChoice`).
 *
 * The place it is in draws its own control (`button`): with words while
 * nothing is connected, and an icon once something is, there even with
 * nothing to offer, disabled, so the header keeps its shape. The control's
 * shape is not the popover's business; whether it is open is.
 */
export const AddSource = ({
	choices: { offerable, gate, live, connectLabel, first },
	enterCode,
	button,
	...connect
}: Omit<ComponentProps<typeof ConnectChoice>, 'gate' | 'live' | 'openAt' | 'offerable'> &
	Readonly<{
		choices: Pick<
			ReturnType<typeof useSourceChoices>,
			'offerable' | 'gate' | 'live' | 'connectLabel' | 'first'
		>;
		/** How many times the app's URL has asked for the code field (`useAdding`). */
		enterCode: number | undefined;
		button: (control: AddButton) => ReactNode;
	}>) => {
	const offering = offerable.length > 0;
	const { adding, openAt, toggle, stopAdding } = useAdding(enterCode, offering);
	const frame = useRef<HTMLDivElement>(null);
	return (
		<div className="source-add" ref={frame}>
			{button({ adding, toggle, first, offering, label: connectLabel })}
			{adding && (
				<Popover label={t('sources.providers')} frame={frame} onClose={stopAdding}>
					<p className="source-add-heading">
						{first ? t('sources.chooseProvider') : connectLabel}
					</p>
					<ConnectChoice
						gate={gate}
						live={live}
						openAt={openAt}
						offerable={offerable}
						{...connect}
					/>
				</Popover>
			)}
		</div>
	);
};
