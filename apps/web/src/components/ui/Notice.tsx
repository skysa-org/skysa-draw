/**
 * A line said in passing (docs/ARCHITECTURE.md §7, "The interface"): "Saved",
 * "Pencil does not work on a raster layer". A small card floating over the
 * canvas while there is a message, and nothing while there is not — except
 * the live region itself, which stays so that a screen reader is told when
 * the message changes rather than finding a new region.
 */
export const Notice = ({ message }: { message: string | undefined }) => (
	<div role="status" aria-live="polite" className="notice">
		{message !== undefined && <div className="notice-card">{message}</div>}
	</div>
);
