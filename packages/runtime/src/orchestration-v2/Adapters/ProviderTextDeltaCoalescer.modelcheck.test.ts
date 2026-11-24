// Model check of the real ProviderTextDeltaCoalescer: every order of append, complete, flushTurn, emit and the clock,
// for every pair of items in one turn or in two turns. Skill: .claude/skills/adapter-turn-lifecycle/SKILL.md
import {
  assertHolds,
  checkAsync,
  formatTrace,
  type Action,
  type AsyncSpec,
} from "@caveman-app/model-check";
import { Gates, openHarness, type Harness } from "@caveman-app/model-check/effect";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaCoalescer,
} from "./ProviderTextDeltaCoalescer.ts";

const FLUSH_INTERVAL_MS = 50;
const QUIET_SPELLS = 1;

/** `turn/item` to the deltas the caller streams into it, in order. */
type Scope = Readonly<Record<string, ReadonlyArray<string>>>;
type ItemKey = string;

interface Emitted {
  readonly text: string;
  readonly completed: boolean;
}

interface Coalescing {
  readonly harness: Harness<ProviderTextDeltaCoalescer>;
  readonly emitted: Map<ItemKey, Array<Emitted>>;
  readonly appended: Map<ItemKey, string>;
  /** How the caller ended the item; after that it never touches the item again. */
  readonly ended: Map<ItemKey, "complete" | "flushTurn">;
  readonly flushed: Set<string>;
  commands: number;
  stops: number;
  quietSpells: number;
}

interface Observation {
  readonly items: Readonly<
    Record<
      string,
      {
        readonly appended: string;
        readonly ended: "complete" | "flushTurn" | null;
        readonly emitted: ReadonlyArray<Emitted>;
      }
    >
  >;
  readonly flushed: ReadonlyArray<string>;
  readonly callerBusy: boolean;
  readonly stopperBusy: boolean;
  readonly quietSpells: number;
  readonly parked: ReadonlyArray<string>;
  readonly now: number;
}

const busy = (coalescing: Coalescing, prefix: string, count: number) =>
  count > 0 && coalescing.harness.fibers()[`${prefix} ${count}`] === "running";

