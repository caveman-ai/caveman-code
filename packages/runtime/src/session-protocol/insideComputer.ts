// The one check a client's call passes before it makes, takes or keeps a credential of the person's on this computer
// (cloud-computers SPEC §5.6, CONTRACT §2; cloudLink/credentialRule.ts). On a Cloud computer under the rule the agent
// is root, so whatever the runtime keeps, the agent holds too: the call is refused (`unsupported`) with a sentence
// that says where to do it instead, before anything is checked with a provider, stored or handed on. While Cloud
// cannot say whether the rule applies, nothing is taken either (`engine_unavailable`). A Mac's rule is never joined:
// there every call passes, and nothing is asked.
//
// What passes it: engine.account.add, signin, complete and remove (engineAccounts.ts), web.keys.set (webKeys.ts),
// secret_provider.save and a secret_slot.set that points at a secret manager (secretProviders.ts), credential.grant
// and an mcp.add or marketplace.add whose command line or URL carries a key (plugins/protocolHandlers.ts), and a
// chief.voice.key that sets one (chief/voice/Call.ts setKey). A call that only removes what an earlier run kept here
// (web.keys.clear, secret_provider.remove, credential.revoke, a null voice key) is not one of them: it takes
// nothing in. Nor is what a person types into a chat, a terminal or a file: that is theirs to give the agent.
import * as Effect from "effect/Effect";

import { credentialRule } from "../cloudLink/credentialsOutside.ts";
import { ProtocolError } from "./handlers.ts";

/** What a call is told while Cloud cannot say whether credentials stay outside this computer. */
export const RULE_UNHEARD = "Can't reach Caveman. Try again.";

/** Passes where a credential may be made, taken or kept on this computer; refuses with `refusal` where they stay outside it. */
export type InsideComputer = (refusal: string) => Effect.Effect<void, ProtocolError>;

export const makeInsideComputer = credentialRule.pipe(
  Effect.map(
    (rule): InsideComputer =>
      (refusal) =>
        Effect.promise(() =>
          rule.outside().then(
            (outside) => (outside ? ("unsupported" as const) : undefined),
            () => "engine_unavailable" as const,
          ),
        ).pipe(
          Effect.flatMap((reason) =>
            reason === undefined
              ? Effect.void
              : Effect.fail(
                  new ProtocolError({
                    reason,
                    message: reason === "unsupported" ? refusal : RULE_UNHEARD,
                  }),
                ),
          ),
        ),
  ),
);
