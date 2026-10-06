import type {
  ApiKeyMethod,
  AuthenticatorMethod,
  OAuthMethod,
  TokenMethod,
} from "@opensesame/vault-core";
import {
  apiKeyHeaderLine,
  bearerHeaderLine,
  headerName,
  totpSetupUri,
} from "@opensesame/vault-core";
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
 * The credential as one pasteable header line, concealed like the secret in
 * it. Its reveal and copy keys act on the whole line; the rows above it keep
 * the single values.
 */
function HeaderLine({
  label,
  fieldKey,
  line,
  name,
  ports,
}: {
  label: string;
  fieldKey: string;
  line: string;
  /** The line's header, shown in the clear while its value is hidden. */
  name: string;
  ports: Ports;
}) {
  const revealed = ports.revealed.has(fieldKey);
  const lower = label.toLowerCase();
  return (
    <FieldRow
      label={label}
      actions={
        <>
          <RevealButton
            revealed={revealed}
            label={lower}
            onToggle={() => ports.toggle(fieldKey)}
          />
          <CopyButton
            value={line}
            label={lower}
            fieldKey={fieldKey}
            copied={ports.copied}
            failed={ports.failed}
            onCopy={ports.copy}
          />
        </>
      }
    >
      {revealed ? (
        <ConcealedValue value={line} label={lower} revealed />
      ) : (
        <>
          <span className="frow__value frow__value--mono">{name}: </span>
          <ConcealedValue value={line} label={lower} revealed={false} />
        </>
      )}
    </FieldRow>
  );
}

export function ApiKeyRows({
  method,
  ports,
}: { method: ApiKeyMethod; ports: Ports }) {
  const name = headerName(method.header);
  return (
    <>
      {method.key ? (
        <Concealed
          label="API key"
          fieldKey={`${method.id}:key`}
          value={method.key}
          ports={ports}
        />
      ) : (
        <FieldRow label="API key">
          <span className="frow__value frow__value--muted">Not set</span>
        </FieldRow>
      )}
      <Plain
        label="Header"
        fieldKey={`${method.id}:header`}
        value={name}
        ports={ports}
      />
      {method.key ? (
        <HeaderLine
          label="Header with key"
          fieldKey={`${method.id}:line`}
          line={apiKeyHeaderLine(method.header, method.key)}
          name={name}
          ports={ports}
        />
      ) : null}
    </>
  );
}

export function TokenRows({
  method,
  ports,
}: { method: TokenMethod; ports: Ports }) {
  return (
    <>
      {method.token ? (
        <>
          <Concealed
            label="Token"
            fieldKey={`${method.id}:token`}
            value={method.token}
            ports={ports}
          />
          <HeaderLine
            label="Bearer header"
            fieldKey={`${method.id}:line`}
            line={bearerHeaderLine(method.token)}
            name="Authorization"
            ports={ports}
          />
        </>
      ) : (
        <FieldRow label="Token">
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
