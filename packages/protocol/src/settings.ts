// ), packages/contracts/src/settings.ts @ ab3a3cd1.
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  OmittedWhenNull,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { EnvironmentMachineKind, ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { SecretProviderId, SecretProviderKind } from "./secretReference.ts";
import { KeybindingShortcut } from "./keybindings.ts";
import {
  CustomModelSetting,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectScript, type ProjectMutation } from "./project.ts";
import { DEFAULT_RUNTIME_MODE, RuntimeMode } from "./providerPolicy.ts";
import { BrowserProfile, BrowserProfileId, DEFAULT_BROWSER_PROFILE_ID } from "./browserProfile.ts";
import {
  BrowserRecordingFrameRate,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PreviewAppearancePreference,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./preview.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderDriverKind,
} from "./providerInstance.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const DiffLayout = Schema.Literals(["stacked", "split"]);
export type DiffLayout = typeof DiffLayout.Type;
const DEFAULT_DIFF_LAYOUT: DiffLayout = "stacked";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
// Not exported: mobile was the last consumer of the value itself; the
// wire field keeps its decoding default below.
const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;
export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;
export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;

export const MAX_SNOOZE_PRESET_MINUTES = 30 * 24 * 60;
export const MAX_SNOOZE_PRESETS = 8;
export const SnoozePresetDay = Schema.Literals([
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export type SnoozePresetDay = typeof SnoozePresetDay.Type;
/** `after` wakes a fixed time from now. `at` wakes at a local time; a weekday is its next occurrence after today. */
export const SnoozePresetSetting = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("after"),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SNOOZE_PRESET_MINUTES })),
  }),
  Schema.Struct({
    kind: Schema.Literal("at"),
    day: SnoozePresetDay,
    time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  }),
]);
export type SnoozePresetSetting = typeof SnoozePresetSetting.Type;
export const SnoozePresetSettings = Schema.Array(SnoozePresetSetting).check(
  Schema.isMaxLength(MAX_SNOOZE_PRESETS),
);
export const DEFAULT_SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;

export const MIN_APPEARANCE_CONTRAST = 50;
export const MAX_APPEARANCE_CONTRAST = 200;
export const AppearanceContrast = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_APPEARANCE_CONTRAST, maximum: MAX_APPEARANCE_CONTRAST }),
);
export type AppearanceContrast = typeof AppearanceContrast.Type;
const DEFAULT_APPEARANCE_CONTRAST: AppearanceContrast = 100;
export const MIN_PANEL_ANIMATION_DURATION_MS = 0;
export const MAX_PANEL_ANIMATION_DURATION_MS = 400;
export const PanelAnimationDurationMs = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PANEL_ANIMATION_DURATION_MS,
    maximum: MAX_PANEL_ANIMATION_DURATION_MS,
  }),
);
export type PanelAnimationDurationMs = typeof PanelAnimationDurationMs.Type;
const DEFAULT_PANEL_ANIMATION_DURATION_MS: PanelAnimationDurationMs = 0;
/**
 * Font size preferences, in CSS pixels. The ranges are deliberately narrow:
 * the interface size scales every rem-based dimension in the app, so the
 * bounds keep layouts intact rather than offering unusable extremes.
 */
export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 20;
export const InterfaceFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_INTERFACE_FONT_SIZE, maximum: MAX_INTERFACE_FONT_SIZE }),
);
export type InterfaceFontSize = typeof InterfaceFontSize.Type;
export const DEFAULT_INTERFACE_FONT_SIZE: InterfaceFontSize = 16;

export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 20;
export const PromptFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_PROMPT_FONT_SIZE, maximum: MAX_PROMPT_FONT_SIZE }),
);
export type PromptFontSize = typeof PromptFontSize.Type;
export const DEFAULT_PROMPT_FONT_SIZE: PromptFontSize = 14;

export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;
export const CodeFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_CODE_FONT_SIZE, maximum: MAX_CODE_FONT_SIZE }),
);
export type CodeFontSize = typeof CodeFontSize.Type;
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 13;

export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 20;
export const TerminalFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_TERMINAL_FONT_SIZE, maximum: MAX_TERMINAL_FONT_SIZE }),
);
export type TerminalFontSize = typeof TerminalFontSize.Type;
const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

export const EnvironmentIdentificationMode = Schema.Literals(["artwork", "pill", "none"]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;
export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

export const SnapShotKeyChord = KeybindingShortcut.check(
  Schema.makeFilter(
    (shortcut) =>
      shortcut.metaKey ||
      shortcut.ctrlKey ||
      shortcut.shiftKey ||
      shortcut.altKey ||
      shortcut.modKey ||
      "Snapshot shortcut requires a modifier.",
  ),
);
export type SnapShotKeyChord = typeof SnapShotKeyChord.Type;
export const SNAP_SHOT_MODIFIERS = ["shift", "meta", "control", "alt"] as const;
export const SnapShotModifier = Schema.Literals(SNAP_SHOT_MODIFIERS);
export type SnapShotModifier = typeof SnapShotModifier.Type;
export const SnapShotShortcut = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("both-shift-keys") }),
  Schema.Struct({ kind: Schema.Literal("modifier-pair"), modifier: SnapShotModifier }),
  SnapShotKeyChord,
]);
export type SnapShotShortcut = typeof SnapShotShortcut.Type;
export const SnapShotSound = Schema.Literals(["soft-pop", "camera-shutter"]);
export type SnapShotSound = typeof SnapShotSound.Type;
const DEFAULT_SNAP_SHOT_SOUND: SnapShotSound = "soft-pop";

export type SnapShotModifierPairShortcut = Extract<SnapShotShortcut, { readonly kind: string }>;

export function isModifierPairShortcut(
  shortcut: SnapShotShortcut,
): shortcut is SnapShotModifierPairShortcut {
  return "kind" in shortcut;
}

export function snapShotShortcutModifierPair(
  shortcut: SnapShotModifierPairShortcut,
): SnapShotModifier {
  return shortcut.kind === "both-shift-keys" ? "shift" : shortcut.modifier;
}

const APPLE_MODIFIER_LABELS: Record<SnapShotModifier, string> = {
  shift: "Shift",
  meta: "Command",
  control: "Control",
  alt: "Option",
};
const OTHER_MODIFIER_LABELS: Record<SnapShotModifier, string> = {
  shift: "Shift",
  meta: "Super",
  control: "Ctrl",
  alt: "Alt",
};

export function snapShotModifierPairLabel(modifier: SnapShotModifier, apple: boolean): string {
  const label = (apple ? APPLE_MODIFIER_LABELS : OTHER_MODIFIER_LABELS)[modifier];
  return `${label} + ${label}`;
}
const DEFAULT_SNAP_SHOT_SHORTCUT: SnapShotShortcut = {
  kind: "both-shift-keys",
};

export const NotificationMode = Schema.Literals([
  "off",
  "notifications",
  "sound",
  "notifications-and-sound",
]);
export type NotificationMode = typeof NotificationMode.Type;

export const QuitConfirmationMode = Schema.Literals(["direct", "hold", "double-click"]);
export type QuitConfirmationMode = typeof QuitConfirmationMode.Type;
const DEFAULT_QUIT_CONFIRMATION_MODE: QuitConfirmationMode = "hold";

const LegacyConfirmQuit = Schema.Boolean.pipe(
  Schema.decodeTo(
    QuitConfirmationMode,
    SchemaTransformation.transform({
      decode: (confirmQuit): QuitConfirmationMode => (confirmQuit ? "hold" : "direct"),
      encode: (mode) => mode === "hold",
    }),
  ),
);

const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);

/**
 * A user-chosen font family (a single name or a comma-separated list). Empty
 * means "use the app default"; clients compose their own fallback stacks.
 */
export const FontFamilyPreference = Schema.String.check(Schema.isMaxLength(200));
export type FontFamilyPreference = typeof FontFamilyPreference.Type;

/**
 * The environment's theme, set with `t3 theme set <id>`. Each client applies
 * it once per value — live when connected, on its next connect otherwise — so
 * setting it switches every client, while a theme a user picks in Settings
 * afterwards sticks until the next set. Empty means "no environment theme",
 * which is also how it is cleared.
 */
export const DefaultThemePreference = Schema.String.check(Schema.isMaxLength(64));
// Deliberately absent from ServerSettingsPatch: `t3 theme set` checks that an
// id is syntactically valid and actually resolvable, and a generic RPC patch
// would let a client write a theme no client can resolve, bypassing both.
export type DefaultThemePreference = typeof DefaultThemePreference.Type;

