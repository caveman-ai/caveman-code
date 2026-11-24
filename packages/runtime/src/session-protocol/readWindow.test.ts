import { expect, test } from "vitest";

import { wholeUtf8 } from "./handlers.ts";

test("a read window that stops inside a character ends before it (T3 #21466)", () => {
  const text = Buffer.from("aé€😀", "utf8"); // 1 + 2 + 3 + 4 bytes
  for (let end = 0; end <= text.length; end++) {
    const window = wholeUtf8(text.subarray(0, end));
    // Always whole characters: decoding and encoding again gives the same bytes.
    expect(Buffer.from(window.toString("utf8"), "utf8").equals(window), `end ${end}`).toBe(true);
    expect(end - window.length, `end ${end}`).toBeLessThan(4);
  }
  expect(wholeUtf8(text.subarray(0, 4)).toString("utf8")).toBe("aé");
  expect(wholeUtf8(text).toString("utf8")).toBe("aé€😀");
  // Bytes that are no UTF-8 are left to the binary check.
  expect(wholeUtf8(Buffer.from([0x00, 0xff, 0xfe]))).toEqual(Buffer.from([0x00, 0xff, 0xfe]));
});
