/**
 * Project secrets on both sides of the wire. The composer uses `detectSecrets`
 * to catch a pasted `.env` or key before it becomes chat text; the runtime
 * uses `createScrubber` to replace every stored value with `[secret:NAME]` in
 * anything bound for a model or a transcript. Values never cross the protocol
 * except in `secret.set`.
 *
 * @module secrets
 */

export interface SecretEntry {
  readonly name: string;
  readonly value: string;
}

/** An environment variable name; never one that names an object's own machinery. */
export const SECRET_NAME_PATTERN = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names a repository secret may not set in a process the runtime starts:
 * they would change how the process itself runs (its shell, loader, git,
 * TLS trust, proxies) or collide with what the runtime sets. `engine` adds
 * the engines' own logins and config (a project's ANTHROPIC_API_KEY must not
 * become Claude Agent's login; it still reaches the project's own commands).
 *
 * Also the names that say where an interpreter or a package manager loads
 * code from (PYTHONPATH, NODE_PATH, RUBYOPT, BUNDLE_GEMFILE, a registry or an
 * index, its config file): a Cloud computer that could write one would run
 * its code in the person's other computers (cloud-computers CONTRACT §2, S7).
 * Cloud's `reservedNames` holds the same list.
 */
const RESERVED_ENV =
  /^(?:PATH|HOME|SHELL|USER|LOGNAME|TMPDIR|TMP|TEMP|PWD|IFS|ENV|BASH_ENV|ZDOTDIR|PROMPT_COMMAND|PS[1-4]|SSH_AUTH_SOCK|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_EXEC_PATH|GIT_DIR|GIT_WORK_TREE|GIT_CONFIG\w*|LD_\w+|DYLD_\w+|PYTHONPATH|NODE_PATH|NPM_CONFIG_REGISTRY|NPM_CONFIG_USERCONFIG|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|PIP_CONFIG_FILE|UV_INDEX_URL|BUNDLE_GEMFILE|RUBYOPT|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|(?:HTTPS?|ALL|NO)_PROXY|XDG_\w+|USERPROFILE|APPDATA|LOCALAPPDATA|CAVEMAN_(?:PORT\w*|CODE_\w+|CLOUD_\w+|WORKSPACE_\w+))$/i;
const ENGINE_RESERVED_ENV = /^(?:ANTHROPIC|CLAUDE|OPENAI|CODEX)_\w*$/i;

export const isReservedEnvName = (name: string, scope: "process" | "engine"): boolean =>
  RESERVED_ENV.test(name) || (scope === "engine" && ENGINE_RESERVED_ENV.test(name));

/**
 * Known credential shapes and the variable name each one usually lives in. An `sk-` key's alphabet is kebab text's
 * too, so it must start its own word (not `task-...`) and its random body must hold a capital or a digit.
 */
const KNOWN_TOKENS: ReadonlyArray<{ readonly re: RegExp; readonly name: string }> = [
  { re: /(?<![A-Za-z0-9_-])sk-ant-(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{20,}/, name: "ANTHROPIC_API_KEY" },
  { re: /(?<![A-Za-z0-9_-])sk-or-(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{20,}/, name: "OPENROUTER_API_KEY" },
  { re: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9_-]{20,}/, name: "OPENAI_API_KEY" },
  { re: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, name: "STRIPE_SECRET_KEY" },
  { re: /whsec_[A-Za-z0-9]{20,}/, name: "STRIPE_WEBHOOK_SECRET" },
  { re: /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/, name: "GITHUB_TOKEN" },
  { re: /(?:AKIA|ASIA)[0-9A-Z]{16}/, name: "AWS_ACCESS_KEY_ID" },
  { re: /xox[baprs]-[A-Za-z0-9-]{16,}/, name: "SLACK_BOT_TOKEN" },
  { re: /AIza[A-Za-z0-9_-]{30,}/, name: "GOOGLE_API_KEY" },
  { re: /gsk_[A-Za-z0-9]{20,}/, name: "GROQ_API_KEY" },
  { re: /hf_[A-Za-z0-9]{20,}/, name: "HF_TOKEN" },
  { re: /npm_[A-Za-z0-9]{30,}/, name: "NPM_TOKEN" },
  { re: /re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/, name: "RESEND_API_KEY" },
  { re: /sbp_[A-Za-z0-9]{30,}/, name: "SUPABASE_ACCESS_TOKEN" },
  { re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, name: "SENDGRID_API_KEY" },
  { re: /glpat-[A-Za-z0-9_-]{20,}/, name: "GITLAB_TOKEN" },
  { re: /lin_api_[A-Za-z0-9]{30,}/, name: "LINEAR_API_KEY" },
  { re: /phx_[A-Za-z0-9]{30,}/, name: "POSTHOG_PERSONAL_API_KEY" },
  { re: /cave_live_[A-Za-z0-9_-]{12,}/, name: "CAVEMAN_API_KEY" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/, name: "PRIVATE_KEY" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, name: "JWT" },
  { re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:@\s"']*:[^@\s"']+@[^\s"']+/, name: "DATABASE_URL" },
];

