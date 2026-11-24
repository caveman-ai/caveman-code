// BERT's uncased WordPiece, as Hugging Face's BertTokenizer (do_lower_case, tokenize_chinese_chars): the
// tokenizer bge-small-en-v1.5 was trained with. Ids come from the model's own vocab.txt, one token per line.

const CLS = "[CLS]";
const SEP = "[SEP]";
const UNK = "[UNK]";
/** BertTokenizer's max_input_chars_per_word: a longer word is one [UNK]. */
const MAX_WORD = 100;

/** CJK ideographs, each its own word (BasicTokenizer._is_chinese_char). */
const isCjk = (cp: number) =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f);

/** ASCII non-alphanumerics count as punctuation even where Unicode says symbol ($, ^, `); elsewhere category P. */
const isPunctuation = (ch: string, cp: number) =>
  (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126) || /\p{P}/u.test(ch);

const isControl = (ch: string) => ch !== "\t" && ch !== "\n" && ch !== "\r" && /\p{C}/u.test(ch);

/** Lower-cased, accents stripped, split on whitespace and around punctuation and CJK. */
export function basicTokens(text: string): string[] {
  const out: string[] = [];
  let word = "";
  const flush = () => {
    if (word) out.push(word);
    word = "";
  };
  for (const ch of text.toLowerCase().normalize("NFD")) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || /\s/u.test(ch)) flush();
    else if (/\p{Mn}/u.test(ch) || isControl(ch)) continue;
    else if (isPunctuation(ch, cp) || isCjk(cp)) {
      flush();
      out.push(ch);
    } else word += ch;
  }
  flush();
  return out;
}

export interface WordPiece {
  /** [CLS] tokens [SEP], at most `max` ids. */
  readonly encode: (text: string, max: number) => number[];
  /** A whole word of the vocabulary (lower-case): an English word or a common name, never a typo. */
  readonly has: (word: string) => boolean;
}

export function wordPiece(vocabText: string): WordPiece {
  const vocab = new Map<string, number>();
  vocabText.split(/\r?\n/).forEach((token, id) => token && !vocab.has(token) && vocab.set(token, id));
  const id = (token: string) => {
    const found = vocab.get(token);
    if (found === undefined) throw new Error(`vocab has no ${token}`);
    return found;
  };
  const cls = id(CLS);
  const sep = id(SEP);
  const unk = id(UNK);
  // Greedy longest match first, continuations as ##piece; a word with any unmatched rest is one [UNK].
  const pieces = (word: string): number[] => {
    const chars = [...word];
    if (chars.length > MAX_WORD) return [unk];
    const ids: number[] = [];
    for (let start = 0; start < chars.length; ) {
      let end = chars.length;
      let found: number | undefined;
      for (; start < end; end--) {
        found = vocab.get((start > 0 ? "##" : "") + chars.slice(start, end).join(""));
        if (found !== undefined) break;
      }
      if (found === undefined) return [unk];
      ids.push(found);
      start = end;
    }
    return ids;
  };
  return {
    has: (word) => vocab.has(word),
    encode: (text, max) => {
      const ids = [cls];
      for (const word of basicTokens(text)) {
        for (const piece of pieces(word)) {
          if (ids.length >= max - 1) return [...ids, sep];
          ids.push(piece);
        }
      }
      return [...ids, sep];
    },
  };
}
