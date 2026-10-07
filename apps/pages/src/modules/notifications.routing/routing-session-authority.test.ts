import {
  currentSession,
  identitySeams,
} from "@opensesame/app-core/lib/identity.js";
import {
  heldResponse,
  json,
  observe,
  transition,
} from "@opensesame/app-core/lib/member-response-authority.test-support.js";
import { createNotificationRouting } from "@opensesame/app-core/lib/notification-routing/routing.js";
/** PRIVATE UNEXECUTED Pages session publication controls. */
import { expect, it, vi } from "vitest";
import { createRoutingSession } from "./session.js";
const NONCE = "generated_binding_nonce";
function server(hold: Response) {
  let begun = false;
  let heldOnce = false;
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/v1/notification-channels")
      return json({ channels: [{ kind: "telegram", configured: true }] });
    if (
      path === "/v1/notification-channels/bindings" &&
      init?.method === "POST"
    ) {
      begun = true;
      return json({
        challengeId: "generated_challenge",
        nonce: NONCE,
        expiresAt: "2030-01-01T00:00:00.000Z",
        authorizeUrl: "https://generated.example.invalid/authorize",
      });
    }
    if (path === "/v1/notification-channels/bindings") {
      if (begun && !heldOnce) {
        heldOnce = true;
        return hold;
      }
      return json({ bindings: [] });
    }
    if (path === "/v1/notification-preferences") return json({ byClass: {} });
    if (path.startsWith("/v1/notification-preferences/effective?"))
      return json({ steps: [], excluded: [], fanOut: false });
    throw new Error("Unexpected generated routing fixture request");
  });
}
it("does not return a begun nonce from a held second bindings response across fresh recovery", async () => {
  const held = heldResponse(JSON.stringify({ bindings: [] }));
  identitySeams.identityFetch = server(held.response);
  const model = createNotificationRouting();
  await model.load();
  const pending = observe(model.bind("telegram"));
  try {
    await vi.waitFor(() => expect(held.readStarted()).toBe(true), {
      timeout: 1000,
      interval: 10,
    });
    await transition("fresh");
  } finally {
    held.release();
  }
  const result = await pending;
  if (result.ok) expect(result.value.begun).toBeUndefined();
});
it("publishes no old begun nonce after the default session's held second read changes realm", async () => {
  const held = heldResponse(JSON.stringify({ bindings: [] }));
  identitySeams.identityFetch = server(held.response);
  const session = createRoutingSession(
    () => currentSession()?.principalId ?? null,
  );
  try {
    session.ensure();
    await vi.waitFor(() => expect(session.view().busy).toBe(false), {
      timeout: 1000,
      interval: 10,
    });
    expect(
      session.view().state?.channels.some((row) => row.kind === "telegram"),
    ).toBe(true);
    const pending = observe(session.bind("telegram"));
    try {
      await vi.waitFor(() => expect(held.readStarted()).toBe(true), {
        timeout: 1000,
        interval: 10,
      });
      await transition("fresh");
    } finally {
      held.release();
    }
    await pending;
    expect(session.view().begun).toBeNull();
    expect(JSON.stringify(session.view())).not.toContain(NONCE);
  } finally {
    held.release();
    session.dispose();
  }
});
it("same-identity ABA model replacement cannot publish an old bind into a successor view", async () => {
  const held = heldResponse(JSON.stringify({ bindings: [] }));
  const fetch = server(held.response);
  let who: string | null = "generated_owner";
  const session = createRoutingSession(() => who, {
    fetch,
    signedIn: () => who !== null,
  });
  try {
    session.ensure();
    await vi.waitFor(() => expect(session.view().busy).toBe(false), {
      timeout: 1000,
      interval: 10,
    });
    const pending = observe(session.bind("telegram"));
    try {
      await vi.waitFor(() => expect(held.readStarted()).toBe(true), {
        timeout: 1000,
        interval: 10,
      });
      who = null;
      session.ensure();
      who = "generated_owner";
      session.ensure();
    } finally {
      held.release();
    }
    await pending;
    await vi.waitFor(() => expect(session.view().busy).toBe(false), {
      timeout: 1000,
      interval: 10,
    });
    expect(session.view().begun).toBeNull();
    expect(JSON.stringify(session.view())).not.toContain(NONCE);
  } finally {
    held.release();
    session.dispose();
  }
});
it("preserves a current default session's exact begun nonce and authorization URL", async () => {
  identitySeams.identityFetch = server(json({ bindings: [] }));
  const session = createRoutingSession(
    () => currentSession()?.principalId ?? null,
  );
  try {
    session.ensure();
    await vi.waitFor(() => expect(session.view().busy).toBe(false), {
      timeout: 1000,
      interval: 10,
    });
    await session.bind("telegram");
    expect(session.view().begun).toMatchObject({
      nonce: NONCE,
      authorizeUrl: "https://generated.example.invalid/authorize",
    });
  } finally {
    session.dispose();
  }
});

it("same principal after fresh owner recovery does not admit the original load refusal", async () => {
  const held = heldResponse(
    JSON.stringify({ channels: [{ kind: "telegram", configured: true }] }),
  );
  const fetch = server(json({ bindings: [] }));
  identitySeams.identityFetch = vi.fn(
    async (path: string, init?: RequestInit) =>
      path === "/v1/notification-channels" ? held.response : fetch(path, init),
  );
  const session = createRoutingSession(
    () => currentSession()?.principalId ?? null,
  );
  try {
    session.ensure();
    await vi.waitFor(() => expect(held.readStarted()).toBe(true), {
      timeout: 1000,
      interval: 10,
    });
    await transition("fresh");
    held.release();
    await vi.waitFor(() => expect(session.view().busy).toBe(false), {
      timeout: 1000,
      interval: 10,
    });
    expect(session.view().state).toBeNull();
    expect(session.view().begun).toBeNull();
    // This bounded originating-operation refusal is authored by the session,
    // not an error from the retired model's load/body or a successor adoption.
    expect(session.view().error).toBe("Session changed. Try again.");
  } finally {
    held.release();
    session.dispose();
  }
});
