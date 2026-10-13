/**
 * AWS Secrets Manager and Parameter Store from a browser (ADR 0197): the
 * person's own access key, signed with Signature Version 4, sent to the
 * endpoint AWS publishes for the region. Verification is a real list call, so
 * it proves the key may list names and nothing about who owns the account.
 * The flows that save, re-prove and forget are the shared key driver's.
 */
import {
  NATIVE_AWS_SERVICES,
  type NativeAwsTarget,
  isNativeAwsProvider,
  nativeAwsClassification,
  nativeAwsFingerprint,
  nativeAwsInput,
  nativeAwsServiceOf,
} from "./native-aws-input.js";
import {
  readNativeAwsNames,
  readNativeAwsValue,
} from "./native-aws-operations.js";
import { nativeAwsUi } from "./native-aws-ui.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type { NativeKeyProof } from "./native-key-types.js";

export { isNativeAwsProvider } from "./native-aws-input.js";

export type NativeAwsResult = {
  label: string;
  items: { id: string; label: string; secretValue?: string }[];
};

function awsProof(target: NativeAwsTarget): NativeKeyProof {
  const region = target.parameters.region ?? "";
  return {
    identity: {
      id: region,
      label: `${NATIVE_AWS_SERVICES[target.service].name} in ${region}`,
      kind: "region",
    },
    targets: [{ id: region, label: region, kind: "region" }],
    grantLabel: "AWS signing credentials",
    target: { key: "region", id: region },
  };
}

const aws = createNativeKeyFlows<NativeAwsTarget>({
  family: "AWS",
  idPrefix: "conn_aws_",
  accepts: isNativeAwsProvider,
  classification: nativeAwsClassification,
  ui: nativeAwsUi,
  parse: nativeAwsInput,
  fingerprint: (target) =>
    nativeAwsFingerprint(target.service, target.parameters),
  prove: async (target, transport) => {
    await readNativeAwsNames(target, transport);
    return awsProof(target);
  },
  targetOf: (saved) => ({
    providerId: saved.configuration.providerId,
    service: nativeAwsServiceOf(saved.configuration.providerId),
    parameters: saved.configuration.parameters,
    credentials: saved.privateState.credentials,
  }),
  operations: [
    {
      id: "provider.names.read",
      inputKeys: [],
      run: async (target, transport) => {
        const items = await readNativeAwsNames(target, transport);
        return { label: `First ${items.length} names`, items };
      },
    },
    {
      id: "provider.secret.read",
      inputKeys: ["name"],
      run: async (target, transport, input) => {
        const name = input.name ?? "";
        const secretValue = await readNativeAwsValue(target, transport, name);
        return {
          label: "Value read once",
          items: [{ id: name, label: name, secretValue }],
        };
      },
    },
  ],
});

export const awsKeyFlows = aws;
export const configureNativeAws = aws.configure;
export const verifyNativeAws = aws.verify;
export const invokeNativeAws = aws.invoke;
export const nativeAwsCleanup = aws.cleanup;
