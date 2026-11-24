// Problem reports (README.md): what a Caveman client sends when a person
// presses "Report a problem", and the redaction every byte of it passes before
// it leaves the computer. No dependencies and browser-safe: a web client runs
// the same rules over what the person types in its preview, so the preview
// shows exactly what is sent. The Node half (signature, tar.gz, log tails, the
// outbox on disk) is ./node.ts.
//
// The wire contract is Caveman Cloud's (POST /api/v1/code/bug-reports,
// multipart: the `report` JSON part first, then `logs` and `screenshot`).

/** Caveman Cloud's routes for the person's own reports, on the kept sign-in. */
export const BUG_REPORT_ROUTE = "/api/v1/code/bug-reports";

/**
 * What a client says when the Cloud answers 404 for BUG_REPORT_ROUTE: it takes no reports (not yet, or a
 * company's own Cloud without them). The report stays on the computer and is tried again later.
 */
export const BUG_REPORTS_UNAVAILABLE = "Bug reports aren't available yet.";

export const BUG_REPORT_LIMITS = {
  /** The gzipped tar of logs (the contract's 25 MB). */
  logsGzipBytes: 25 * 1024 * 1024,
  /** The screenshot (the contract's 5 MB). */
  screenshotBytes: 5 * 1024 * 1024,
  titleChars: 120,
  summaryChars: 8_000,
  noteChars: 4_000,
  /** Logs older than this are left out. */
  logWindowMs: 6 * 60 * 60 * 1000,
  /** The tail of one log file, before redaction. */
  logFileTailBytes: 1024 * 1024,
  /** Every log file together, after redaction: small enough to read in the preview. */
  logTotalBytes: 4 * 1024 * 1024,
  /** A line longer than this is cut: long lines are payloads (prompts, file bodies), not log messages. */
  lineChars: 2_000,
  /** The thread excerpt. */
  excerptChars: 12_000,
} as const;

export const BUG_REPORT_SURFACES = [
  "chat",
  "chief",
  "onboarding",
  "install",
  "runtime",
  "other",
] as const;
export type BugReportSurface = (typeof BUG_REPORT_SURFACES)[number];

/** The `report` part of POST /api/v1/code/bug-reports, as Caveman Cloud reads it. */
export interface BugReportPayload {
  readonly reportId: string;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly buildChannel: string;
  readonly platform: "win32" | "darwin" | "linux";
  readonly osVersion: string;
  readonly arch: string;
  readonly errorSignature: string;
  readonly title: string;
  readonly agentSummary: string;
  readonly userNote?: string;
  readonly context: {
    readonly surface: BugReportSurface;
    readonly providerId?: string;
    readonly modelId?: string;
    /** An opaque id only. */
    readonly threadId?: string;
  };
  readonly redaction: { readonly version: string; readonly rulesApplied: ReadonlyArray<string> };
  readonly includes: {
    readonly logs: boolean;
    readonly screenshot: boolean;
    readonly threadExcerpt: boolean;
  };
}

/** The error a report is about, as the page or the runtime saw it. */
export interface ReportedError {
  readonly name?: string | undefined;
  readonly message: string;
  readonly stack?: string | undefined;
}

// --------------------------------------------------------------- redaction

/**
 * Bump when a rule is added, removed or changed: Cloud keeps the version with
 * each report, so the team knows which rules a report passed.
 */
export const REDACTION_VERSION = "2026-11-08.1";

export interface RedactionContext {
  /** This computer's home directory: replaced with `~`. */
  readonly homeDir?: string | undefined;
  /** This computer's user name: replaced where it names a path segment. */
  readonly userName?: string | undefined;
  /** The person opted in to code and file contents for this report: fenced code and diffs stay. */
  readonly keepCode?: boolean | undefined;
}

export interface Redaction {
  readonly text: string;
  /** How many times each rule matched. */
  readonly counts: Readonly<Record<string, number>>;
  /** Every rule that ran, matched or not: what the report says it passed. */
  readonly rules: ReadonlyArray<string>;
}

const mark = (rule: string) => `[REDACTED:${rule}]`;

interface Rule {
  readonly id: string;
  readonly apply: (text: string, ctx: RedactionContext, count: (n?: number) => void) => string;
}

