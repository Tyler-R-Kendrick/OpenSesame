import {
  clearRetiredCredentialEvents,
  enrollRetiredCredential,
  refreshRetiredCredentialStatus,
  removeRetiredCredential,
} from "../../lib/retired-credentials/index.js";
import { PERSONAL_TOMB } from "../../lib/vfs.js";
import { action, element, secret } from "./dom.js";

/** Settings are shown only after owner admission; mutations still prove the current password. */
export async function enrollmentPanel(say: (words: string) => void) {
  const root = element("section");
  root.append(
    element("h3", "Retired credential traps"),
    element(
      "p",
      "Choose up to three retired vault passwords. Record and reject is the default. Synthetic routing opens an isolated example vault; it never freezes or wipes your real vault.",
    ),
  );
  const { current, retired, response, risk, acknowledgment } = formFields();
  const list = element("ul");
  const events = element("p");
  const refresh = async () => {
    const status = await refreshRetiredCredentialStatus(PERSONAL_TOMB);
    list.replaceChildren(
      ...status.traps.map((trap) => {
        const row = element("li", `${trap.createdAt} · ${trap.response}`);
        row.append(
          action(
            "Remove trap",
            async () => {
              try {
                await removeRetiredCredential({
                  tomb: PERSONAL_TOMB,
                  currentPassword: current.input.value,
                  id: trap.id,
                });
              } finally {
                current.input.value = "";
              }
              await refresh();
            },
            say,
          ),
        );
        return row;
      }),
    );
    events.textContent = `Local observations: ${status.events.length}. ${status.durable ? "Stored on this device." : "Persistent storage unavailable."}`;
    for (const observation of status.events)
      events.append(element("br"), `${observation.at} · ${observation.type}`);
  };
  const enroll = action(
    "Enroll retired password",
    async () => {
      try {
        await enrollRetiredCredential({
          tomb: PERSONAL_TOMB,
          currentPassword: current.input.value,
          retiredPassword: retired.input.value,
          response:
            response.value === "synthetic_decoy" ? "synthetic_decoy" : "reject",
          acknowledgePasswordVerifierRisk: risk.checked,
        });
      } finally {
        current.input.value = "";
        retired.input.value = "";
      }
      say("Retired credential trap enrolled.");
      await refresh();
    },
    say,
  );
  const clear = action(
    "Clear local observations",
    async () => {
      try {
        await clearRetiredCredentialEvents({
          tomb: PERSONAL_TOMB,
          currentPassword: current.input.value,
        });
      } finally {
        current.input.value = "";
      }
      await refresh();
    },
    say,
  );
  root.append(
    current.wrapper,
    retired.wrapper,
    response,
    acknowledgment,
    enroll,
    list,
    events,
    clear,
  );
  await refresh();
  return root;
}

function formFields() {
  const current = secret("Current vault password");
  const retired = secret("Retired vault password");
  const response = element("select");
  response.append(
    new Option("Record and reject", "reject"),
    new Option("Open synthetic vault", "synthetic_decoy"),
  );
  response.setAttribute("aria-label", "Retired password response");
  const risk = element("input");
  risk.type = "checkbox";
  const acknowledgment = element(
    "label",
    "I understand retained verifiers allow offline password guessing and may expose passwords reused elsewhere.",
  );
  acknowledgment.prepend(risk);
  return { current, retired, response, risk, acknowledgment };
}
