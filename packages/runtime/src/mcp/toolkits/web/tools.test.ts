// The engine waits WEB_TOOL_TIMEOUT_MS for a web tool. Every path through a call, each step at its own limit, must
// end within it, or a read that succeeds slowly comes back to the model as a timeout.
import { expect, it } from "vitest";

import { CREDITS_TIMEOUT_MS } from "../../../web/credits.ts";
import { FETCH_TIMEOUT_MS } from "../../../web/fetchPage.ts";
import { FIRECRAWL_TIMEOUT_MS } from "../../../web/firecrawl.ts";
import { FIRECRAWL_LOCAL_START_MS } from "../../../web/firecrawlLocal.ts";
import { PARSE_TIMEOUT_MS } from "../../../web/pageProcess.ts";
import { PROVIDER_TIMEOUT_MS, WEB_PROVIDERS } from "../../../web/providers.ts";
import { WEB_TOOL_TIMEOUT_MS } from "./tools.ts";

it("outlasts every path a call can take, each step at its own limit", () => {
  const paths = {
    // Firecrawl Local starts, reads and its page fails to parse; the runtime's reader is turned away or reads a
    // shell; Firecrawl Cloud renders it.
    localThenOwnThenCloud:
      FIRECRAWL_LOCAL_START_MS +
      FIRECRAWL_TIMEOUT_MS +
      PARSE_TIMEOUT_MS +
      FETCH_TIMEOUT_MS +
      PARSE_TIMEOUT_MS +
      FIRECRAWL_TIMEOUT_MS +
      PARSE_TIMEOUT_MS,
    // Firecrawl Local not installed: the runtime's reader, then Firecrawl Cloud.
    ownThenCloud: FETCH_TIMEOUT_MS + PARSE_TIMEOUT_MS + FIRECRAWL_TIMEOUT_MS + PARSE_TIMEOUT_MS,
    // Every own search key fails over slowly, then Caveman credits.
    search: WEB_PROVIDERS.length * PROVIDER_TIMEOUT_MS + CREDITS_TIMEOUT_MS,
  };
  for (const [path, ms] of Object.entries(paths))
    expect({ path, fits: ms + 5_000 <= WEB_TOOL_TIMEOUT_MS }).toEqual({ path, fits: true });
});
