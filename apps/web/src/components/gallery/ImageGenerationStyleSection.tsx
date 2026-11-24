// Living examples use the production event reducer and transcript, never a separate mock card.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { useMemo } from "react";
import { SessionModel } from "../../state/transcript.ts";
import { Transcript } from "../Transcript.tsx";

function sampleImage(): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const sky = ctx.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, "#b0b3dd"); sky.addColorStop(0.6, "#e8c6ba"); sky.addColorStop(1, "#d58773");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = "#f8e2aa"; ctx.beginPath(); ctx.arc(332, 186, 62, 0, Math.PI * 2); ctx.fill();
  for (const [fill, points] of [
    ["#9996b1", [[0, 340], [140, 215], [280, 364], [410, 290], [512, 340], [512, 512], [0, 512]]],
    ["#6f708b", [[0, 375], [80, 320], [250, 415], [370, 312], [512, 390], [512, 512], [0, 512]]],
    ["#494f6a", [[0, 450], [170, 383], [330, 453], [450, 405], [512, 435], [512, 512], [0, 512]]],
  ] as const) {
    ctx.fillStyle = fill; ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fill();
  }
  return canvas.toDataURL("image/png").split(",")[1]!;
}

export function ImageGenerationStyleSection() {
  const states = useMemo(() => {
    const png = sampleImage();
    return (["running", "completed", "failed"] as const).map((state) => {
      const model = new SessionModel();
      let cursor = 0;
      const apply = (type: SessionEvent["type"], payload: unknown, item_id?: string) => model.apply({ session_id: `image-demo-${state}`, turn_id: "turn", cursor: ++cursor, at: new Date().toISOString(), type, payload, ...(item_id ? { item_id } : {}) } as SessionEvent);
      apply("turn.started", { engine: "codex" });
      apply("tool.started", { name: "image_generation", title: "image_generation", kind: "other", input: { prompt: "A quiet mountain landscape at sunset, in soft lavender and peach." } }, "image");
      if (state !== "running") {
        apply("tool.done", state === "completed" ? { status: "completed", result: { result: png, revised_prompt: "A quiet mountain landscape at sunset, in soft lavender and peach." } } : { status: "failed", error: "Image generation limit reached. Try again after the limit resets." }, "image");
        apply("turn.done", { status: state });
      }
      return { state, items: model.snapshot().items };
    });
  }, []);
  return (
    <section id="image-generation" aria-labelledby="image-generation-h" className="border-t border-border py-10">
      <h2 id="image-generation-h" className="text-[14px] font-medium">Image generation</h2>
      <p className="mt-1 max-w-[76ch] text-[13px] text-muted-foreground">Native generation stays in the conversation: a quiet working state, artwork that stays outside the folded trace, an expandable prompt, and the shared image viewer. Demo artwork below is drawn locally.</p>
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        {states.map(({ state, items }) => <div key={state} className="min-w-0"><div className="mb-2 text-[12px] capitalize text-muted-foreground">{state}</div><Transcript items={items} engine="codex" engineLabel="Codex" engineIsCaveman={false} running={state === "running"} onAnswer={() => {}} cavemanVersion={null} /></div>)}
      </div>
    </section>
  );
}
