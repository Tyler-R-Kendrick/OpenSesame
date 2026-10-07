import { loginWebsiteLink } from "@opensesame/app-core/lib/vault/website-pattern.js";
import { type AccountItem, hostOf } from "@opensesame/vault-core";
import { SessionAnchor } from "../../components/DecoyNavigationAnchor.js";
import { CopyButton, FieldRow } from "../../components/FieldRow.js";
import { IconExternal } from "../../components/Icons.js";

/** The sites an account lives at, each with its match rule, an open key and a copy key. */
export function AccountWebsiteRows({
  item,
  copying: { copied, failed, copy },
}: {
  item: AccountItem;
  copying: {
    copied: string | null;
    failed: string | null;
    copy: (key: string, value: string) => Promise<void>;
  };
}) {
  if (item.uris.length === 0) return null;
  return (
    <>
      <section className="detail__group">
        <h2 className="detail__grouphead">Websites</h2>
        {item.uris.map((uri) => {
          const href = loginWebsiteLink(uri);
          return (
            <FieldRow
              key={uri.id}
              label={`Match: ${uri.match === "domain" || uri.match === "host" ? hostOf(uri.uri) : uri.match}`}
              actions={
                <>
                  {href ? (
                    <SessionAnchor
                      className="icon-btn"
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`Open ${hostOf(uri.uri) || uri.uri}`}
                      title="Open in a new tab"
                    >
                      <IconExternal size={17} />
                    </SessionAnchor>
                  ) : null}
                  <CopyButton
                    value={uri.uri}
                    label="address"
                    fieldKey={`uri-${uri.id}`}
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                </>
              }
            >
              <span className="frow__value">{uri.uri}</span>
            </FieldRow>
          );
        })}
      </section>
    </>
  );
}
