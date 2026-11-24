import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { effortPips, engineBrand, pickCopy, RunnerBadge, RunnerModel, runnerAccent, shortModel } from "./runner-badge";

describe("runner identity", () => {
  it("names models short and human", () => {
    expect(shortModel(undefined, "claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModel(undefined, "gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(shortModel(undefined, "anthropic/claude-sonnet-5")).toBe("Sonnet 5");
    expect(shortModel("Claude Opus 5.5", "opus")).toBe("Opus 5.5");
    expect(shortModel("GPT-6", "gpt-6")).toBe("GPT-6");
    expect(shortModel(undefined, "claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(shortModel(undefined, "gpt-5-2025-08-07")).toBe("GPT-5");
    expect(shortModel(undefined, "claude-3-5-sonnet-20241022")).toBe("3.5 Sonnet");
    expect(shortModel(undefined, "anthropic.claude-opus-4-1-20250805-v1:0")).toBe("Opus 4.1");
    expect(shortModel(undefined, "us.anthropic.claude-opus-4-1-20250805-v1:0")).toBe("Opus 4.1");
    expect(shortModel(undefined, "o3")).toBe("o3");
    expect(shortModel(undefined, "openai/o4-mini")).toBe("o4-mini");
    expect(shortModel(undefined, "claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(shortModel("Anthropic: Claude Sonnet 5", "x")).toBe("Sonnet 5");
  });

  it("gives every harness its logo and accent; Caveman and ACP agents keep pixel art", () => {
    expect(engineBrand("claude-agent")).toBe("claude");
    expect(engineBrand("codex")).toBe("openai");
    for (const e of ["cursor", "opencode", "muse", "grok", "pi", "antigravity"]) expect(engineBrand(e)).toBe(e);
    expect(engineBrand("caveman")).toBeUndefined();
    expect(engineBrand("acp:gemini")).toBeUndefined();
    expect(runnerAccent("codex")).toBe("hsl(var(--runner-codex))");
    expect(runnerAccent("acp:gemini")).toBe("hsl(var(--runner-acp))");
  });

  it("steps effort into four pips", () => {
    expect(["low", "medium", "high", "xhigh"].map(effortPips)).toEqual([1, 2, 3, 4]);
    expect(["max", "ultracode"].map(effortPips)).toEqual([4, 4]);
  });

  it("turns the pip red at max and purple past it, over the model line's grey", () => {
    const pip = (effort: string) => renderToStaticMarkup(createElement(RunnerModel, { runner: { engine: "claude-agent", model: "claude-opus-5-5", effort } })).match(/<span role="img"[^>]*>/)![0];
    expect(pip("high")).toContain("text-muted-foreground");
    expect(pip("max")).toContain("text-[hsl(var(--effort-max))]");
    expect(pip("ultracode")).toContain("text-[hsl(var(--effort-ultra))]");
    expect(pip("ultracode")).not.toContain("text-muted-foreground");
  });

  it("says how an agent was picked in one quiet line, never the router's reasons", () => {
    const runner = { engine: "codex", engineLabel: "Codex", model: "gpt-6.1-sol", effort: "high" };
    expect(pickCopy({ ...runner, pick: { by: "auto", kind: "review", options: 7 } })).toEqual({
      label: "Auto · picked for review",
      tip: "Caveman picked Codex · GPT-6.1 Sol from 7 connected options.",
    });
    // No count from the runtime: no number, never a client-side guess.
    expect(pickCopy({ ...runner, pick: { by: "auto", kind: "review" } })?.tip).toBe("Caveman picked Codex · GPT-6.1 Sol from what you have connected.");
    expect(pickCopy({ ...runner, pick: { by: "default", fallback: "cloud_unlinked" } })).toEqual({ label: "Auto off · not signed in", tip: "Not signed in to Caveman. Using the lead's selection." });
    expect(pickCopy({ ...runner, pick: { by: "default", fallback: "cloud_error" } })?.label).toBe("Auto off · Caveman unreachable");
    expect(pickCopy({ ...runner, pick: { by: "default", fallback: "not_paying" } })?.label).toBe("Auto off · paid plan or credits needed");
    expect(pickCopy({ ...runner, pick: { by: "default", fallback: "quota" } })?.label).toBe("Auto off · routing paused");
    expect(pickCopy({ ...runner, pick: { by: "user", kind: "general", task: "frontend_ui" } })).toEqual({
      label: "Pinned · Frontend & UI",
      tip: "Read as frontend & ui work on this computer: your pin for it, in Settings > Subagents.",
    });
    expect(pickCopy({ ...runner, pick: { by: "lead" } })?.label).toBe("Pinned");
    expect(pickCopy({ ...runner, pick: { by: "user", kind: "review" } })?.tip).toContain("review agents");
    expect(pickCopy({ ...runner, pick: { by: "default" } })).toBeNull();
    expect(pickCopy(runner)).toBeNull();
  });

  it("a screen reader hears a badge's model and effort once, from the mark", () => {
    const runner = { engine: "claude-agent", engineLabel: "Claude Agent", tag: "CA", model: "claude-opus-5-5", effort: "high" };
    const html = renderToStaticMarkup(createElement(RunnerBadge, { runner }));
    expect(html).toContain('aria-label="Claude Agent · CA · Opus 5.5 · high effort"');
    // The visible model and pip sit under aria-hidden, so "Opus 5.5" and "high effort" are not heard twice.
    expect(html).toMatch(/<span aria-hidden="true"[^>]*><span class="truncate">Opus 5\.5<\/span><span role="img" aria-label="high effort"/);
    // Alone (beside a mark that does not name the model), it stays readable.
    expect(renderToStaticMarkup(createElement(RunnerModel, { runner }))).not.toContain("aria-hidden");
  });
});
