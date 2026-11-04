import { answer, type InpaintRequest } from './engine.js';

/**
 * The worker content-aware fill runs in (`./index.ts` starts it): one request,
 * the picture and the mask, and one reply, the picture filled, its buffer
 * transferred back. The page terminates it once it has answered.
 */
self.addEventListener('message', (event: MessageEvent<InpaintRequest>) => {
	void answer(event.data).then((reply) => {
		self.postMessage(reply, { transfer: 'data' in reply ? [reply.data] : [] });
	});
});
