// The one-time offer to use a subscription in Cloud (state/cloud-offer.ts): what it reads back from storage, when a
// Cloud start may show it, and what it says.
import { describe, expect, test } from "vitest";
import { cloudOfferTitle, MAX_SHOWN, mayOfferCloud, readCloudOffer } from "./cloud-offer.ts";

const CLAUDE = { engine: "claude-agent", approve: "Claude" } as const;
const CHATGPT = { engine: "codex", approve: "ChatGPT" } as const;

describe("what is read back", () => {
  test("nothing, damaged or foreign storage reads as never asked", () => {
    for (const raw of [
      null,
      "",
      "{",
      "null",
      "7",
      '{"answer":"maybe","shown":"2"}',
      '{"shown":-3}',
    ]) {
      expect(readCloudOffer(raw)).toEqual({ answer: null, shown: 0 });
    }
  });

  test("an answer and how often the offer was shown are kept", () => {
    expect(readCloudOffer('{"answer":"no","shown":2}')).toEqual({ answer: "no", shown: 2 });
    expect(readCloudOffer('{"answer":"yes","shown":1.9}')).toEqual({ answer: "yes", shown: 1 });
    expect(readCloudOffer('{"answer":null,"shown":1}')).toEqual({ answer: null, shown: 1 });
  });
});

describe("when a Cloud start shows it", () => {
  test("the first time, when a plan here could be carried to Cloud", () => {
    expect(mayOfferCloud({ answer: null, shown: 0 }, [CLAUDE])).toBe(true);
  });

  test("never once answered, whichever the answer", () => {
    expect(mayOfferCloud({ answer: "yes", shown: 1 }, [CLAUDE])).toBe(false);
    expect(mayOfferCloud({ answer: "no", shown: 1 }, [CLAUDE])).toBe(false);
  });

  test("not when there is nothing to approve (no plan login here, or it is connected already)", () => {
    expect(mayOfferCloud({ answer: null, shown: 0 }, [])).toBe(false);
  });

  test("an offer shows the first time only, answered or not, then is left to Settings", () => {
    expect(mayOfferCloud({ answer: null, shown: MAX_SHOWN - 1 }, [CLAUDE])).toBe(true);
    expect(mayOfferCloud({ answer: null, shown: MAX_SHOWN }, [CLAUDE])).toBe(false);
  });
});

describe("what it says", () => {
  test("names the subscription, or both", () => {
    expect(cloudOfferTitle([CLAUDE])).toBe("Use your Claude subscription here too?");
    expect(cloudOfferTitle([CHATGPT])).toBe("Use your ChatGPT subscription here too?");
    expect(cloudOfferTitle([CLAUDE, CHATGPT])).toBe(
      "Use your Claude and ChatGPT subscriptions here too?",
    );
  });
});
