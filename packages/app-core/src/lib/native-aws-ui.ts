/** What the AWS connection form says and offers, for every AWS service this driver reaches (ADR 0197). */
import { NATIVE_AWS_SERVICES, nativeAwsServiceId } from "./native-aws-input.js";
import type {
  NativeKeyAction,
  NativeKeyField,
  NativeKeyUi,
} from "./native-key-types.js";

const FIELDS: readonly NativeKeyField[] = [
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
];

function names(noun: string, placeholder: string): readonly NativeKeyAction[] {
  return [
    { id: "provider.names.read", label: `List ${noun} names`, fields: [] },
    {
      id: "provider.secret.read",
      label: `Read a ${noun} value`,
      fields: [
        {
          id: "name",
          label: `${noun[0]?.toUpperCase()}${noun.slice(1)} name`,
          kind: "text",
          secret: false,
          required: true,
          placeholder,
        },
      ],
    },
  ];
}

export function nativeAwsUi(providerId: string): NativeKeyUi {
  const id = nativeAwsServiceId(providerId) ?? "aws";
  const service = NATIVE_AWS_SERVICES[id];
  return {
    name: service.name,
    methodLabel: "AWS access key",
    instructions:
      "Use an IAM access key limited to listing names, and to reading values only if you want to read them here. The request is signed in this browser with Signature Version 4 and sent only to the endpoint AWS publishes for the region. Verification lists the first names, which proves permission to list and nothing about who owns the account.",
    fields: FIELDS,
    links: [
      {
        label: "Create an IAM access key",
        url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's access key. It revokes nothing at AWS: delete or rotate the key in IAM to end its other uses.",
    actions:
      id === "aws"
        ? names("secret", "prod/database")
        : names("parameter", "/prod/database/url"),
  };
}
