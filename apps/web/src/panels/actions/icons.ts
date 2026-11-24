// An action's glyph (ProjectAction.icon), for the Actions tab and the pane menu's list.
import type { ActionIcon } from "@caveman-app/session-protocol";
import { Bug01Icon, CheckListIcon, FileDiffIcon, FlaskConicalIcon, HammerIcon, PlayIcon, PreferenceHorizontalIcon, type IconSvgElement } from "@caveman-app/ui/icons/huge";

export const ACTION_ICONS: Record<ActionIcon, IconSvgElement> = {
  play: PlayIcon,
  test: FlaskConicalIcon,
  lint: CheckListIcon,
  configure: PreferenceHorizontalIcon,
  build: HammerIcon,
  debug: Bug01Icon,
  diff: FileDiffIcon,
};

/** The icon picker's order. */
export const ICON_ORDER: ReadonlyArray<ActionIcon> = ["play", "test", "lint", "build", "configure", "debug", "diff"];
