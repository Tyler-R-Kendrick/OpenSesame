/**
 * AWS Security Token Service from a browser (ADR 0198): the person's own
 * access key, signed with Signature Version 4, sent to the regional endpoint
 * STS publishes. Verification is GetCallerIdentity, which needs no permission
 * and says whose key it is. A person may also ask for short-lived credentials;
 * they are shown once and never kept.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalize } from "@opensesame/os-domain";
import { EgressDenied } from "./capabilities/egress.js";
import { canonicalProviderId } from "./connector-catalog.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import { awsRefusal, awsSigningMaterial } from "./native-aws-http.js";
import {
  assertOnlyAwsFields,
  awsPublicParameters,
  awsSigningCredentials,
  nativeAwsClassification,
  nativeAwsRegionalEndpoint,
} from "./native-aws-input.js";
import { awsXmlRequired, awsXmlValue } from "./native-aws-xml.js";
import { readBoundedText } from "./native-bounded-body.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type {
  NativeKeyField,
  NativeKeyProof,
  NativeKeyTarget,
  NativeKeyUi,
} from "./native-key-types.js";
import { signAws } from "./secret-fs/s3-sigv4.js";

const NAME = "AWS Security Token Service";
const ROLE_ARN =
  /^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const SESSION_NAME = "OpenSesame";
const SECONDS = "3600";

export function isNativeStsProvider(providerId: string): boolean {
  return canonicalProviderId(providerId) === "aws-sts";
}

function stsTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): NativeKeyTarget {
  assertOnlyAwsFields(input, isNativeStsProvider(input.providerId));
  const parameters = awsPublicParameters(input);
  const credentials = awsSigningCredentials(input, saved);
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  for (const value of Object.values(parameters))
    safeProviderText(value, credentials);
  return { providerId: input.providerId, parameters, credentials };
}

/** What an STS action takes beyond its name, in the order it is signed. */
type StsParams =
  | { RoleArn: string; RoleSessionName: string; DurationSeconds: string }
  | { DurationSeconds: string };

