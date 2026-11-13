import { describeScheduling } from '@skysa/client/testing';

import { dexieDevice } from '../support/dexieDevice.js';

// The scheduler over this app's database and with its own scheduler: the
// suite the kit runs over the ports in memory (`scheduler.test.ts`).
describeScheduling('over the app’s database', dexieDevice);
