/**
 * A key one press arms and a second press fires, with a keep beside it while
 * armed that hands focus back to the key it disarmed — the way every
 * destructive key in Identity behaves.
 */

import { type ReactNode, useRef } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import type { Armed, TailnetModel } from "./use-tailnet-admin.js";

export function ArmedKey({
  model,
  arm,
  label,
  confirmLabel,
  keepLabel,
  onConfirm,
  children,
}: {
  model: TailnetModel;
  arm: Armed;
  label: string;
  confirmLabel: string;
  keepLabel: string;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const primary = useRef<HTMLButtonElement>(null);
  const { armed, setArmed, busy } = model;
  const isArmed = armed?.action === arm.action && armed.id === arm.id;
  return (
    <>
      <IconKey
        keyRef={primary}
        label={isArmed ? confirmLabel : label}
        small
        armed={isArmed}
        disabled={busy}
        onClick={() => (isArmed ? onConfirm() : setArmed(arm))}
      >
        {children}
      </IconKey>
      {isArmed ? (
        <IconKey
          label={keepLabel}
          small
          disabled={busy}
          onClick={() => {
            setArmed(null);
            primary.current?.focus();
          }}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
    </>
  );
}
