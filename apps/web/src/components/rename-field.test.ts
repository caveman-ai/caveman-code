import { expect, test } from "vitest";
import { markTyped, renamedTo } from "./rename-field.ts";

const field = (value: string) => ({ value, dataset: {} as DOMStringMap });

test("an untouched rename saves nothing, so a title that landed meanwhile stays (T3's #23171)", () => {
  // Opened on "New chat"; the chat's own title arrived as "Fix the retry jitter" while the field was open.
  expect(renamedTo(field("New chat"), "Fix the retry jitter")).toBeNull();
});

test("a typed name saves, trimmed; an empty or unchanged one does not", () => {
  const typed = field("  Retry jitter  ");
  markTyped({ currentTarget: typed });
  expect(renamedTo(typed, "New chat")).toBe("Retry jitter");
  const cleared = field("   ");
  markTyped({ currentTarget: cleared });
  expect(renamedTo(cleared, "New chat")).toBeNull();
  const same = field("New chat");
  markTyped({ currentTarget: same });
  expect(renamedTo(same, "New chat")).toBeNull();
});
