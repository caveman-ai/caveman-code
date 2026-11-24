import { expect, test } from "vitest";
import { idleFolds } from "./settled-work.ts";
import type { HeldFold, Row } from "./rows.ts";
import { detailKey } from "./work-disclosures.ts";

const fold: Row = { kind: "fold", id: "fold:work", speaker: true, ms: 1000, rows: [{ kind: "work", id: "work", speaker: false, items: [] }] };
const held: HeldFold[] = [{ id: "fold:work", rows: ["work"] }];
test("only automatically held completed work is eligible to settle", () => {
  expect(idleFolds([fold], held, new Map())).toEqual(held);
  expect(idleFolds([], held, new Map())).toEqual([]);
});

test("opened tool output protects its turn unless its group was explicitly closed", () => {
  const thought = { kind: "reasoning", id: "step", text: "Reading the retry loop.", streaming: false } as const;
  const detailed: Row = { ...fold, rows: [{ kind: "work", id: "work", speaker: false, items: [thought] }] };
  expect(idleFolds([detailed], held, new Map([[detailKey("step"), true]]))).toEqual([]);
  expect(idleFolds([detailed], held, new Map([[detailKey("step"), true], ["work", false]]))).toEqual(held);
});
test("explicit turn and nested work choices survive idle completion", () => {
  expect(idleFolds([fold], held, new Map([["fold:work", true]]))).toEqual([]);
  expect(idleFolds([fold], held, new Map([["fold:work", false]]))).toEqual([]);
  expect(idleFolds([fold], held, new Map([["work", true]]))).toEqual([]);
  expect(idleFolds([fold], held, new Map([["work", false]]))).toEqual(held);
});
