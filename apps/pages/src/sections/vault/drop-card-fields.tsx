import { isDeviceIdentityMode } from "@opensesame/app-core/lib/device-identity.js";
import type { ReactNode } from "react";
import { CopyButton, FieldRow } from "../../components/FieldRow.js";
import { QrCode } from "../../components/QrCode.js";

export type DropCardCopyFeedback = {
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
};

type DropCopyProps = DropCardCopyFeedback & {
  label: string;
  value: string;
  fieldKey: string;
  copyLabel: string;
  children: ReactNode;
};

function DropCopyFieldRow({
  label,
  value,
  fieldKey,
  copyLabel,
  copied,
  failed,
  copy,
  children,
}: DropCopyProps) {
  return (
    <FieldRow
      label={label}
      actions={
        <CopyButton
          value={value}
          label={copyLabel}
          fieldKey={fieldKey}
          copied={copied}
          failed={failed}
          onCopy={copy}
        />
      }
    >
      {children}
    </FieldRow>
  );
}

export function DropCardUsername({ username }: { username: string }) {
  if (username === "") return null;
  return (
    <FieldRow label="Username">
      <span className="frow__value">{username}</span>
    </FieldRow>
  );
}

export function DropCardLinkRow({
  link,
  copy,
}: {
  link: string;
  copy: DropCardCopyFeedback;
}) {
  return (
    <DropCopyFieldRow
      label="Link"
      value={link}
      fieldKey="drop-link"
      copyLabel="drop link"
      {...copy}
    >
      <span className="frow__value frow__value--mono drop-card__link">
        {link}
      </span>
    </DropCopyFieldRow>
  );
}

export function DropCardUserCodeRow({
  userCode,
  copy,
}: {
  userCode: string;
  copy: DropCardCopyFeedback;
}) {
  return (
    <DropCopyFieldRow
      label="User code"
      value={userCode}
      fieldKey="drop-code"
      copyLabel="user code"
      {...copy}
    >
      <span className="frow__value frow__value--mono">{userCode}</span>
    </DropCopyFieldRow>
  );
}

export function DropCardShareTextRow({
  clipboard,
  passwordInCopy,
  copy,
}: {
  clipboard: string;
  passwordInCopy: boolean;
  copy: DropCardCopyFeedback;
}) {
  if (clipboard === "") return null;
  return (
    <DropCopyFieldRow
      label="Share text"
      value={clipboard}
      fieldKey="drop-share-text"
      copyLabel="share text"
      {...copy}
    >
      <span className="frow__value frow__value--mono">Sealed in this drop</span>
      {passwordInCopy ? (
        <span className="hint">Contains the password.</span>
      ) : null}
    </DropCopyFieldRow>
  );
}

export function DropCardMetaRows({
  opensFor,
  expiresLabel,
  portable,
}: {
  opensFor: string;
  expiresLabel: string;
  /** A portable bearer opens in any browser; anything else claims locally. */
  portable: boolean;
}) {
  return (
    <>
      {opensFor !== "" ? (
        <FieldRow label={portable ? "Suggested window" : "Opens for"}>
          <span className="frow__value">{opensFor}</span>
        </FieldRow>
      ) : null}
      {portable || isDeviceIdentityMode() ? (
        <FieldRow label="Opens on">
          <span className="frow__value">
            {portable ? "Any browser with the link and code" : "This browser"}
          </span>
        </FieldRow>
      ) : null}
      <FieldRow label={portable ? "Suggested expiry" : "Expires"}>
        <span className="frow__value">{expiresLabel}</span>
      </FieldRow>
      {portable ? (
        <p className="hint">
          A saved link and code can reopen this copy after that time. It cannot
          be revoked.
        </p>
      ) : null}
    </>
  );
}

export function DropCardQr({ link }: { link: string }) {
  return (
    <div className="drop-card__qr">
      <QrCode value={link} label="Scan to open this drop" size={144} />
    </div>
  );
}