/**
 * Defaults for the in-app preview browser, applied whenever a tab is opened
 * without an explicit viewport/zoom/appearance — by the user opening a browser
 * tab, or by an agent calling `preview_open` with no size. Recording quality is
 * client-local for the same reason: the Chromium guest being captured belongs
 * to the desktop app.
 */
export const DEFAULT_BROWSER_VIEWPORT: PreviewViewportSetting = FILL_PREVIEW_VIEWPORT;
export const DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW = true;
export {
  BROWSER_RECORDING_FRAME_RATES,
  BrowserRecordingFrameRate,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
} from "./preview.ts";
/**
 * Where a clicked link goes: the OS default browser, or a tab in the in-app
 * browser beside the thread. "system" is the default because that is what
 * every link did before the setting existed.
 */
export const BrowserLinkTarget = Schema.Literals(["system", "app"]);
export type BrowserLinkTarget = typeof BrowserLinkTarget.Type;
export const DEFAULT_BROWSER_LINK_TARGET: BrowserLinkTarget = "system";

export const LoadBalancingWeights = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

export const DiffColorScheme = Schema.Literals(["red-green", "blue-orange"]);

/** Maximum width of the chat timeline and composer on wide screens. */
export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);
export type ChatWidth = typeof ChatWidth.Type;

/** Preferences shared by clients connected to the same environment. */
export const ModelFavorite = Schema.Struct({
  // The historical field name is retained; default instance ids also decode old provider-kind favorites.
  provider: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export const ModelFavorites = Schema.Array(ModelFavorite);
export const ProviderModelPreferences = Schema.Record(
  ProviderInstanceId,
  Schema.Struct({
    hiddenModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
);
export type ModelPreferences = {
  readonly favorites: typeof ModelFavorites.Type;
  readonly providerModelPreferences: typeof ProviderModelPreferences.Type;
};

export const ClientSettingsSchema = Schema.Struct({
  notificationMode: NotificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  inAppNotificationsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  diffColorScheme: DiffColorScheme.pipe(
    Schema.withDecodingDefault(Effect.succeed("red-green" as const)),
  ),
  chatWidth: ChatWidth.pipe(Schema.withDecodingDefault(Effect.succeed("comfortable" as const))),
  loadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingWeights: LoadBalancingWeights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  appearanceContrast: AppearanceContrast.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_APPEARANCE_CONTRAST)),
  ),
  // Panel motion defaults to zero because width and height transitions cause
  // layout work on every frame, which is noticeable on lower-power clients.
  panelAnimationDurationMs: PanelAnimationDurationMs.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PANEL_ANIMATION_DURATION_MS)),
  ),
  browserDefaultViewport: PreviewViewportSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_VIEWPORT)),
  ),
  browserDefaultZoomFactor: PreviewZoomFactor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_ZOOM_FACTOR)),
  ),
  browserDefaultAppearance: PreviewAppearancePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_APPEARANCE)),
  ),
  browserRecordingFrameRate: BrowserRecordingFrameRate.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_RECORDING_FRAME_RATE)),
  ),
  browserRecordingShowKeyPresses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  browserRecordingShowMousePresses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Where links clicked in a thread (chat markdown, terminal output) open.
   * Only the desktop app has an in-app browser, so other clients ignore "app".
   */
  browserLinkTarget: BrowserLinkTarget.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_LINK_TARGET)),
  ),
  /**
   * Whether an agent using a preview pops the floating mini player into
   * view. Only applies when the agent didn't ask either way — an explicit
   * `open`/`show` on `preview_open` still wins, since that is the agent
   * deliberately showing or hiding its work.
   */
  browserAutoShowFloatingPreview: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW)),
  ),
  /**
   * User-created browser profiles. The built-in Default and Incognito profiles
   * are synthesized by `resolveBrowserProfiles`, not stored here, so they
   * cannot be renamed away or deleted.
   */
  browserProfiles: Schema.Array(BrowserProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Profile new tabs open under. Falls back to Default if it no longer exists. */
  browserDefaultProfileId: BrowserProfileId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_PROFILE_ID)),
  ),
  // Desktop-only. Boolean values from older settings files decode to their
  // equivalent mode and encode back as the canonical string value.
  confirmQuit: QuitConfirmationModeSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_QUIT_CONFIRMATION_MODE)),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadUnpin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffFilesCollapsed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffLayout: DiffLayout.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_DIFF_LAYOUT))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  glassOpacity: GlassOpacity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLASS_OPACITY)),
  ),
  fontSizeInterface: InterfaceFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_INTERFACE_FONT_SIZE)),
  ),
  fontSizePrompt: PromptFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROMPT_FONT_SIZE)),
  ),
  fontSizeCode: CodeFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT_SIZE)),
  ),
  fontSizeTerminal: TerminalFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_SIZE)),
  ),
  fontFamilyCode: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyComposer: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilySans: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyTerminal: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Grayscale `-webkit-font-smoothing: antialiased` (thinner strokes);
  // disabling restores the platform's heavier default. No effect off macOS.
  fontSmoothing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // When the first-run welcome wizard finished (or was skipped), as an ISO
  // timestamp. `null` alone does not mean "show the wizard" — every install
  // that predates this field decodes to `null` — so the gate also requires an
  // empty workspace before it treats the client as a fresh install.
  onboardingCompletedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  persistComposerContextStrip: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  // Legacy client values retained for migration to the connected environment.
  favorites: ModelFavorites.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: ProviderModelPreferences.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  pullRequestMergeMethodOverrides: Schema.Record(
    TrimmedNonEmptyString,
    PullRequestMergeMethod,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Legacy plan mode. The composer's Build/Plan toggle was removed from the
  // default UI; this beta flag restores it (plus the /plan and /default slash
  // commands) for users who still rely on the old workflow.
  planModeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Legacy context window meter. The composer hides it by default; users who
  // still want the old usage indicator can restore it from Settings.
  contextWindowMeterEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Desktop resting composer: scrolling an existing thread's conversation
  // settles the composer into its single-line layout. Losing focus never does.
  composerCollapseOnScroll: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Rich text is the default; users can opt out for literal Markdown editing.
  composerRichTextEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sendShortcut: Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
  followUpBehavior: Schema.Literals(["queue", "steer"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("queue")),
  ),
  proactivePanelsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  showSkillsInSlashMenu: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Legacy sidebar (the original per-project tree). Deliberately a fresh key
  // (was `sidebarV2Enabled` + `sidebarV2ConfiguredByUser`): decoding drops the
  // old keys, so everyone, including prior beta opt-outs, resets to the new
  // default sidebar.
  legacySidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Beta: working and monitoring threads fold into a Working shelf and return
  // to the top of the inbox once they need the user. The inbox then orders by
  // time, so manual placement there is ignored (and kept) while it is on.
  sidebarWorkingShelfEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  snapShotEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snapShotIncludeAccessibility: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  snapShotShortcut: SnapShotShortcut.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNAP_SHOT_SHORTCUT)),
  ),
  snapShotPlaySound: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  snapShotSound: SnapShotSound.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNAP_SHOT_SOUND)),
  ),
  snapShotFlash: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  snapShotAnimations: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

const UsageModelTokenPrice = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

/** USD per million tokens. Omitted cache rates use the input rate. */
export const UsageModelPriceOverride = Schema.Struct({
  inputCostPerMillionTokens: UsageModelTokenPrice,
  outputCostPerMillionTokens: UsageModelTokenPrice,
  cacheReadCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
  cacheWriteCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
});
export type UsageModelPriceOverride = typeof UsageModelPriceOverride.Type;

/** A binary path setting that decodes empty input to the provider's default executable. */
export const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch" | "select";

export interface ProviderSettingsFormOption {
  readonly value: string;
  readonly label: string;
}

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
  /** Choices for a `select` control. The first entry is the default. */
  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

