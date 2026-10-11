import type { IssuedRoot } from "@opensesame/app-core/lib/model-keys/broker.js";
import { useEffect, useRef, useState } from "react";
import { IconKey } from "../../../../components/IconKey.js";
import { IconCopy } from "../../../../components/Icons.js";
import { StatusMark } from "../../../../components/StatusMark.js";
import { useCopySecret } from "../../../../lib/vault/hooks.js";

type Props = Readonly<{
  issued: IssuedRoot;
  lifetime: string;
}>;

/** The key as it is shown once, with its copy key; closing the sheet forgets it. */
export function IssuedKey({ issued, lifetime }: Props) {
  const copy = useCopySecret();
  const [said, setSaid] = useState("");
  const copyRef = useRef<HTMLButtonElement>(null);
  // The key that made this one is gone; focus goes to the thing to do with it.
  useEffect(() => {
    copyRef.current?.focus();
  }, []);
  return (
    <>
      <div className="f">
        <div className="f__labelrow">
          <span className="f__label" id="model-key-token-label">
            Key
          </span>
          {said ? <StatusMark tone="ok" label={said} /> : null}
        </div>
        <div className="f__shell mkey__token">
          <code
            className="mkey__token-text"
            data-testid="model-key-token"
            aria-labelledby="model-key-token-label"
          >
            {issued.token}
          </code>
          <span className="f__tail">
            <IconKey
              label="Copy the key"
              keyRef={copyRef}
              small
              onClick={() =>
                void copy(issued.token).then((result) =>
                  setSaid(
                    result === "copied"
                      ? "Copied"
                      : "The clipboard is unavailable",
                  ),
                )
              }
            >
              <IconCopy size={15} />
            </IconKey>
          </span>
        </div>
      </div>
      <p className="vexport__marks">
        <StatusMark tone="warn" label={`Shown once. Ends in ${lifetime}.`} />
      </p>
    </>
  );
}
