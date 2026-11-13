import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppFoot } from '../../src/components/shell/AppFoot.js';
import type * as Gate from '../../src/components/shell/StaleTabGate.js';

const broken = vi.hoisted(() => ({ gate: false }));

// The real gate, but for a test that has it fail as it renders.
vi.mock('../../src/components/shell/StaleTabGate.js', async (importOriginal) => {
	const real = await importOriginal<typeof Gate>();
	const Broken = () => {
		throw new Error('the gate broke');
	};
	return {
		StaleTabGate: (props: Parameters<typeof real.StaleTabGate>[0]) =>
			broken.gate ? <Broken /> : <real.StaleTabGate {...props} />,
	};
});

describe("the bars along the window's foot", () => {
	it("holds the stale window's and the new build's, in that order", () => {
		broken.gate = false;
		const { container } = render(<AppFoot />);

		const foot = container.querySelector('.app-foot');
		// The gate's status is there before it has anything to say.
		expect(foot?.firstElementChild).toBe(screen.getByRole('status'));
	});

	it('takes only the bars away when one of them fails, not the page', () => {
		broken.gate = true;
		// React says what a boundary caught; here it is meant to.
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { container } = render(
			<>
				<p>the drawing</p>
				<AppFoot />
			</>
		);

		expect(screen.getByText('the drawing')).toBeDefined();
		expect(container.querySelector('.app-foot')).toBeNull();
	});
});
