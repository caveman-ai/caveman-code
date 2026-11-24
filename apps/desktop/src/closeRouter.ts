// ⌘W belongs to the page first: the side panel closes its active tab, and
// only when nothing in the page takes it does the window close. Main stops
// the chord before Chromium sees it and sends a close request here.

export type CloseHandler = () => boolean;

export function createCloseRouter(closeWindow: () => void) {
  const handlers: CloseHandler[] = [];
  return {
    /** Newest handler first; one returning true has handled the request. */
    register(handler: CloseHandler): () => void {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    request(): void {
      for (let i = handlers.length - 1; i >= 0; i--) {
        try {
          if (handlers[i]!() === true) return;
        } catch {
          // A broken handler must never trap the window open.
        }
      }
      closeWindow();
    },
  };
}

/** The ⌘W chord (Ctrl+W off macOS), with no other modifier. */
export function isCloseChord(
  input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean },
  platform: NodeJS.Platform,
): boolean {
  const primary = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  return input.type === "keyDown" && primary && !input.alt && !input.shift && input.key.toLowerCase() === "w";
}

/**
 * What closing the main window does. macOS keeps the app and its runtime running with no window; the window only
 * hides, so its page keeps posting notices and badging the Dock, and comes back as it was. Elsewhere closing it quits
 * the app: through the app's quit, which asks first while chats work and keeps the window on Cancel (the hidden
 * capture window would otherwise keep a windowless app running). It closes for real once the app quits (or the
 * updater quits it), and in the smoke test.
 */
export function windowCloseAction(state: { platform: NodeJS.Platform; quitting: boolean; smoke: boolean; fullScreen: boolean }): "close" | "hide" | "leave-full-screen" | "quit" {
  if (state.quitting || state.smoke) return "close";
  if (state.platform !== "darwin") return "quit";
  // Hiding a full-screen window would leave its empty Space behind: leave full screen, then hide.
  return state.fullScreen ? "leave-full-screen" : "hide";
}
