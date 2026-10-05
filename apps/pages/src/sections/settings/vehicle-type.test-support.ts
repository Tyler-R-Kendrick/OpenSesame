/** A small community item type, for tests that need one installed. */
export const VEHICLE_TYPE = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "vehicle",
    version: "1.0.0",
    publisher: "https://community.test",
  },
  spec: {
    title: "Vehicle",
    plural: "Vehicles",
    extension: ".vehicle",
    summary: "A vehicle and its plate.",
    categories: [],
    sections: [
      {
        id: "s",
        title: "S",
        fields: [{ id: "plate", type: "string", label: "Plate" }],
      },
    ],
    native: { secret: null, trailer: [{ key: "plate", field: "plate" }] },
    cxf: { credential: "custom-fields" },
    subtitle: ["plate"],
    search: ["plate"],
  },
});
