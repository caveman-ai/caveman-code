// The ask classifier `ask_r4` (model/MODEL_CARD.md): hashed tf-idf logistic text scores feeding LightGBM heads. A port
// of Caveman Cloud's gateway-managed/internal/askmodel model.go. The artifact: ask_r4.json.gz (feature names, text
// heads, trees as flat arrays), ask_r4.text.bin (idf as float32, logistic weights as float16, read in place) and
// ask_r4.calib.json (the calibration fitted on its predictions). The tree walk is LightGBM's NumericalDecision.
// Values pass through float32 where Go's do, so a feature lands on the same side of every threshold.
import { readFile } from "node:fs/promises";
import { endianness } from "node:os";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import {
  type AskInput,
  featureNames,
  features,
  HASH_SIZE,
  type Hist,
  SHORT_WORDS,
  Vec,
} from "./features.ts";

interface TreeJson {
  readonly f?: ReadonlyArray<number>;
  readonly t?: ReadonlyArray<number>;
  readonly l?: ReadonlyArray<number>;
  readonly r?: ReadonlyArray<number>;
  readonly d?: ReadonlyArray<number>;
  readonly m?: ReadonlyArray<number>;
  readonly v?: ReadonlyArray<number>;
}

interface HeadJson {
  readonly objective?: string;
  readonly num_class?: number;
  readonly features?: ReadonlyArray<string>;
  readonly trees?: ReadonlyArray<TreeJson>;
}

interface TextJson {
  readonly blocks?: ReadonlyArray<string>;
  readonly scale?: ReadonlyArray<number>;
  readonly outputs?: ReadonlyArray<string>;
  readonly intercept?: ReadonlyArray<number>;
  readonly apply?: ReadonlyArray<{
    readonly prefix?: string;
    readonly texts?: ReadonlyArray<string>;
  }>;
}

interface ModelJson {
  readonly hash_size?: number;
  readonly text?: ReadonlyArray<TextJson | null>;
  readonly heads?: Readonly<Record<string, HeadJson | null>>;
  readonly order?: ReadonlyArray<string>;
  readonly stack?: Readonly<Record<string, string>>;
  readonly level?: string;
  readonly lean?: number;
  readonly cheap?: string;
  readonly class_prior?: ReadonlyArray<number>;
  readonly classes?: ReadonlyArray<string>;
  readonly levels?: ReadonlyArray<string>;
}

/** One tree's splits side by side: a walk reads one node per level. */
class Tree {
  readonly f: Int32Array;
  readonly t: Float64Array;
  readonly l: Int32Array;
  readonly r: Int32Array;
  readonly d: Uint8Array;
  readonly m: Uint8Array;
  readonly v: Float64Array;

  /**
   * Rejects a tree eval could index out of range or never leave: a model file is never trusted. Children come after
   * their parent (the export writes a tree in pre-order), so a walk always ends.
   */
  constructor(json: TreeJson, nFeatures: number) {
    const [f, t, l, r, d, m, v] = [
      json.f ?? [],
      json.t ?? [],
      json.l ?? [],
      json.r ?? [],
      json.d ?? [],
      json.m ?? [],
      json.v ?? [],
    ];
    const n = f.length;
    if ([t, l, r, d, m].some((a) => a.length !== n) || v.length === 0)
      throw new Error("broken tree");
    for (let i = 0; i < n; i++) {
      if (f[i]! < 0 || f[i]! >= nFeatures) throw new Error(`split feature ${f[i]} out of range`);
      for (const c of [l[i]!, r[i]!]) {
        if ((c >= 0 && (c <= i || c >= n)) || (c < 0 && -c - 1 >= v.length))
          throw new Error("broken tree");
      }
    }
    this.f = Int32Array.from(f);
    this.t = Float64Array.from(t);
    this.l = Int32Array.from(l);
    this.r = Int32Array.from(r);
    this.d = Uint8Array.from(d);
    this.m = Uint8Array.from(m);
    this.v = Float64Array.from(v);
  }

