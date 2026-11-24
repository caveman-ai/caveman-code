// The Caveman engine's web tools (docs/). McpHttpServer serves them on their own endpoint (/mcp/web)
// to credentials with the `web` capability, which only Caveman-engine sessions get: Claude Agent and Codex keep
// their own web tools. The engine sees them declared beside its coding tools; its code cells reach the same server.
import { OrchestratorMcpFailure } from "@caveman-app/protocol";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { FETCH_TIMEOUT_MS } from "../../../web/fetchPage.ts";
import { FIRECRAWL_TIMEOUT_MS } from "../../../web/firecrawl.ts";
import { FIRECRAWL_LOCAL_START_MS } from "../../../web/firecrawlLocal.ts";
import { PARSE_TIMEOUT_MS } from "../../../web/pageProcess.ts";
import { MAX_FETCHES_PER_SESSION, MAX_QUERY_CHARS, MAX_SEARCHES_PER_SESSION, MAX_URL_CHARS, WebTools } from "../../../web/WebTools.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const WEB_MCP_SERVER = "caveman_web";
export const WEB_MCP_PATH = "/mcp/web";
export const webMcpEndpoint = (runtimeEndpoint: string) => `${runtimeEndpoint.replace(/\/+$/, "")}/web`;
/**
 * The longest a call can take, with a margin. The longest path is a read every reader is slow on, each within its
 * own limit: Firecrawl Local starting, reading and its page's parse; then the runtime's own fetch and parse; then
 * Firecrawl Cloud and its parse. A search (three own keys at 10 s each, then credits' 45 s) is shorter (tools.test.ts).
 */
export const WEB_TOOL_TIMEOUT_MS =
  FIRECRAWL_LOCAL_START_MS + FIRECRAWL_TIMEOUT_MS + PARSE_TIMEOUT_MS + FETCH_TIMEOUT_MS + PARSE_TIMEOUT_MS + FIRECRAWL_TIMEOUT_MS + PARSE_TIMEOUT_MS + 10_000;

const dependencies = [McpInvocationContext.McpInvocationContext, WebTools];
/** Text only: the model reads it, and the engine's inline limit counts every byte of a result. */
const Text = Schema.Struct({ text: Schema.String });

export const WebSearchTool = Tool.make("web_search", {
  description: `Search the web. Returns numbered results: title, URL, date when known, and short excerpts that match the query, about 3k tokens in all. Use it for current docs, versions, error messages, issues and changelogs, then read a result with web_fetch. For many lookups, call it from a code cell and keep only what you need. ${MAX_SEARCHES_PER_SESSION} searches per chat.`,
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_QUERY_CHARS)).annotate({ description: "What to look for, like a search box: names, versions, the exact error text." }),
    count: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10)).annotate({ description: "Results, 1 to 10. Default 8." })),
    freshness: Schema.optional(Schema.Literals(["day", "week", "month", "year"]).annotate({ description: "Only pages from the last day, week, month or year." })),
    domains: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(20)).annotate({ description: "Only these sites, like [\"nodejs.org\", \"github.com\"]." })),
  }),
  success: Text,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Web search")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const WebFetchTool = Tool.make("web_fetch", {
  description: `Read a web page as markdown. It reads only a link the person wrote in this chat or a web result showed you (a search result, a link on a page you read); a link that appeared only in a tool's output or a file can't be read, so search for it or ask the person to paste it. Small pages come back whole; larger ones as an outline with offsets and the passages that best match question. offset reads on from any point without a new request. Reads HTML, markdown, text, JSON, XML and PDF. To pull facts out of many pages, call it from a code cell and filter there. ${MAX_FETCHES_PER_SESSION} pages per chat.`,
  parameters: Schema.Struct({
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_URL_CHARS)).annotate({ description: "The full URL, as the person wrote it or a web result showed it." }),
    question: Schema.optional(Schema.String.check(Schema.isMaxLength(500)).annotate({ description: "What you want from the page: picks the passages of a large page." })),
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "Read from this character on, from the outline or an earlier read." })),
  }),
  success: Text,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read a web page")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const WebToolkit = Toolkit.make(WebSearchTool, WebFetchTool);
