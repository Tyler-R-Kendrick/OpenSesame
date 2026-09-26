/**
 * Settings › Notifications' half of the stand-in Identity API (ADR 0084;
 * ADR 0140 plan step 11): the channel listing, one destination, the
 * preferences and one effective route per class, planned the way
 * `planNotificationRoute` plans it — policy ∩ preference ∩ live bindings ∩
 * configured adapters, the inbox appended, every policy-allowed channel
 * named.
 *
 * Policy here refuses Push for "Someone asks to use your authority" and
 * allows it for security events, so a journey can show a preference
 * narrowing, and the file viewer refusing one that tries to widen.
 */

const POLICY = {
  authorization_request: ["in_app", "telegram", "slack"],
  authorization_decision: ["in_app", "telegram"],
  security_event: ["in_app", "telegram", "native_push"],
};
const CONFIGURED = ["in_app", "telegram", "native_push"];
const BINDS = ["telegram", "slack", "teams", "wechat", "sms", "webhook"];

/** One page's routing state: the preferences and the destinations. */
export function routingState() {
  return {
    byClass: {
      authorization_request: {
        channels: ["telegram", "in_app"],
        fanOut: false,
      },
      // Listed before policy tightened: the route marks it refused.
      authorization_decision: {
        channels: ["native_push", "in_app"],
        fanOut: false,
      },
      security_event: { channels: ["in_app", "telegram"], fanOut: true },
    },
    bindings: [
      {
        id: "bind_evidence",
        kind: "telegram",
        providerId: "telegram",
        displayLabel: "Personal phone",
        state: "active",
        verification: "provider_callback_challenge",
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    ],
  };
}

function plan(state, cls) {
  const allowed = POLICY[cls] ?? ["in_app"];
  const pref = state.byClass[cls] ?? { channels: ["in_app"], fanOut: false };
  const live = state.bindings
    .filter((row) => row.state === "active")
    .map((row) => row.kind);
  const steps = [];
  const excluded = [];
  for (const kind of pref.channels) {
    if (kind === "in_app") continue;
    if (!allowed.includes(kind)) {
      excluded.push({ kind, reason: "not_allowed_by_policy" });
    } else if (!CONFIGURED.includes(kind)) {
      excluded.push({ kind, reason: "adapter_unavailable" });
    } else if (BINDS.includes(kind) && !live.includes(kind)) {
      excluded.push({ kind, reason: "no_active_binding" });
    } else {
      steps.push({ kind, mode: "rendezvous", confidentiality: "minimal" });
    }
  }
  for (const kind of allowed) {
    if (kind !== "in_app" && !pref.channels.includes(kind)) {
      excluded.push({ kind, reason: "not_preferred" });
    }
  }
  steps.push({ kind: "in_app", mode: "interactive", confidentiality: "full" });
  return { steps, fanOut: pref.fanOut, excluded };
}

function bodyOf(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

/** Answer the routing routes; `null` when the call is not one of them. */
export function answerRouting(state, at, search, request) {
  if (at === "GET /v1/notification-channels") {
    return [
      200,
      {
        channels: ["in_app", "telegram", "slack", "native_push"].map(
          (kind) => ({ kind, configured: CONFIGURED.includes(kind) }),
        ),
      },
    ];
  }
  if (at === "GET /v1/notification-channels/bindings") {
    return [200, { bindings: state.bindings }];
  }
  if (at === "POST /v1/notification-channels/bindings") {
    return [
      201,
      {
        challengeId: "chbc_evidence",
        nonce: "tg-link-4821",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    ];
  }
  if (at.startsWith("DELETE /v1/notification-channels/bindings/")) {
    const id = at.split("/").at(-1);
    state.bindings = state.bindings.filter((row) => row.id !== id);
    return [204, null];
  }
  if (at === "GET /v1/notification-preferences") {
    return [200, { byClass: state.byClass }];
  }
  if (at === "PUT /v1/notification-preferences") {
    state.byClass = bodyOf(request).byClass ?? {};
    return [200, { byClass: state.byClass }];
  }
  if (at === "GET /v1/notification-preferences/effective") {
    return [200, plan(state, new URLSearchParams(search).get("class") ?? "")];
  }
  return null;
}

/** Verbs for Settings' file viewer, where a file's pane shares its name. */
export function routingSteps() {
  return {
    /**
     * Bring the element with this id to the middle of the viewport, so a
     * section near the end of a long page is not left under the statusline.
     * Skipped when this build has no such element.
     */
    async centre(page, id) {
      const target = page.locator(`[id="${id}"]`).first();
      if (!(await target.count())) return;
      await target.evaluate((node) => {
        node.scrollIntoView({ block: "center", behavior: "instant" });
      });
      await page.waitForTimeout(600);
    },
    /**
     * Replace an open file's text, the way a person pastes into it: the
     * textarea named by its path. Skipped when this build has no such file.
     */
    async fillFile(page, { path, text }) {
      const field = page.locator(`textarea[aria-label="${path}"]`).first();
      if (!(await field.count())) return;
      await field.fill(text);
      await page.waitForTimeout(600);
    },
  };
}
