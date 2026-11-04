/** The class names given, joined, with the ones a condition left out dropped. */
export const classes = (...names: readonly (string | false | undefined)[]): string =>
	names.filter((name) => typeof name === 'string' && name !== '').join(' ');
