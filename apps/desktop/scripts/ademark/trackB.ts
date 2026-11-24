// ADEMark Track B (tokens, TESTS.md §3) through the packaged app's runtime: a new Claude Agent chat in the arena sends
// the B1 prompt (`hi`) and the B3 prompt to fakeModel.ts, which keeps every request body. B1 and B3 total what the model
// is sent and sends back; B2 splits the first request by what it carries; B4 asks whether the arena's AGENTS.md canary
// reached the model. With --real the requests go on to the real API through the stand-in and its reported usage is the
// count (that needs a Claude Code login the scratch home can use, and spends a little of it); otherwise tokens are
// estimated from bytes at the ratio measured for Claude Code's own requests (BYTES_PER_TOKEN).
import { chat, startRuntime, type Profile } from "./harness.ts";
import { startFakeModel, type CapturedRequest } from "./fakeModel.ts";

/**
 * Bytes of a Messages API request body per input token: 48,763 bytes counted 17,058 tokens (input + cache) for Claude
 * Code 2.1.325's `hi` with Opus 5.5 on 2026-11-16 (fakeModel pass-through, the real API's usage). Tool schemas and
 * prose share the body about as they do in an app's request, so the ratio holds within a few percent.
 */
export const BYTES_PER_TOKEN = 48_763 / 17_058;

export const B1_PROMPT = "hi";
export const B3_PROMPT =
  "Read src/paginate.ts and src/dates.ts. Explain what each function does and list every bug you find with the line number. Do not change any file.";
const CANARY = "End every final answer with the line ledger-ok.";

export interface Anatomy {
  /** System prompt text, every block. */
  system: number;
  /** Built-in tool definitions sent in full. */
  tools: number;
  /** MCP tools sent in full (`mcp__…`). */
  mcp_tools: number;
  /** Everything in the messages that the person did not type: reminders, instructions, the deferred tool list. */
  injected: number;
  tool_names: Array<string>;
}

const tokens = (chars: number) => Math.round(chars / BYTES_PER_TOKEN);

export function anatomy(request: CapturedRequest, typed: string): Anatomy {
  const body = request.body as {
    system?: Array<{ text: string }>;
    tools?: Array<{ name: string }>;
    messages?: Array<unknown>;
  };
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const tools = body.tools ?? [];
  return {
    system: tokens((body.system ?? []).reduce((n, s) => n + Buffer.byteLength(s.text), 0)),
    tools: tokens(
      tools.filter((t) => !t.name.startsWith("mcp__")).reduce((n, t) => n + size(t), 0),
    ),
    mcp_tools: tokens(
      tools.filter((t) => t.name.startsWith("mcp__")).reduce((n, t) => n + size(t), 0),
    ),
    injected: tokens(size(body.messages ?? []) - Buffer.byteLength(typed)),
    tool_names: tools.map((t) => t.name),
  };
}

export interface PromptTax {
  requests: number;
  /** Requests whose first user text is not the chat's (titles, summaries, branch names): ADEMark's side calls. */
  side_requests: number;
  /** Input of every request plus what the model sent back: ADEMark's B1/total. */
  total_tokens: number;
  side_tokens: number;
  first_request_tokens: number;
  first_request_bytes: number;
  canary_in_request: boolean;
  measured: "usage" | "estimate";
  /** Each request: its model, size and first words, so a side call can be named. */
  each: Array<{ model: string; bytes: number; main: boolean; first: string }>;
}

/** The texts the person could have typed: every text part of every user message, trimmed. */
function userTexts(r: CapturedRequest): Array<string> {
  const messages = (r.body.messages ?? []) as Array<{ role: string; content: unknown }>;
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? ""),
    )
    .map((t) => t.trim());
}

function tax(requests: ReadonlyArray<CapturedRequest>, prompt: string): PromptTax {
  // The chat's own requests carry its prompt as a message of its own; any other request in the window is a side call.
  const isMain = (r: CapturedRequest) => userTexts(r).includes(prompt);
  const count = (r: CapturedRequest) =>
    r.usage
      ? r.usage.input_tokens +
        r.usage.cache_creation_input_tokens +
        r.usage.cache_read_input_tokens +
        r.usage.output_tokens
      : tokens(r.bytes) + 16;
  const main = requests.filter(isMain);
  const side = requests.filter((r) => !isMain(r));
  return {
    requests: requests.length,
    side_requests: side.length,
    total_tokens: requests.reduce((n, r) => n + count(r), 0),
    side_tokens: side.reduce((n, r) => n + count(r), 0),
    first_request_tokens: main[0] ? count(main[0]) : 0,
    first_request_bytes: main[0]?.bytes ?? 0,
    canary_in_request: main.some((r) => JSON.stringify(r.body).includes(CANARY)),
    measured: requests.every((r) => r.usage) ? "usage" : "estimate",
    each: requests.map((r) => ({
      model: String(r.body.model),
      bytes: r.bytes,
      main: isMain(r),
      first: (userTexts(r).at(-1) ?? "").slice(0, 80),
    })),
  };
}

export interface TrackB {
  b1: PromptTax;
  b2: Anatomy;
  b3: PromptTax;
  user_agent: string;
}

/** B1 to B4 on a fresh chat each, waiting `sideCallMs` after each answer for side calls (ADEMark waits 30 s). */
export async function trackB(
  app: string | "source",
  profile: Profile,
  env: (modelUrl: string) => NodeJS.ProcessEnv,
  options: { real?: boolean; sideCallMs?: number; claude?: string } = {},
): Promise<TrackB> {
  const model = await startFakeModel({
    tokensPerSecond: 1e9,
    ...(options.real ? { upstream: "https://api.anthropic.com" } : {}),
  });
  const runEnv = env(model.url);
  if (options.real) delete runEnv.ANTHROPIC_API_KEY;
  const runtime = await startRuntime(
    app,
    runEnv,
    options.claude === undefined ? {} : { claude: options.claude },
  );
  const wait = options.sideCallMs ?? 30_000;
  try {
    const before = model.requests.length;
    await chat(runtime, profile.arena, B1_PROMPT, "b1");
    await new Promise((r) => setTimeout(r, wait));
    const b1 = model.requests.slice(before);
    const mid = model.requests.length;
    await chat(runtime, profile.arena, B3_PROMPT, "b3");
    await new Promise((r) => setTimeout(r, wait));
    const b3 = model.requests.slice(mid);
    const first = b1.find((r) => userTexts(r).includes(B1_PROMPT));
    if (!first) throw new Error(`the hi chat sent no request (${b1.length} requests)`);
    return {
      b1: tax(b1, B1_PROMPT),
      b2: anatomy(first, B1_PROMPT),
      b3: tax(b3, B3_PROMPT),
      user_agent: first.user_agent,
    };
  } finally {
    await runtime.stop();
    await model.close();
  }
}