/** One signed STS query call; the reply is XML, read bounded, and AWS's own message is never shown. */
async function stsCall(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  action: string,
  params?: StsParams,
): Promise<string> {
  transport.assertCurrent();
  const region = target.parameters.region ?? "";
  const body = new URLSearchParams([
    ["Action", action],
    ["Version", "2011-06-15"],
    ...Object.entries(params ?? {}),
  ]).toString();
  const signed = signAws({
    method: "POST",
    url: nativeAwsRegionalEndpoint("sts", region),
    headers: new Headers({
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    }),
    payloadHash: bytesToHex(sha256(new TextEncoder().encode(body))),
    region,
    credentials: awsSigningMaterial(target),
    service: "sts",
    payloadHashHeader: false,
    pathEncoding: "twice",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport.fetch(signed.url, {
      method: "POST",
      headers: signed.headers,
      body,
      signal: controller.signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    transport.assertCurrent();
    if (response.redirected) throw new NativeApiError("response");
    const text = await readBoundedText(response);
    if (!response.ok)
      throw awsRefusal(
        response.status,
        awsXmlValue(text, ["Error", "Code"]) ?? "",
      );
    transport.assertCurrent();
    if (controller.signal.aborted) throw new NativeApiError("network");
    return text;
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    if (error instanceof EgressDenied) throw new NativeApiError("deployment");
    throw new NativeApiError("network");
  } finally {
    clearTimeout(timeout);
  }
}

async function callerIdentity(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const xml = await stsCall(target, transport, "GetCallerIdentity");
  const path = ["GetCallerIdentityResult"];
  return {
    account: awsXmlRequired(xml, [...path, "Account"], /^\d{12}$/),
    arn: awsXmlRequired(
      xml,
      [...path, "Arn"],
      /^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:[\x21-\x7e]+$/,
    ),
    userId: awsXmlRequired(
      xml,
      [...path, "UserId"],
      /^[A-Za-z0-9:_@.=,+/-]{1,256}$/,
    ),
  };
}

async function stsProof(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<NativeKeyProof> {
  const who = await callerIdentity(target, transport);
  const region = target.parameters.region ?? "";
  return {
    identity: {
      id: who.account,
      label: safeProviderText(who.arn, target.credentials),
      kind: "account",
    },
    targets: [{ id: region, label: region, kind: "region" }],
    grantLabel: "AWS signing credentials",
    target: { key: "region", id: region },
  };
}

/** Temporary credentials, shown once: the key and token are secret, the expiry is not. */
function credentialItems(xml: string, resultTag: string) {
  const path = [resultTag, "Credentials"];
  const token = /^[A-Za-z0-9+/=_-]{16,16384}$/;
  const expires = awsXmlRequired(
    xml,
    [...path, "Expiration"],
    /^\d{4}-\d\d-\d\dT[\d:.]+Z$/,
  );
  return {
    label: "Temporary credentials, shown once",
    items: [
      {
        id: "AccessKeyId",
        label: "Access key ID",
        secretValue: awsXmlRequired(
          xml,
          [...path, "AccessKeyId"],
          /^[A-Z0-9]{16,128}$/,
        ),
      },
      {
        id: "SecretAccessKey",
        label: "Secret access key",
        secretValue: awsXmlRequired(xml, [...path, "SecretAccessKey"], token),
      },
      {
        id: "SessionToken",
        label: "Session token",
        secretValue: awsXmlRequired(xml, [...path, "SessionToken"], token),
      },
      { id: "Expiration", label: `Expires ${expires}` },
    ],
  };
}

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

export function nativeStsUi(): NativeKeyUi {
  return {
    name: NAME,
    methodLabel: "AWS access key",
    instructions:
      "Use an IAM access key. The request is signed in this browser with Signature Version 4 and sent only to the STS endpoint AWS publishes for the region. Verification calls GetCallerIdentity, which needs no permission and shows which account and identity the key belongs to.",
    fields: FIELDS,
    links: [
      {
        label: "Create an IAM access key",
        url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's access key. It revokes nothing at AWS: delete or rotate the key in IAM to end its other uses.",
    actions: [
      { id: "sts.identity.read", label: "Show who this key is", fields: [] },
      {
        id: "sts.role.assume",
        label: "Assume a role",
        fields: [
          {
            id: "role_arn",
            label: "Role ARN",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "arn:aws:iam::123456789012:role/Deploy",
          },
        ],
      },
      { id: "sts.session-token.get", label: "Get a session token", fields: [] },
    ],
  };
}

export const stsKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "AWS STS",
  idPrefix: "conn_sts_",
  accepts: isNativeStsProvider,
  classification: nativeAwsClassification,
  ui: nativeStsUi,
  parse: stsTarget,
  fingerprint: async (target) => {
    const bytes = new TextEncoder().encode(
      canonicalize({
        contract: "aws:sigv4:sts:v1",
        parameters: target.parameters,
      }),
    );
    return bytesToHex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    );
  },
  prove: stsProof,
  targetOf: (saved) => ({
    providerId: saved.configuration.providerId,
    parameters: saved.configuration.parameters,
    credentials: saved.privateState.credentials,
  }),
  operations: [
    {
      id: "sts.identity.read",
      inputKeys: [],
      run: async (target, transport) => {
        const who = await callerIdentity(target, transport);
        return {
          label: "Caller identity",
          items: [
            { id: "account", label: `Account ${who.account}` },
            { id: "arn", label: safeProviderText(who.arn, target.credentials) },
            { id: "user", label: `User ID ${who.userId}` },
          ],
        };
      },
    },
    {
      id: "sts.role.assume",
      inputKeys: ["role_arn"],
      run: async (target, transport, input) => {
        const role = input.role_arn ?? "";
        if (!ROLE_ARN.test(role)) throw new Error("Enter a valid IAM role ARN");
        const xml = await stsCall(target, transport, "AssumeRole", {
          RoleArn: role,
          RoleSessionName: SESSION_NAME,
          DurationSeconds: SECONDS,
        });
        return credentialItems(xml, "AssumeRoleResult");
      },
    },
    {
      id: "sts.session-token.get",
      inputKeys: [],
      run: async (target, transport) => {
        const xml = await stsCall(target, transport, "GetSessionToken", {
          DurationSeconds: SECONDS,
        });
        return credentialItems(xml, "GetSessionTokenResult");
      },
    },
  ],
});
