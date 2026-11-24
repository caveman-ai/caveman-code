/**
 * Pi's own words for a failed turn, except an expired sign-in. Pi reports a dead OAuth refresh as
 * "OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {json}"; the chat
 * says which login it was and how to renew it instead (seen live, 2026-10-17).
 */
export function piFailureMessage(raw: string | undefined, fallback: string): string {
  const message = raw?.trim() || fallback;
  const oauth = /OAuth refresh failed for ([\w.-]+)/i.exec(message);
  if (oauth && /refresh[_ ]token|sign(?:ing)? in again|invalid_grant|\b40[13]\b/i.test(message)) {
    return `Pi's sign-in for ${oauth[1]} expired. Run pi in a terminal and sign in again with /login.`;
  }
  return message;
}