const regexRule = (
  id: string,
  pattern: RegExp,
  replace: string | ((...m: string[]) => string) = mark(id),
): Rule => ({
  id,
  apply: (text, _ctx, count) =>
    text.replace(pattern, (...m: string[]) => {
      count();
      return typeof replace === "string" ? replace : replace(...m);
    }),
});

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Fenced blocks and git diffs: code a log or a chat carried, out unless the person opted in. */
const codeRule: Rule = {
  id: "code_block",
  apply: (text, ctx, count) => {
    if (ctx.keepCode) return text;
    const fenced = text.replace(
      /(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[^\n]*(?=\n|$)|$)/g,
      (block, lead: string, indent: string) => {
        count();
        return `${lead}${indent}[code removed: ${block.split("\n").length - (lead ? 1 : 0)} lines]`;
      },
    );
    // A diff: from `diff --git` (or a `@@` hunk) through the lines a diff is made of.
    const lines = fenced.split("\n");
    const out: string[] = [];
    let removed = 0;
    const flush = () => {
      if (removed > 0) out.push(`[diff removed: ${removed} lines]`);
      removed = 0;
    };
    let inDiff = false;
    for (const line of lines) {
      if (/^diff --git |^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) {
        if (!inDiff) count();
        inDiff = true;
        removed++;
        continue;
      }
      if (
        inDiff &&
        /^([+\- \\]|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |@@ )/.test(
          line,
        )
      ) {
        removed++;
        continue;
      }
      inDiff = false;
      flush();
      out.push(line);
    }
    flush();
    return out.join("\n");
  },
};

