// The embedding model itself: the pinned files, ONNX Runtime and bge's pooling. It runs in embedder-worker.ts,
// never on the runtime's thread: ONNX Runtime's run is synchronous native code (0.1-0.5 s a batch), and the
// model's sha256 reads 34 MB, so either on the runtime's thread stalls every request while chats are indexed.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { wordPiece } from "./wordpiece.ts";

export const REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
const BASE = `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${REVISION}`;
const FILES = {
  model: { url: `${BASE}/onnx/model_quantized.onnx`, name: "model_quantized.onnx", sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4" },
  vocab: { url: `${BASE}/vocab.txt`, name: "vocab.txt", sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3" },
} as const;
/** bge reads 512 tokens; a passage is a chunk of about 200, so 256 keeps a batch short. */
const MAX_TOKENS = 256;

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** `file` as pinned: kept if its hash matches, else downloaded beside it and renamed into place once checked. */
async function fetchPinned(dir: string, spec: { url: string; name: string; sha256: string }, signal: AbortSignal): Promise<string> {
  const file = path.join(dir, spec.name);
  if (fs.existsSync(file) && sha256(file) === spec.sha256) return file;
  const response = await fetch(spec.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) });
  if (!response.ok) throw new Error(`download ${spec.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== spec.sha256) throw new Error(`download ${spec.url}: sha256 ${got}, expected ${spec.sha256}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.partial`, bytes);
  fs.renameSync(`${file}.partial`, file);
  return file;
}

type Ort = typeof import("onnxruntime-node");

/** The model under `dir`, downloaded the first time: its vocabulary file, and unit-length vectors for texts. `signal` stops a download, and a load not yet begun. */
export async function openModel(dir: string, signal: AbortSignal): Promise<{ readonly vocab: string; readonly embed: (texts: ReadonlyArray<string>) => Promise<Float32Array[]> }> {
  // Loaded from disk (a native addon the runtime bundle keeps external), and only once search asks for it.
  const ort = createRequire(import.meta.url)("onnxruntime-node") as Ort;
  const [model, vocab] = [await fetchPinned(dir, FILES.model, signal), await fetchPinned(dir, FILES.vocab, signal)];
  signal.throwIfAborted();
  // Two threads: indexing a backlog runs beside the person's chats, never in their way.
  const session = await ort.InferenceSession.create(model, { intraOpNumThreads: 2, interOpNumThreads: 1, graphOptimizationLevel: "all" });
  const tokenizer = wordPiece(fs.readFileSync(vocab, "utf8"));
  const embed = async (texts: ReadonlyArray<string>): Promise<Float32Array[]> => {
    const encoded = texts.map((text) => tokenizer.encode(text, MAX_TOKENS));
    const width = Math.max(...encoded.map((ids) => ids.length));
    const size = encoded.length * width;
    const ids = new BigInt64Array(size);
    const mask = new BigInt64Array(size);
    encoded.forEach((row, b) => row.forEach((id, i) => ((ids[b * width + i] = BigInt(id)), (mask[b * width + i] = 1n))));
    const dims = [encoded.length, width];
    const feeds: Record<string, import("onnxruntime-node").Tensor> = {
      input_ids: new ort.Tensor("int64", ids, dims),
      attention_mask: new ort.Tensor("int64", mask, dims),
    };
    if (session.inputNames.includes("token_type_ids")) feeds["token_type_ids"] = new ort.Tensor("int64", new BigInt64Array(size), dims);
    const output = (await session.run(feeds))[session.outputNames[0]!]!;
    const hidden = output.dims[2]!;
    const data = output.data as Float32Array;
    // bge pools by [CLS], the first token's state, then unit length so a dot product is the cosine.
    return encoded.map((_, b) => {
      const v = data.slice(b * width * hidden, b * width * hidden + hidden);
      const norm = Math.hypot(...v) || 1;
      for (let d = 0; d < v.length; d++) v[d] = v[d]! / norm;
      return v;
    });
  };
  return { vocab, embed };
}