  eval(x: Float64Array): number {
    if (this.f.length === 0) return this.v[0]!;
    let i = 0;
    while (i >= 0) {
      let v = x[this.f[i]!]!;
      const m = this.m[i]!;
      if (Number.isNaN(v) && m !== 2) v = 0;
      const left =
        (m === 1 && Math.abs(v) <= 1e-35) || (m === 2 && Number.isNaN(v))
          ? this.d[i] === 1
          : v <= this.t[i]!;
      i = left ? this.l[i]! : this.r[i]!;
    }
    return this.v[-i - 1]!;
  }
}

class Head {
  readonly objective: string;
  readonly numClass: number;
  readonly features: ReadonlyArray<string>;
  readonly trees: ReadonlyArray<Tree>;
  /** Where each feature sits in the row predict builds. */
  idx: Int32Array = new Int32Array(0);

  constructor(name: string, json: HeadJson) {
    this.objective = json.objective ?? "";
    this.numClass = json.num_class ?? 0;
    this.features = json.features ?? [];
    this.trees = (json.trees ?? []).map((tree) => {
      try {
        return new Tree(tree, this.features.length);
      } catch (error) {
        throw new Error(`head ${name}: ${(error as Error).message}`, { cause: error });
      }
    });
  }

  /** The probabilities (one for binary and cross_entropy, numClass for multiclass), or the raw value. */
  predict(row: Float64Array, x: Float64Array): Array<number> {
    this.idx.forEach((i, j) => (x[j] = row[i]!));
    const k = Math.max(this.numClass, 1);
    const raw = Array.from({ length: k }, () => 0);
    this.trees.forEach((tree, i) => (raw[i % k]! += tree.eval(x)));
    switch (this.objective) {
      case "binary":
      case "cross_entropy":
        raw[0] = 1 / (1 + Math.exp(-raw[0]!));
        break;
      case "multiclass": {
        let mx = raw[0]!;
        for (const v of raw) mx = Math.max(mx, v);
        let sum = 0;
        raw.forEach((v, i) => {
          raw[i] = Math.exp(v - mx);
          sum += raw[i]!;
        });
        raw.forEach((v, i) => (raw[i] = v / sum));
        break;
      }
    }
    return raw;
  }
}

/**
 * A one-vs-rest logistic model over hashed tf-idf blocks. apply lists (prefix, texts) pairs: the same weights score the
 * ask ("tt_"), the previous ask ("tp_") and the agent's last reply ("ta_").
 */
interface TextScorer {
  /** The idf block of each weight block: T, P, A, G. */
  readonly blocks: ReadonlyArray<string>;
  readonly scale: ReadonlyArray<number>;
  readonly outputs: ReadonlyArray<string>;
  readonly intercept: ReadonlyArray<number>;
  readonly apply: ReadonlyArray<{ readonly prefix: string; readonly texts: ReadonlyArray<string> }>;
  /** Per block: HASH_SIZE x outputs float16 bits, row-major, as stored. */
  readonly w: Array<Uint16Array>;
}

/** float16 bits -> float32, for every half. */
const halves = (() => {
  const bits = new Int32Array(1 << 16);
  for (let h = 0; h < 1 << 16; h++) {
    const s = h >>> 15;
    let e = (h >>> 10) & 0x1f;
    let m = h & 0x3ff;
    if (e === 0) {
      if (m === 0) {
        bits[h] = s << 31;
        continue;
      }
      while ((m & 0x400) === 0) {
        m <<= 1;
        e--;
      }
      e++;
      m &= 0x3ff;
    } else if (e === 31) {
      bits[h] = (s << 31) | 0x7f800000 | (m << 13);
      continue;
    }
    bits[h] = (s << 31) | ((e + 112) << 23) | (m << 13);
  }
  return new Float32Array(bits.buffer);
})();

/** The idf blocks of text.bin, in file order. */
const IDF_BLOCKS = ["T", "P", "A", "G"];

/**
 * A model's post-hoc calibration, refitted with every retrain: a temperature on the class probabilities, a Platt map
 * on P(cheap), and the risk an ask is routed at (routedLevel), with what each routing mode adds to it.
 */
export class Calib {
  readonly tClass: number;
  /** a, b. */
  readonly cheap: readonly [number, number];
  readonly levelRisk: number;
  /** By routing mode: auto-max routes at a smaller risk, auto-save at a larger. */
  readonly levelRiskOffset: Readonly<Record<string, number>>;