const SECRETISH_NAME = /KEY|TOKEN|SECRET|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN|SALT|SIGNING|(?:DATABASE|DB|REDIS|MONGO)_?UR[LI]/i;

/** The variable a known credential usually lives in, if `value` is one. */
export const suggestSecretName = (value: string): string | undefined =>
  KNOWN_TOKENS.find(({ re }) => fullMatch(re, value.trim()))?.name;

const fullMatch = (re: RegExp, text: string) => {
  const m = re.exec(text);
  return m !== null && m.index === 0 && m[0].length === text.length;
};

/** Whether `text` carries a known credential anywhere in it. */
export const containsKnownSecret = (text: string): boolean => KNOWN_TOKENS.some(({ re }) => re.test(text));

/**
 * Every known credential inside prose or code, with a suggested name, and the
 * text with each one replaced by `$NAME` (numbered when a name repeats with
 * another value). Leftmost-longest: a match never overlaps an earlier one.
 */
export function extractKnownSecrets(text: string): { readonly entries: SecretEntry[]; readonly text: string } {
  const found: Array<{ start: number; end: number; name: string }> = [];
  for (const { re, name } of KNOWN_TOKENS) {
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!found.some((f) => start < f.end && end > f.start)) found.push({ start, end, name });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const byValue = new Map<string, string>();
  const used = new Set<string>();
  let out = "";
  let at = 0;
  for (const f of found) {
    const value = text.slice(f.start, f.end);
    let name = byValue.get(value);
    if (name === undefined) {
      name = f.name;
      for (let n = 2; used.has(name); n++) name = `${f.name}_${n}`;
      used.add(name);
      byValue.set(value, name);
    }
    out += `${text.slice(at, f.start)}$${name}`;
    at = f.end;
  }
  return { entries: [...byValue].map(([value, name]) => ({ name, value })), text: out + text.slice(at) };
}

/**
 * Parses dotenv text: `KEY=value`, `export KEY=value`, `#` comments, single,
 * double (with `\n` escapes, may span lines) and backtick quotes, and inline
 * comments after unquoted values. Lines that are not assignments are skipped;
 * `rest` counts them so callers can tell an env file from prose.
 */