/** Secret fields declared by a settings schema, shared by persistence and client redaction. */
export function secretSettingsFields(schema: {
  readonly fields: Readonly<Record<string, Schema.Top>>;
}): ReadonlyArray<string> {
  return Object.entries(schema.fields).flatMap(([field, fieldSchema]) => {
    return isSecretSetting(fieldSchema) ? [field] : [];
  });
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Store this credential separately and expose only whether it is configured to clients. */
      readonly settingsSecret?: boolean | undefined;
      /** Set by `SettingsSecretValue`: the credential may name a secret provider reference. */
      readonly settingsSecretReference?: boolean | undefined;
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

/** Mark a string or a record of strings as a credential in its settings schema. */
export function secretSetting<S extends Schema.Top>(schema: S): S["Rebuild"] {
  return schema.annotateKey({ settingsSecret: true });
}

/** A masked form field is a credential too, so none is saved or sent to clients as plain text. */
export function isSecretSetting(schema: Schema.Top): boolean {
  const annotations = Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
  return (
    annotations?.settingsSecret === true ||
    annotations?.providerSettingsForm?.control === "password"
  );
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

/** A provider settings struct whose fields the settings form renders in `order`. */
export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    // Caveman Code: Codex runs on an API key in a home the app manages. The
 // user's own Codex login (~/.codex, a compact plan) waits for OpenAI's approval.
    chatGptLogin: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Use my ChatGPT login (waiting for OpenAI's approval)",
        description:
          "Off: Codex runs on an OpenAI API key in a home Caveman Code manages, and ~/.codex is never used. On: Codex uses your own Codex login and CODEX_HOME.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["chatGptLogin", "binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

// Empty, or an integer from 100,000 to 1,000,000. Shared by the full
// Claude settings schema and its patch so an out-of-range value fails at
// the update that introduced it.
const CLAUDE_AUTO_COMPACT_WINDOW_PATTERN = /^(?:|[1-9]\d{5}|1000000)$/;

export const IDLE_COMPACTION_MODES = [
  { value: "onReturn", label: "When you return" },
  { value: "beforeCacheExpires", label: "Before the cache expires (beta)" },
  { value: "off", label: "Never" },
] as const;
export const IdleCompactionMode = Schema.Literals(IDLE_COMPACTION_MODES.map((mode) => mode.value));
export type IdleCompactionMode = typeof IdleCompactionMode.Type;

// `compactIdleThreads` was a beta on/off switch for compacting before the cache expires.
const LegacyCompactIdleThreads = Schema.Boolean.pipe(
  Schema.decodeTo(
    IdleCompactionMode,
    SchemaTransformation.transform({
      decode: (enabled): IdleCompactionMode => (enabled ? "beforeCacheExpires" : "onReturn"),
      encode: (mode) => mode === "beforeCacheExpires",
    }),
  ),
);
const IdleCompactionModeSetting = Schema.Union([IdleCompactionMode, LegacyCompactIdleThreads]);

const INSTANCE_IDLE_COMPACTION_MODES = [
  { value: "default", label: "Use default" },
  ...IDLE_COMPACTION_MODES,
] as const;
const InstanceIdleCompaction = Schema.Literals(
  INSTANCE_IDLE_COMPACTION_MODES.map((mode) => mode.value),
);

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR path",
        description:
          "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    autoCompactWindow: TrimmedString.check(
      Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Auto-compact after",
        description:
          "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.",
        providerSettingsForm: {
          placeholder: "e.g. 300000",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    idleCompaction: InstanceIdleCompaction.pipe(
      Schema.withDecodingDefault(Effect.succeed("default" as const)),
      Schema.annotateKey({
        title: "Compact idle threads",
        description:
          "When to compact an idle thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Overrides the default in General settings.",
        providerSettingsForm: {
          control: "select",
          options: INSTANCE_IDLE_COMPACTION_MODES,
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "autoCompactWindow", "idleCompaction", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

// ), packages/contracts/src/settings.ts @ 13aa882c22.
export const ANTIGRAVITY_AUTH_METHODS = [
  { value: "oauth-personal", label: "Google account" },
  { value: "oauth-business", label: "Gemini Enterprise" },
  { value: "gemini-api-key", label: "Gemini API key" },
  { value: "agent-platform", label: "Agent Platform (Vertex AI)" },
] as const satisfies ReadonlyArray<ProviderSettingsFormOption>;
export const AntigravityAuthMethod = Schema.Literals(
  ANTIGRAVITY_AUTH_METHODS.map((method) => method.value),
);
export type AntigravityAuthMethod = typeof AntigravityAuthMethod.Type;

export const AntigravitySettings = makeProviderSettingsSchema(
  {
    // Off until the user turns it on: its ACP server is a managed download.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    authMethod: AntigravityAuthMethod.pipe(
      Schema.withDecodingDefault(Effect.succeed("oauth-personal" as const)),
      Schema.annotateKey({
        title: "Sign-in method",
        description:
          "Google accounts use your subscription; API keys and Agent Platform bill usage.",
        providerSettingsForm: {
          control: "select",
          options: ANTIGRAVITY_AUTH_METHODS,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiKey: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description: "Gemini or Vertex AI express key. Stored separately on the host.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    gcpProject: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GCP project",
        description:
          "Required for Gemini Enterprise. Agent Platform uses it when no API key is set.",
        providerSettingsForm: { placeholder: "my-project-id", clearWhenEmpty: "omit" },
      }),
    ),
    gcpLocation: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GCP location",
        description: "Region for Gemini Enterprise or Agent Platform.",
        providerSettingsForm: { placeholder: "us-central1", clearWhenEmpty: "omit" },
      }),
    ),
    binaryPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Binary path",
        description: "Custom ACP executable. Leave empty to select automatically.",
        providerSettingsForm: { placeholder: "Automatic", clearWhenEmpty: "persist" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["authMethod", "apiKey", "gcpProject", "gcpLocation", "binaryPath"] },
);
export type AntigravitySettings = typeof AntigravitySettings.Type;

/** A GitHub host name, lowercased on decode so `GitHub.com` and `github.com` are one entry. */
export const GitHubHost = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.toLowerCase()),
);

/**
 * One source control host's saved settings. Each host package declares the fields it reads in
 * its client definition's settings schema and decodes this blob with it; the environment stores
 * it whole, so a host this build does not ship keeps its settings. A field annotated as a secret
 * holds a string, or a string per server host, whose value lives in the server's secret store:
 * settings and clients only see a redaction marker for a saved one.
 */
export const SourceControlHostSettings = Schema.Record(Schema.String, Schema.Unknown);
export type SourceControlHostSettings = typeof SourceControlHostSettings.Type;

// Secret providers. Ports upstream 7a4f5b6188 (#25709) and ee81ea4ce8 (#27044); the slug schemas
// live in secretReference.ts, where 97e35bcf23 (#27115) moved them.

const ONE_PASSWORD_ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Any value `op --account` accepts: shorthand, sign-in address, account ID, or user ID.
 * It is passed to the CLI as an argument, so it can never start with `-`.
 */
export const OnePasswordAccount = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.makeFilter((value: string) =>
    ONE_PASSWORD_ACCOUNT_PATTERN.test(value)
      ? true
      : "1Password account must be a shorthand, sign-in address, or ID with no spaces.",
  ),
).pipe(Schema.brand("OnePasswordAccount"));
export type OnePasswordAccount = typeof OnePasswordAccount.Type;

export const SecretProviderLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * How `op` signs in: through the 1Password app on this computer for `account` (upstream only way),
 * or, Caveman's addition, as a service account whose token the runtime keeps sealed in its
 * secret store, never in settings. Exactly one of the two.
 */
export const OnePasswordSecretProviderConfig = Schema.Struct({
  account: Schema.optionalKey(OnePasswordAccount),
  serviceAccount: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter((config) =>
    (config.serviceAccount === true) !== (config.account !== undefined)
      ? true
      : "Name a 1Password account or use a service account, not both.",
  ),
);
export type OnePasswordSecretProviderConfig = typeof OnePasswordSecretProviderConfig.Type;

/** Kinds decode their own config; unknown-kind envelopes round-trip verbatim across versions. */
export const SecretProviderConfig = Schema.Struct({
  kind: SecretProviderKind,
  label: TrimmedNonEmptyString,
  config: Schema.optionalKey(Schema.Unknown),
});
export type SecretProviderConfig = typeof SecretProviderConfig.Type;

/** Kinds this build can resolve. Their `config` holds no credentials, so clients may read it. */
const SECRET_PROVIDER_KIND_CONFIG_GUARDS: Readonly<Record<string, (config: unknown) => boolean>> = {
  one_password: Schema.is(OnePasswordSecretProviderConfig),
};

export function isKnownSecretProviderKind(kind: string): boolean {
  return Object.hasOwn(SECRET_PROVIDER_KIND_CONFIG_GUARDS, kind);
}

/** Whether `config` is one this build accepts for `kind`; an unknown kind accepts none. */
export function isSecretProviderConfigFor(kind: string, config: unknown): boolean {
  return isKnownSecretProviderKind(kind) && SECRET_PROVIDER_KIND_CONFIG_GUARDS[kind]!(config);
}

// Limits that may change later are enforced on writes only, never on the stored envelope.
// Writes must be a kind this build knows with a config it accepts, so an older server
// rejects a newer kind instead of storing what it cannot check.
export const SecretProviderConfigWrite = Schema.Struct({
  ...SecretProviderConfig.fields,
  label: SecretProviderLabel,
}).check(
  Schema.makeFilter((entry) =>
    !isKnownSecretProviderKind(entry.kind)
      ? `Unsupported secret provider kind: ${entry.kind}.`
      : isSecretProviderConfigFor(entry.kind, entry.config)
        ? true
        : `Invalid ${entry.kind} secret provider config.`,
  ),
);

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpLogsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

const LegacySourceControlWritingStyle = TrimmedString.pipe(
  Schema.decodeTo(
    Schema.toType(SourceControlWritingStyleSettings),
    SchemaTransformation.transform({
      decode: (value): SourceControlWritingStyleSettings => ({
        mode: value.length > 0 ? "custom" : "repo_conventions",
        customInstructions: value,
        followChangeRequestTemplates: true,
      }),
      encode: (value) => value.customInstructions,
    }),
  ),
);

// The struct member comes first so encoding uses its defaulted fields: the server strips
// default sub-fields before writing settings.json, and a toType target would reject them.
const SourceControlWritingStyleSetting = Schema.Union([
  SourceControlWritingStyleSettings,
  LegacySourceControlWritingStyle,
]);

export const BranchNamingMode = Schema.Literals(["static", "semantic", "custom"]);
export type BranchNamingMode = typeof BranchNamingMode.Type;

export interface BranchNamingOptions {
  mode: BranchNamingMode;
  prefix: string;
  instructions: string;
}

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  idleClientTtl: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

/**
 * How assistant text reaches clients while a turn runs.
 * - `turn`: hold the whole message until the turn finishes or pauses.
 * - `live`: deliver the text as it arrives (the engine's own ~50 ms batches); the
 *   client renders the unfinished tail so its markdown never reshapes.
 *
 * upstream `paragraph` (each finished paragraph, at most every 400 ms) is retired: a
 * one-paragraph answer showed only when done. It reads as `live`, so a settings
 * file or client that still says it keeps working (README.md).
 */
const ResponseStreamingModes = Schema.Literals(["turn", "live"]);
export const ResponseStreamingMode = Schema.Literals(["turn", "live", "paragraph"]).pipe(
  Schema.decodeTo(
    ResponseStreamingModes,
    SchemaTransformation.transform({
      decode: (mode) => (mode === "paragraph" ? "live" : mode),
      encode: (mode) => mode,
    }),
  ),
);
export type ResponseStreamingMode = typeof ResponseStreamingMode.Type;

/**
 * Server settings a project may override. Every other server setting is
 * environment-wide: providers, keybindings, observability, device hosts,
 * background activity, theme. UI, search and the write planner derive
 * eligibility from this list, so adding a key here is the whole opt-in.
 */
const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
const SettledWorktreeRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
);

export const WorktreeKeepWhen = Schema.Literals([
  "any-local-files",
  "uncommitted-changes",
  "tracked-changes",
]);
export type WorktreeKeepWhen = typeof WorktreeKeepWhen.Type;

export const WorktreeCleanupRules = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays,
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean,
  worktreeOnDelete: Schema.Boolean,
  worktreeUnchanged: Schema.Boolean,
});
export type WorktreeCleanupRules = typeof WorktreeCleanupRules.Type;

export const WorktreeCleanup = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ mode: Schema.Literal("off") }),
    Schema.Struct({ mode: Schema.Literal("custom"), rules: WorktreeCleanupRules }),
  ]),
);
export type WorktreeCleanup = typeof WorktreeCleanup.Type;