  constructor(
    tClass: number,
    cheap: readonly [number, number],
    levelRisk: number,
    levelRiskOffset: Readonly<Record<string, number>>,
  ) {
    this.tClass = tClass;
    this.cheap = cheap;
    this.levelRisk = levelRisk;
    this.levelRiskOffset = levelRiskOffset;
  }

  /** The risk an ask is routed at in a routing mode: levelRisk plus the mode's offset (auto has none). */
  risk(mode: string): number {
    return (
      this.levelRisk + (Object.hasOwn(this.levelRiskOffset, mode) ? this.levelRiskOffset[mode]! : 0)
    );
  }

  /** The calibrated probability of the top class: softmax(log p / T). The top class itself does not change. */
  confidence(pClass: ReadonlyArray<number>): number {
    let top = 0;
    for (const p of pClass) top = Math.max(top, p);
    // No class has any probability (a model file's absurd leaf values): never a confident label.
    if (!(top > 0)) return 0;
    let sum = 0;
    for (const p of pClass) sum += Math.pow(p / top, 1 / this.tClass);
    return 1 / sum;
  }

  /** The calibrated P(cheap): sigmoid(a·logit(p) + b), p clipped to [1e-6, 1 − 1e-6]. */
  pCheap(raw: number): number {
    const p = Math.min(Math.max(raw, 1e-6), 1 - 1e-6);
    return 1 / (1 + Math.exp(-(this.cheap[0] * Math.log(p / (1 - p)) + this.cheap[1])));
  }
}

/**
 * The level an ask is routed at, as an index into pLevel: the lowest level whose risk of being too low (the
 * probability of the levels above it) is at most risk. It is the top level's argmax only when the model is sure; in
 * doubt it routes up.
 */
export const routedLevel = (pLevel: ReadonlyArray<number>, risk: number): number => {
  for (let i = 0; i < pLevel.length; i++) {
    let above = 0;
    for (const p of pLevel.slice(i + 1)) above += p;
    if (above <= risk) return i;
  }
  return pLevel.length - 1;
};

/** The model's answer for one ask. pClass and pLevel follow Model.classes and Model.levels. */
export interface Pred {
  readonly class: string;
  readonly level: string;
  /** P(xlow or low), P(the ask turns out realized-high), P(an edit follows). */
  readonly pCheap: number;
  readonly pBig: number;
  readonly pEdit: number;
  readonly pClass: ReadonlyArray<number>;
  readonly pLevel: ReadonlyArray<number>;
}

const parseCalib = (raw: string): Calib => {
  let json: {
    T_class?: unknown;
    platt_p_cheap?: unknown;
    level_risk?: unknown;
    level_risk_offset?: Record<string, unknown> | null;
  };
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`calib.json: ${(error as Error).message}`, { cause: error });
  }
  const num = (x: unknown): number => (typeof x === "number" ? x : 0);
  const cheap = Array.isArray(json.platt_p_cheap) ? json.platt_p_cheap : [];
  const offsets = json.level_risk_offset ?? {};
  const calib = new Calib(
    num(json.T_class),
    [num(cheap[0]), num(cheap[1])],
    num(json.level_risk),
    Object.fromEntries(Object.entries(offsets).map(([mode, x]) => [mode, num(x)])),
  );
  const finite = (x: number) => Number.isFinite(x);
  if (
    !(calib.tClass > 0) ||
    !finite(calib.tClass) ||
    !(Math.abs(calib.cheap[0]) > 0) ||
    !finite(calib.cheap[0]) ||
    !finite(calib.cheap[1]) ||
    !(calib.levelRisk > 0 && calib.levelRisk < 1)
  ) {
    throw new Error(
      "calib.json: T_class, platt_p_cheap [a, b] and level_risk (between 0 and 1) must be set",
    );
  }
  // auto-max's offset and auto-save's and no other key, so auto routes at level_risk itself; auto-max at no larger a
  // risk and auto-save at no smaller one, each between 0 and 1. A swapped pair would route the careful mode at the
  // loose risk.
  const [max, save] = [offsets["auto-max"], offsets["auto-save"]];
  if (
    Object.keys(offsets).length !== 2 ||
    typeof max !== "number" ||
    typeof save !== "number" ||
    !(max <= 0 && calib.levelRisk + max > 0) ||
    !(save >= 0 && calib.levelRisk + save < 1)
  ) {
    throw new Error(
      "calib.json: level_risk_offset must hold auto-max (0 or less) and auto-save (0 or more) and nothing else, each leaving the risk between 0 and 1",
    );
  }
  return calib;
};

