/**
 * Values read from secret providers this run (SecretResolver), for the egress scrub, which joins
 * them to its token scrubber. Process-wide, like `providerKeyValues`, and never emptied: a process
 * started with a value may still hold it after the reference changes.
 *
 * @module secrets/secretProviderValues
 */
export const secretProviderValues = new Set<string>();
