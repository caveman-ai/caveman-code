// The desktop's other places, each its page as a phone shows it, pushed over Home with the pushed bar: Review
// (./pages/Review.tsx) and Automations (./pages/Automations.tsx). None of them has a box; a chat they name opens over
// them, and Back returns. Plugins is the Connect sheet's on a phone, so its link opens that.
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import * as script from "../board/script";
import type { ScreenProps } from "../nav/routes";
import { useInbox } from "../shell/inbox";
import { useMe } from "../shell/me";
import { TopBar } from "../shell/TopBar";
import { openGuide } from "../review/lookup";
import { openConnect } from "../shell/ui";
import { useRows } from "../store/select";
import { AutomationsScreen } from "./pages/Automations";
import { ReviewScreen } from "./pages/Review";
import { queueOf, reviews, waitingOnYou } from "./pages/review-model";

export { AutomationsScreen, ReviewScreen };

export function ReviewRoute({ navigation }: ScreenProps<"Review">) {
  const rows = useRows();
  const chats = useMemo(() => rows.map((r) => r.chat), [rows]);
  const inbox = useInbox(chats, null);
  // Review's verdicts, so the bar's count drops as you answer.
  const sent = reviews.use();
  // The desktop's header count: the pull requests that wait on your review.
  const n = waitingOnYou(queueOf(chats, sent, inbox.now));
  return (
    <ReviewScreen chats={chats} below={0} onBack={() => navigation.goBack()} line={n ? (n === 1 ? "1 waits on you" : `${n} wait on you`) : undefined} onGuide={openGuide} />
  );
}

// Automations wears the list shell: its large title, then Automations | Agents under it. The page is the scripted
// world's: on a board that is the person's own nothing leads to it, and a link or a kept screen that names it goes
// back to where it came from, so nobody signed in is shown automations that are not theirs.
export function AutomationsRoute({ navigation }: ScreenProps<"Automations">) {
  const scripted = useMe().scripted;
  useEffect(() => {
    if (scripted) return;
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace("Home");
  }, [scripted, navigation]);
  if (!scripted) return <View style={{ flex: 1 }} />;
  return (
    <AutomationsScreen below={0} onBack={() => navigation.goBack()} onNotify={(text) => script.notify(text)} />
  );
}

/**
 * Plugins on a phone are the Connect sheet's (DECISIONS.md O8): a link to /plugins opens it on its plugins, over the
 * screen beneath, and leaves no page of its own on the stack.
 */
export function PluginsRoute({ navigation }: ScreenProps<"Plugins">) {
  useEffect(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace("Home");
    // Once the shell has the screen beneath (on a cold launch it mounts after this one); this screen is gone by then.
    setTimeout(() => openConnect("plugins"), 60);
  }, [navigation]);
  return <View style={{ flex: 1 }} />;
}
