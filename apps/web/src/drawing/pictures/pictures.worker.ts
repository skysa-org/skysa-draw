import { answerPicture, type PictureAnswer } from './answer.js';
import { isPictureRequest, type PictureHello, type PictureReply } from './protocol.js';

/**
 * The worker the page's picture work runs in (`./index.ts` starts one a
 * page, the first time it is asked for, and keeps it): requests in, each
 * answered as soon as it is done (`./answer.ts`), in whatever order that is,
 * by its id. It says it listens before anything is asked of it, so the page
 * transfers no pixels to a worker that never started.
 */

/** The answer posted; one whose reply cannot be posted still says why, so the page does not wait on it. */
const post = ({ reply, transfer }: PictureAnswer): void => {
	try {
		self.postMessage(reply, { transfer: [...transfer] });
	} catch (error) {
		const told: PictureReply = {
			id: reply.id,
			error: error instanceof Error ? error.message : 'the reply could not be posted',
		};
		self.postMessage(told);
	}
};

self.addEventListener('message', (event: MessageEvent<unknown>) => {
	if (isPictureRequest(event.data)) void answerPicture(event.data).then(post);
});

const hello: PictureHello = { ready: true };
self.postMessage(hello);
