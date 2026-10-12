import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";

/** Permission is tested with ListObjectsV2 before this browser stores a connection. */
export function nativeS3Descriptor(
  provider: Provider,
  available: boolean,
): NativeConnectorDescriptor {
  return {
    providerId: "s3",
    name: provider.displayName,
    docsUrl: provider.docsUrl,
    disconnectExplanation:
      "Disconnect forgets this device's signing credentials. Revoke a shared key at the provider to end its other uses.",
    methods: [
      {
        id: "api-key",
        label: "S3 signing credentials",
        available,
        unavailableReason:
          "S3 signing and bucket verification are unavailable in this browser runtime.",
        scopeGroups: [],
        fields: [
          {
            id: "endpoint",
            label: "S3 HTTPS service origin",
            kind: "url",
            secret: false,
            required: true,
            placeholder: "https://s3.us-east-1.amazonaws.com",
          },
          {
            id: "region",
            label: "Region",
            kind: "text",
            secret: false,
            required: true,
            defaultValue: "us-east-1",
          },
          {
            id: "bucket",
            label: "Bucket",
            kind: "text",
            secret: false,
            required: true,
          },
          {
            id: "access_key_id",
            label: "Access key ID",
            kind: "text",
            secret: false,
            required: true,
          },
          {
            id: "secret_access_key",
            label: "Secret access key",
            kind: "text",
            secret: true,
            required: true,
          },
          {
            id: "session_token",
            label: "Session token (optional)",
            kind: "text",
            secret: true,
            required: false,
          },
          {
            id: "prefix",
            label: "Object prefix (optional)",
            kind: "text",
            secret: false,
            required: false,
          },
        ],
        instructions:
          "Allow this site's origin to use GET with Authorization, x-amz-date, x-amz-content-sha256 and, for temporary credentials, x-amz-security-token in your bucket's CORS policy. Connection verification checks ListObjectsV2 permission for this bucket and prefix.",
      },
    ],
    actions: [],
  };
}
