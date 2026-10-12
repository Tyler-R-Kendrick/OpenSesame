import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { vi } from "vitest";
import type {
  NativeConnectorController,
  NativeConnectorDescriptor,
} from "./native-connector-ui.js";

export function nativeUiView(): NativeConnectorView {
  return {
    providerId: "algolia",
    connectionId: "native-1",
    revision: 1,
    fingerprint: "binding-1",
    configuration: {
      version: 1,
      providerId: "algolia",
      method: "api-key",
      displayName: "Search production",
      icon: "",
      parameters: { application_id: "app-1" },
      requestedScopes: {},
      targetIds: {},
      fingerprint: "binding-1",
    },
    status: "connected",
    identity: {
      id: "app-1",
      label: "Application app-1",
      kind: "application",
      assurance: "credential-valid",
    },
    targets: [{ id: "index-1", label: "Products", kind: "index" }],
    grants: [
      {
        actor: "key",
        label: "Algolia API key",
        permissionState: "provider-managed",
        grantedScopes: [],
        expiresAt: null,
        needsReauth: false,
      },
    ],
    verifiedAt: 1000,
    recovery: [],
  };
}

export function nativeUiDescriptor(): NativeConnectorDescriptor {
  return {
    providerId: "algolia",
    name: "Algolia",
    docsUrl: "https://www.algolia.com/doc/",
    methods: [
      {
        id: "api-key",
        label: "Algolia API key",
        available: true,
        instructions: "Use the key for your Algolia application.",
        fields: [
          {
            id: "application_id",
            label: "Algolia application ID",
            kind: "text",
            required: true,
            secret: false,
          },
          {
            id: "key",
            label: "Algolia API key",
            kind: "text",
            required: true,
            secret: true,
            defaultValue: "must-not-prefill-secret",
          },
        ],
        scopeGroups: [],
        links: [
          {
            label: "Algolia API keys",
            url: "https://www.algolia.com/account/api-keys",
          },
        ],
      },
      {
        id: "oauth",
        label: "Operator OAuth",
        available: false,
        unavailableReason: "Register a supported public application first.",
        fields: [],
        scopeGroups: [],
      },
    ],
    actions: [
      {
        id: "indexes.list",
        label: "Read Algolia indexes",
        available: true,
        fields: [],
        resultOrigins: ["https://dashboard.algolia.com"],
      },
    ],
  };
}

export function nativeUiController(view = nativeUiView()) {
  const configure = vi.fn<NativeConnectorController["configure"]>(
    async () => view,
  );
  const controller = {
    load: vi.fn(() => view),
    configure,
    connect: vi.fn<NativeConnectorController["connect"]>(async (input) =>
      configure(input),
    ),
    authorize: vi.fn<NativeConnectorController["authorize"]>(
      async () => undefined,
    ),
    cancelAuthorization:
      vi.fn<NativeConnectorController["cancelAuthorization"]>(),
    verify: vi.fn<NativeConnectorController["verify"]>(async () => view),
    invoke: vi.fn<NativeConnectorController["invoke"]>(async () => ({
      label: "Algolia indexes",
      items: [],
    })),
    retry: vi.fn<NativeConnectorController["retry"]>(async () => view),
    remove: vi.fn<NativeConnectorController["remove"]>(async () => undefined),
  } satisfies NativeConnectorController;
  return controller;
}
