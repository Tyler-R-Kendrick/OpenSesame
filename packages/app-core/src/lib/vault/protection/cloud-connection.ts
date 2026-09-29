/**
 * The cloud key a person configured on this device, as an enrollment or proof
 * can use it: the sealed Connections record (Settings › Connections › AWS KMS
 * or Google Cloud KMS) read out of the open tomb into a live transport.
 *
 * The credential is read into memory for one operation and never written
 * anywhere else — not the record, not the journal, not a log line. What a
 * protector record keeps is the key's identity and the connection's config
 * version, never the credential that reached it.
 */

import { readAwsKmsConfig } from "../../aws-kms-config.js";
import { readGcpKmsConfig } from "../../gcp-kms-config.js";
import { createAwsKmsHttpsTransport } from "./adapters/aws-kms-https.js";
import type { AwsKmsTransport } from "./adapters/aws-kms.js";
import type { AwsSigV4Credentials } from "./adapters/aws-sigv4.js";
import { createGcpKmsHttpsTransport } from "./adapters/gcp-kms-https.js";
import type { GcpKmsTransport } from "./adapters/gcp-kms.js";
import { mintGcpAccessToken } from "./adapters/gcp-oauth.js";
import { ProtectionError } from "./errors.js";

export const AWS_KMS_CONNECTION_ID = "aws-kms";
export const GCP_KMS_CONNECTION_ID = "gcp-kms";

export type AwsKmsConnection = {
  transport: AwsKmsTransport;
  keyArn: string;
  region: string;
  connectionId: string;
  connectionConfigVersion: string;
};

export type GcpKmsConnection = {
  transport: GcpKmsTransport;
  keyName: string;
  connectionId: string;
  connectionConfigVersion: string;
};

export async function awsKmsConnection(
  tomb: string,
  fetchImpl?: typeof fetch,
): Promise<AwsKmsConnection> {
  const config = await readAwsKmsConfig(tomb);
  if (!config.keyArn || !config.secretAccessKey) {
    throw new ProtectionError(
      "unavailable",
      "Save the AWS KMS key and credentials first.",
    );
  }
  const credentials: AwsSigV4Credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
  if (config.sessionToken) credentials.sessionToken = config.sessionToken;
  return {
    transport: createAwsKmsHttpsTransport(
      fetchImpl ? { credentials, fetchImpl } : { credentials },
    ),
    keyArn: config.keyArn,
    region: config.region,
    connectionId: AWS_KMS_CONNECTION_ID,
    connectionConfigVersion: config.configVersion,
  };
}

export async function gcpKmsConnection(
  tomb: string,
  fetchImpl?: typeof fetch,
): Promise<GcpKmsConnection> {
  const config = await readGcpKmsConfig(tomb);
  if (!config.keyName || !config.serviceAccountJson) {
    throw new ProtectionError(
      "unavailable",
      "Save the Google Cloud KMS key and service account first.",
    );
  }
  const bearerToken = await mintGcpAccessToken(
    fetchImpl
      ? { serviceAccountJson: config.serviceAccountJson, fetchImpl }
      : { serviceAccountJson: config.serviceAccountJson },
  );
  return {
    transport: createGcpKmsHttpsTransport(
      fetchImpl ? { bearerToken, fetchImpl } : { bearerToken },
    ),
    keyName: config.keyName,
    connectionId: GCP_KMS_CONNECTION_ID,
    connectionConfigVersion: config.configVersion,
  };
}
