// No browser-test dependency: run `pnpm --filter @caveman-app/web dev` and open
// /src/panels/files/FileView.browser.html. The page reports pass/fail in data-result.
// This exercises the public FileView entry point with real React state and PNG decoding.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { FileView } from "./FileView.tsx";
import "../../styles.css";

const host = document.getElementById("file-view")!;
const result = document.getElementById("result")!;
const root = createRoot(host);
const path = "updated.png";
const completed: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until(check: () => boolean, message: string) {
  const deadline = performance.now() + 3000;
  while (!check()) {
    assert(performance.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}
function show(content: string) {
  flushSync(() => root.render(
    <FileView workspaceId="image-regression" root={undefined} path={path}
      state={{ status: "ready", file: { path, content, encoding: "base64", size: atob(content).length, truncated: false } }}
      mode="preview" wrap={false} revealLine={undefined} onLink={() => {}} onRetry={() => {}} />,
  ));
}
const failed = () => host.textContent!.includes("Couldn't show this image") && host.querySelectorAll("img").length === 0;
const decoded = () => {
  const image = host.querySelector("img");
  return !!image?.complete && image.naturalWidth === 192 && image.naturalHeight === 128;
};

async function run() {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#153e35";
  ctx.fillRect(0, 0, 192, 128);
  ctx.strokeStyle = "#84e4bc";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(55, 64); ctx.lineTo(85, 90); ctx.lineTo(137, 38); ctx.stroke();
  const valid = canvas.toDataURL("image/png").split(",")[1]!;
  const invalid = btoa("not a PNG");

  show(invalid);
  await until(failed, "Invalid PNG should show the decode error with no image");
  completed.push("invalid PNG reports decode error");
  show(invalid);
  assert(failed(), "Rerendering the same failed source must keep its error");
  completed.push("unchanged failed source retains its error");

  show(valid); // same file, no key/remount: only its content/src changes
  await until(decoded, "Updated PNG at the same path should decode instead of retaining the old error");
  assert(!failed(), "Old source's error must not hide a new source");
  await until(() => host.textContent!.includes("192 × 128"), "Recovered image should report decoded dimensions");
  completed.push("same-path updated PNG recovers and reports dimensions");

  show(btoa("another invalid PNG"));
  await until(failed, "A different corrupt source should still report its own error");
  show(valid);
  await until(decoded, "Image should recover after a second failed source");
  completed.push("new decode failures still recover");
  const zoom = host.querySelector("button")!;
  flushSync(() => zoom.click());
  assert(zoom.getAttribute("aria-pressed") === "true", "Actual-size toggle should still work after recovery");
  completed.push("recovered image supports actual-size toggle");
  document.documentElement.dataset.result = "passed";
  result.textContent = `PASS (${completed.length} checks): ${completed.join("; ")}.`;
}
void run().catch((error: unknown) => {
  document.documentElement.dataset.result = "failed";
  result.textContent = `FAIL after ${completed.length} checks: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
