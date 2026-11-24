// A Cloud computer for a handler's test, with no Cloud behind it: its two services, and its credential rule answered
// as Cloud's `GET runtime` would be (credentialRule.ts). `turnOn` is Cloud refusing a credential route later: the
// rule coming on while the computer runs.
import * as Layer from "effect/Layer";

import { OUTSIDE_COMPUTER, ruleOf } from "./credentialRule.ts";
import { CloudError } from "./identity.ts";
import { CloudComputer, CloudLinkState, type LinkState } from "./index.ts";

export const cloudComputerUnderRule = (outside: boolean) => {
  const link: LinkState = {};
  const rule = ruleOf(link);
  rule.join(() => Promise.resolve(outside));
  return {
    layer: Layer.mergeAll(
      Layer.succeed(CloudComputer, {
        linkDir: "/nonexistent/link",
        computerId: "computer-test",
        workspaceRoot: "/nonexistent/workspace",
      }),
      Layer.succeed(CloudLinkState, link),
    ),
    turnOn: () =>
      void rule.refusedBy(new CloudError(403, "outside this computer", OUTSIDE_COMPUTER)),
  };
};
