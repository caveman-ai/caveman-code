// ), packages/provider-core/src/server/runtimeInstructions.ts @ ab3a3cd1.
/**
 * Every engine's: work lands through a pull request, as T3, Codex and Claude land it (never a merge into the person's
 * own checkout, which nothing pushes); register each pull request with its thread (which also starts its review
 * guide) and watch it. The Caveman engine and Pi add it on their own (provider-caveman runtimeText, provider-pi
 * mcpExtensionSource).
 * Session-invariant, so a harness with a native system-prompt append (Antigravity 1.4.5) carries it once per session.
 */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Asked to merge, ship or land a chat's work, or told to land finished work by the repository's own instructions (CLAUDE.md, AGENTS.md): land it through a PR. Commit, fetch and rebase onto (or merge) origin's base, push the chat's branch, open a PR against the base, and merge it on the host (\`gh pr merge --squash\`) once its checks pass, or say what blocks it. Never git merge into the project's own checkout or another chat's branch, never push to the base branch unless the person asks for exactly that, never edit the project's checkout from a worktree. No gh login (a Cloud computer): push the branch and say its PR is ready to open from Caveman Code.
Link each PR you create, take over or push to, as your next call: link_pull_request, one per PR, full URL, every stack layer; for one you opened here, pass tldr too (the whole change in one line of at most 120 characters, what then why). Host tools never link for you; if linking fails, say so. Skip PRs you only read or review, and PRs named only as background.
Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do (such as a merge) still waits on checks or reviews, even after an earlier unwatch: finish and push any needed branch update, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if told to babysit; after PR work a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait on a PR with sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, unwatch_pull_request every PR you watch.
</pull_request_linking>`;

/**
 * Caveman Code: every engine finishes UI work with screenshots, which the app
 * collects into a gallery under the reply. The Caveman engine, which takes no
 * runtime_info, gets this block on its own (provider-caveman adapter).
 */
export const UI_PROOF_INSTRUCTIONS = `<ui_proof>
When your work changes what a person sees (a page, component, layout or style), end your final reply with screenshots of the result if you can take them, new PNGs in a temp folder outside the repository, embedded by absolute path: ![Settings after the fix](/tmp/proof/settings-after.png), with angle brackets around a path with spaces: ![Alt](</path with spaces/shot.png>). One per state that matters (before and after, light and dark, narrow and wide); a flow is a few in order with one-line captions. They show as a gallery under your reply, alt text as caption: don't describe them again. For a web app or page served from this checkout, also call register_preview once with the command that serves it on {port}, so the person can open it in one click.
</ui_proof>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const instructions = `<runtime_info>If asked: you run in Caveman Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention it otherwise. Replies can embed images and videos as Markdown with absolute file paths.</runtime_info>\n\n${UI_PROOF_INSTRUCTIONS}`;
  return runtime.pullRequestLinking === false
    ? instructions
    : `${instructions}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
