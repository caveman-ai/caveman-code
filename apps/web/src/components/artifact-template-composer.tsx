import type { CodexArtifactTemplate } from "@caveman-app/shared/codexArtifactTemplates";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

type UseTemplate = (template: CodexArtifactTemplate) => void;
interface ComposerTarget {
  readonly use: UseTemplate;
  readonly register: (handler: UseTemplate) => () => void;
}
const Target = createContext<ComposerTarget | null>(null);

/** One mounted chat column, not a workspace-wide event: even the same chat in two panes stays isolated. */
export function ArtifactTemplateComposerProvider({ children }: { children: ReactNode }) {
  const handler = useRef<UseTemplate | null>(null);
  const target = useMemo<ComposerTarget>(() => ({
    use: (template) => handler.current?.(template),
    register: (next) => {
      handler.current = next;
      return () => { if (handler.current === next) handler.current = null; };
    },
  }), []);
  return <Target.Provider value={target}>{children}</Target.Provider>;
}

/** No target in a passive transcript, including the side panel's nested agents. */
export function useArtifactTemplateComposer(): UseTemplate | undefined {
  return useContext(Target)?.use;
}

export function useArtifactTemplateComposerTarget(handler: UseTemplate): void {
  const target = useContext(Target);
  const stable = useStableCallback(handler);
  // Activity's hidden chats disconnect the target, just as their other interactions do.
  useLayoutEffect(() => target?.register(stable), [target, stable]);
}
