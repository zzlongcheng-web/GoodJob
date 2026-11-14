/**
 * Consistent duplicate key for company and country.
 * Preserve the historical matching contract: trim, collapse whitespace,
 * and compare without case sensitivity.
 */
export function entityDuplicateKey(company: string, country: string): string {
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
  return JSON.stringify([normalize(company), normalize(country)]);
}
