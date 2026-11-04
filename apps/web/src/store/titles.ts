import { t } from '../i18n/t.js';

/**
 * A drawing's title as it is shown. The row's title is the file's own
 * `<title>`, or the name its file was given (`titleOf` in `store/drawings.ts`),
 * so a title is all but never empty; one that is, a file whose name was all
 * punctuation, is shown in the user's words rather than as nothing
 * (docs/ARCHITECTURE.md §7, "The app's words").
 *
 * Ported from skysa-notes' `store/titles.ts` with only this: a note's name
 * falls back on its first words, and a drawing has none.
 */
export const titleShown = (title: string): string =>
	title.trim() === '' ? t('drawings.untitled') : title;