/** One loaded artifact. */
export class Model {
  readonly classes: ReadonlyArray<string>;
  readonly levels: ReadonlyArray<string>;
  readonly calib: Calib;
  private readonly text: ReadonlyArray<TextScorer>;
  private readonly heads: ReadonlyMap<string, Head>;
  private readonly order: ReadonlyArray<string>;
  private readonly stack: ReadonlyMap<string, string>;
  private readonly level: string;
  private readonly lean: number;
  private readonly cheap: string;
  private readonly prior: ReadonlyArray<number>;
  private readonly idf: ReadonlyMap<string, Float32Array>;
  /** Feature name -> row index. */
  private readonly cols = new Map<string, number>();
  /** What no head reads (features). */
  private readonly skip: Set<string>;
  private readonly nrow: number;
  private readonly maxFeat: number;

  /** Checks a decoded model.json and wires it to text.bin and calib.json. */
  constructor(json: ModelJson, bin: Uint8Array, calib: string) {
    this.calib = parseCalib(calib);
    if (json.hash_size !== HASH_SIZE)
      throw new Error(`model hash size ${json.hash_size}, this port ${HASH_SIZE}`);
    let off = IDF_BLOCKS.length * 4 * HASH_SIZE;
    if (bin.length < off) throw new Error("text.bin is shorter than the model needs");
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    this.idf = new Map(
      IDF_BLOCKS.map((name, b) => {
        const a = new Float32Array(HASH_SIZE);
        for (let i = 0; i < HASH_SIZE; i++) a[i] = view.getFloat32(4 * (b * HASH_SIZE + i), true);
        return [name, a];
      }),
    );
    // The row every head reads from: dense features, text scores, stacked head outputs.
    const add = (n: string) => {
      if (!this.cols.has(n)) this.cols.set(n, this.cols.size);
    };
    featureNames().forEach(add);
    this.skip = new Set(["c_", "qc_", "e_", "G", "E"]);
    const text: Array<TextScorer> = [];
    for (const t of json.text ?? []) {
      if (t === null) throw new Error("broken text head");
      const [blocks, scale, outputs, intercept, apply] = [
        t.blocks ?? [],
        t.scale ?? [],
        t.outputs ?? [],
        t.intercept ?? [],
        t.apply ?? [],
      ];
      const k = outputs.length;
      if (scale.length !== blocks.length || intercept.length !== k)
        throw new Error("broken text head");
      const w: Array<Uint16Array> = [];
      for (const b of blocks) {
        if (!this.idf.has(b))
          throw new Error(`text head reads block "${b}", which this port does not compute`);
        if (off + 2 * HASH_SIZE * k > bin.length)
          throw new Error("text.bin is shorter than the model needs");
        w.push(halfWords(bin, off, HASH_SIZE * k));
        off += 2 * HASH_SIZE * k;
        this.skip.delete(b);
      }
      const applied = apply.map((ap) => ({ prefix: ap.prefix ?? "", texts: ap.texts ?? [] }));
      for (const ap of applied) {
        if (ap.texts.length !== blocks.length) throw new Error("broken text head");
        for (const name of ap.texts) {
          if (!["T", "P", "A", "G", "E"].includes(name))
            throw new Error(`text head reads text "${name}", which this port does not compute`);
          this.skip.delete(name);
        }
        for (const o of outputs) add(ap.prefix + o);
      }
      text.push({ blocks, scale, outputs, intercept, apply: applied, w });
    }
    this.text = text;
    if (off !== bin.length)
      throw new Error(`text.bin: ${bin.length} bytes, the model reads ${off}`);
    this.stack = new Map(Object.entries(json.stack ?? {}));
    for (const n of this.stack.keys()) add(n);
    this.nrow = this.cols.size;
    const heads = new Map<string, Head>();
    let maxFeat = 0;
    for (const [name, h] of Object.entries(json.heads ?? {})) {
      if (h === null) throw new Error(`the model has no ${name} head`);
      const head = new Head(name, h);
      for (const f of head.features) {
        for (const pre of ["c_", "qc_", "e_"]) if (f.startsWith(pre)) this.skip.delete(pre);
        if (!this.cols.has(f))
          throw new Error(`head ${name} reads feature "${f}", which this port does not compute`);
      }
      head.idx = Int32Array.from(head.features, (f) => this.cols.get(f)!);
      heads.set(name, head);
      maxFeat = Math.max(maxFeat, head.features.length);
    }
    this.heads = heads;
    this.maxFeat = maxFeat;
    this.order = json.order ?? [];
    this.level = json.level ?? "";
    this.lean = json.lean ?? 0;
    this.cheap = json.cheap ?? "";
    this.prior = json.class_prior ?? [];
    this.classes = json.classes ?? [];
    this.levels = json.levels ?? [];
    this.checkDecode();
  }

