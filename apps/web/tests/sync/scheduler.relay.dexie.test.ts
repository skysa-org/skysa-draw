import { describeChangeRelay } from '@skysa/client/testing';

import { dexieDevice } from '../support/dexieDevice.js';

// The change relay over this app's database and with its own scheduler: the
// suite the kit runs over the ports in memory (`scheduler.relay.test.ts`).
describeChangeRelay('over the app’s database', dexieDevice);
