export interface DraftSource {
  documentId: number | null;
  rawConfig: string;
  /**
   * Carried so callers and tests can pass the full effect input. Deliberately excluded from
   * the comparison — see `shouldResetDrafts`.
   */
  configBaseUrl?: string;
}

/**
 * Decides whether the import editor and the raw editor must be reset from the active
 * configuration document.
 *
 * The rule is keyed on document identity and its stored content only. It must never
 * consider the resolved base URL: the remote import flow sets the base URL from the fetched
 * address and then loads the fetched text into the import editor, so a base URL change
 * would reset that editor back to the document that is already open. The user would then
 * save a byte-identical copy of the current document while believing the remote
 * configuration had been imported.
 *
 * Extracted so the rule is explicit and testable rather than living in a dependency array,
 * where dropping or adding one entry changes behaviour silently.
 */
export function shouldResetDrafts(previous: DraftSource, next: DraftSource) {
  return (
    previous.documentId !== next.documentId ||
    previous.rawConfig !== next.rawConfig
  );
}
