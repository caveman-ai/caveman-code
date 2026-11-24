// ), apps/desktop/src/ipc/channels.ts @ ab3a3cd1.
export const RUNTIME_CHANNEL = "caveman:runtime";
/**
 * In the main window's renderer argv (webPreferences.additionalArguments) when the app is packaged and not the smoke
 * test: the page's `cavemanDesktop.packaged`, which keeps the required Cloud sign-in to the person's real app.
 */
export const PACKAGED_ARG = "--caveman-packaged";
/** main -> page: the user pressed ⌘W (or chose File > Close). */
export const CLOSE_REQUEST_CHANNEL = "caveman:close-request";
/** page -> main: nothing in the page took the request; close the window. */
export const CLOSE_WINDOW_CHANNEL = "caveman:close-window";
/** main -> page: the window entered (true) or left (false) full screen. */
export const FULLSCREEN_CHANNEL = "caveman:fullscreen";
/** main -> page: the Mac woke after the lid moved chats to Cloud or stopped them ({moving, paused}, src/lid.ts lidReport). */
export const LID_OUTCOME_CHANNEL = "caveman:lid-outcome";
/** page -> main: Settings > Appearance's theme (system, light or dark), for the window's material. */
export const THEME_CHANNEL = "caveman:theme";
/** page -> main: the page's zoom factor, so a Mac's traffic lights stay centred on its title band (preload.ts). */
export const ZOOM_CHANNEL = "caveman:zoom";
/** page -> main: reveal a project's folder or a chat's worktree in Finder, or open Terminal there (src/folders.ts). */
export const REVEAL_FOLDER_CHANNEL = "caveman:reveal-folder";
export const OPEN_TERMINAL_CHANNEL = "caveman:open-terminal";
/** page -> main (invoke): "Keep this Mac awake while chats work" (src/keepAwake.ts): read it, or set it; both resolve to {keepAwake, holding}. */
export const POWER_GET_CHANNEL = "caveman:power-get";
/** Calls with the Chief: macOS's microphone permission, asked before the first call (systemPreferences). */
export const MIC_STATUS_CHANNEL = "caveman:mic-status";
export const MIC_ASK_CHANNEL = "caveman:mic-ask";
export const MIC_SETTINGS_CHANNEL = "caveman:mic-settings";
export const POWER_SET_CHANNEL = "caveman:power-set";
/** page -> main (invoke): clear the side-panel browser's cookies, storage and cache, once the person confirms; resolves true when cleared. */
export const BROWSER_CLEAR_CHANNEL = "caveman:browser-clear";
/** App-only: create/release a bounded HTML document at the isolated preview origin. */
export const HTML_PREVIEW_CREATE_CHANNEL = "caveman:html-preview-create";
export const HTML_PREVIEW_RELEASE_CHANNEL = "caveman:html-preview-release";
/** page -> main: the app's bound shortcut chords, which a focused side-panel browser page hands back (src/guestKeys.ts). */
export const GUEST_SHORTCUTS_CHANNEL = "caveman:guest-shortcuts";
/** main -> page: one of those chords was pressed in a browser page; replay it here. */
export const GUEST_KEY_CHANNEL = "caveman:guest-key";
/** page -> main: bring the window back and to the front (a notice was clicked while the window was closed). */
export const SHOW_WINDOW_CHANNEL = "caveman:show-window";
/** page -> main: how many sessions posted a notice while the app was away, for the Dock badge; 0 clears it. */
export const BADGE_CHANNEL = "caveman:badge";
/** page -> main (invoke): the native folder dialog for Add project; resolves to a path or null. */
export const PICK_FOLDER_CHANNEL = "caveman:pick-folder";
/** page -> main (invoke): the updater's state (src/updates/DesktopUpdates.ts); `check` checks now. */
export const UPDATES_STATE_CHANNEL = "caveman:updates-state";
export const UPDATES_CHECK_CHANNEL = "caveman:updates-check";
/** page -> main (invoke): Settings > General's update channel, "stable" or "nightly"; resolves to the new state. */
export const UPDATES_SET_CHANNEL_CHANNEL = "caveman:updates-set-channel";
/** page -> main (invoke): the runtime this app uses when it did not start it ({pid, version, appVersion, skew}), or null. */
export const UPDATES_RUNTIME_CHANNEL = "caveman:updates-runtime";
/** page -> main: quit, install the downloaded update and reopen. */
export const UPDATES_INSTALL_CHANNEL = "caveman:updates-install";
/** page -> main (invoke): the `caveman-code` command (src/cli.ts); `install` links it into /usr/local/bin. */
export const CLI_STATUS_CHANNEL = "caveman:cli-status";
export const CLI_INSTALL_CHANNEL = "caveman:cli-install";
/** page -> main: crash and onboarding counts (src/telemetry.ts): read or set the choice, report a step or a page error. */
export const TELEMETRY_CHOICE_CHANNEL = "caveman:telemetry-choice";
export const TELEMETRY_SET_CHANNEL = "caveman:telemetry-set";
export const TELEMETRY_STEP_CHANNEL = "caveman:telemetry-step";
export const TELEMETRY_CRASH_CHANNEL = "caveman:telemetry-crash";
/** page -> main: the one-time notice naming turn stats is on screen (an install that saw the older disclosure). */
export const TELEMETRY_DISCLOSED_CHANNEL = "caveman:telemetry-disclosed";
/** page -> main: whether crash reports are on (src/crashReports.ts), so the page starts its own reporter. */
export const CRASH_REPORTS_CHANNEL = "caveman:crash-reports";
/** page -> main (invoke): the global capture shortcut (src/capture.ts): what is bound, or bind another. */
export const CAPTURE_STATUS_CHANNEL = "caveman:capture-status";
export const CAPTURE_SHORTCUT_CHANNEL = "caveman:capture-shortcut";
/** capture window -> main (invoke): a note for the Chief (chief.capture), mode decide or queue. */
export const CAPTURE_SUBMIT_CHANNEL = "caveman:capture-submit";
/** capture window -> main: Escape hides the window. */
export const CAPTURE_CLOSE_CHANNEL = "caveman:capture-close";
/** main -> capture window: it was just shown; clear the last error and focus the box. */
export const CAPTURE_SHOWN_CHANNEL = "caveman:capture-shown";
/** page -> main (invoke): the image viewer (src/media.ts): PNG bytes to open in the system's viewer or share; resolves to an error message or null. */
export const MEDIA_OPEN_CHANNEL = "caveman:media-open";
export const MEDIA_SHARE_CHANNEL = "caveman:media-share";
/** page -> main (invoke): a web image's bytes the page can't fetch itself (src/media.ts readWebMedia); `{ status, mimeType, data }` or null. */
export const MEDIA_READ_CHANNEL = "caveman:media-read";
/** page -> main (invoke): this app's own device key for driving another Mac (src/deviceKey.ts): its public half and name, or a signature over a device-approval payload. */
export const DEVICE_DESCRIBE_CHANNEL = "caveman:device-describe";
export const DEVICE_SIGN_CHANNEL = "caveman:device-sign";
/** Computer use's guide panel over System Settings (src/computerGuide.ts): the main window asks main to open it. */
export const COMPUTER_GUIDE_OPEN_CHANNEL = "caveman:computer-guide-open";
/** Main → the panel: the step it is on. */
export const COMPUTER_GUIDE_STATE_CHANNEL = "caveman:computer-guide-state";
/** The panel → main: I added it, Not now, Reopen, Open System Settings again. */
export const COMPUTER_GUIDE_ACTION_CHANNEL = "caveman:computer-guide-action";
/** The panel → main: the tile's drag began; main drags Caveman Code.app. */
export const COMPUTER_GUIDE_DRAG_CHANNEL = "caveman:computer-guide-drag";
/**
 * Problem reports (src/bugReport.ts). page -> main (invoke): a PNG of the window as it is now, taken before the report
 * opens over it; and, while the runtime cannot run, prepare a report from this app's own logs and queue it in the
 * runtime's outbox. page -> main: the page closed such a report (the startup recovery window comes back).
 */
