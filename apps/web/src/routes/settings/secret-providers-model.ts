// Settings > Secret providers, as words: what each provider and each key or token row says. No React, so it is tested
// without a browser.
import {
  isOnePasswordReference,
  type SecretProviderInfo,
  type SecretSlot,
  type SecretSlotTarget,
} from "@caveman-app/session-protocol";

/** How a provider signs in, one line. */
export function providerLine(p: SecretProviderInfo): string {
  if (!p.supported) return "A kind of secret manager this version can't read.";
  if (p.service_account)
    return p.has_token
      ? "1Password service account. Its token is stored encrypted on this computer."
      : "1Password service account. Add its token.";
  return p.account
    ? `Through the 1Password app on this computer, account ${p.account}.`
    : "Through the 1Password app on this computer.";
}

/** Where a key or token reads from now, one line; never a value. */
export function slotLine(slot: SecretSlot, providers: ReadonlyArray<SecretProviderInfo>): string {
  if (slot.ref) {
    const provider = providers.find((p) => p.id === slot.ref!.provider);
    return provider
      ? `Read from ${provider.label} when it is used.`
      : `Its secret provider (${slot.ref.provider}) was removed: it reads as unset.`;
  }
  return slot.has_value ? "A pasted value is stored on this computer." : "Not set.";
}

/** Why a reference typed into a row can't be used yet, or null. */
export function referenceProblem(reference: string): string | null {
  const value = reference.trim();
  if (value === "") return null;
  return isOnePasswordReference(value)
    ? null
    : "Use a 1Password reference like op://vault/item/field.";
}

/** The rows in Settings' order: engines first, then source control, each by label. */
export function groupSlots(
  slots: ReadonlyArray<SecretSlot>,
): ReadonlyArray<{ readonly title: string; readonly slots: ReadonlyArray<SecretSlot> }> {
  const by = (group: SecretSlot["group"]) =>
    slots.filter((s) => s.group === group).sort((a, b) => a.label.localeCompare(b.label));
  return [
    { title: "Engine keys", slots: by("engine") },
    { title: "Source control tokens", slots: by("source_control") },
  ].filter((g) => g.slots.length > 0);
}

/** A stable key for a row. */
export const slotKey = (target: SecretSlotTarget): string =>
  target.kind === "engine_env"
    ? `env:${target.instance_id}:${target.name}`
    : `host:${target.host}:${target.field}:${target.server_host ?? ""}`;