export const PROJECT_SCOPED_SERVER_SETTING_KEYS = [
  "worktreeCleanup",
  "defaultModelSelection",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "defaultAutoPull",
  "defaultProjectScripts",
  "enableAgentBrowserAccess",
  "enableAgentDeviceAccess",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "sourceControlWritingStyle",
  "removeAgentCreditsOnMerge",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "pullRequestMergeMethod",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleKeepPullRequests",
  "continueThreadsAfterServerUpdate",
  "responseStreamingMode",
] as const;
export type ProjectScopedServerSettingKey = (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number];

export const ProjectProviderInstanceOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type ProjectProviderInstanceOverride = typeof ProjectProviderInstanceOverride.Type;

/**
 * One project's overrides. An absent key inherits the environment value;
 * `null` is a real value where the environment type is nullable (no default
 * model, no dedicated writer model, never auto-settle).
 *
 * `providerInstances` sits outside `PROJECT_SCOPED_SERVER_SETTING_KEYS`:
 * every other key replaces its `ServerSettings` field whole, while this one
 * keeps the settings.json shape but overrides field by field, per
 * `ProviderInstanceId`. Only `enabled` is overridable today. An instance id
 * or field absent here inherits the machine value, and a present `enabled`
 * wins in either direction, so a project can turn on an instance the machine
 * disabled, or turn off one the machine enabled. See
 * `resolveProjectProviderInstanceEnabled` for the combined resolution.
 */
export const ProjectSettingsOverrides = Schema.Struct({
  worktreeCleanup: Schema.optionalKey(WorktreeCleanup),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: ForwardCompatibleOptional(WorktreeSubmodules),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  textGenerationModelSelection: Schema.optionalKey(ModelSelection),
  threadTitleInstructions: Schema.optionalKey(TrimmedString),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSetting),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  providerInstances: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ProjectProviderInstanceOverride),
  ),
} satisfies Record<ProjectScopedServerSettingKey | "providerInstances", unknown>);
export type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;

/**
 * A project override entry that also keeps keys this build does not know,
 * so a whole-entry write from an older or newer client round-trips them. The
 * type stays closed to catch misspellings.
 */
export const keepUnknownOverrideKeys = <Entry extends Schema.Struct<Schema.Struct.Fields>>(
  entry: Entry,
): Schema.Codec<
  Entry["Type"],
  Entry["Encoded"],
  Entry["DecodingServices"],
  Entry["EncodingServices"]
> => Schema.StructWithRest(entry, [Schema.Record(Schema.String, Schema.Unknown)]);

/**
 * Whether `null` is a stored override value for this key rather than "unset".
 * Clients writing a project override treat null for every other key as a
 * request to remove the override, so a picker's "Inherit" item and the row's
 * reset do the same thing.
 */
export function isNullableProjectSettingsOverride(key: ProjectScopedServerSettingKey): boolean {
  return NULLABLE_PROJECT_SETTINGS_OVERRIDES.has(key);
}
const NULLABLE_PROJECT_SETTINGS_OVERRIDES: ReadonlySet<ProjectScopedServerSettingKey> = new Set<
  {
    [K in ProjectScopedServerSettingKey]: null extends ProjectSettingsOverrides[K] ? K : never;
  }[ProjectScopedServerSettingKey]
>([
  "defaultModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "pullRequestMergeMethod",
  "sidebarAutoSettleAfterDays",
]);

export const StorageCleanupReportEntry = Schema.Struct({
  kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
  outcome: Schema.Literals(["removed", "kept", "failed"]),
  reason: Schema.String,
  path: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  files: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupReportEntry = typeof StorageCleanupReportEntry.Type;
export const StorageCleanupReport = Schema.Struct({
  trigger: Schema.Literals(["automatic", "manual"]),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  entries: Schema.Array(StorageCleanupReportEntry),
  counts: Schema.Struct({ removed: Schema.Number, kept: Schema.Number, failed: Schema.Number }),
  omittedCount: Schema.Number,
  bytesFreed: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type StorageCleanupReport = typeof StorageCleanupReport.Type;

/**
 * delegate_task's limits and default child model (Settings > Subagents; the Session Protocol's
 * subagent_* settings). Enforced by the runtime, never by the prompt.
 */
const SubagentMaxDepth = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }));
const SubagentMaxConcurrent = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }));
const SubagentTreeTokenCeiling = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SubagentDefaultModel = Schema.Literals(["auto", "auto-by-role", "inherit"]);
const SubagentRoleKeys = ["implementation", "research", "review", "design", "test", "general"] as const;
/** The task classifier's kinds (the Session Protocol's TaskKind). */
const SubagentTaskKeys = ["frontend_ui", "backend_fix", "general_coding", "large_refactor", "plan_design", "explore_readonly", "terminal_ops", "trivial_chat"] as const;
/**
 * A role's or task kind's pinned harness account, model and effort (Settings > Subagents); null is a cleared pin
 * (deepMerge keeps keys). `always`: it outranks the lead's own pick too.
 */