export function parseDotenv(text: string): { readonly entries: SecretEntry[]; readonly rest: number } {
  const entries: SecretEntry[] = [];
  let rest = 0;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/.exec(line);
    if (m === null) {
      rest++;
      continue;
    }
    const name = m[1]!;
    let raw = m[2]!.trim();
    let value: string;
    const quote = raw[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      // A quoted value may continue on later lines until its closing quote.
      let body = raw.slice(1);
      let end = closingQuote(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]!}`;
        end = closingQuote(body, quote);
      }
      value = end < 0 ? body : body.slice(0, end);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\(["\\])/g, "$1");
    } else {
      const hash = raw.search(/\s#/);
      value = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    }
    entries.push({ name, value });
  }
  return { entries, rest };
}

const closingQuote = (body: string, quote: string) => {
  for (let j = 0; j < body.length; j++) {
    if (body[j] === "\\" && quote === '"') j++;
    else if (body[j] === quote) return j;
  }
  return -1;
};

export type Detection =
  /** Env-file shaped text: store these instead of sending them. */
  | { readonly kind: "env"; readonly entries: ReadonlyArray<SecretEntry> }
  /** One bare credential; `name` is a suggestion the user can change. */
  | { readonly kind: "token"; readonly entries: readonly [SecretEntry] }
  /** Prose or code with a known credential inside it. */
  | { readonly kind: "embedded" }
  | { readonly kind: "none" };

/**
 * What a paste (or a message about to be sent) holds. Env-shaped means every
 * non-comment line is an assignment, or one assignment whose name or value
 * looks secret. A single bare word is a token when it is a known credential or
 * long and random enough to be one.
 */
export function detectSecrets(text: string): Detection {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "none" };
  const known = suggestSecretName(trimmed);
  if (known !== undefined) return { kind: "token", entries: [{ name: known, value: trimmed }] };
  const { entries, rest } = parseDotenv(trimmed);
  const withValues = entries.filter((e) => e.value !== "");
  // A config with nothing secret in it (PORT=3000, HOST=localhost) is just text.
  if (rest === 0 && withValues.some(isSecretEntry)) return { kind: "env", entries: withValues };
  if (/^[^\s./@:]{24,}$/.test(trimmed) && isRandomLooking(trimmed) && !NOT_A_KEY.test(trimmed) && !isJoinedWords(trimmed)) {
    return { kind: "token", entries: [{ name: "", value: trimmed }] };
  }
  return containsKnownSecret(trimmed) ? { kind: "embedded" } : { kind: "none" };
}

const isSecretEntry = (e: SecretEntry) => SECRETISH_NAME.test(e.name) || containsKnownSecret(e.value) || isRandomLooking(e.value);

/** Random-looking words that are ids, not keys: git SHAs and other hex, UUIDs. */
const NOT_A_KEY = /^(?:[0-9a-f]+|[0-9A-F]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Words joined kebab, snake or camel style (`fix-calendar-sync`, `getUserProfileById`): the hyphens or capitals
 * that join them give a second character class and the entropy of a key. A key's letters fall into words of a sort
 * too, so these must read as English: their letter pairs are, on average, at least as likely in English words as in
 * random letters (ENGLISH_PAIRS). A run of capitals inside a camel word (`HTTP`, `API`) counts as the least likely
 * pairs, since a key's capitals leave many such runs. A digit sits beside a letter at most twice (`oauth2`, `k8s`).
 */
const isJoinedWords = (s: string) => {
  const parts = s.split(/[-_]+/).filter((p) => p !== "");
  if (!parts.every((p) => /^[A-Za-z0-9]+$/.test(p))) return false;
  if (parts.length < 2 && !/[a-z][A-Z]|[A-Z][A-Z][a-z]/.test(s)) return false;
  let words = 0;
  let letters = 0;
  let pairs = 0;
  let score = 0;
  for (const part of parts) {
    const cased = /[a-z]/.test(part);
    for (const word of part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []) {
      words++;
      letters += word.length;
      const acronym = cased && !/[a-z]/.test(word);
      const w = word.toLowerCase();
      for (let i = 1; i < w.length; i++, pairs++) score += acronym ? -4 : pairScore(w, i);
    }
  }
  const digitJoins = parts.reduce((n, p) => n + (p.match(/[A-Za-z](?=[0-9])|[0-9](?=[A-Za-z])/g)?.length ?? 0), 0);
  return words > 0 && digitJoins <= 2 && letters / words >= 3.5 && pairs > 0 && score >= 0;
};

/**
 * How much likelier each letter pair is inside English words than in random letters (row: first letter, column:
 * second): log2 of the ratio, rounded and held to -4..3, stored plus 4. Counted over 15M pairs of English technical
 * prose (the macOS man pages and this repository's docs).
 */
const ENGLISH_PAIRS = [
  "04540140402646030656330030", // a
  "51207000430610500441500050", // b
  "60305006404400620416405010", // c
  "51147030600311510352400020", // d
  "40563420200446032665032420", // e
  "52105400700300720524400030", // f
  "40107035600425410552510000", // g
  "60007000600001500203100000", // h
  "33444430001537530365030202", // i
  "40007020202011623050700000", // j
  "51117030500214210162402010", // k
  "50047100600600510144500050", // l
  "74017000500151550031400020", // m
  "50465360401312510056320030", // n
  "12441520202456340644534000", // o
  "60026012400500540635400010", // p
  "00000000000310000210702000", // q
  "50337130502444510454321040", // r
  "40407104502211450057511030", // s
  "50306107600200520443301030", // t
  "34435130400556140666000000", // u
  "70007000600010400010000000", // v
  "50015006700204500440002000", // w
  "60416101600020160037300530", // x
  "21214010400444760265403010", // y
  "60117200500320510050000012", // z
];
const pairScore = (w: string, i: number) => Number(ENGLISH_PAIRS[w.charCodeAt(i - 1) - 97]![w.charCodeAt(i) - 97]) - 4;

/** Shannon entropy in bits per character. */
const entropy = (s: string) => {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
};

const isRandomLooking = (s: string) => s.length >= 16 && entropy(s) >= 3.5 && classes(s) >= 2;

const classes = (s: string) =>
  [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;

/**
 * Whether a value can be scrubbed from output without wrecking ordinary text.
 * `development` or `postgres` would replace every mention of the word, so
 * such values are stored and injected but flagged as not hidden.
 */
export const isHideable = (value: string): boolean =>
  value.length >= 20 || (value.length >= 8 && classes(value) >= 2);

/** Names frameworks ship to the browser (NEXT_PUBLIC_*, VITE_*, ...): config, public by design. */
export const PUBLIC_ENV_PREFIX = /^(?:NEXT_PUBLIC|VITE|PUBLIC|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|REACT_APP)_/;

/**
 * Whether a stored secret is scrubbed from what the agent and transcripts see.
 * Public-by-design names stay visible (hiding a dev URL only blinds the
 * agent); so do values too short or plain to scrub. Both are still injected.
 */
export const isHiddenSecret = (name: string, value: string): boolean => !PUBLIC_ENV_PREFIX.test(name) && isHideable(value);

export interface Scrubber {
  /** Replaces every stored value, in any form it knows, with `[secret:NAME]`. */
  readonly scrub: (text: string) => string;
  /** Walks objects and arrays, scrubbing every string (keys included). */
  readonly scrubDeep: <A>(value: A) => A;
  /**
   * False only when scrubDeep would leave every string in `JSON.parse(json)` as it is, so a stored JSON text can go
   * out without a parse (each value's forms are matched once more JSON-escaped, as they sit inside JSON strings).
   */
  readonly mayChangeJson?: (json: string) => boolean;
  /** For chunked output: holds back a tail so a value split across chunks is still caught. */
  readonly stream: () => { readonly push: (chunk: string) => string; readonly flush: () => string };
  /**
   * For text a bound cut out of longer output at its start (a tail window): how many of its first characters could
   * be the end of a value the cut fell inside, which no scrub recognises; 0 when none. A stream's end is the twin.
   */
  readonly cutValueEnd: (text: string) => number;
  /** Names whose values matched since creation, for the "hidden N times" note. */
  readonly hits: () => ReadonlyMap<string, number>;
}

/**
 * Exact-value scrubbing: the runtime knows every value, so nothing is
 * guessed. Each hideable value is matched raw, JSON-escaped, URL-encoded, as
 * base64 and base64url at all three byte alignments (so a value inside a
 * longer encoded string, such as Basic auth, is caught), and, for URLs that
 * carry one, by the password alone.
 */
export function createScrubber(secrets: ReadonlyArray<SecretEntry>): Scrubber {
  /** Exact text -> name. */
  const literals = new Map<string, string>();
  /** Base64 core -> name; matched with line breaks allowed between characters (wrapped output). */
  const cores = new Map<string, string>();
  const addLiteral = (needle: string, name: string) => {
    if (needle.length >= 8 && !literals.has(needle)) literals.set(needle, name);
  };
  const addValue = (value: string, name: string) => {
    for (const form of forms(value)) addLiteral(form, name);
    for (const core of base64Cores(value)) if (core.length >= 8 && !cores.has(core)) cores.set(core, name);
  };
  for (const { name, value } of secrets) {
    if (!isHiddenSecret(name, value)) continue;
    addValue(value, name);
    const password = urlPassword(value);
    if (password !== undefined && isHideable(password)) addValue(password, name);
    // A multi-line value (a PEM key) also goes line by line: re-wrapped, re-indented or CRLF output still loses every line.
    if (/[\r\n]/.test(value)) {
      for (const line of value.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length >= 16 && isHideable(t)) for (const form of forms(t)) addLiteral(form, name);
      }
    }
  }
  const counts = new Map<string, number>();
  const longestFirst = (keys: Iterable<string>) => [...keys].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const none = literals.size === 0 && cores.size === 0;
  const literalRe = literals.size === 0 ? undefined : new RegExp(longestFirst(literals.keys()), "g");
  // Cores match across the line breaks of wrapped base64 in the text with its breaks taken out (withoutBreaks), as
  // plain literals: a break pattern between every character made a regex V8 took ~0.5 s to compile, on the event loop.
  const coreRe = cores.size === 0 ? undefined : new RegExp(longestFirst(cores.keys()), "g");
  // A wrapped core is longer than itself by its line breaks; twice its length bounds that.
  const maxLen = Math.max(0, ...[...literals.keys()].map((l) => l.length), ...[...cores.keys()].map((c) => c.length * 2));

  // Every form as it sits inside a JSON string: literals escaped once more, breaks as their escapes.
  const jsonLiteralRe = literals.size === 0 ? undefined : new RegExp(longestFirst([...literals.keys()].map(jsonEscaped)));
  const coreTest = cores.size === 0 ? undefined : new RegExp(coreRe!.source);
  const mayChangeJson = (json: string) =>
    (jsonLiteralRe?.test(json) ?? false) || (coreTest?.test(json.replace(JSON_BREAKS_RE, "")) ?? false);

  /** Every match, overlapping ones included, merged into disjoint spans. */
  const spans = (text: string) => {
    const found: Array<{ start: number; end: number; names: Set<string> }> = [];
    const collect = (re: RegExp | undefined, source: string, names: ReadonlyMap<string, string>, at: (i: number) => number) => {
      if (re === undefined) return;
      re.lastIndex = 0;
      for (let m = re.exec(source); m !== null; m = re.exec(source)) {
        const name = names.get(m[0]);
        if (name !== undefined) found.push({ start: at(m.index), end: at(m.index + m[0].length - 1) + 1, names: new Set([name]) });
        // Step one character, not past the match: a value overlapping this one is found too.
        re.lastIndex = m.index + 1;
      }
    };
    collect(literalRe, text, literals, (i) => i);
    if (coreRe !== undefined) {
      const stripped = withoutBreaks(text);
      collect(coreRe, stripped.text, cores, stripped.at);
    }
    found.sort((a, b) => a.start - b.start);
    const merged: typeof found = [];
    for (const f of found) {
      const last = merged[merged.length - 1];
      if (last !== undefined && f.start < last.end) {
        last.end = Math.max(last.end, f.end);
        for (const n of f.names) last.names.add(n);
      } else merged.push(f);
    }
    return merged;
  };

  const scrub = (text: string) => {
    if (none || text.length === 0) return text;
    let out = "";
    let at = 0;
    for (const s of spans(text)) {
      for (const n of s.names) counts.set(n, (counts.get(n) ?? 0) + 1);
      out += `${text.slice(at, s.start)}[secret:${[...s.names].join(",")}]`;
      at = s.end;
    }
    return at === 0 ? text : out + text.slice(at);
  };

  const scrubDeep = <A>(value: A): A => {
    if (none) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return scrub(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), walk(x)]));
      }
      return v;
    };
    return walk(value) as A;
  };

  const literalList = [...literals.keys()];
  const coreList = [...cores.keys()];
  /** Whether `tail` (the end of the text so far) could be the start of a value, so it must wait for more. */
  const couldStart = (tail: string) => {
    if (literalList.some((n) => tail.length < n.length && n.startsWith(tail))) return true;
    // A tail cut inside a JSON-escaped break ends in its backslash; the break's letter comes with the next chunk.
    const bare = tail.replace(BREAKS, "").replace(/\\$/, "");
    return bare.length > 0 && coreList.some((c) => bare.length < c.length && c.startsWith(bare));
  };
  /** Where the tail of `text` could be the start of a value (held back until more arrives); else its end. */
  const holdFrom = (text: string) => {
    for (let p = Math.max(0, text.length - (maxLen - 1)); p < text.length; p++) {
      if (couldStart(text.slice(p))) return p;
    }
    return text.length;
  };

  const cutValueEnd = (text: string) => {
    if (none) return 0;
    const head = text.slice(0, maxLen);
    let end = 0;
    for (const n of literalList) {
      for (let j = 1; n.length - j > end; j++) {
        if (head.startsWith(n.slice(j))) {
          end = n.length - j;
          break;
        }
      }
    }
    // Cores match with breaks taken out. A head cut inside a JSON-escaped break starts with its letter.
    for (const skip of /^[nr]/.test(head) ? [0, 1] : [0]) {
      const stripped = withoutBreaks(head.slice(skip));
      for (const c of coreList) {
        for (let j = 1; j < c.length; j++) {
          if (stripped.text.startsWith(c.slice(j))) {
            end = Math.max(end, skip + stripped.at(c.length - j - 1) + 1);
            break;
          }
        }
      }
    }
    return end;
  };

  const stream = () => {
    let carry = "";
    return {
      push: (chunk: string) => {
        if (none) return chunk;
        const text = carry + chunk;
        // Only a tail that could begin a value waits, so ordinary output is not delayed.
        let safe = holdFrom(text);
        // A match that starts before the cut moves the cut to its end.
        for (const s of spans(text)) {
          if (s.start >= safe) break;
          if (s.end > safe) safe = s.end;
        }
        carry = text.slice(safe);
        return scrub(text.slice(0, safe));
      },
      flush: () => {
        const out = scrub(carry);
        carry = "";
        return out;
      },
    };
  };

  return { scrub, scrubDeep, mayChangeJson, stream, cutValueEnd, hits: () => new Map(counts) };
}

const BREAKS = /\r|\n|\\r|\\n/g;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The breaks wrapped base64 may carry between any two characters: raw (`\n`, `\r\n`) or JSON-escaped, longest first. */
const BREAK_FORMS = ["\\r\\n", "\r\n", "\\n", "\n"];
const breaksRe = (forms: ReadonlyArray<string>) => new RegExp(forms.map(escapeRegExp).join("|"), "g");
const BREAKS_RE = breaksRe(BREAK_FORMS);
/** The same as they sit inside JSON text, escaped once more. */
const JSON_BREAKS_RE = breaksRe(BREAK_FORMS.map((form) => JSON.stringify(form).slice(1, -1)));

/**
 * `text` with every break taken out, and where each of its characters was in `text`. The map is only worked out
 * when asked (a core matched, which is rare); taking breaks out is one native replace.
 */
function withoutBreaks(text: string): { readonly text: string; readonly at: (i: number) => number } {
  const stripped = text.replace(BREAKS_RE, "");
  if (stripped.length === text.length) return { text, at: (i) => i };
  let map: Int32Array | undefined;
  const at = (i: number) => {
    if (map === undefined) {
      map = new Int32Array(stripped.length);
      let k = 0;
      BREAKS_RE.lastIndex = 0;
      let from = 0;
      for (let m = BREAKS_RE.exec(text); m !== null; m = BREAKS_RE.exec(text)) {
        for (let j = from; j < m.index; j++) map[k++] = j;
        from = m.index + m[0].length;
      }
      for (let j = from; j < text.length; j++) map[k++] = j;
    }
    return map[i]!;
  };
  return { text: stripped, at };
}


/** Escapes as a double-quoted .env value is written (the inverse of parseDotenv). */
const dotenvQuoted = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

const jsonEscaped = (value: string) => JSON.stringify(value).slice(1, -1);

/**
 * Every literal form a value can take on its way to a model: raw, JSON-escaped
 * once and twice (a tool's output inside a request body), as written in a
 * double-quoted .env or a JSON file (`\n` for a newline) and that JSON-escaped,
 * with CRLF line ends (a PTY), and URL-encoded. A lone surrogate has no UTF-8
 * form: a process's env, its output and the sealed store hold U+FFFD in its
 * place, so the value goes in that spelling too.
 */
function forms(value: string): string[] {
  const out = new Set<string>();
  const utf8 = value.toWellFormed();
  for (const text of new Set([value, utf8])) {
    const crlf = text.replace(/\r?\n/g, "\r\n");
    for (const v of [text, dotenvQuoted(text), crlf]) {
      out.add(v);
      out.add(jsonEscaped(v));
      out.add(jsonEscaped(jsonEscaped(v)));
    }
  }
  out.add(encodeURIComponent(utf8));
  return [...out];
}

/** The value's base64 and base64url, at all three byte alignments: only the characters encoded entirely from its own bits. */
function base64Cores(value: string): string[] {
  const out: string[] = [];
  const bytes = new TextEncoder().encode(value);
  for (let k = 0; k < 3; k++) {
    const padded = new Uint8Array(k + bytes.length);
    padded.set(bytes, k);
    const core = toBase64(padded).slice(Math.ceil((4 * k) / 3), Math.floor((8 * (k + bytes.length)) / 6));
    out.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return out;
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const urlPassword = (value: string) => {
  try {
    const url = new URL(value);
    return url.password === "" ? undefined : decodeURIComponent(url.password);
  } catch {
    return undefined;
  }
};

/**
 * The key a repository's secrets live under everywhere (this runtime and
 * Caveman Cloud): `host/owner/name`, lowercase, no `.git`, from any git
 * remote form (https, ssh, scp-like `git@host:owner/name`). Undefined for a
 * URL that names no such repository (a local path, a bare host).
 */
export function repositoryKey(remote: string): string | undefined {
  const raw = remote.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw);
  let host: string;
  let path: string;
  if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const url = new URL(raw);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  }
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (host === "" || parts.length < 2 || parts.some((p) => p === "." || p === "..")) return undefined;
  return `${host}/${parts.join("/")}`.toLowerCase();
}

/** The text a model sees in place of pasted secrets: names only, never values. */
export const secretsNotice = (names: ReadonlyArray<string>): string =>
  `[Added ${names.length === 1 ? "secret" : `${names.length} secrets`} to this project: ${names.join(", ")}. ` +
  `Values are hidden from you; they are set as environment variables in every command you run. ` +
  `Refer to them by name and never write their values into files.]`;

// 1Password secret reference syntax (upstream 97e35bcf23, #27115): names outside this charset must be
// written as item ids. It also keeps `{{`, `}}` and line breaks out of the `op inject` template the
// runtime builds from references.
const ONE_PASSWORD_NAME = String.raw`[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?`;
const ONE_PASSWORD_REFERENCE = new RegExp(
  String.raw`^op://${ONE_PASSWORD_NAME}(?:/${ONE_PASSWORD_NAME}){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$`,
);

/** `op://vault/item/field` (or `op://vault/item/section/field`), as `op read` takes it. */
export const isOnePasswordReference = (reference: string): boolean =>
  reference.length <= 1024 && ONE_PASSWORD_REFERENCE.test(reference);

export const ONE_PASSWORD_REFERENCE_PLACEHOLDER = "op://vault/item/field";
