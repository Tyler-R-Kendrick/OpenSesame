import { type VaultItem, definitionFor } from "@opensesame/vault-core";
import { AccountDetail } from "./AccountDetail.js";
import { CredentialDetail } from "./CredentialDetail.js";
import {
  CardFields,
  CertificateFields,
  PasskeyFields,
  SecretFields,
} from "./ItemFieldRows.js";
import { TypedFieldRows, UnknownTypeRows } from "./TypedFields.js";
import { KindRecord } from "./item-contributions.js";

type FieldsProps = {
  item: VaultItem;
  revealed: Set<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
  onUpdateSecret: (next: string) => Promise<void>;
};

export function ItemFields({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
  onUpdateSecret,
}: FieldsProps) {
  const ports = { revealed, toggle, copied, failed, copy };
  switch (item.kind) {
    case "account":
      return <AccountDetail key={item.id} item={item} {...ports} />;

    case "credential":
      return (
        <CredentialDetail
          key={item.id}
          item={item}
          ports={{ name: item.name, ...ports }}
        />
      );

    case "passkey":
      return <PasskeyFields item={item} {...ports} />;

    case "card":
      return <CardFields item={item} {...ports} />;

    case "secret":
      return (
        <SecretFields item={item} {...ports} onUpdateSecret={onUpdateSecret} />
      );

    case "drop":
      return <KindRecord item={item} />;

    case "note":
      return (
        <section className="detail__group">
          <h2 className="detail__grouphead">Note</h2>
          <div className="frow">
            <p className="frow__notes">{item.notes || "This note is empty."}</p>
          </div>
        </section>
      );

    case "typed": {
      const definition = definitionFor(item);
      if (definition === undefined) {
        return (
          <UnknownTypeRows
            typeId={item.typeId}
            values={item.values}
            revealed={revealed}
            toggle={toggle}
          />
        );
      }
      return (
        <TypedFieldRows
          definition={definition}
          values={item.values}
          revealed={revealed}
          toggle={toggle}
          copied={copied}
          failed={failed}
          copy={copy}
        />
      );
    }

    case "certificate":
      return <CertificateFields item={item} {...ports} />;
  }
}
