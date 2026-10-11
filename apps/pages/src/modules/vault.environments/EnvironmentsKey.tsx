/**
 * The vault path strip's Environments key (`vault.environments`), and on a
 * phone the same flow as one of the Add button's other ways to add. The sheet
 * is addressed by the vault's own address, `/vault?environments=1`, so a
 * notice can open it, Back closes it, and a link can be sent.
 */

import { ENVIRONMENTS_QUERY } from "@opensesame/app-core/lib/vault/environments.js";
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { IconKey } from "../../components/IconKey.js";
import { IconLayers } from "../../components/Icons.js";
import { useAddEntry } from "../../sections/vault/add-menu.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { EnvironmentsSheet } from "./EnvironmentsSheet.js";

function useEnvironmentsFlow() {
  const [params, setParams] = useSearchParams();
  const open = params.get(ENVIRONMENTS_QUERY) !== null;
  const show = useCallback(() => {
    const next = new URLSearchParams(params);
    next.set(ENVIRONMENTS_QUERY, "1");
    setParams(next);
  }, [params, setParams]);
  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete(ENVIRONMENTS_QUERY);
    setParams(next, { replace: true });
  }, [params, setParams]);
  return {
    open,
    show,
    element: open ? <EnvironmentsSheet onClose={close} /> : null,
  };
}

export function EnvironmentsKey() {
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.environments");
  const flow = useEnvironmentsFlow();
  return (
    <>
      <IconKey
        keyRef={guideRef}
        small
        label="Environments"
        aria-haspopup="dialog"
        aria-expanded={flow.open}
        onClick={flow.show}
      >
        <IconLayers size={15} />
      </IconKey>
      {flow.element}
    </>
  );
}

export function EnvironmentsEntry() {
  const flow = useEnvironmentsFlow();
  useAddEntry({
    id: "environments",
    label: "Environments",
    order: 20,
    run: flow.show,
  });
  return flow.element;
}
