// A provider failure crosses into events, transcripts and Cloud copies (.claude/skills/secret-containment):
// makeProviderFailure must strip every credential form it names (Bearer and Basic tokens, http(s) URL userinfo, query
// and fragment, quoted and key=value credentials, sk- keys) and stay within its bound without splitting a surrogate
// pair. A message it made is not always a fixed point: that finding is pinned below.
import { describe, expect, it } from "@effect/vitest";
import { sequences } from "@caveman-app/model-check";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import {
  makeProviderFailure,
  MAX_PROVIDER_FAILURE_CODE_LENGTH,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
} from "./failure.ts";

const canary = (n: number) => `cnry${n}Q7xZ9w`;
/** Each credential form the redaction names, carrying its own canary. */
const CREDENTIALS: ReadonlyArray<readonly [form: string, value: string]> = [
  [`Authorization: Bearer ${canary(1)}`, canary(1)],
  [`Basic ${canary(2)}`, canary(2)],
  [`https://user:${canary(3)}@api.example.test/v1`, canary(3)],
  [`https://${canary(4)}@api.example.test/`, canary(4)],
  [`https://api.example.test/v1?access_token=${canary(5)}&x=1`, canary(5)],
  [`https://api.example.test/v1#${canary(6)}`, canary(6)],
  [`{"api_key":"${canary(7)}"}`, canary(7)],
  [`{'password': '${canary(8)}'}`, canary(8)],
  [`token=${canary(9)}`, canary(9)],
  [`secret: "${canary(10)}"`, canary(10)],
  [`credential = '${canary(11)}'`, canary(11)],
  [`sk-${canary(12)}abcdefgh`, canary(12)],
];
const FILLER = [
  "request failed:",
  "(",
  ").",
  ",",
  "\n",
  "\t",
  "\u0000",
  "\u007f",
  "🚀",
  "é",
  '"',
  "'",
  "…",
];
const FRAGMENTS = [...CREDENTIALS.map(([form]) => form), ...FILLER];
/** Padding that puts the truncation boundary just before, inside or after what follows. Words are space-separated, as
 * provider text is: the patterns start at a word boundary, so `xBearer t` is not a credential form. */
const PADDING = [0, 4_000, 4_070, 4_085, 4_090, 4_094, 4_095, 4_096];

const holds = (message: string, code?: string) => {
  const failure = makeProviderFailure({ message, ...(code === undefined ? {} : { code }) });
  for (const [form, value] of CREDENTIALS) {
    if (message.includes(value))
      expect(
        failure.message,
        `${form} survived in ${JSON.stringify(failure.message.slice(-200))}`,
      ).not.toContain(value);
    if (code?.includes(value))
      expect(failure.code ?? "", `${form} survived in the code`).not.toContain(value);
  }
  expect(failure.message.length, "within the bound").toBeLessThanOrEqual(
    MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  );
  expect((failure.code ?? "").length).toBeLessThanOrEqual(MAX_PROVIDER_FAILURE_CODE_LENGTH);
  expect(failure.message, "the cut splits no surrogate pair").not.toMatch(/[\uD800-\uDBFF]…$/u);
  const again = makeProviderFailure({ message: failure.message }).message;
  for (const [form, value] of CREDENTIALS)
    expect(again, `${form} came back on a second pass`).not.toContain(value);
};

describe("makeProviderFailure: no named credential form survives, within its bound", () => {
  it("every message of up to 3 fragments, and of up to 2 at every padding (exhaustive)", () => {
    let messages = 0;
    for (const pad of PADDING) {
      for (const parts of sequences(FRAGMENTS, pad === 0 ? 3 : 2)) {
        holds(["x".repeat(pad), ...parts].join(" "));
        messages++;
      }
    }
    for (const [form] of CREDENTIALS) holds("ok", `E: ${form}`);
    console.log(
      `[secret-containment] makeProviderFailure: ${messages} messages and ${CREDENTIALS.length} codes, exhaustive to 3 fragments (2 when padded to the bound)`,
    );
  });

  it.prop(
    "longer messages of up to 12 fragments (sampled)",
    [
      Arbitrary.schema(Schema.Literals(PADDING as unknown as [number, ...Array<number>])),
      Arbitrary.array(Arbitrary.schema(Schema.Literals(FRAGMENTS as [string, ...Array<string>])), {
        maxLength: 12,
      }),
    ],
    ([pad, parts]) => holds(["x".repeat(pad), ...parts].join(" ")),
    { arbitrary: { runs: 2000, seed: 20261106 } },
  );

  it("FINDING (no leak): a message cut at the bound inside a URL changes when it passes through again", () => {
    const first = makeProviderFailure({
      message: `${"x".repeat(4_070)} https://user:${canary(3)}@api.example.test/v1`,
    }).message;
    const second = makeProviderFailure({ message: first }).message;
    expect(
      second,
      "the second pass is now a fixed point: the finding is fixed, delete this test",
    ).not.toBe(first);
    console.log(
      `[secret-containment] FINDING on makeProviderFailure: the cut leaves ${JSON.stringify(first.slice(-24))}; a second pass reads it as a URL and gives ${JSON.stringify(second.slice(-24))}`,
    );
  });
});
