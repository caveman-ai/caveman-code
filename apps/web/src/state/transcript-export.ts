// /export: a chat as Markdown, for a file. What was said and done, in order:
// the person's messages and the engine's answers in full, its tool calls as
// one line each, plans as checklists. Reasoning and usage stay out.
import { parseThreadReferences } from "@caveman-app/session-protocol/references";
import { plainCommand } from "./tool-actions.ts";
import type { TranscriptItem } from "./transcript-model.ts";

/** Thread links read back as "@Title". */
const plain = (text: string) => {
  let out = "";
  let at = 0;
  for (const r of parseThreadReferences(text)) {
    out += `${text.slice(at, r.start)}@${r.label}`;
    at = r.end;
  }
  return out + text.slice(at);
};

const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

/** "- Read `retry.go` (`sed -n 1,80p retry.go`)": what the call did, and a one-line command as it ran. */
const toolLine = (t: Extract<TranscriptItem, { kind: "tool" }>) => {
  const command = t.command === null ? "" : plainCommand(t.command);
  const ran = command && command !== t.subject && !command.includes("\n") ? ` (${code(command)})` : "";
  return `- ${t.verb}${t.subject ? ` ${code(t.subject)}` : ""}${ran}${t.added !== null || t.removed !== null ? ` (+${t.added ?? 0} −${t.removed ?? 0})` : ""}${t.status === "failed" ? " (failed)" : t.status === "denied" ? " (denied)" : ""}`;
};

export function transcriptMarkdown(title: string, engine: string, items: ReadonlyArray<TranscriptItem>, exportedAt = new Date()): string {
  const blocks: string[] = [`# ${title}`, `_Exported from Caveman Code on ${exportedAt.toISOString().slice(0, 10)}. Engine: ${engine}._`];
  let speaker: string | null = null;
  let tools: string[] = [];
  const say = (who: string) => {
    if (speaker !== who) blocks.push(`## ${who}`);
    speaker = who;
  };
  const flush = () => {
    if (tools.length) blocks.push(tools.join("\n"));
    tools = [];
  };
  for (const item of items) {
    if (item.kind !== "tool") flush();
    switch (item.kind) {
      case "user":
        speaker = null;
        say(item.from ? item.from.title : "You");
        blocks.push(plain(item.text));
        break;
      case "assistant":
        if (!item.text.trim()) break;
        say(engine);
        blocks.push(item.text);
        break;
      case "tool":
        say(engine);
        tools.push(toolLine(item));
        break;
      case "plan":
        say(engine);
        blocks.push(item.steps.map((s) => `- [${s.status === "completed" ? "x" : " "}] ${s.text}`).join("\n"));
        break;
      case "ask":
        say(engine);
        blocks.push(`**Asked:** ${item.prompt}${item.resolution ? `\n\n**Answer:** ${item.resolution}` : ""}`);
        break;
      case "subagent":
        say(engine);
        blocks.push(`- Agent: ${item.title}${item.summary ? ` — ${item.summary}` : ""}`);
        break;
      case "grill_finished":
        say(engine);
        blocks.push(`- Wrote the decisions to \`${item.docPath}\``);
        break;
      case "notice":
        blocks.push(`> ${item.text}`);
        break;
      case "compaction":
        if (item.status === "done") blocks.push("_Context compacted._");
        break;
      default:
        break;
    }
  }
  flush();
  return `${blocks.join("\n\n")}\n`;
}

/** A file name for the chat: its title in lowercase words, ".md". */
export const exportName = (title: string) => `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "chat"}.md`;
