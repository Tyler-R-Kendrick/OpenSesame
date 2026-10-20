/** Only the selected canonical method may expose registered protocol controls. */
const AUTH_CONTROL =
  /Token endpoint|Authorization endpoint|Server URL|Client secret|OAuth issuer URL|API resource URL|MCP server endpoint|MCP messages endpoint|MCP resource audience|MCP credential/i;

export function nativeAuthFieldViolations(methods, observed) {
  const restricted = observed.inputs.filter(
    (input) => !input.readOnly && AUTH_CONTROL.test(input.label),
  );
  if (!restricted.length) return [];
  if (observed.methodChoiceCount > 0 && !observed.methodLabel)
    return restricted;
  // A single-method form has no radio. Its protocol selector still identifies
  // OAuth/MCP; absence or ambiguity never grants an endpoint/secret exception.
  const candidates = methods.filter((method) =>
    observed.methodLabel
      ? method.label === observed.methodLabel
      : method.fields.some(
          (field) =>
            ["token_auth_method", "mcp_authentication"].includes(field.id) &&
            Object.hasOwn(observed.selections, field.label),
        ),
  );
  if (candidates.length !== 1) return restricted;
  const method = candidates[0];
  for (const field of method.fields) {
    if (!["token_auth_method", "mcp_authentication"].includes(field.id))
      continue;
    if (
      !field.choices?.some(
        (choice) => choice.id === observed.selections[field.label],
      )
    )
      return restricted;
  }
  const values = {};
  for (const field of method.fields) {
    if (field.kind !== "choice") continue;
    const value = observed.selections[field.label];
    if (value === undefined) continue;
    if (value !== "" && !field.choices?.some((choice) => choice.id === value))
      return restricted;
    values[field.id] = value;
  }
  const fields = method.fields.filter(
    (field) => !field.when || values[field.when.fieldId] === field.when.value,
  );
  return restricted.filter(
    (input) =>
      !fields.some(
        (field) =>
          field.label === input.label &&
          !field.readOnly &&
          field.kind !== "choice" &&
          input.type ===
            (field.secret ? "password" : field.kind === "url" ? "url" : "text"),
      ),
  );
}

/** Inspect actual controls without collecting any credential values. */
export function nativeAuthFieldObservation(form) {
  const label = (input) => input.labels?.[0]?.textContent?.trim() ?? "";
  return {
    methodChoiceCount: form.querySelectorAll('.cx-modes input[type="radio"]')
      .length,
    methodLabel:
      form
        .querySelector('.cx-modes input[type="radio"]:checked')
        ?.closest("label")
        ?.textContent?.trim() ?? null,
    selections: Object.fromEntries(
      [...form.querySelectorAll("select")].map((select) => [
        label(select),
        select.value,
      ]),
    ),
    inputs: [...form.querySelectorAll("input")].map((input) => ({
      label: label(input),
      type: input.type,
      readOnly: input.readOnly,
    })),
  };
}
