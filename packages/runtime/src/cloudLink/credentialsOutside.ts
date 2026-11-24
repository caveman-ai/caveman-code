// How a runtime gets its credential rule (credentialRule.ts): on a Cloud computer the rule is joined to Cloud's
// `GET runtime`, asked when the runtime first reads the rule (as it starts); on a Mac it is never joined and never
// applies.
import * as Effect from "effect/Effect";

import { CALL_TIMEOUT_MS, withRuntimeToken } from "./computers.ts";
import { ruleOf } from "./credentialRule.ts";
import { CloudError, cloudFailure, readIdentity } from "./identity.ts";
import { CloudComputer, CloudLinkState, type LinkState } from "./index.ts";

/**
 * Cloud's word, from `GET runtime`: an answer without the field, or a Cloud from before the route, is "no".
 *
 * While the link runs the ask goes out on the link's own token, never one minted beside it (computers.ts tokenFor,
 * K14). Before the link runs there is no token to wait for, and the first ask is made then: a starting runtime reads
 * its engines' keys (readCavemanKeys, modelConnections.ts computerKeySource) on its way to listening, and starts its
 * link only once it listens. Waiting here for the link held every Cloud computer's start, and so every wake, for the
 * whole call timeout (10 s), and then asked on a minted token anyway. So it asks at once: tokenFor mints one for the
 * call, as for every call made while no link runs, and the link's own mint, made after it, is the newer.
 *
 * The same answer's `routes_auto` (the agents whose Auto Cloud routes here) goes to the link's rule as it is heard.
 */
export async function askCredentialsOutside(input: {
  readonly linkDir: string;
  readonly link: LinkState;
  readonly fetch?: typeof fetch;
}): Promise<boolean> {
  const identity = readIdentity(input.linkDir);
  if (identity === undefined) throw new CloudError(503, "This computer has no Cloud identity yet");
  const fetchImpl = input.fetch ?? fetch;
  const response = await withRuntimeToken(identity, input.link, fetchImpl, (token) =>
    fetchImpl(`${identity.cloudUrl}/api/v1/code/runtime`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }),
  );
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  if (!response.ok) throw await cloudFailure(response);
  const body = (await response.json().catch(() => undefined)) as
    | { credentials_outside?: unknown; routes_auto?: unknown }
    | undefined;
  ruleOf(input.link).heardRoutesAuto(body?.routes_auto);
  return body?.credentials_outside === true;
}

/**
 * This runtime's rule, joined to Cloud on a Cloud computer (the first read starts the ask). Both services have
 * defaults, so this reads from any fiber of the runtime.
 */
export const credentialRule = Effect.gen(function* () {
  const computer = yield* CloudComputer;
  const link = yield* CloudLinkState;
  const rule = ruleOf(link);
  if (computer !== undefined)
    rule.join(() => askCredentialsOutside({ linkDir: computer.linkDir, link }));
  return rule;
});

/** Whether credentials stay outside this computer (CredentialRule.outside), failing with Cloud's failure when it cannot say. */
export const credentialsOutside = credentialRule.pipe(
  Effect.flatMap((rule) =>
    Effect.tryPromise({ try: () => rule.outside(), catch: (error) => error }),
  ),
);
