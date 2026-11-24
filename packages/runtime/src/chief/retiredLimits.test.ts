import { expect, test } from "vitest";

import { retireLimitDefaults } from "./Chief.ts";

test("limits saved at their retired defaults go (an install never changed reads as no limit); other values stay", () => {
  const old = retireLimitDefaults({
    theme: "dark",
    chief_max_concurrent: 4,
    chief_daily_cap_usd: 20,
    chief_daily_turns: 200,
    chief_ask_above_chats: 3,
  });
  expect(old).toEqual({ kept: { theme: "dark", chief_ask_above_chats: 3 }, changed: true });

  const chosen = { chief_max_concurrent: 6, chief_daily_cap_usd: 5, chief_daily_turns: 0 };
  expect(retireLimitDefaults(chosen)).toEqual({ kept: chosen, changed: false });
  expect(retireLimitDefaults({})).toEqual({ kept: {}, changed: false });
});
