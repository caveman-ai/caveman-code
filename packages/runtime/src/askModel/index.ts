// A task's kind and level from its words alone, on this computer and offline: Caveman Cloud's ask classifier
// (`ask_r4`, model/MODEL_CARD.md) read the way Cloud's router reads a delegated brief (routedecide task.go
// taskLevel): the brief as a first ask with no history, routed at the `auto` mode's risk, a label under 0.5
// confidence read as general_coding, and plan_design, large_refactor or a coding ask that is a judgement call kept
// high. The model loads once, on first use.
import type { TaskKind } from "@caveman-app/session-protocol";

import { askWords, judgementAsk, typedSlash, userWords } from "./askWords.ts";
import { loadAskModel, type Model, routedLevel } from "./model.ts";

type Level = "xlow" | "low" | "medium" | "high";

const KINDS: ReadonlyArray<TaskKind> = [
  "frontend_ui",
  "backend_fix",
  "general_coding",
  "large_refactor",
  "plan_design",
  "explore_readonly",
  "terminal_ops",
  "trivial_chat",
];
const LEVELS: ReadonlyArray<Level> = ["xlow", "low", "medium", "high"];

let loading: Promise<Model | undefined> | undefined;

const load = (): Promise<Model | undefined> =>
  (loading ??= loadAskModel()
    .then((model) => {
      if (
        !model.classes.every((c) => (KINDS as ReadonlyArray<string>).includes(c)) ||
        model.levels.join() !== LEVELS.join()
      ) {
        throw new Error(
          `classes ${model.classes.join(", ")} and levels ${model.levels.join(", ")} are not the task kinds and levels`,
        );
      }
      return model;
    })
    .catch((error: unknown) => {
      console.warn(
        `task classifier: the ask model did not load, tasks go unclassified: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }));

/** Starts loading the model in the background (about 70 ms, 24 MB read), so the first classifyTask does not wait. */
export const warmTaskClassifier = (): void => {
  void load();
};

let failed = false;

/**
 * The kind and level of a task from its text. confidence is the calibrated probability of the model's top class;
 * under 0.5 the kind reads as general_coding. Undefined when the text holds none of the person's words (a harness's
 * own text) or the model is unavailable.
 */
export async function classifyTask(
  text: string,
): Promise<{ kind: TaskKind; level: Level; confidence: number } | undefined> {
  const words = askWords(text);
  if (words === "") return undefined;
  const model = await load();
  if (model === undefined) return undefined;
  try {
    const p = model.predict(
      {
        text: words,
        prevText: "",
        prevAsst: "",
        turnIdx: 0,
        harness: "other",
        slash: typedSlash(words),
        ts: Date.now(),
      },
      [],
    );
    const confidence = model.calib.confidence(p.pClass);
    const kind = (confidence < 0.5 ? "general_coding" : p.class) as TaskKind;
    const routed = model.levels[routedLevel(p.pLevel, model.calib.risk("auto"))] as Level;
    const keptHigh = () =>
      kind === "plan_design" ||
      kind === "large_refactor" ||
      ((kind === "general_coding" || kind === "frontend_ui" || kind === "backend_fix") &&
        judgementAsk(userWords(text)));
    return { kind, level: routed !== "high" && keptHigh() ? "high" : routed, confidence };
  } catch (error) {
    if (!failed) {
      failed = true;
      console.warn(
        `task classifier: the ask model failed on a task: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }
}
