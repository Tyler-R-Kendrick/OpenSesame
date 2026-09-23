/** A minimal community definition the registry suites install and vary. */
export function communityDefinition(
  id: string,
  publisher: string,
  version = "1.0.0",
): string {
  return JSON.stringify({
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "VaultItemType",
    metadata: { id, version, publisher },
    spec: {
      title: "Community type",
      plural: "Community types",
      extension: ".ct",
      summary: "Installed at runtime, with no build.",
      categories: ["other"],
      sections: [
        {
          id: "main",
          title: "Main",
          fields: [{ id: "label", type: "string", label: "Label" }],
        },
      ],
      native: { secret: null, trailer: [{ key: "label", field: "label" }] },
      cxf: { credential: "custom-fields" },
      subtitle: ["label"],
      search: ["label"],
    },
  });
}
