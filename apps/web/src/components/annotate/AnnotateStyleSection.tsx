// The living example on the style page: the production transcript and box, on
// a picture and a recording made here. Every way in is the real one: the
// image's thumbnail opens the viewer, whose pen opens the Annotator; the
// video's Annotate takes the frame its player stands on; an image in the box
// opens from its chip. The recording comes from a MediaRecorder, as an agent's
// does, and is read through media.read like a file on the computer.
import type { Client } from "@caveman-app/session-protocol/client";
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { useEffect, useMemo, useState } from "react";
import { ChatClientScope, RuntimeFixture, useRuntime } from "../../state/runtime.tsx";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import { Composer } from "../Composer.tsx";
import { Transcript } from "../Transcript.tsx";

/** The example's chat: its transcript's workspace and its box's name, so a marked-up picture finds the box. */
const CHAT = "style-annotate";
const CLIP_PATH = "/tmp/checkout-run.mp4";
const ENGINE = {
  id: "claude-agent",
  label: "Claude Agent",
  capabilities: { structured: true, fork: true, steer: true, interrupt: true, tool_hooks: true, resume_across_machines: false, approvals: true, plans: true, subagents: true, images: true, mcp: true, grill_mode: false },
  models: [{ id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "high" }],
  auth: { state: "signed_in", accounts: [] },
} as EngineDescriptor;

const W = 1280;
const H = 800;

/** A plain app screen, with one thing wrong to circle; `t` moves its progress bar. */
function drawScreen(ctx: CanvasRenderingContext2D, t = 0.35): void {
  ctx.fillStyle = "#101113";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#17181b";
  ctx.fillRect(0, 0, 240, H);
  ctx.fillStyle = "#26282d";
  for (let i = 0; i < 7; i++) ctx.fillRect(24, 96 + i * 44, 120 + ((i * 37) % 70), 12);
  ctx.fillStyle = "#eb9e3d";
  ctx.fillRect(24, 36, 28, 28);
  ctx.fillStyle = "#e8e8ea";
  ctx.font = "600 28px system-ui, sans-serif";
  ctx.fillText("Checkout", 296, 84);
  ctx.fillStyle = "#8b8d93";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText("Review your order, then pay.", 296, 116);
  for (const [x, label, price] of [[296, "Stone axe", "$24.00"], [616, "Club, oak", "$18.00"], [936, "Flint, 12", "$9.50"]] as const) {
    ctx.fillStyle = "#1b1c20";
    ctx.fillRect(x, 160, 288, 200);
    ctx.fillStyle = "#2a2c31";
    ctx.fillRect(x + 20, 180, 248, 96);
    ctx.fillStyle = "#e8e8ea";
    ctx.font = "600 17px system-ui, sans-serif";
    ctx.fillText(label, x + 20, 312);
    ctx.fillStyle = "#8b8d93";
    ctx.font = "15px system-ui, sans-serif";
    ctx.fillText(price, x + 20, 338);
  }
  ctx.fillStyle = "#26282d";
  ctx.fillRect(296, 420, 928, 8);
  ctx.fillStyle = "#3dbb6b";
  ctx.fillRect(296, 420, 928 * t, 8);
  // The thing wrong: the total and its button overlap.
  ctx.fillStyle = "#e8e8ea";
  ctx.font = "600 22px system-ui, sans-serif";
  ctx.fillText("Total  $51.50", 1010, 520);
  ctx.fillStyle = "#f4f4f5";
  ctx.fillRect(1064, 498, 160, 44);
  ctx.fillStyle = "#101113";
  ctx.font = "600 16px system-ui, sans-serif";
  ctx.fillText("Pay now", 1112, 526);
}

function screen(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  return canvas;
}

const still = (): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const canvas = screen();
    drawScreen(canvas.getContext("2d")!);
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No picture"))), "image/png");
  });

/** A second and a half of the screen, its bar filling. */
function recording(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = screen();
    const ctx = canvas.getContext("2d")!;
    const type = ["video/mp4;codecs=avc1.640033", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) return reject(new Error("This browser records no video"));
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type });
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => parts.push(e.data);
    recorder.onstop = () => resolve(new Blob(parts, { type: type.split(";")[0]! }));
    const started = performance.now();
    const frame = () => {
      const t = Math.min(1, (performance.now() - started) / 1500);
      drawScreen(ctx, t);
      if (t < 1) requestAnimationFrame(frame);
      else recorder.stop();
    };
    recorder.start();
    frame();
  });
}

const base64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const noop = () => undefined;
const noopAsync = async () => undefined;

export function AnnotateStyleSection() {
  const runtime = useRuntime();
  const [media, setMedia] = useState<{ readonly shot: string; readonly clip: { readonly mime_type: string; readonly data: string } | null } | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const shot = await base64(await still());
      // No recorder in this browser: the image alone.
      const clip = await recording().then(async (blob) => ({ mime_type: blob.type, data: await base64(blob) }), () => null);
      if (live) setMedia({ shot, clip });
    })();
    return () => {
      live = false;
    };
  }, []);
  // The recording is this example's one file on "the computer": its chat's client answers media.read with it, and nothing else.
  const clip = media?.clip ?? null;
  const computer = useMemo(
    () => (clip ? ({ call: async (method: string) => (method === "media.read" ? { path: CLIP_PATH, size: 0, ...clip } : Promise.reject(new Error("Not on the style page"))) } as unknown as Client) : null),
    [clip],
  );
  const box = useMemo(() => ({ ...runtime, engines: [ENGINE] }), [runtime]);
  const items = useMemo<TranscriptItem[]>(() => {
    if (!media) return [];
    const at = new Date().toISOString();
    return [
      { kind: "user", id: "annotate-ask", text: "Checkout looks off at the bottom. Can you record the run?", delivery: "message", at, attachments: [{ type: "image", name: "checkout.png", mime_type: "image/png", data: media.shot }] },
      { kind: "assistant", id: "annotate-reply", text: media.clip ? `Recorded it. The bar fills, then the total sits under its button:\n\n![checkout run](${CLIP_PATH})` : "Recorded it.", streaming: false, at },
    ];
  }, [media]);
  const transcript = <Transcript items={items} engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} running={false} onAnswer={noop} cavemanVersion={null} workspaceId={CHAT} />;
  return (
    <section id="annotate" aria-labelledby="annotate-h" className="border-t border-border py-10">
      <h2 id="annotate-h" className="text-[14px] font-medium">Marking up a picture</h2>
      <p className="mt-1 max-w-[76ch] text-[13px] text-muted-foreground">
        An image from the chat (open it, then the pen), a video's frame (Annotate under its player) and an image attached in the box (its chip) open on one surface. The bar is the whole tool: pen, shape, text, colour, weight, undo, redo, clear, then the one white button that keeps the copy. The tool in hand is the raised card; the rest are ghost. A copy from the chat lands in the box, ready to send.
      </p>
      <div className="mt-5 max-w-[720px]">
        {computer ? <ChatClientScope client={computer}>{transcript}</ChatClientScope> : transcript}
        <div className="mt-4">
          <RuntimeFixture value={box}>
            <Composer draftKey={CHAT} running={false} engineId="claude-agent" engineLabel="Claude Agent" canSteer onSubmit={noopAsync} onInterrupt={noopAsync} placeholder="Say what to do about it" />
          </RuntimeFixture>
        </div>
      </div>
    </section>
  );
}