export const SubagentRolePin = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  effort: Schema.optionalKey(TrimmedNonEmptyString),
  always: Schema.optionalKey(Schema.Boolean),
});
export type SubagentRolePin = typeof SubagentRolePin.Type;
const SubagentRolePins = Schema.Struct(
  Object.fromEntries(SubagentRoleKeys.map((role) => [role, Schema.optionalKey(Schema.NullOr(SubagentRolePin))])) as {
    readonly [R in (typeof SubagentRoleKeys)[number]]: Schema.optionalKey<Schema.NullOr<typeof SubagentRolePin>>;
  },
);
const SubagentTaskPins = Schema.Struct(
  Object.fromEntries(SubagentTaskKeys.map((kind) => [kind, Schema.optionalKey(Schema.NullOr(SubagentRolePin))])) as {
    readonly [K in (typeof SubagentTaskKeys)[number]]: Schema.optionalKey<Schema.NullOr<typeof SubagentRolePin>>;
  },
);
export const SubagentSettings = Schema.Struct({
  /** How deep delegated agents nest: 2 lets a lead's builder delegate once more. */
  maxDepth: SubagentMaxDepth.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  /** Delegated agents working at once under one root thread. */
  maxConcurrent: SubagentMaxConcurrent.pipe(Schema.withDecodingDefault(Effect.succeed(8))),
  /** Uncached input plus output tokens every delegated agent under one root thread may use together; 0 is no ceiling. */
  treeTokenCeiling: SubagentTreeTokenCeiling.pipe(Schema.withDecodingDefault(Effect.succeed(5_000_000))),
  /**
   * auto: Caveman Cloud picks from connected harnesses; without an answer, inherit the lead's selection.
   * inherit and legacy auto-by-role: use the person's role pin or agent type model, else inherit the lead.
   */
  defaultModel: SubagentDefaultModel.pipe(Schema.withDecodingDefault(Effect.succeed("auto" as const))),
  /** Per role the lead names: the runner a person pinned; outranks a task kind's pin and Auto, the lead's own pick outranks it unless `always`. */
  rolePins: SubagentRolePins.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Per task kind the classifier reads a brief as, when the lead names no role (or general): below a role's pin, above general's. */
  taskPins: SubagentTaskPins.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type SubagentSettings = typeof SubagentSettings.Type;

export const StorageCleanupSettings = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeOnDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeUnchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  browserArtifactsAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  logsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;

/** An environment variable name. */
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EnvVarName = Schema.String.check(Schema.isPattern(ENV_VAR_NAME));
/**
 * An HTTP header name (RFC 9110's token), as Claude Code and Codex take them: `Authorization`, `X-Api-Key`, and
 * `CONTEXT7_API_KEY` too. Letters, digits and `-` only was too narrow: one such header in ~/.claude.json failed a whole import.
 */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/**
 * Before marketplaces: a git repo of plugins at a pinned commit. Read only to
 * migrate it (into `marketplaces` and `installed`) the first time the runtime
 * can check it out; never written.
 */
export const PluginSpace = Schema.Struct({
  /** A git URL (https, ssh) or a local repository path. */
  url: TrimmedNonEmptyString,
  /** The full 40-character commit the space is pinned to. */
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  /** The branch, tag or commit it was added at; an update follows it. Absent: HEAD. */
  ref: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Names (never values) of the credentials granted to this space. Recorded on
   * grant and cleared on revoke so removing the space revokes every grant even
   * when its checkout failed and no plugin is loaded to declare the names.
   * Optional: spaces written before this field existed simply have no record.
   */
  granted: Schema.optionalKey(Schema.Array(EnvVarName)),
});
export type PluginSpace = typeof PluginSpace.Type;

/**
 * A personal MCP server, outside any space: added by hand, imported from
 * Claude Code or Codex, or a connector. Commands and URLs only: credentials
 * are names here and values in the broker (credential.grant to the
 * `personal` space), or runtime-held OAuth tokens.
 */
export const PluginServer = Schema.Struct({
  /** Its MCP server name; tools show as `mcp__<name>__<tool>`. */
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/)),
  command: Schema.optionalKey(TrimmedNonEmptyString),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A streamable HTTP endpoint (no SSE). Exactly one of command and url. */
  url: Schema.optionalKey(TrimmedNonEmptyString),
  /** Environment variables a command needs; each is a credential the user grants. */
  env: Schema.optionalKey(Schema.Array(EnvVarName)),
  /** Header names a URL needs; each is a credential `<NAME>_<HEADER>` the user grants. */
  headers: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isPattern(HEADER_NAME)))),
  /** `oauth`: the runtime signs in and holds the tokens; `github`: the runtime's GitHub login. Reached through the runtime's MCP hub only. */
  auth: Schema.optionalKey(Schema.Literals(["oauth", "github"])),
  source: Schema.Literals(["manual", "claude", "codex", "cursor", "connector"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("manual" as const)),
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * The person said yes to its granted credentials reaching this server on
   * Caveman Cloud computers (cloud.server.set_available): the values go to
   * Cloud's vault and only this server's process there gets them. Absent: no.
   */
  cloudConsent: Schema.optionalKey(Schema.Boolean),
});
export type PluginServer = typeof PluginServer.Type;

const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
/** A marketplace's name: the part after `@` in its plugins' ids. */
const MarketplaceName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));

/** A marketplace you added: a git repository pinned to a commit, or a folder read in place. */
export const PluginMarketplace = Schema.Struct({
  name: MarketplaceName,
  source: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("git"),
      /** A git URL (https, ssh) or a local repository path. */
      url: TrimmedNonEmptyString,
      /** The branch, tag or commit it was added at; Update follows it. Absent: HEAD. */
      ref: Schema.optionalKey(TrimmedNonEmptyString),
      commit: Commit,
    }),
    Schema.Struct({ kind: Schema.Literal("folder"), path: TrimmedNonEmptyString }),
  ]),
  added_at: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Names (never values) of the credentials granted to its plugins, so removing it revokes them all. */
  granted: Schema.optionalKey(Schema.Array(EnvVarName)),
});
export type PluginMarketplace = typeof PluginMarketplace.Type;

/** A plugin installed for me (`name@marketplace`). */
export const PluginInstall = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: Schema.optionalKey(Schema.String),
  /** An entry fetched from elsewhere: its repository and folder, and the commit it was pinned to at install. */
  source: Schema.optionalKey(Schema.Struct({ url: TrimmedNonEmptyString, path: Schema.optionalKey(Schema.String) })),
  commit: Schema.optionalKey(Commit),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** A Cloud computer's copy of one of This Mac's installs (profile sync): the next pull replaces it. Absent: installed here. */
  profile: Schema.optionalKey(Schema.Boolean),
});
export type PluginInstall = typeof PluginInstall.Type;

