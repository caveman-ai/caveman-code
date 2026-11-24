import { assert, it } from "@effect/vitest";

import { approvalKindFor, approvalPrompt } from "./approvals.ts";

it("asks by access mode and tool effect, with a short card line", () => {
  const ask = (mode: Parameters<typeof approvalKindFor>[0]) => (["read", "idempotent", "write", "external"] as const).map((effect) => approvalKindFor(mode, effect));
  assert.deepEqual(ask("approval-required"), [null, null, "file-change", "command"]);
  assert.deepEqual(ask("auto-accept-edits"), [null, null, null, "command"]);
  assert.deepEqual(ask("full-access"), [null, null, null, null]);
  assert.equal(approvalPrompt("bash", { command: " ls -la " }), "Run ls -la");
  assert.equal(approvalPrompt("edit_file", { path: "src/a.ts" }), "Edit src/a.ts");
  assert.equal(approvalPrompt("mcp__github__create_issue", {}), "Use mcp__github__create_issue");
  assert.equal(approvalPrompt("bash", { command: "x".repeat(300) }).length, 200);
  // The runtime's own orchestration tools never ask, as for Claude Agent; outside MCP tools do.
  assert.equal(approvalKindFor("approval-required", "external", { name: "mcp__caveman_code__delegate_task" }), null);
  assert.equal(approvalKindFor("auto-accept-edits", "external", { name: "mcp__caveman_code__thread_wait" }), null);
  assert.equal(approvalKindFor("approval-required", "external", { name: "mcp__caveman_code__delegate_task", readOnlySandbox: true }), "command");
  assert.equal(approvalKindFor("approval-required", "external", { name: "mcp__github__create_issue" }), "command");
  // The desktop's clicks and keys are commands; looking at it is not. Full access asks nothing.
  for (const mode of ["approval-required", "auto-accept-edits"] as const) {
    for (const action of ["left_click", "type", "key", "scroll", "left_click_drag", "mouse_move"]) assert.equal(approvalKindFor(mode, "external", { name: "mcp__caveman_code__computer", args: { action } }), "command");
    for (const action of ["screenshot", "cursor_position", "wait"]) assert.equal(approvalKindFor(mode, "external", { name: "mcp__caveman_code__computer", args: { action } }), null);
  }
  assert.equal(approvalKindFor("full-access", "external", { name: "mcp__caveman_code__computer", args: { action: "key" } }), null);
  assert.equal(approvalPrompt("mcp__caveman_code__computer", { action: "key", text: "ctrl+s" }), "Desktop: key ctrl+s");
  assert.equal(approvalPrompt("mcp__caveman_code__computer", { action: "left_click", coordinate: [300, 200] }), "Desktop: left_click at 300, 200");
  // Grill mode's tools only ask the user, so no card in front of them.
  assert.equal(approvalKindFor("approval-required", "external", { name: "mcp__caveman_grill__grill_round" }), null);
  // Web search and fetch never ask, in any mode: provenance and the secret check protect the person.
  for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    for (const tool of ["web_search", "web_fetch"]) assert.equal(approvalKindFor(mode, "external", { name: `mcp__caveman_web__${tool}`, args: { query: "x", url: "https://example.com" } }), null);
  }
  // Polling, listing or stopping a command already allowed asks nothing; a new command or stdin still asks.
  for (const action of ["read", "list", "kill"]) assert.equal(approvalKindFor("auto-accept-edits", "external", { name: "bash", args: { action, sessionId: "s1" } }), null);
  assert.equal(approvalKindFor("auto-accept-edits", "external", { name: "bash", args: { action: "write", sessionId: "s1", input: "rm -rf /\n" } }), "command");
  assert.equal(approvalKindFor("auto-accept-edits", "external", { name: "bash", args: { command: "sleep 300" } }), "command");
  // A session action that also carries a command or stdin still asks: the engine would run it.
  for (const action of ["read", "list", "kill"]) {
    assert.equal(approvalKindFor("approval-required", "external", { name: "bash", args: { action, sessionId: "s1", command: "rm -rf /" } }), "command");
    assert.equal(approvalKindFor("auto-accept-edits", "external", { name: "bash", args: { action, sessionId: "s1", input: "rm -rf /\n" } }), "command");
  }
  // A secret is scrubbed before the clip, so a cut never leaves part of it behind.
  const secret = "sk-ant-" + "k".repeat(40);
  const scrub = (text: string) => text.replaceAll(secret, "[redacted]");
  assert.notInclude(approvalPrompt("bash", { command: `${"x".repeat(180)} ${secret}` }, scrub), "sk-ant-");
});

it("asks for an edit or write that carries then_run as a command, in every mode that asks for commands", () => {
  const fused = { path: "src/a.ts", old_string: "a", new_string: "b", then_run: { command: "pnpm test" } };
  // A wrapper may still report the declared effect (write); the card follows the arguments.
  for (const effect of ["write", "external"] as const) {
    assert.equal(approvalKindFor("auto-accept-edits", effect, { name: "edit_file", args: fused }), "command");
    assert.equal(approvalKindFor("approval-required", effect, { name: "write_file", args: { path: "x.sh", content: "", then_run: { command: "sh x.sh" } } }), "command");
    assert.equal(approvalKindFor("full-access", effect, { name: "edit_file", args: fused }), null);
  }
  // Without then_run an edit stays an edit.
  assert.equal(approvalKindFor("auto-accept-edits", "write", { name: "edit_file", args: { path: "src/a.ts", old_string: "a", new_string: "b" } }), null);
  assert.equal(approvalPrompt("edit_file", fused), "Edit src/a.ts, then run pnpm test");
  assert.equal(approvalPrompt("write_file", { path: "x.sh", content: "", then_run: { command: "sh x.sh" } }), "Write x.sh, then run sh x.sh");
});

it("outside the app runtime (agent exec) a server named like the app's own asks like any other", () => {
  const outside = { appServers: false } as const;
  for (const name of ["mcp__caveman_code__delegate_task", "mcp__caveman_web__web_search", "mcp__caveman_grill__ask", "mcp__caveman_setup__build", "mcp__caveman_code__computer"]) {
    assert.equal(approvalKindFor("auto-accept-edits", "external", { name }, outside), "command", name);
  }
  assert.equal(approvalKindFor("auto-accept-edits", "external", { name: "mcp__caveman_web__web_search" }), null);
  // Everything else is the same rule.
  assert.equal(approvalKindFor("auto-accept-edits", "read", { name: "read_file" }, outside), null);
  assert.equal(approvalKindFor("approval-required", "write", { name: "write_file" }, outside), "file-change");
  assert.equal(approvalKindFor("full-access", "external", { name: "mcp__caveman_web__web_search" }, outside), null);
});

it("keeps legacy runtime tool calls recognizable without bypassing desktop approval", () => {
  assert.equal(approvalKindFor("approval-required", "external", { name: "mcp__t3_code__t3_thread_wait" }), null);
  assert.equal(approvalKindFor("approval-required", "external", { name: "mcp__t3_code__computer", args: { action: "key" } }), "command");
  assert.equal(approvalKindFor("approval-required", "external", { name: "mcp__t3_code__computer", args: { action: "screenshot" } }), null);
  assert.equal(approvalPrompt("mcp__t3_code__computer", { action: "key", text: "ctrl+s" }), "Desktop: key ctrl+s");
});
