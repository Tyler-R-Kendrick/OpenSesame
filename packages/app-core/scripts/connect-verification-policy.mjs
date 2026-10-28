/** Compile the provider-owned exception for an error inside a valid response. */
export function allowedError(rule) {
  if (!rule) return undefined;
  return {
    field: rule.field,
    whenField: rule.when_field,
    whenEquals: rule.when_equals,
  };
}

/** Bind the provider's response to the public request parameter. */
export function responseBinding(rule) {
  if (!rule) return undefined;
  return { field: rule.field, parameter: rule.parameter, format: rule.format };
}