const coalescerSpec = (scope: Scope): AsyncSpec<Coalescing, Observation> => {
  const ITEM_KEYS = Object.keys(scope);
  const TURNS = [...new Set(ITEM_KEYS.map((key) => key.split("/")[0]!))];
  return {
    make: async () => {
      const emitted = new Map<ItemKey, Array<Emitted>>();
      const harness = await openHarness(
        Effect.gen(function* () {
          const gates = yield* Gates;
          return yield* makeProviderTextDeltaCoalescer({
            flushIntervalMs: FLUSH_INTERVAL_MS,
            // The emit is where the coalescer hands text to the transcript; gating it lets the checker park a flush
            // mid-write while the caller and the timer race for the lock.
            emit: (update) => {
              const key = `${update.turnId}/${update.itemId}`;
              return gates
                .gate(`emit ${key}${update.completed ? " completed" : ""} "${update.text}"`)
                .pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      emitted.set(key, [
                        ...(emitted.get(key) ?? []),
                        { text: update.text, completed: update.completed },
                      ]);
                    }),
                  ),
                );
            },
          });
        }),
      );
      return {
        harness,
        emitted,
        appended: new Map(),
        ended: new Map(),
        flushed: new Set(),
        commands: 0,
        stops: 0,
        quietSpells: 0,
      };
    },
    actions: (coalescing) => {
      const { harness } = coalescing;
      const actions: Array<Action<Coalescing>> = harness
        .enabled()
        .map((name) => ({ name, run: () => harness.step(name) }));
      const caller = (
        name: string,
        effect: Effect.Effect<unknown>,
        before: () => void,
      ): Action<Coalescing> => ({
        name,
        run: async () => {
          before();
          coalescing.commands++;
          harness.fork(`caller ${coalescing.commands}`, effect);
          await harness.settle();
        },
      });
      if (!busy(coalescing, "caller", coalescing.commands)) {
        for (const key of ITEM_KEYS) {
          if (coalescing.ended.has(key)) continue;
          const [turnId, itemId] = key.split("/") as [string, string];
          const appended = coalescing.appended.get(key) ?? "";
          const delta = scope[key]![appended.length];
          if (delta !== undefined) {
            actions.push(
              caller(
                `append ${key} "${delta}"`,
                harness.value.append({ turnId, itemId, delta }),
                () => {
                  coalescing.appended.set(key, appended + delta);
                },
              ),
            );
          }
          if (appended !== "") {
            actions.push(
              caller(`complete ${key}`, harness.value.complete({ turnId, itemId }), () => {
                coalescing.ended.set(key, "complete");
              }),
            );
          }
        }
      }
      // A turn's end can come from another fiber than the stream's (ClaudeAdapterV2's interrupt timeout path), so
      // flushTurn runs beside an in-flight caller command.
      if (!busy(coalescing, "stopper", coalescing.stops)) {
        for (const turnId of TURNS) {
          if (coalescing.flushed.has(turnId)) continue;
          actions.push({
            name: `flushTurn ${turnId}`,
            run: async () => {
              coalescing.flushed.add(turnId);
              for (const key of ITEM_KEYS)
                if (key.startsWith(`${turnId}/`) && !coalescing.ended.has(key))
                  coalescing.ended.set(key, "flushTurn");
              coalescing.stops++;
              harness.fork(`stopper ${coalescing.stops}`, harness.value.flushTurn(turnId));
              await harness.settle();
            },
          });
        }
      }
      if (harness.clock.nextDeadline() === undefined && coalescing.quietSpells < QUIET_SPELLS) {
        actions.push({
          name: `clock: ${FLUSH_INTERVAL_MS} ms pass with no timer set`,
          run: async () => {
            coalescing.quietSpells++;
            harness.clock.advanceTo(harness.clock.currentTimeMillisUnsafe() + FLUSH_INTERVAL_MS);
            await harness.settle();
          },
        });
      }
      return actions;
    },
    observe: (coalescing) => ({
      items: Object.fromEntries(
        ITEM_KEYS.map((key) => [
          key,
          {
            appended: coalescing.appended.get(key) ?? "",
            ended: coalescing.ended.get(key) ?? null,
            emitted: coalescing.emitted.get(key) ?? [],
          },
        ]),
      ),
      flushed: [...coalescing.flushed].sort(),
      callerBusy: busy(coalescing, "caller", coalescing.commands),
      stopperBusy: busy(coalescing, "stopper", coalescing.stops),
      quietSpells: coalescing.quietSpells,
      parked: coalescing.harness.gates.parked(),
      now: coalescing.harness.clock.currentTimeMillisUnsafe(),
    }),
    invariants: {
      "every streamed text is a prefix of what was appended": (o) =>
        Object.values(o.items).every((item) =>
          item.emitted.every((update) => item.appended.startsWith(update.text)),
        ),
      "streamed partials only grow": (o) =>
        Object.values(o.items).every((item) =>
          item.emitted.every(
            (update, index) =>
              index === 0 ||
              update.text.length > item.emitted[index - 1]!.text.length ||
              update.completed,
          ),
        ),
      "nothing follows an item's completed update": (o) =>
        Object.values(o.items).every((item) =>
          item.emitted.every(
            (update, index) => !update.completed || index === item.emitted.length - 1,
          ),
        ),
      "a completed update carries the whole text": (o) =>
        Object.values(o.items).every((item) =>
          item.emitted.every((update) => !update.completed || update.text === item.appended),
        ),
    },
    atEnd: {
      // flushTurn completes the turn's buffered items; one that never got text has nothing buffered and stays silent.
      "every item ends with one completed update of its whole text": (o) =>
        Object.values(o.items).every((item) => {
          if (item.ended === "flushTurn" && item.appended === "") return item.emitted.length === 0;
          const last = item.emitted.at(-1);
          return (
            item.emitted.filter((update) => update.completed).length === 1 &&
            last?.completed === true &&
            last.text === item.appended
          );
        }),
    },
    eventually: {
      "appended text reaches the transcript within one flush interval": (o) =>
        Object.values(o.items).every((item) => (item.emitted.at(-1)?.text ?? "") === item.appended),
    },
    drain: (coalescing) => coalescing.harness.fairRound(),
    drainRounds: 6,
    // append is uninterruptible and may wait on the lock a parked emit holds, so a close that interrupted first would
    // wait forever on a flush parked in the coalescer's own scope: run the parked writes out before closing.
    dispose: async ({ harness }) => {
      while (harness.gates.parked().length > 0) {
        harness.gates.releaseAll();
        await harness.settle();
      }
      await harness.close();
    },
  };
};

const show = (o: Observation) =>
  [
    ...Object.entries(o.items).map(
      ([key, item]) =>
        `${key} appended="${item.appended}"${item.ended ? ` ended by ${item.ended}` : ""} emitted=[${item.emitted.map((u) => `${u.completed ? "done:" : ""}"${u.text}"`).join(", ")}]`,
    ),
    `parked=[${o.parked.join("; ")}] now=${o.now}`,
  ].join("\n     ");

const SCOPES: ReadonlyArray<readonly [string, Scope]> = [
  ["two items of one turn, two deltas each", { "t1/i1": ["a", "b"], "t1/i2": ["c", "d"] }],
  ["one item in each of two turns, two deltas each", { "t1/i1": ["a", "b"], "t2/i1": ["c", "d"] }],
];

describe("ProviderTextDeltaCoalescer over every order of append, complete, flushTurn, emit and the clock", () => {
  it.each(SCOPES)(
    `streams prefixes, completes each item once with its whole text, and flushes within ${FLUSH_INTERVAL_MS} ms: %s`,
    async (label, scope) => {
      const started = performance.now();
      const verdict = await checkAsync({
        ...coalescerSpec(scope),
        maxStates: Number(process.env.MC_MAX ?? 100_000),
      });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      if (verdict.ok) {
        console.log(
          `coalescer model check (${label}): ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive=${verdict.exhaustive}, ${seconds}s`,
        );
      } else {
        console.log(
          `coalescer model check (${label}): ${verdict.kind} "${verdict.property}" after ${verdict.states} states\n${formatTrace(verdict.trace, show)}`,
        );
      }
      assertHolds(verdict, { show });
      expect(verdict).toMatchObject({ ok: true, exhaustive: true });
    },
    120_000,
  );
});