  /**
   * Every head predict reads is evaluated, and every head (a short follow-up's fu_ twin included) is as wide as
   * predict indexes it: the classes for a class head, the levels for a level head, one otherwise.
   */
  private checkDecode(): void {
    if (this.classes.length === 0 || this.levels.length !== 4)
      throw new Error("the model needs its classes and four levels");
    const need = ["big", "edit"];
    if (this.level === "ordinal") need.push("level_ge1", "level_ge2", "level_ge3");
    else need.push("level");
    if (this.cheap === "head") need.push("cheap");
    if (this.heads.has("class")) need.push("class");
    else this.classes.forEach((_, k) => need.push(`class_${k}`));
    for (const name of need)
      if (!this.order.includes(name)) throw new Error(`the model does not evaluate a ${name} head`);
    for (const name of this.order)
      if (!this.heads.has(name)) throw new Error(`the model has no ${name} head`);
    for (const [name, h] of this.heads) {
      const base = name.startsWith("fu_") ? name.slice(3) : name;
      const want =
        base === "class" ? this.classes.length : base === "level" ? this.levels.length : 1;
      if (Math.max(h.numClass, 1) !== want)
        throw new Error(`head ${name} answers ${h.numClass} values, the model reads ${want}`);
    }
  }

  /** Classifies one ask from its input and the session's earlier asks. */
  predict(input: AskInput, hist: ReadonlyArray<Hist>): Pred {
    const v = new Vec(false);
    const sp = features(v, input, hist, this.skip);
    const row = new Float64Array(this.nrow);
    row.set(v.x);
    const lists: Record<string, ReadonlyArray<number>> = {
      T: sp.T,
      P: sp.P,
      A: sp.A,
      G: sp.G,
      E: sp.E,
    };
    // tf-idf of (text, idf block), shared between text heads.
    const cache = new Map<string, readonly [Uint32Array, Float64Array]>();
    for (const t of this.text) {
      const k = t.outputs.length;
      for (const ap of t.apply) {
        const z = new Float64Array(k);
        let empty = true;
        ap.texts.forEach((name, b) => {
          const key = `${name}/${t.blocks[b]}`;
          let c = cache.get(key);
          if (c === undefined) {
            c = tfidfVec(lists[name] ?? [], this.idf.get(t.blocks[b]!)!);
            cache.set(key, c);
          }
          const [ids, vals] = c;
          const [w, sc] = [t.w[b]!, t.scale[b]!];
          for (let i = 0; i < ids.length; i++) {
            const x = Math.fround(vals[i]! * sc);
            const base = ids[i]! * k;
            for (let o = 0; o < k; o++) z[o]! += x * halves[w[base + o]!]!;
          }
          empty &&= ids.length === 0;
        });
        t.outputs.forEach((name, o) => {
          let p = Math.fround(1 / (1 + Math.exp(-(z[o]! + t.intercept[o]!))));
          // No previous ask, no reply: no score (as in training).
          if (empty && ap.prefix !== "tj_" && ap.prefix !== "tt_") p = NaN;
          row[this.cols.get(ap.prefix + name)!] = p;
        });
      }
    }
    const x = new Float64Array(this.maxFeat);
    const out = new Map<string, Array<number>>();
    // A head named fu_<head> answers in place of <head> for a short follow-up (at most SHORT_WORDS words, a reply
    // tail, not a slash command): class, level and cheap heads trained on those asks alone.
    const short =
      goRound(Math.expm1(row[this.cols.get("p_words")!]!)) <= SHORT_WORDS &&
      row[this.cols.get("a_chars")!]! > 0 &&
      !input.slash;
    for (const name of this.order) {
      const fu = this.heads.get(`fu_${name}`);
      const h = short && fu !== undefined ? fu : this.heads.get(name)!;
      const answer = h.predict(row, x);
      out.set(name, answer);
      for (const [f, by] of this.stack)
        if (by === name) row[this.cols.get(f)!] = Math.fround(answer[0]!);
    }
    const first = (name: string): number => out.get(name)![0]!;
    let pl: Array<number>;
    if (this.level === "ordinal") {
      const g1 = first("level_ge1");
      const g2 = Math.min(first("level_ge2"), g1);
      const g3 = Math.min(first("level_ge3"), g2);
      pl = [1 - g1, g1 - g2, g2 - g3, g3];
    } else pl = out.get("level")!;
    let top = 0;
    for (const p of pl) top = Math.max(top, p);
    let level = 0;
    pl.forEach((p, i) => {
      if (p >= this.lean * top) level = i;
    });
    let pc = out.get("class");
    if (pc === undefined) {
      // One-vs-rest heads class_0..7, times the decode prior, normalised.
      pc = this.classes.map(
        (_, k) => first(`class_${k}`) * (k < this.prior.length ? this.prior[k]! : 1),
      );
      let sum = 0;
      for (const p of pc) sum += p;
      pc = pc.map((p) => p / sum);
    }
    let cls = 0;
    pc.forEach((p, i) => {
      if (p > pc[cls]!) cls = i;
    });
    const cheap = this.cheap === "head" ? first("cheap") : pl[0]! + pl[1]!;
    return {
      class: this.classes[cls]!,
      level: this.levels[level]!,
      pCheap: Math.min(Math.max(cheap, 0), 1),
      pBig: first("big"),
      pEdit: first("edit"),
      pClass: pc,
      pLevel: pl,
    };
  }
}

