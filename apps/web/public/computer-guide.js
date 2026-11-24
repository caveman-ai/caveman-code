// The guide panel's page (computer-guide.html): draws the state the desktop's main process sends
// (apps/desktop/src/computerGuide.ts) and sends back the person's choices. The tile is a real drag: main starts a
// native drag of Caveman Code.app, which System Settings' list takes. In a browser (no bridge), ?step= shows one state.
(() => {
  const bridge = window.cavemanGuide;
  const $ = (id) => document.getElementById(id);
  const card = $("card");

  const COPY = {
    accessibility: (name) => ({
      title: `Allow ${name}`,
      lead: "Drag <b>Caveman Code</b> into the list, then switch it on.",
      sub: "macOS asks for Touch ID or your password. Agents then use your apps in the background and never move your pointer.",
      pane: name,
    }),
    screen_recording: () => ({
      title: "Allow Screen Recording",
      lead: "Drag <b>Caveman Code</b> into the list, then switch it on.",
      sub: "So you can watch an agent work in the Computer tab, and it can take a screenshot when reading isn't enough.",
      pane: "Screen & System Audio Recording",
    }),
    reopen: () => ({
      title: "Reopen Caveman Code",
      lead: "macOS turns on Screen Recording once Caveman Code reopens.",
      sub: "Agents that are working stop; your chats stay where they are. Until then agents read apps without screenshots.",
    }),
    done: () => ({
      title: "You're set",
      lead: "Agents can use apps on this Mac.",
      sub: "Each app still asks you the first time, and Take over in the Computer tab pauses an agent.",
    }),
  };

  let current = null;
  const render = (state) => {
    current = state;
    const copy = COPY[state.step](state.accessibilityName || "Accessibility");
    card.dataset.step = state.step;
    $("title").textContent = copy.title;
    $("lead").innerHTML = copy.lead;
    $("sub").textContent = copy.sub;
    if (copy.pane) $("pane").textContent = copy.pane;
    const asking = state.step === "accessibility" || state.step === "screen_recording";
    $("count").textContent = state.step === "done" ? "All set" : state.step === "reopen" ? "One more thing" : `Step ${state.index} of ${state.total}`;
    $("pips").innerHTML = Array.from({ length: state.total }, (_, i) => `<i class="${i + 1 < state.index || state.step === "done" || state.step === "reopen" ? "done" : i + 1 === state.index ? "on" : ""}"></i>`).join("");
    $("added").textContent = state.step === "reopen" ? "Reopen now" : state.step === "done" ? "Done" : "I added it";
    $("later").textContent = state.step === "reopen" ? "Later" : "Not now";
    $("later").hidden = state.step === "done";
    $("settings").hidden = !asking;
    $("tile").setAttribute("aria-hidden", asking ? "false" : "true");
  };

  const act = (action) => (bridge ? bridge.action(action) : console.log("guide:", action));
  $("added").addEventListener("click", () => act(current?.step === "reopen" ? "reopen" : current?.step === "done" ? "close" : "added"));
  $("later").addEventListener("click", () => act("close"));
  $("settings").addEventListener("click", () => act("settings"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") act("close");
  });
  // The real drag: main hands System Settings the app bundle itself.
  $("tile").addEventListener("dragstart", (event) => {
    event.preventDefault();
    if (bridge) bridge.drag();
  });

  if (bridge) {
    bridge.onState(render);
  } else {
    const step = new URLSearchParams(location.search).get("step") || "accessibility";
    render({ step, index: step === "screen_recording" ? 2 : 1, total: 2, accessibilityName: new URLSearchParams(location.search).get("name") || "Accessibility" });
  }
})();
