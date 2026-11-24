// Session Protocol's own device tests (packages/session-protocol/test/devices.test.ts: ids and codes, hellos, frame
// keys, sealed frames, signed calls and moves, statements, pairing proofs), run again here with the phone's WebCrypto
// (webcrypto.ts) in place of Node's: the one implementation of the protocol holds on the adapter as it does on a
// platform's own crypto. The same file runs on Node's WebCrypto in the protocol package's own suite.
import { afterEach, beforeEach, expect } from "vitest";

import { installWebCrypto, subtle } from "./webcrypto";

installWebCrypto({ force: true });

// Each of those tests starts and ends on the adapter: none of them ran on Node's crypto by a slip.
const onAdapter = () => expect(globalThis.crypto.subtle).toBe(subtle);
beforeEach(onAdapter);
afterEach(onAdapter);

await import("../../../../packages/session-protocol/test/devices.test.ts");
