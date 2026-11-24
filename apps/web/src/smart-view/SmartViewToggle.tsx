// Smart View's switch, one click from the Chief's chat (its bar), the same setting as Settings > Chief's
// (chief_smart_view, default on). Off, a Chief opens nothing in the sidebar and is told so.
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { Icon, ViewIcon, ViewOffSlashIcon } from "@caveman-app/ui/icons/huge";
import { BarButton } from "../panels/chrome.tsx";
import { useSaveSettings } from "../routes/settings/rows.tsx";
import { useRuntimeSelector } from "../state/runtime.tsx";

export function SmartViewToggle() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const on = settings?.chief_smart_view !== false;
  return (
    <TooltipProvider delayDuration={500}>
      <BarButton
        label={on ? "Smart View is on: the Chief may open what's worth a look beside you. Turn off" : "Smart View is off. Turn on"}
        pressed={on}
        disabled={!settings}
        data-smart-view-toggle=""
        onClick={() => void save({ chief_smart_view: !on })}
      >
        <Icon icon={on ? ViewIcon : ViewOffSlashIcon} />
      </BarButton>
    </TooltipProvider>
  );
}
