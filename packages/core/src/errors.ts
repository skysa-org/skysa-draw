/**
 * What an unknown thrown value says, as a sentence to show or to log: an
 * `Error`'s message, a string as it is, and the type of anything else.
 * `throw` takes anything, and the places that catch (an error boundary, a
 * build script's report) must not throw over what they were handed.
 */
export const messageOf = (error: unknown): string => {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	return error === undefined || error === null ? '' : `${typeof error} thrown`;
};
