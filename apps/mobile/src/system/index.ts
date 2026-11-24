// What the app runs for the phone's own surfaces outside its screens, once, as the shell first draws: the Live
// Activity and the widget (activity.ts), and the Home Screen quick actions (shortcuts.ts). Each is off where its
// native module isn't built in (Expo Go, the web).
import { startActivity } from "./activity";
import { startShortcuts } from "./shortcuts";

export function startSystem() {
  startActivity();
  startShortcuts();
}
