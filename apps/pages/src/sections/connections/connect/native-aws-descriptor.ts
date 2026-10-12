import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { nativeAwsServiceId } from "@opensesame/app-core/lib/native-aws-input.js";
import type {
  NativeActionDescriptor,
  NativeConnectorDescriptor,
} from "./native-connector-ui.js";

/**
 * AWS Secrets Manager and Parameter Store (ADR 0197): a person's own IAM
 * access key, signed in this browser and sent only to AWS's endpoint for the
 * region. Verification is a real list call.
 */
export function nativeAwsDescriptor(
  provider: Provider,
  available: boolean,
): NativeConnectorDescriptor {
  return {
    providerId: provider.id,
    name: provider.displayName,
    docsUrl: provider.docsUrl,
    disconnectExplanation:
      "Disconnect forgets this device's access key. It revokes nothing at AWS: delete or rotate the key in IAM to end its other uses.",
    methods: [
      {
        id: "api-key",
        label: "AWS access key",
        available,
        unavailableReason: `${provider.displayName} signing is unavailable in this browser runtime.`,
        instructions:
          "Use an IAM access key limited to listing names, and to reading values only if you want to read them here. The request is signed in this browser with Signature Version 4 and sent only to the endpoint AWS publishes for the region. Verification lists the first names, which proves permission to list and nothing about who owns the account.",
        fields: [
          {
            id: "region",
            label: "Region",
            kind: "text",
            secret: false,
            required: true,
            defaultValue: "us-east-1",
            placeholder: "us-east-1",
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
        ],
        scopeGroups: [],
        links: [
          {
            label: "Create an IAM access key",
            url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
          },
        ],
      },
    ],
    actions: [],
  };
}

/** What a verified AWS connection can do on a person's request. */
export function nativeAwsActions(
  providerId: string,
): readonly NativeActionDescriptor[] {
  const secrets = nativeAwsServiceId(providerId) === "aws";
  const noun = secrets ? "secret" : "parameter";
  return [
    {
      id: "provider.names.read",
      label: `List ${noun} names`,
      available: true,
      fields: [],
      resultOrigins: [],
    },
    {
      id: "provider.secret.read",
      label: `Read a ${noun} value`,
      available: true,
      fields: [
        {
          id: "name",
          label: `${noun[0]?.toUpperCase()}${noun.slice(1)} name`,
          kind: "text",
          secret: false,
          required: true,
          placeholder: secrets ? "prod/database" : "/prod/database/url",
        },
      ],
      resultOrigins: [],
    },
  ];
}