/** Paths under a home directory name the person: `~` for this computer's, `<user>` for any other's. */
const homeRule: Rule = {
  id: "home_path",
  apply: (text, ctx, count) => {
    let out = text;
    const home = ctx.homeDir?.replace(/[\\/]+$/, "");
    if (home && home.length > 1) {
      // As written, with forward slashes (Windows paths in URLs) and JSON-escaped backslashes.
      const forms = new Set([home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")]);
      for (const form of forms) {
        out = out.replace(
          new RegExp(`${escapeRegExp(form)}(?=$|[\\\\/"'\`\\s:)\\]])`, "gi"),
          () => {
            count();
            return "~";
          },
        );
      }
    }
    out = out.replace(
      /(\/Users\/|\/home\/|\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))(?!<user>)([^\\/\s"'`:]+)/g,
      (_m, prefix: string, name: string) => {
        if (/^(Shared|Public|Default|All Users)$/i.test(name)) return `${prefix}${name}`;
        count();
        return `${prefix}<user>`;
      },
    );
    const user = ctx.userName?.trim();
    if (user && user.length >= 3) {
      out = out.replace(new RegExp(`(?<=[\\\\/])${escapeRegExp(user)}(?=[\\\\/])`, "gi"), () => {
        count();
        return "<user>";
      });
    }
    return out;
  },
};

const longLineRule: Rule = {
  id: "long_line",
  apply: (text, _ctx, count) =>
    text.replace(new RegExp(`[^\\n]{${BUG_REPORT_LIMITS.lineChars + 1},}`, "g"), (line) => {
      count();
      return `${line.slice(0, BUG_REPORT_LIMITS.lineChars)} [line cut: ${line.length - BUG_REPORT_LIMITS.lineChars} more characters]`;
    }),
};

/** Words that make a name a secret's: `OPENAI_API_KEY=`, `"refresh_token": "…"`, `password: …`. */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passphrase|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential|session[_-]?id|client[_-]?secret|auth)[A-Za-z0-9_.-]*`;

/** A value under a secret's name anywhere: JSON, YAML, flags, logfmt. Plain numbers (token counts), booleans and nulls stay. */
const secretAssignmentRule: Rule = {
  id: "secret_assignment",
  apply: (text, _ctx, count) =>
    text.replace(
      new RegExp(
        String.raw`(["']?\b${SECRET_NAME}["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;}\]]+)`,
        "gi",
      ),
      (whole, lead: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
        const inner = quote ? value.slice(1, -1) : value;
        if (
          inner.length < 4 ||
          inner.startsWith("[REDACTED") ||
          /^-?\d+(\.\d+)?$/.test(inner) ||
          /^(true|false|null|undefined|none)$/i.test(inner)
        )
          return whole;
        count();
        return `${lead}${quote}${mark("secret_assignment")}${quote}`;
      },
    ),
};

/**
 * In order: blocks first (a private key, code), then whole tokens by their
 * known shapes, then values by the name they are under, then the person.
 */
const RULES: ReadonlyArray<Rule> = [
  regexRule(
    "private_key",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  ),
  codeRule,
  regexRule("anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{8,}/g),
  regexRule("openai_key", /\bsk-(?:proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}/g),
  regexRule("github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g),
  regexRule("aws_access_key", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g),
  regexRule(
    "aws_secret",
    /\b(aws_?secret_?access_?key|aws_?session_?token)(["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{16,}/gi,
    (_m, name: string, sep: string) => `${name}${sep}${mark("aws_secret")}`,
  ),
  regexRule("google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g),
  regexRule("slack_token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g),
  regexRule("stripe_key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g),
  regexRule("caveman_key", /\bcave_[A-Za-z0-9_]{16,}\b/g),
  regexRule("jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  regexRule("ssh_key", /\bssh-(?:rsa|ed25519|dss) AAAA[A-Za-z0-9+/=]{40,}/g),
  regexRule(
    "auth_header",
    /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-goog-api-key|cookie|set-cookie)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\n,}]+)/gi,
    (_m, name: string, sep: string, value: string) =>
      `${name}${sep}${value.startsWith('"') ? `"${mark("auth_header")}"` : value.startsWith("'") ? `'${mark("auth_header")}'` : mark("auth_header")}`,
  ),
  regexRule(
    "bearer",
    /\b(Bearer|Basic|Token)\s+(?!\[REDACTED)(?=[A-Za-z._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/g,
    (_m, scheme: string) => `${scheme} ${mark("bearer")}`,
  ),
  regexRule(
    "url_credentials",
    /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@"'<>]+:[^/\s@"'<>]+@/gi,
    (_m, scheme: string) => `${scheme}${mark("url_credentials")}@`,
  ),
  regexRule(
    "secret_query",
    /([?&;](?:token|access_token|refresh_token|id_token|api_key|apikey|key|secret|client_secret|password|code|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s"'#<>]+/gi,
    (_m, name: string) => `${name}${mark("secret_query")}`,
  ),
  // A .env line: every value, whatever its name.
  regexRule(
    "env_value",
    /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*[ \t]*=[ \t]*)(?!\[REDACTED)(\S.*)$/gm,
    (_m, lead: string) => `${lead}${mark("env_value")}`,
  ),
  // A command line's secret flag: `--api-key abc`, `-password=abc`.
  regexRule(
    "secret_flag",
    /(\s--?[A-Za-z0-9-]*(?:password|passwd|token|secret|api-?key)[A-Za-z0-9-]*)(\s+|=)(?!-|\[REDACTED)(\S{4,})/gi,
    (_m, flag: string, sep: string) => `${flag}${sep}${mark("secret_flag")}`,
  ),
  secretAssignmentRule,
  regexRule("email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g),
  homeRule,
  longLineRule,
];

/** Every rule this version has, in the order they run. */
export const REDACTION_RULES: ReadonlyArray<string> = RULES.map((rule) => rule.id);

/** Runs every rule over `text`. Idempotent: redacting a redacted text changes nothing. */
export function redact(text: string, ctx: RedactionContext = {}): Redaction {
  const counts: Record<string, number> = {};
  let out = text;
  const rules: string[] = [];
  for (const rule of RULES) {
    if (rule.id === "code_block" && ctx.keepCode) continue;
    rules.push(rule.id);
    out = rule.apply(out, ctx, (n = 1) => void (counts[rule.id] = (counts[rule.id] ?? 0) + n));
  }
  return { text: out, counts, rules };
}

/** Rules that ran over any of `redactions`, in rule order. */
export function rulesOf(redactions: ReadonlyArray<Pick<Redaction, "rules">>): string[] {
  const ran = new Set(redactions.flatMap((r) => r.rules));
  return REDACTION_RULES.filter((id) => ran.has(id));
}

/** Matches per rule over several redactions, summed. */
export function sumCounts(
  redactions: ReadonlyArray<Pick<Redaction, "counts">>,
): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const r of redactions)
    for (const [id, n] of Object.entries(r.counts)) sum[id] = (sum[id] ?? 0) + n;
  return sum;
}

// --------------------------------------------------------------- the template

const SURFACE_LABEL: Record<BugReportSurface, string> = {
  chat: "Chat",
  chief: "Chief",
  onboarding: "Onboarding",
  install: "Install",
  runtime: "Runtime",
  other: "App",
};

const firstLine = (s: string) =>
  s
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "";

export const clip = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;

/**
 * The description when no model can write one (no engine signed in yet, which
 * is common when onboarding is what failed): the error as it is, and the
 * headings the team reads. The error is redacted first.
 */
export function templateDraft(
  input: { readonly surface: BugReportSurface; readonly error?: ReportedError | undefined },
  ctx: RedactionContext = {},
): { title: string; summary: string } {
  const error = input.error;
  const message = error ? redact(firstLine(error.message) || "(no message)", ctx).text : "";
  const name = error?.name && error.name !== "Error" ? `${error.name}: ` : "";
  const title = clip(
    error
      ? `${SURFACE_LABEL[input.surface]}: ${name}${message}`
      : `${SURFACE_LABEL[input.surface]}: a problem to report`,
    BUG_REPORT_LIMITS.titleChars,
  );
  const what = error
    ? `Caveman Code showed this error (${SURFACE_LABEL[input.surface].toLowerCase()}):\n\n    ${name}${message}`
    : `The person reported a problem from ${SURFACE_LABEL[input.surface].toLowerCase()}.`;
  const summary = [
    "What happened",
    what,
    "",
    "Likely cause",
    "Not known yet: no model was available to read the logs. The attached logs hold the details.",
    "",
    "Steps to reproduce",
    "1. (Describe what you did just before this happened.)",
  ].join("\n");
  return { title, summary };
}
