/** Observe actual Vertex/Bedrock controls and shared mandatory credential actions. */
export async function selectOptions(form, label) {
  return form
    .getByLabel(label, { exact: true })
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value));
}

export async function sharedDisabledActions(
  form,
  row,
  check,
  reason = "requires a complete configuration",
) {
  const actionsDisabled = {};
  for (const name of ["Test AI connection", "Save AI connection"]) {
    const disabled = await form
      .getByRole("button", { name, exact: true })
      .isDisabled();
    check(disabled, `${row.id}: ${name} ${reason}`);
    actionsDisabled[name] = disabled;
  }
  return actionsDisabled;
}

async function cloudAiCredentials(form, row, preset, check) {
  const vertex = !!preset.vertex;
  const vertexCredential =
    preset.vertex?.credential === "service-account"
      ? "Service account JSON"
      : "Google access token";
  const credentials = vertex
    ? [vertexCredential]
    : [
        "AWS access key ID",
        "AWS secret access key",
        "AWS session token (optional)",
      ];
  for (const label of credentials) {
    const field = form.getByLabel(label, { exact: true });
    check(
      (await field.inputValue()) === "",
      `${row.id}: ${label} is never prefilled`,
    );
    const json = label === "Service account JSON";
    check(
      json
        ? await field.evaluate(
            (node) =>
              node.tagName === "TEXTAREA" && node.autocomplete === "off",
          )
        : (await field.getAttribute("type")) === "password",
      `${row.id}: ${label} uses its actual private credential control`,
    );
    check(
      await field.isEditable(),
      `${row.id}: ${label} accepts an explicit new credential`,
    );
  }
  const authentication = vertex
    ? await selectOptions(form, "Vertex authentication")
    : [];
  if (vertex) {
    check(
      JSON.stringify(authentication) ===
        JSON.stringify(["service-account", "access-token"]),
      `${row.id}: service account and Google access token modes are explicit`,
    );
    await form
      .getByLabel("Vertex authentication", { exact: true })
      .selectOption("access-token");
    const token = form.getByLabel("Google access token", { exact: true });
    check(
      (await token.inputValue()) === "" &&
        (await token.getAttribute("type")) === "password",
      `${row.id}: switching Vertex mode exposes only a blank write-only access token`,
    );
    await form
      .getByLabel("Vertex authentication", { exact: true })
      .selectOption(preset.vertex.credential);
  }
  return { credentials, authentication };
}

export async function cloudAiDefaults(form, row, preset, check) {
  const vertex = !!preset.vertex;
  const endpoint = vertex ? "Vertex API base URL" : "Bedrock runtime endpoint";
  const defaults = [
    ["Connection name", preset.name],
    ["API family", preset.family],
    [endpoint, preset.baseUrl],
    ["Model ID", ""],
    ...(vertex
      ? [
          ["Google Cloud project", preset.vertex.project],
          ["Vertex location", preset.vertex.location],
          ["Vertex authentication", preset.vertex.credential],
        ]
      : [["AWS region", preset.bedrock.region]]),
  ];
  const fields = {};
  for (const [label, expected] of defaults) {
    const field = form.getByLabel(label, { exact: true });
    const value = await field.inputValue();
    check(
      value === expected,
      `${row.id}: ${label} has its cloud provider default`,
    );
    const locked =
      label === endpoint && ["google-vertex", "aws-bedrock"].includes(row.id);
    const editable = ["API family", "Vertex authentication"].includes(label)
      ? await field.isEnabled()
      : await field.isEditable();
    check(
      editable === !locked,
      `${row.id}: ${label} preserves native versus BYO authority`,
    );
    fields[label] = { value, configurable: editable };
  }
  const families = await selectOptions(form, "API family");
  check(
    JSON.stringify(families) === JSON.stringify(preset.families),
    `${row.id}: supported inference API families are explicit`,
  );
  check(
    (await form.getByLabel("Authentication", { exact: true }).count()) === 0 &&
      (await form.getByLabel("API key", { exact: true }).count()) === 0,
    `${row.id}: cloud credentials never offer an unrelated unauthenticated API-key mode`,
  );
  const { credentials, authentication } = await cloudAiCredentials(
    form,
    row,
    preset,
    check,
  );
  await form
    .getByLabel("Model ID", { exact: true })
    .fill(vertex ? "gemini-2.5-flash" : "amazon.nova-lite-v1:0");
  if (vertex)
    await form
      .getByLabel("Google Cloud project", { exact: true })
      .fill("native-browser-proof");
  const actionsDisabled = await sharedDisabledActions(
    form,
    row,
    check,
    "still requires private credentials after public target fields are complete",
  );
  await form.getByLabel("Model ID", { exact: true }).fill("");
  if (vertex)
    await form
      .getByLabel("Google Cloud project", { exact: true })
      .fill(preset.vertex.project);
  return {
    fields,
    families,
    authentication,
    credentialFields: credentials,
    actionsDisabled,
  };
}