/** math.Round: half away from zero. */
const goRound = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/** count float16 values of bin from byte off, as little-endian words; in place where the platform allows. */
const halfWords = (bin: Uint8Array, off: number, count: number): Uint16Array => {
  const at = bin.byteOffset + off;
  if (at % 2 === 0 && endianness() === "LE") return new Uint16Array(bin.buffer, at, count);
  const view = new DataView(bin.buffer, at, 2 * count);
  return Uint16Array.from({ length: count }, (_, i) => view.getUint16(2 * i, true));
};

/** tf-idf of one hashed token list (with repeats): sorted bucket ids and their l2-normalised (1 + ln count) * idf. */
const tfidfVec = (
  ids: ReadonlyArray<number>,
  idf: Float32Array,
): readonly [Uint32Array, Float64Array] => {
  if (ids.length === 0) return [new Uint32Array(0), new Float64Array(0)];
  const s = Uint32Array.from(ids).sort();
  const u: Array<number> = [];
  const v: Array<number> = [];
  let norm = 0;
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j < s.length && s[j] === s[i]) j++;
    const x = (1 + Math.log(j - i)) * idf[s[i]!]!;
    u.push(s[i]!);
    v.push(x);
    norm += x * x;
    i = j;
  }
  norm = Math.sqrt(norm);
  return [Uint32Array.from(u), Float64Array.from(v, (x) => x / norm)];
};

const MODEL_URL = new URL("./model/ask_r4.json.gz", import.meta.url);
const TEXT_URL = new URL("./model/ask_r4.text.bin", import.meta.url);
const CALIB_URL = new URL("./model/ask_r4.calib.json", import.meta.url);

/** Reads and checks the shipped artifact (model/), off the event loop but for the JSON parse. */
export const loadAskModel = async (): Promise<Model> => {
  const [gz, bin, calib] = await Promise.all([
    readFile(MODEL_URL),
    readFile(TEXT_URL),
    readFile(CALIB_URL, "utf8"),
  ]);
  const raw = await promisify(gunzip)(gz);
  return new Model(JSON.parse(raw.toString("utf8")) as ModelJson, bin, calib);
};
