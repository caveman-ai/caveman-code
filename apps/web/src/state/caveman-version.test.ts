import { describe, expect, test } from "vitest";
import { cavemanVersionOnce } from "./caveman-version.ts";

describe("cavemanVersionOnce", () => {
  test("asks once per chat and message: toggling back or a remount reads what came back", async () => {
    let asks = 0;
    const ask = () => (asks++, Promise.resolve("Same answer."));
    expect(await cavemanVersionOnce("s1", "m1", ask)).toBe("Same answer.");
    expect(await cavemanVersionOnce("s1", "m1", ask)).toBe("Same answer.");
    expect(asks).toBe(1);
    // Another message, or the same id in another chat, is its own rewrite.
    await cavemanVersionOnce("s1", "m2", ask);
    await cavemanVersionOnce("s2", "m1", ask);
    expect(asks).toBe(3);
  });

  test("two asks while the first is out share it", async () => {
    let asks = 0;
    let finish!: (text: string) => void;
    const ask = () => (asks++, new Promise<string>((resolve) => (finish = resolve)));
    const a = cavemanVersionOnce("s3", "m1", ask);
    const b = cavemanVersionOnce("s3", "m1", ask);
    finish("short");
    expect(await Promise.all([a, b])).toEqual(["short", "short"]);
    expect(asks).toBe(1);
  });

  test("a failed ask is forgotten, so trying again asks again", async () => {
    let asks = 0;
    const failing = () => (asks++, Promise.reject(new Error("engine_unavailable")));
    await expect(cavemanVersionOnce("s4", "m1", failing)).rejects.toThrow("engine_unavailable");
    expect(await cavemanVersionOnce("s4", "m1", () => (asks++, Promise.resolve("ok")))).toBe("ok");
    expect(asks).toBe(2);
  });
});
