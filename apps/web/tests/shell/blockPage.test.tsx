import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { useBlockedPage } from '../../src/components/shell/blockPage.js';

/**
 * A cover over the page, with a button of its own that takes the focus, as
 * the gate's notice does.
 */
const Cover = ({ name }: { name: string }) => {
	const cover = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	useBlockedPage(cover);
	useEffect(() => {
		button.current?.focus();
	}, []);
	return createPortal(
		<div ref={cover}>
			<button ref={button} type="button">
				{name}
			</button>
		</div>,
		document.body
	);
};

const Page = ({ covers }: { covers: readonly string[] }) => (
	<>
		<button type="button">the drawing</button>
		{covers.map((name) => (
			<Cover key={name} name={name} />
		))}
	</>
);

describe('the page blocked behind a cover', () => {
	it('stacks: a second cover is not blocked by the first, and the page is let go only once the last goes', async () => {
		// As the editor's shortcuts listen: on the window.
		const heard = vi.fn();
		window.addEventListener('keydown', heard);
		onTestFinished(() => {
			window.removeEventListener('keydown', heard);
		});
		const page = () => screen.getByRole('button', { name: 'the drawing' });
		const blocked = (element: Element) => element.closest('[inert]') !== null;
		const view = render(<Page covers={[]} />);
		page().focus();

		// A window settling at a take-over, which goes out of date meanwhile.
		view.rerender(<Page covers={['settling']} />);
		view.rerender(<Page covers={['settling', 'out of date']} />);
		// Put in the page after the second cover: once the block's watch on the
		// body has blocked it, it has seen the cover come too.
		const later = document.body.appendChild(document.createElement('div'));
		onTestFinished(() => {
			later.remove();
		});
		await vi.waitFor(() => {
			expect(later.hasAttribute('inert')).toBe(true);
		});

		expect(blocked(page())).toBe(true);
		expect(blocked(screen.getByRole('button', { name: 'settling' }))).toBe(false);
		expect(blocked(screen.getByRole('button', { name: 'out of date' }))).toBe(false);

		// The notice put aside, while the window still settles.
		view.rerender(<Page covers={['settling']} />);
		expect(blocked(page())).toBe(true);
		fireEvent.keyDown(page(), { key: 'z' });
		expect(heard).not.toHaveBeenCalled();

		view.rerender(<Page covers={[]} />);
		expect(blocked(page())).toBe(false);
		fireEvent.keyDown(page(), { key: 'z' });
		expect(heard).toHaveBeenCalledOnce();
		// The focus back where it was before the first cover came.
		expect(document.activeElement).toBe(page());
	});
});
