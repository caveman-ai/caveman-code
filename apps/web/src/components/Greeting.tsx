import { MascotOnFloor } from "./EmptyState.tsx";

/** The mascot waving over one speech-bubble line: first run, Connect and the Cloud runtime picker. */
export function Greeting({ line }: { line: string }) {
  return (
    <div className="flex flex-col items-center">
      <MascotOnFloor pose="wave" scale={4} />
      <div className="relative mt-4 rounded-lg border border-border bg-card px-4 py-2 text-[14px]">
        <span aria-hidden className="absolute -top-[5px] left-1/2 size-2.5 -translate-x-1/2 rotate-45 border-l border-t border-border bg-card" />
        {line}
      </div>
    </div>
  );
}