export const BUG_REPORT_SCREENSHOT_CHANNEL = "caveman:bug-report-screenshot";
export const BUG_REPORT_PREPARE_CHANNEL = "caveman:bug-report-prepare";
export const BUG_REPORT_QUEUE_CHANNEL = "caveman:bug-report-queue";
export const BUG_REPORT_DONE_CHANNEL = "caveman:bug-report-done";
/**
 * The notch (src/notch.ts): the island at the top of the screen that marks the chats at work and opens when one needs
 * the person. page -> main: what it shows now (apps/web src/notch/model.ts NotchState), or null to put it away.
 */
export const NOTCH_FEED_CHANNEL = "caveman:notch-feed";
/** main -> page: what the person did on the notch (open a chat, press a card's key, hide it). */
export const NOTCH_ACTION_CHANNEL = "caveman:notch-action";
/** The notch -> main: its page listens; send what it shows. */
export const NOTCH_READY_CHANNEL = "caveman:notch-ready";
/** main -> the notch: what it shows, with what the screen's own notch and menu bar measure. */
export const NOTCH_STATE_CHANNEL = "caveman:notch-state";
/** The notch -> main: what the person did on it. */
export const NOTCH_ACT_CHANNEL = "caveman:notch-act";
/** The notch -> main: the pointer is over its shape (true) or off it (false): the rest of its window lets clicks through. */
export const NOTCH_OVER_CHANNEL = "caveman:notch-over";
/** main -> the notch: the pointer left its window without a last move to say so; nothing is under it now. */
export const NOTCH_AWAY_CHANNEL = "caveman:notch-away";
/** The notch -> main: its right-click menu. */
export const NOTCH_MENU_CHANNEL = "caveman:notch-menu";
