// Chat search by meaning, on this computer: BAAI's bge-small-en-v1.5 (MIT; Xenova's int8 ONNX export) on ONNX
// Runtime. Chats never leave the machine to be embedded, and no key is needed. The model (34 MB) downloads once
// into the runtime's state dir from a pinned revision and is checked by sha256 before it is loaded.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { REVISION } from "./embedderModel.ts";
import { wordPiece, type WordPiece } from "./wordpiece.ts";

export interface EmbedderService {
  /** Vectors of one model compare only with each other: stored vectors are dropped when it changes. */
  readonly model: string;
  readonly dimensions: number;
  /** Ready to embed, downloading the model the first time. Fails when it cannot (offline, no native runtime). */
  readonly load: Effect.Effect<void, Error>;
  readonly ready: () => boolean;
  /** A whole word of the model's vocabulary, so a real word the chats never use is not taken for a typo. False until loaded. */
  readonly isWord: (word: string) => boolean;
  /** Unit-length vectors, one per text. A query is phrased as one (bge's instruction); a passage as it is. */
  readonly embed: (texts: ReadonlyArray<string>, as: "query" | "passage") => Effect.Effect<ReadonlyArray<Float32Array>, Error>;
}

/** Absent (the default, and in tests unless one provides it): search is by words only. */
export class Embedder extends Context.Reference<EmbedderService | undefined>("caveman/search/Embedder", { defaultValue: () => undefined }) {}

const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

/** The worker's entry beside this module: embedder-worker.mjs in the bundle (dist/), embedder-worker.ts in the source tree. */
const workerEntry = (): string => {
  for (const name of ["embedder-worker.mjs", "embedder-worker.ts"]) {
    const entry = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (fs.existsSync(entry)) return entry;
  }
  throw new Error("the embedder's worker is missing beside the runtime");
};

type Reply = { readonly id: number; readonly vocab?: string; readonly vectors?: Float32Array[]; readonly error?: string };

/**
 * The on-device embedder, its model kept under `modelsDir` and run on its own thread (embedderModel.ts). Nothing loads
 * until `load`. `close` resolves once the thread has ended itself; the runtime awaits it as it stops and exits no
 * sooner, because a thread left running with the model's native runtime in it can crash the process as it exits (on
 * Windows, 0xC0000409; embedder-worker.ts).
 */
export function makeLocalEmbedder(modelsDir: string): EmbedderService & { readonly close: () => Promise<void> } {
  const dir = path.join(modelsDir, `bge-small-en-v1.5-${REVISION.slice(0, 8)}`);
  let thread: { readonly worker: Worker; readonly waiting: Map<number, (reply: Reply) => void> } | undefined;
  let closed = false;
  let nextId = 0;
  let loading: Promise<WordPiece> | undefined;
  let tokenizer: WordPiece | undefined;
  const ask = (texts?: ReadonlyArray<string>) =>
    new Promise<Reply>((resolve) => {
      if (closed) return resolve({ id: -1, error: "the embedder is closed" });
      if (thread === undefined) {
        const worker = new Worker(workerEntry(), { workerData: { dir } });
        const waiting = new Map<number, (reply: Reply) => void>();
        const current = { worker, waiting };
        const end = (error: string) => {
          if (thread === current) thread = undefined;
          for (const [id, done] of waiting) done({ id, error });
          waiting.clear();
        };
        worker.on("message", (reply: Reply) => {
          waiting.get(reply.id)?.(reply);
          waiting.delete(reply.id);
          if (waiting.size === 0 && !closed) worker.unref();
        });
        worker.on("error", (error) => end(error.message));
        worker.on("exit", (code) => end(`the embedder's thread exited (${code})`));
        thread = current;
      }
      const id = nextId++;
      thread.waiting.set(id, resolve);
      // Alive while it owes an answer; idle, never what keeps the runtime running.
      thread.worker.ref();
      thread.worker.postMessage({ id, texts });
    });
  const start = async (): Promise<WordPiece> => {
    const reply = await ask();
    if (reply.error !== undefined || reply.vocab === undefined) {
      // A thread whose model failed (offline, no native runtime) stays failed: the next load starts another.
      thread?.worker.postMessage({ close: true });
      thread = undefined;
      throw new Error(reply.error ?? "the embedder's thread gave no vocabulary");
    }
    return (tokenizer = wordPiece(await fs.promises.readFile(reply.vocab, "utf8")));
  };
  const load = Effect.tryPromise({
    try: () => (loading ??= start().catch((error: unknown) => {
      loading = undefined;
      throw error;
    })),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.asVoid);

  return {
    model: `bge-small-en-v1.5@${REVISION.slice(0, 8)}`,
    dimensions: 384,
    load,
    ready: () => tokenizer !== undefined,
    isWord: (word) => tokenizer?.has(word) ?? false,
    embed: (texts, as) =>
      Effect.gen(function* () {
        yield* load;
        if (texts.length === 0) return [];
        const reply = yield* Effect.promise(() => ask(as === "query" ? texts.map((t) => QUERY_INSTRUCTION + t) : texts));
        if (reply.vectors === undefined) return yield* Effect.fail(new Error(reply.error ?? "the embedder gave no vectors"));
        return reply.vectors;
      }),
    close: () => {
      closed = true;
      const current = thread;
      if (current === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        current.worker.once("exit", () => resolve());
        current.worker.ref();
        current.worker.postMessage({ close: true });
      });
    },
  };
}
