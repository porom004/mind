// ── UUID helper functions ──

/**
 * Generates a UUID v4 (RFC 9562) using Bun's native crypto.randomUUID().
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (36 chars with dashes)
 */
export function generateUuid(): string {
  return crypto.randomUUID();
}
