import type { LocalApplication } from "@opensesame/app-core/lib/local-applications.js";
import { ApplicationDiagnostics } from "./ApplicationDiagnostics.js";
import { ApplicationRecipePanel } from "./ApplicationRecipePanel.js";

export function RegistrationExtras(props: {
  tomb: string;
  registration: LocalApplication | undefined;
  revision: number | undefined;
  onApplied?: () => void;
}) {
  return (
    <>
      <ApplicationRecipePanel
        registration={props.registration}
        tomb={props.tomb}
        revision={props.revision}
        onApplied={props.onApplied}
      />
      <ApplicationDiagnostics
        policy={props.registration?.scopeRoles}
        policyRevision={String(props.revision ?? 0)}
      />
    </>
  );
}