/** A project kept on this computer (signed out of Caveman Cloud): its repositories share its plugins. */
export const PluginProject = Schema.Struct({
  /** The project.list id. */
  id: TrimmedNonEmptyString,
  /** Repository keys (`host/owner/name`) besides the project's own. */
  repos: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  installed: Schema.Array(
    Schema.Struct({
      ...PluginInstall.fields,
      policy: Schema.Literals(["available", "default", "required"]).pipe(Schema.withDecodingDefault(Effect.succeed("default" as const))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type PluginProject = typeof PluginProject.Type;

/** What one repository says about one thing (a plugin id, a server name): on there, or off there. */
const RepoSwitch = <S extends Schema.Top>(id: S) => Schema.Struct({ repository: TrimmedNonEmptyString, id, enabled: Schema.Boolean });

/** Marketplaces and installed plugins. Defaults: none added, nothing installed (the Caveman catalog ships with the app). */
export const PluginSettings = Schema.Struct({
  marketplaces: Schema.Array(PluginMarketplace).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  installed: Schema.Array(PluginInstall).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  projects: Schema.Array(PluginProject).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Before marketplaces (`PluginSpace`); emptied as each is migrated. */
  spaces: Schema.Array(PluginSpace).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Plugin ids (`name@marketplace`) I turned off: a project's or team's default, or one I installed. */
  disabled: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * Extra environment variable names plugin hooks and MCP servers may see.
   * Everything else in the runtime's environment is withheld; credentials
   * come from the credential broker, never from here.
   */
  envAllowlist: Schema.Array(EnvVarName).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Personal MCP servers (`PluginServer`), names unique. */
  servers: Schema.Array(PluginServer).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Plugins whose hooks run, each `<id>#<digest>`: the digest of the plugin's
   * files and where they come from when it was trusted. A plugin whose files
   * no longer match (or an entry without a digest) is not trusted. Every
   * other plugin's hooks are left out of every engine.
   */
  trusted: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Plugins a repository suggests that the person turned on there: the repository's key (`host/owner/name`, or its folder) and the plugin id. */
  repoEnabled: Schema.Array(Schema.Struct({ repository: TrimmedNonEmptyString, id: TrimmedNonEmptyString })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * One project's own switch for an installed plugin, over the everywhere one (`disabled`): the repository's key
   * (as in repoEnabled) and the plugin id. Kept only while it differs from everywhere when set.
   */
  repoSwitches: Schema.Array(RepoSwitch(TrimmedNonEmptyString)).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** The same for a personal MCP server (`servers`), by its name. */
  repoServerSwitches: Schema.Array(RepoSwitch(TrimmedNonEmptyString)).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type PluginSettings = typeof PluginSettings.Type;

/** Review guide thresholds (`reviewGuide*` below): each one's range, shared by the settings and their patch. */
const ReviewGuideShortLines = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2000 }));
const ReviewGuideSinglePassKb = Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 512 }));
const ReviewGuidePrewarmDaily = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }));
const ReviewGuidePrewarmPlanPercent = Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 100 }));
const ReviewGuidePrewarmIdleMinutes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60 }));

export const ServerSettings = Schema.Struct({
  // Null means no client has migrated this preference yet; an empty value is
  // authoritative so another device cannot resurrect cleared preferences.
  favorites: Schema.NullOr(ModelFavorites).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  providerModelPreferences: Schema.NullOr(ProviderModelPreferences).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeCleanup: WorktreeCleanup.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  storageCleanup: StorageCleanupSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(StorageCleanupSettings)({}))),
  ),
  /**
   * Absolute directory new worktrees are created under, e.g. `D:\worktrees`
   * or `~/worktrees`. Empty uses `<T3 home>/worktrees`.
   */
  worktreesDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Custom locations used before the current one. Server-maintained so
   * worktrees left there stay eligible for cleanup and review diffs.
   */
  previousWorktreesDirectories: Schema.Array(TrimmedString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  responseStreamingMode: ResponseStreamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("live" as const)),
  ),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * After a completed Caveman engine, Claude Agent or Codex turn, the engine predicts the person's next message; the empty
 * composer shows it and Tab takes it (upstream #28047). Codex follows a change at once; an open Claude
   * Agent chat once its engine restarts. Off by default: each guess is one more request carrying the whole chat, after
   * every turn (on ADEMark's read-only prompt, a third of what Claude Agent sent).
   */
  promptSuggestionsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  subagents: SubagentSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Retain the update-era key. On by default so restarts resume the work they
  // interrupted; recovery stops after three automatic continuations in a row.
  continueThreadsAfterServerUpdate: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * Whether agents may drive the in-app preview browser. Turning this off
   * withholds the MCP credential, so the `caveman-code` server (and with it every
   * `preview_*` tool) is never attached to a provider session, and the prompt
   * text describing those tools is dropped along with them. The user's own
   * browser panel is unaffected — this gates agent access only.
   *
   * Server-authoritative rather than client-local: tool injection and prompt
   * construction both happen on the server, and the answer must not differ
   * between a desktop window and a phone attached to the same server.
   */
  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  projectAgentBrowserAccessOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  defaultAutoPull: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultProjectScripts: Schema.Array(ProjectScript).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  projectScriptOverrides: Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  projectAutoPullOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  defaultRuntimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE)),
  ),
  /**
   * Per-project overrides of the keys in `PROJECT_SCOPED_SERVER_SETTING_KEYS`,
   * plus `providerInstances`. The source of truth for project
   * settings; `projectAgentBrowserAccessOverrides`, `projectAutoPullOverrides`
   * and `projectScriptOverrides` are derived views kept for one release so
   * older clients keep reading them.
   */
  projectSettingsOverrides: Schema.Record(
    ProjectId,
    keepUnknownOverrideKeys(ProjectSettingsOverrides),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Whether the legacy per-project fields have been folded into
   * `projectSettingsOverrides`. The fold runs once so a later reset in the
   * settings UI is not undone by the next server start.
   */
  projectSettingsFolded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Whether agents may drive simulators and emulators. Gates the `device_*`
   * MCP tools and the preconfigured `agent-device` CLI the same way
   * `enableAgentBrowserAccess` gates the browser: server-authoritative, applied
   * when the provider session is prepared. The user's own Device panel is
   * unaffected.
   */
  enableAgentDeviceAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarAutoSettleAfterDays: Schema.NullOr(SidebarAutoSettleAfterDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)),
  ),
  compactIdleThreads: IdleCompactionModeSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed("onReturn" as const)),
  ),
  snoozeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoResumeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snoozePresets: SnoozePresetSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNOOZE_PRESETS)),
  ),
  sidebarAutoSettleKeepPullRequests: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarAutoSettleOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,
  // Legacy flat fields retained for old settings files and old clients. New
  // consumers should resolve `backgroundActivity` instead.
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  defaultTheme: DefaultThemePreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * When the environment's theme was last set, so clients can tell a re-set
   * of the same value from one they already applied: `t3 theme set` must act
   * even when it names the theme it named before. Empty on environments
   * provisioned by builds that predate it, where clients fall back to
   * applying once per value.
   */
  defaultThemeSetAt: Schema.String.check(Schema.isMaxLength(64)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  /**
   * The icon clients draw for this environment. Null means "use what the
   * server detected" (`environment.platform.machine`), falling back to a
   * generic server. Lives on the server, not the client, so every device
   * sees the same machine. A kind picked on a newer server decodes as null
   * here rather than failing the whole settings snapshot for an older client.
   */
  environmentIcon: ForwardCompatibleNullable(EnvironmentMachineKind).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Null means inherit: the repository's t3.json, then "local". The old
   * default "local" was never persisted (defaults are stripped on write), so
   * it now decodes as inherit, which resolves the same way because the old
   * chain also let t3.json outrank the environment. Null stays off the wire
   * so older clients, which require a literal here, keep decoding.
   */
  defaultThreadEnvMode: OmittedWhenNull(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * Null defers to the repository's t3.json, then to recursive. A value
   * picked on a newer server decodes as null here rather than failing the
   * whole settings snapshot for an older client.
   */
  worktreeSubmodules: ForwardCompatibleNullable(WorktreeSubmodules).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
        options: [
          {
            id: "reasoningEffort",
            value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          },
        ],
      }),
    ),
  ),
  threadTitleInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  branchNamingMode: BranchNamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("static" as const)),
  ),
  branchNamePrefix: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("t3"))),
  branchNameInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  removeAgentCreditsOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sourceControlWritingStyle: SourceControlWritingStyleSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Review guides on this server. Off hides the Guide tab in every client and refuses to write
   * guides, for people and agents alike. On by default: Caveman Code's Review page writes them.
   */
  reviewGuidesEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Write guides before anyone opens the pull request: one that asks for your review, or is yours,
   * gets its guide when it first shows up and your subscription is idle. On by default.
   */
  reviewGuidePrewarm: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * The model that reads a pull request to write its review guide. It investigates a checkout
   * over many turns, so it can want a stronger model than one-shot writing. `null` uses the
   * source control writer model.
   */
  reviewGuideModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * The maintainer's taste for review guides: what to dwell on, skip, or order first. Shapes the
   * guide's emphasis only; the output format and coverage rules stay fixed.
   */
  reviewGuideInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * A change of at most this many changed lines of code and tests (lockfiles, generated and
   * vendored files not counted) gets a TL;DR guide: one call, no tour. 0 always writes the tour.
   */
  reviewGuideShortLines: ReviewGuideShortLines.pipe(Schema.withDecodingDefault(Effect.succeed(30))),
  /**
   * The chat that opened a pull request writes its TL;DR as it links it (link_pull_request
   * `tldr`), on the context its model already holds: a short change then needs no other run.
   */
  reviewGuideChatTldr: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Post the guide as one comment on a pull request a chat here opens, kept current as it is rewritten, so its
   * reviewers read it on the host without Caveman Code. A guide posted by hand stays current too. On by default.
   */
  reviewGuidePost: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * A person's guide whose checkout run misses the quality check is written once more on the
   * same harness's next model up. Off keeps the first guide. Never for a prewarm.
   */
  reviewGuideStepUp: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** The largest diff of code and tests, in KB, a guide reads in one call; a larger one reads a checkout. */
  reviewGuideSinglePassKb: ReviewGuideSinglePassKb.pipe(Schema.withDecodingDefault(Effect.succeed(48))),
  /** Guides a model writes ahead in a day, at most; 0 prewarms templates only. */
  reviewGuidePrewarmDaily: ReviewGuidePrewarmDaily.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  /** A prewarm runs a model only while the writer's fullest plan window is under this percent. */
  reviewGuidePrewarmPlanPercent: ReviewGuidePrewarmPlanPercent.pipe(
    Schema.withDecodingDefault(Effect.succeed(70)),
  ),
  /** A prewarm runs a model only after this many minutes with no turn on the writer's engine. */
  reviewGuidePrewarmIdleMinutes: ReviewGuidePrewarmIdleMinutes.pipe(
    Schema.withDecodingDefault(Effect.succeed(2)),
  ),
  /**
   * The merge method pull requests start with; `null` reuses the method
   * last chosen on this device. Server-side so a project can override it
   * like any other project setting.
   */
  pullRequestMergeMethod: Schema.NullOr(PullRequestMergeMethod).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
 /** Cursor usage limits may read native own login from the macOS Keychain (opt-in, upstream setting). */
  cursorKeychainUsageEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Keyed by source control host kind, such as `gitcafe`; see `SourceControlHostSettings`. */
  sourceControlHosts: Schema.Record(Schema.String, SourceControlHostSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Secret managers credential settings may point at (`SecretReference`), keyed by a slug of
   * their name. Never a secret: a service account's token lives in the secret store.
   */
  secretProviders: Schema.Record(SecretProviderId, SecretProviderConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Exact model IDs, applied to past and future usage on this environment. */
  usagePriceOverrides: Schema.Record(TrimmedNonEmptyString, UsageModelPriceOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Exact model ID to the model its usage counts as, such as a preview slug to
   * its released name. The mapped model is priced and reported as its target.
   */
  usageModelAliases: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  plugins: PluginSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(PluginSettings)({}))),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

/**
 * Read the legacy `enabled` flag embedded in a provider instance config
 * blob. The envelope-level `ProviderInstanceConfig.enabled` is the single
 * flag going forward; this reader exists for old settings files that still
 * carry the flag in-config.
 */
export const providerInstanceConfigEnabledFlag = (config: unknown): boolean | undefined => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/**
 * Built-in drivers that stay off until the user turns them on. Matches the
 * `enabled` decoding default of each driver's settings schema.
 */
const DEFAULT_DISABLED_PROVIDER_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "muse", "pi", "opencode", "antigravity"].map((driver) =>
    ProviderDriverKind.make(driver),
  ),
);

