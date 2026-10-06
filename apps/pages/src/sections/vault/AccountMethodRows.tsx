import type {
  ApiKeyMethod,
  AuthenticatorMethod,
  LoginMethod,
  OAuthMethod,
  TokenMethod,
} from "@opensesame/vault-core";
import { headerName, totpSetupUri } from "@opensesame/vault-core";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
} from "../../components/FieldRow.js";
import {
  IconCheck,
  IconCopy,
  IconEye,
  IconEyeOff,
} from "../../components/Icons.js";
import { QrCode } from "../../components/QrCode.js";
import { TotpCode, currentTotp } from "../../components/TotpCode.js";
import { apiKeyLabels } from "./credential-labels.js";

type Ports = {
  name: string;
  revealed: Set<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
};

function Concealed({
  label,
  fieldKey,
  value,
  ports,
}: {
  label: string;
  fieldKey: string;
  value: string;
  ports: Ports;
}) {
  const lower = label.toLowerCase();
  return (
    <FieldRow
      label={label}
      actions={
        <>
          <RevealButton
            revealed={ports.revealed.has(fieldKey)}
            label={lower}
            onToggle={() => ports.toggle(fieldKey)}
          />
          <CopyButton
            value={value}
            label={lower}
            fieldKey={fieldKey}
            copied={ports.copied}
            failed={ports.failed}
            onCopy={ports.copy}
          />
        </>
      }
    >
      <ConcealedValue
        value={value}
        label={lower}
        revealed={ports.revealed.has(fieldKey)}
      />
    </FieldRow>
  );
}

function Plain({
  label,
  fieldKey,
  value,
  ports,
}: {
  label: string;
  fieldKey: string;
  value: string;
  ports: Ports;
}) {
  return (
    <FieldRow
      label={label}
      actions={
        <CopyButton
          value={value}
          label={label.toLowerCase()}
          fieldKey={fieldKey}
          copied={ports.copied}
          failed={ports.failed}
          onCopy={ports.copy}
        />
      }
    >
      <span className="frow__value">{value}</span>
    </FieldRow>
  );
}

/**
 * An API key as two rows, like a username and its password: the header it
 * travels in (`API header`, copyable) and its value (`X-Api-Key value`, hidden
 * until asked, copyable). An account may hold several, so each pair is named
 * for its header. The header line a request takes is one of Copy's choices.
 */
export function ApiKeyRows({
  method,
  methods,
  ports,
}: {
  method: ApiKeyMethod;
  methods: readonly LoginMethod[];
  ports: Ports;
}) {
  const labels = apiKeyLabels(methods, method);
  return (
    <>
      <Plain
        label={labels.header}
        fieldKey={`${method.id}:header`}
        value={headerName(method.header)}
        ports={ports}
      />
      {method.key ? (
        <Concealed
          label={labels.value}
          fieldKey={`${method.id}:key`}
          value={method.key}
          ports={ports}
        />
      ) : (
        <FieldRow label={labels.value}>
          <span className="frow__value frow__value--muted">Not set</span>
        </FieldRow>
      )}
    </>
  );
}

export function TokenRows({
  method,
  title,
  ports,
}: {
  method: TokenMethod;
  title: string;
  ports: Ports;
}) {
  return (
    <>
      {method.token ? (
        <Concealed
          label={title}
          fieldKey={`${method.id}:token`}
          value={method.token}
          ports={ports}
        />
      ) : (
        <FieldRow label={title}>
          <span className="frow__value frow__value--muted">Not set</span>
        </FieldRow>
      )}
      {method.expiresAt ? (
        <FieldRow label="Expires">
          <span className="frow__value">{method.expiresAt}</span>
        </FieldRow>
      ) : null}
    </>
  );
}

export function OAuthRows({
  method,
  ports,
}: { method: OAuthMethod; ports: Ports }) {
  return (
    <>
      {method.clientId ? (
        <Plain
          label="Client id"
          fieldKey={`${method.id}:client`}
          value={method.clientId}
          ports={ports}
        />
      ) : null}
      {method.clientSecret ? (
        <Concealed
          label="Client secret"
          fieldKey={`${method.id}:secret`}
          value={method.clientSecret}
          ports={ports}
        />
      ) : null}
      {method.tokenUrl ? (
        <Plain
          label="Token URL"
          fieldKey={`${method.id}:url`}
          value={method.tokenUrl}
          ports={ports}
        />
      ) : null}
      {method.scopes ? (
        <FieldRow label="Scopes">
          <span className="frow__value">{method.scopes}</span>
        </FieldRow>
      ) : null}
      {method.refreshToken ? (
        <Concealed
          label="Refresh token"
          fieldKey={`${method.id}:refresh`}
          value={method.refreshToken}
          ports={ports}
        />
      ) : null}
    </>
  );
}

export function AuthenticatorRows({
  method,
  ports,
}: {
  method: AuthenticatorMethod;
  ports: Ports;
}) {
  if (!method.secret) return null;
  const qr = `${method.id}:qr`;
  const code = `${method.id}:code`;
  return (
    <>
      <FieldRow
        label="Authenticator code"
        actions={
          <button
            type="button"
            className={`icon-btn${ports.copied === code ? " is-on" : ""}`}
            onClick={() => {
              void currentTotp(method.secret)
                .then((value) => ports.copy(code, value))
                .catch(() => undefined);
            }}
            aria-label="Copy current code"
            title="Copy current code"
          >
            {ports.copied === code ? (
              <IconCheck size={17} />
            ) : (
              <IconCopy size={17} />
            )}
          </button>
        }
      >
        <TotpCode id={method.id} secret={method.secret} />
      </FieldRow>
      <FieldRow
        label="Setup QR"
        actions={
          <button
            type="button"
            className={`icon-btn${ports.revealed.has(qr) ? " is-on" : ""}`}
            onClick={() => ports.toggle(qr)}
            aria-label={
              ports.revealed.has(qr) ? "Hide setup QR" : "Show setup QR"
            }
            title={ports.revealed.has(qr) ? "Hide setup QR" : "Show setup QR"}
          >
            {ports.revealed.has(qr) ? (
              <IconEyeOff size={17} />
            ) : (
              <IconEye size={17} />
            )}
          </button>
        }
      >
        {ports.revealed.has(qr) ? (
          <div className="detail__totp-qr">
            <QrCode
              value={totpSetupUri(method.secret, {
                label: ports.name || "OpenSesame",
                issuer: "OpenSesame",
              })}
              label="Scan to enroll this authenticator secret in an authenticator app"
              size={144}
            />
          </div>
        ) : (
          <span className="frow__value frow__value--muted">
            Hidden — shows the otpauth enrollment QR.
          </span>
        )}
      </FieldRow>
    </>
  );
}

export type { Ports as MethodRowPorts };
