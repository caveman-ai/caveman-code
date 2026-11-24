// The capture window's one behaviour (capture.html): Enter sends the note for
// the Chief to sort, ⌥Enter queues it as is, Shift+Enter is a new line,
// Escape closes. The desktop's capture preload is the only bridge.
const text = document.getElementById("text");
const note = document.getElementById("note");
const bridge = window.cavemanCapture;
const IDLE = "Lands on the Queue at once";
let busy = false;

const say = (words, error = false) => {
  note.textContent = words;
  note.className = error ? "error" : "";
};

text.addEventListener("keydown", async (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") {
    e.preventDefault();
    bridge?.close();
    return;
  }
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  const words = text.value.trim();
  if (!words || busy) return;
  if (!bridge) return say("Open Caveman Code to capture", true);
  busy = true;
  say(e.altKey ? "Queueing…" : "Sending…");
  const result = await bridge.send(words, e.altKey ? "queue" : "decide").catch((err) => ({ error: String(err?.message ?? err) }));
  busy = false;
  if (result?.error) return say(result.error, true);
  text.value = "";
  say(IDLE);
});

bridge?.onShown(() => {
  if (!busy) say(IDLE);
  text.focus();
  text.select();
});