/** Built-in drivers whose default instance runs before the user configures it. */
const DEFAULT_ENABLED_DEFAULT_INSTANCES: ReadonlySet<ProviderInstanceId> = new Set(
  ["codex", "claudeAgent", "caveman"].map((instanceId) => ProviderInstanceId.make(instanceId)),
);

/**
 * Whether the built-in default instance at `instanceId` is enabled while
 * settings have no `providerInstances` entry for it. Codex, Claude Agent and
 * the Caveman engine start on (so delegate_task can target any of them); any
 * other id without an entry has no running instance.
 */
export const isUnconfiguredDefaultInstanceEnabled = (instanceId: ProviderInstanceId): boolean =>
  DEFAULT_ENABLED_DEFAULT_INSTANCES.has(instanceId);

/**
 * Default enabled state for a driver when neither the envelope nor the config
 * blob carries a flag. Unknown (fork) drivers default to enabled.
 */
const defaultEnabledForDriver = (driver: ProviderDriverKind): boolean =>
  !DEFAULT_DISABLED_PROVIDER_DRIVERS.has(driver);

/**
 * Resolve whether a configured provider instance is enabled. An explicit
 * false on either the envelope or the in-config flag wins (most
 * restrictive), so a user's disable is never silently undone by the other
 * flag. Otherwise: envelope, then config, then the driver's default.
 */
