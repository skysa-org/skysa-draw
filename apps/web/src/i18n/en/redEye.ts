/** The Red eye tool (docs/decisions/0004-the-interface.md): a pupil a flash turned red, darkened. */
export const redEye = {
	/** A pupil darkened, as the undo history names it. */
	command: 'Red eye',
	/** A click, or a box dragged, where nothing red enough to be a pupil was found: nothing changed. */
	notFound: 'No red pupil was found there. Click the red of the eye, or drag a box around it.',
	/** Red was found, but only where the area selected does not reach: nothing changed. */
	outsideArea: 'The red there is outside the selection, so nothing was changed.',
} as const;
