// The embedder's thread (embedderModel.ts): Embedder.ts starts it with the models dir and posts
// { id, texts }; it answers { id, vectors } or { id, error }. The first message waits for the model to load.
// { close: true } ends the thread once it is idle.
import { parentPort, workerData } from "node:worker_threads";

import { openModel } from "./embedderModel.ts";

const closing = new AbortController();
const model = openModel((workerData as { dir: string }).dir, closing.signal);
// Requests run one after another behind the model's load, so `idle` settles only once ONNX Runtime is in no native call.
let idle: Promise<unknown> = model.catch(() => undefined);

type Request = { readonly id: number; readonly texts?: ReadonlyArray<string> } | { readonly close: true };

const answer = async ({ id, texts }: { readonly id: number; readonly texts?: ReadonlyArray<string> }) => {
  try {
    const opened = await model;
    if (texts === undefined) return parentPort!.postMessage({ id, vocab: opened.vocab });
    const vectors = await opened.embed(texts);
    parentPort!.postMessage({ id, vectors }, vectors.map((v) => v.buffer as ArrayBuffer));
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

parentPort!.on("message", (request: Request) => {
  if ("close" in request) {
    // Terminating this thread inside an ONNX Runtime call (the model's load or a run) aborts the whole process with an
    // uncaught Napi::Error, and the runtime's exit terminates it: it ends itself between calls instead.
    closing.abort();
    idle = idle.then(() => process.exit(0));
    return;
  }
  idle = idle.then(() => answer(request));
});