export const resolveProviderInstanceEnabled = (
  instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean => {
  const configEnabled = providerInstanceConfigEnabledFlag(instance.config);
  if (instance.enabled === false || configEnabled === false) {
    return false;
  }
  return instance.enabled ?? configEnabled ?? defaultEnabledForDriver(instance.driver);
};

/**
 * Effective enablement for a provider instance within a project: the
 * project's `providerInstances[id].enabled` override when set, otherwise the
 * machine-wide `resolveProviderInstanceEnabled` value. `projectId` of `null`
 * (no project in scope) always resolves to the machine-wide value.
 */
export const resolveProjectProviderInstanceEnabled = (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): boolean => {
  const override =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled;
  if (override !== undefined) return override;
  const instanceConfig = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  return instanceConfig !== undefined
    ? resolveProviderInstanceEnabled(instanceConfig)
    : isUnconfiguredDefaultInstanceEnabled(instanceId);
};

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export const resolveIdleCompaction = (
  settings: Pick<ServerSettings, "providerInstances" | "compactIdleThreads">,
  instanceId: ProviderInstanceId,
): IdleCompactionMode => {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  const override = decodeClaudeSettings(instance?.config ?? {}).pipe(
    Option.map((config) => config.idleCompaction),
    Option.getOrElse(() => "default" as const),
  );
  return override === "default" ? settings.compactIdleThreads : override;
};

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "create-provider-instance",
  "read-file",
  "read-provider-history",
  "read-project-settings",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-secret-provider",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedError<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    // Validation failures (e.g. a create colliding with an existing
    // instance) originate without an upstream defect.
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = Omit<ServerSettings, keyof ModelPreferences> & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const ServerSettingsPatch = Schema.Struct({
  setModelFavorites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, favorite: Schema.Boolean })),
  ),
  setModelsHidden: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, hidden: Schema.Boolean })),
  ),
  setProviderModelOrder: Schema.optionalKey(
    Schema.Struct({ provider: ProviderInstanceId, modelOrder: Schema.Array(TrimmedString) }),
  ),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  // Applied under the settings service's write lock, only while still unset.
  migrateModelPreferences: Schema.optionalKey(
    Schema.Struct({
      favorites: Schema.optionalKey(ModelFavorites),
      providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
    }),
  ),
  worktreeCleanup: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({ mode: Schema.Literal("off") }),
        Schema.Struct({
          mode: Schema.Literal("custom"),
          rules: Schema.Struct({
            worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
            worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
            worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
            worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
            worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
            worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
          }),
        }),
      ]),
    ),
  ),
  subagents: Schema.optionalKey(
    Schema.Struct({
      maxDepth: Schema.optionalKey(SubagentMaxDepth),
      maxConcurrent: Schema.optionalKey(SubagentMaxConcurrent),
      treeTokenCeiling: Schema.optionalKey(SubagentTreeTokenCeiling),
      defaultModel: Schema.optionalKey(SubagentDefaultModel),
      rolePins: Schema.optionalKey(SubagentRolePins),
      taskPins: Schema.optionalKey(SubagentTaskPins),
    }),
  ),
  storageCleanup: Schema.optionalKey(
    Schema.Struct({
      worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
      worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
      worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
      worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
      worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
      worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
      browserArtifactsAfterDays: Schema.optionalKey(StorageRetentionDays),
      logsAfterDays: Schema.optionalKey(StorageRetentionDays),
    }),
  ),
  worktreesDirectory: Schema.optionalKey(TrimmedString),
  // Server settings
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  promptSuggestionsEnabled: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  projectAgentBrowserAccessOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  projectScriptOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))),
  ),
  projectAutoPullOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  /**
   * Per-project entry replacement: each entry replaces that project's whole
   * override set and `null` removes it. Clearing one override means resending
   * the entry without that key. Per-key null cannot express "clear" for the
   * keys whose value type is itself nullable, and clients always hold the
   * current entry from the last settings snapshot.
   *
   * `providerInstances` is the one exception: an entry that omits the key
   * keeps the stored value instead of clearing it, so a client built before
   * that field existed cannot wipe it by editing another key. Clearing every
   * provider override for a project means sending `providerInstances: {}`.
   */
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(
      ProjectId,
      Schema.NullOr(
        keepUnknownOverrideKeys(
          Schema.Struct({
            ...ProjectSettingsOverrides.fields,
            sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSettings),
          }),
        ),
      ),
    ),
  ),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  compactIdleThreads: Schema.optionalKey(IdleCompactionMode),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  autoResumeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozePresets: Schema.optionalKey(SnoozePresetSettings),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  environmentIcon: Schema.optionalKey(Schema.NullOr(EnvironmentMachineKind)),
  defaultThreadEnvMode: Schema.optionalKey(Schema.NullOr(ThreadEnvMode)),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: Schema.optionalKey(Schema.NullOr(WorktreeSubmodules)),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  threadTitleInstructions: Schema.optionalKey(TrimmedString),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuidesEnabled: Schema.optionalKey(Schema.Boolean),
  reviewGuidePrewarm: Schema.optionalKey(Schema.Boolean),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  reviewGuideShortLines: Schema.optionalKey(ReviewGuideShortLines),
  reviewGuideChatTldr: Schema.optionalKey(Schema.Boolean),
  reviewGuidePost: Schema.optionalKey(Schema.Boolean),
  reviewGuideStepUp: Schema.optionalKey(Schema.Boolean),
  reviewGuideSinglePassKb: Schema.optionalKey(ReviewGuideSinglePassKb),
  reviewGuidePrewarmDaily: Schema.optionalKey(ReviewGuidePrewarmDaily),
  reviewGuidePrewarmPlanPercent: Schema.optionalKey(ReviewGuidePrewarmPlanPercent),
  reviewGuidePrewarmIdleMinutes: Schema.optionalKey(ReviewGuidePrewarmIdleMinutes),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
      otlpLogsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  /**
   * Merges per host: a patched field replaces the saved one, so a client sends a per-server-host
   * map whole, with the redaction marker for each saved secret it keeps. An empty or omitted
   * secret is removed from the secret store.
   */
  sourceControlHosts: Schema.optionalKey(Schema.Record(Schema.String, SourceControlHostSettings)),
  /** Merges per entry; `null` removes one. */
  secretProviders: Schema.optionalKey(
    Schema.Record(SecretProviderId, Schema.NullOr(SecretProviderConfigWrite)),
  ),
  cursorKeychainUsageEnabled: Schema.optionalKey(Schema.Boolean),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  /** Each entry replaces one model's rates; `null` restores automatic pricing. */
  usagePriceOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(UsageModelPriceOverride)),
  ),
  /** Each entry replaces one model's mapping; `null` removes it. */
  usageModelAliases: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(TrimmedNonEmptyString)),
  ),
  /** Each key present replaces that list whole. */
  plugins: Schema.optionalKey(
    Schema.Struct({
      marketplaces: Schema.optionalKey(Schema.Array(PluginMarketplace)),
      installed: Schema.optionalKey(Schema.Array(PluginInstall)),
      projects: Schema.optionalKey(Schema.Array(PluginProject)),
      spaces: Schema.optionalKey(Schema.Array(PluginSpace)),
      disabled: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
      envAllowlist: Schema.optionalKey(Schema.Array(EnvVarName)),
      servers: Schema.optionalKey(Schema.Array(PluginServer)),
      trusted: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
      repoEnabled: Schema.optionalKey(Schema.Array(Schema.Struct({ repository: TrimmedNonEmptyString, id: TrimmedNonEmptyString }))),
      repoSwitches: Schema.optionalKey(Schema.Array(RepoSwitch(TrimmedNonEmptyString))),
      repoServerSwitches: Schema.optionalKey(Schema.Array(RepoSwitch(TrimmedNonEmptyString))),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

/** A mixed settings patch must be authorized for every configuration domain it changes. */
export function requiredScopesForServerSettingsPatch(
  patch: ServerSettingsPatch,
): ReadonlyArray<AuthEnvironmentScope> {
  let changesProviders = false;
  let changesSettings = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "providers" || key === "providerInstances" || key === "secretProviders") {
      changesProviders = true;
    } else {
      changesSettings = true;
    }
  }
  return [
    ...(changesSettings || !changesProviders ? [AuthSettingsWriteScope] : []),
    ...(changesProviders ? [AuthProvidersManageScope] : []),
  ];
}

/**
 * Project scripts run on the host when a worktree is created or a thread
 * settles, so a project mutation that carries them needs the same grant as
 * saving project scripts through settings, on top of `orchestration:operate`.
 */
export function requiredScopesForProjectMutation(
  mutation: ProjectMutation,
): ReadonlyArray<AuthEnvironmentScope> {
  if (mutation.type === "project.delete" || mutation.scripts === undefined) {
    return [AuthOrchestrationOperateScope];
  }
  return [
    AuthOrchestrationOperateScope,
    ...requiredScopesForServerSettingsPatch({ defaultProjectScripts: mutation.scripts }),
  ];
}

export const ClientSettingsPatch = Schema.Struct({
  notificationMode: Schema.optionalKey(NotificationMode),
  inAppNotificationsEnabled: Schema.optionalKey(Schema.Boolean),
  diffColorScheme: Schema.optionalKey(DiffColorScheme),
  chatWidth: Schema.optionalKey(ChatWidth),
  loadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingWeights: Schema.optionalKey(LoadBalancingWeights),
  appearanceContrast: Schema.optionalKey(AppearanceContrast),
  panelAnimationDurationMs: Schema.optionalKey(PanelAnimationDurationMs),
  browserDefaultViewport: Schema.optionalKey(PreviewViewportSetting),
  browserDefaultZoomFactor: Schema.optionalKey(PreviewZoomFactor),
  browserDefaultAppearance: Schema.optionalKey(PreviewAppearancePreference),
  browserRecordingFrameRate: Schema.optionalKey(BrowserRecordingFrameRate),
  browserRecordingShowKeyPresses: Schema.optionalKey(Schema.Boolean),
  browserRecordingShowMousePresses: Schema.optionalKey(Schema.Boolean),
  browserLinkTarget: Schema.optionalKey(BrowserLinkTarget),
  browserAutoShowFloatingPreview: Schema.optionalKey(Schema.Boolean),
  browserProfiles: Schema.optionalKey(Schema.Array(BrowserProfile)),
  browserDefaultProfileId: Schema.optionalKey(BrowserProfileId),
  confirmQuit: Schema.optionalKey(QuitConfirmationMode),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  confirmThreadUnpin: Schema.optionalKey(Schema.Boolean),
  diffFilesCollapsed: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffLayout: Schema.optionalKey(DiffLayout),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  glassOpacity: Schema.optionalKey(GlassOpacity),
  onboardingCompletedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fontSizeInterface: Schema.optionalKey(InterfaceFontSize),
  fontSizePrompt: Schema.optionalKey(PromptFontSize),
  fontSizeCode: Schema.optionalKey(CodeFontSize),
  fontSizeTerminal: Schema.optionalKey(TerminalFontSize),
  fontFamilyCode: Schema.optionalKey(FontFamilyPreference),
  fontFamilyComposer: Schema.optionalKey(FontFamilyPreference),
  fontFamilySans: Schema.optionalKey(FontFamilyPreference),
  fontFamilyTerminal: Schema.optionalKey(FontFamilyPreference),
  fontSmoothing: Schema.optionalKey(Schema.Boolean),
  persistComposerContextStrip: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  pullRequestMergeMethodOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, PullRequestMergeMethod),
  ),
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  contextWindowMeterEnabled: Schema.optionalKey(Schema.Boolean),
  composerCollapseOnScroll: Schema.optionalKey(Schema.Boolean),
  composerRichTextEnabled: Schema.optionalKey(Schema.Boolean),
  sendShortcut: Schema.optionalKey(Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"])),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  proactivePanelsEnabled: Schema.optionalKey(Schema.Boolean),
  showSkillsInSlashMenu: Schema.optionalKey(Schema.Boolean),
  legacySidebarEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarWorkingShelfEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  snapShotEnabled: Schema.optionalKey(Schema.Boolean),
  snapShotIncludeAccessibility: Schema.optionalKey(Schema.Boolean),
  snapShotShortcut: Schema.optionalKey(SnapShotShortcut),
  snapShotPlaySound: Schema.optionalKey(Schema.Boolean),
  snapShotSound: Schema.optionalKey(SnapShotSound),
  snapShotFlash: Schema.optionalKey(Schema.Boolean),
  snapShotAnimations: Schema.optionalKey(Schema.Boolean),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
