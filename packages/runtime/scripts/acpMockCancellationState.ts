// ), apps/server/scripts/acpMockCancellationState.ts @ ab3a3cd1.
export function beginAcpMockPrompt(cancelledSessions: Set<string>, sessionId: string): void {
  cancelledSessions.delete(sessionId);
}
