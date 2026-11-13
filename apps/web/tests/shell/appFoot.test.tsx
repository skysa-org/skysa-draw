import { render, screen } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AppFoot } from '../../src/components/shell/AppFoot.js';
import type * as Gate from '../../src/components/shell/StaleTabGate.js';
import type * as Prompt from '../../src/components/shell/UpdatePrompt.js';

const broken = vi.hoisted(() => ({ gate: false, prompt: false }));

const Broken = () => {
	throw new Error('the bar broke');
};

// The real bars, but for a test that has one fail as it renders.
vi.mock('../../src/components/shell/StaleTabGate.js', async (importOriginal) => {
	const real = await importOriginal<typeof Gate>();
	return {
		StaleTabGate: (props: Parameters<typeof real.StaleTabGate>[0]) =>
			broken.gate ? <Broken /> : <real.StaleTabGate {...props} />,
	};
});
vi.mock('../../src/components/shell/UpdatePrompt.js', async (importOriginal) => {
	const real = await importOriginal<typeof Prompt>();
	return {
		UpdatePrompt: (props: Parameters<typeof real.UpdatePrompt>[0]) =>
			broken.prompt ? <Broken /> : <real.UpdatePrompt {...props} />,
	};
});

/** One bar broken, and React's word on what a boundary caught, which here is meant, kept quiet. */
const breaking = (bar: 'gate' | 'prompt') => {
	broken[bar] = true;
	const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	onTestFinished(() => {
		broken[bar] = false;
		quiet.mockRestore();
	});
};

describe("the bars along the window's foot", () => {
	it("holds the stale window's and the new build's, in that order", () => {
		const { container } = render(<AppFoot />);

		const foot = container.querySelector('.app-foot');
		// The gate's status is there before it has anything to say.
		expect(foot?.firstElementChild).toBe(screen.getByRole('status'));
	});

	it('takes only the gate away when it fails, not the page', () => {
		breaking('gate');
		render(
			<>
				<p>the drawing</p>
				<AppFoot />
			</>
		);

		expect(screen.getByText('the drawing')).toBeDefined();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it("keeps the gate when the new build's bar fails", () => {
		breaking('prompt');
		render(<AppFoot />);

		expect(screen.getByRole('status')).toBeDefined();
	});
});
