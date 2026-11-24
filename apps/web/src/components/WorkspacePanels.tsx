// The workspace's Changes, Terminal and Browser tabs moved to the side panel
// (apps/web/src/panels). What's left is the routes' shared message line.

export function PanelMessage({ children }: { children: React.ReactNode }) {
  return <div className="p-4 text-[13px] text-muted-foreground">{children}</div>;
}
