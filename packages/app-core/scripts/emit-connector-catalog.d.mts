/** The generated module's text for a catalog view (the checked-in view by default). */
export function renderModule(raw?: string): string;

/** The `ai_model_provider` ids module's text for a catalog view (the checked-in view by default). */
export function renderAiProviderIds(raw?: string): string;

/** Extract fields identical across all rows without discarding each row's differing fields. */
export function factorCatalogRows<Row extends object>(
  rows: readonly Row[],
): {
  common: Partial<Row>;
  rows: Partial<Row>[];
};
