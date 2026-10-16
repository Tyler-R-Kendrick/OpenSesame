/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, StrictMode, useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useNativeSignInUiLifetime } from "./NativeCancelSignIn.js";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import { NativeConnectorSummary } from "./NativeConnectorSummary.js";
import type { NativeAuthorizationTicket } from "./native-connector-controller.js";
import {
  nativeUiController,
  nativeUiDescriptor,
  nativeUiView,
} from "./native-connector-ui.test-support.js";

afterEach(cleanup);

function button(name: string) {
  return screen.getByRole("button", { name });
}

function summary(props: ComponentProps<typeof NativeConnectorSummary>) {
  return <NativeConnectorSummary {...props} />;
}

function form(
  props: ComponentProps<typeof NativeConnectorForm> & { key?: string },
) {
  return <NativeConnectorForm {...props} />;
}

function signInDescriptor() {
  const descriptor = nativeUiDescriptor();
  descriptor.methods = [
    {
      id: "oauth",
      label: "Sign in",
      authorizeFirst: true,
      available: true,
      fields: [],
      scopeGroups: [],
    },
  ];
  return descriptor;
}

it("cancels the pending provider sign-in from its originating form and allows another attempt", async () => {
  const controller = nativeUiController();
  const done = deferred<ReturnType<typeof nativeUiView>>();
  controller.connect.mockImplementation(() => done.promise);
  controller.cancelAuthorization.mockImplementation(() =>
    done.reject(new Error("Sign-in cancelled")),
  );
  const onFlash = vi.fn();
  const onChanged = vi.fn();
  render(
    <NativeConnectorForm
      descriptor={signInDescriptor()}
      controller={controller}
      onFlash={onFlash}
      onChanged={onChanged}
    />,
  );
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await userEvent.click(button("Sign in to Algolia"));
  expect(button("Sign in to Algolia")).toHaveProperty("disabled", true);
  expect(button("Cancel sign-in").parentElement).toBe(
    button("Sign in to Algolia").parentElement,
  );
  await userEvent.click(button("Cancel sign-in"));
  expect(controller.cancelAuthorization).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull(),
  );
  expect(button("Sign in to Algolia")).toHaveProperty("disabled", false);
  expect(onChanged).toHaveBeenCalledOnce();
  expect(onFlash).not.toHaveBeenCalledWith(
    expect.objectContaining({ tone: "ok" }),
  );
});

it("cancels consent renewal without offering cancellation for a separate access check", async () => {
  const view = renewalView();
  const controller = nativeUiController(view);
  const done = deferred<void>();
  controller.authorize.mockImplementation(() => done.promise);
  controller.cancelAuthorization.mockImplementation(() =>
    done.reject(new Error("Sign-in cancelled")),
  );
  render(
    <NativeConnectorSummary
      descriptor={signInDescriptor()}
      controller={controller}
      view={view}
      onFlash={vi.fn()}
      onChanged={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  await userEvent.click(button("Authorize Algolia"));
  await userEvent.click(button("Cancel sign-in"));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull(),
  );
  expect(controller.cancelAuthorization).toHaveBeenCalledOnce();
  let finish: ((value: ReturnType<typeof nativeUiView>) => void) | undefined;
  controller.verify.mockImplementation(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  await userEvent.click(button("Verify Algolia access"));
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  expect(controller.remove).not.toHaveBeenCalled();
  finish?.(view);
  await waitFor(() =>
    expect(button("Verify Algolia access")).toHaveProperty("disabled", false),
  );
});

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<T>((done, refused) => {
    resolve = done;
    reject = refused;
  });
  return { promise, resolve, reject };
}

function callbacks() {
  return { onChanged: vi.fn(), onFlash: vi.fn(), onRemoved: vi.fn() };
}

function renewalView() {
  const view = nativeUiView();
  view.status = "reauthorize";
  view.verifiedAt = null;
  view.configuration.method = "oauth";
  return view;
}

it("projects only the exact ticket into the commit row even without an available replacement method", async () => {
  const controller = nativeUiController();
  const descriptor = signInDescriptor();
  descriptor.methods = descriptor.methods.map((method) => ({
    ...method,
    available: false,
  }));
  const a: NativeAuthorizationTicket = {
    method: "oauth",
    current: () => true,
    cancel: vi.fn(),
  };
  const b = { ...a, cancel: vi.fn() };
  const props = {
    descriptor,
    controller,
    view: nativeUiView(),
    ...callbacks(),
  };
  const pair = (authorization: NativeAuthorizationTicket | null) => (
    <>
      <NativeConnectorForm {...props} authorization={authorization} />
      <NativeConnectorSummary {...props} authorization={authorization} />
    </>
  );
  const mounted = render(pair(a));
  const cancel = button("Cancel sign-in");
  expect(
    screen.getAllByRole("button", { name: "Cancel sign-in" }),
  ).toHaveLength(1);
  expect(cancel.parentElement?.classList.contains("go-row")).toBe(true);
  expect(cancel).toHaveProperty("disabled", false);
  expect(button("Sign in to Algolia")).toHaveProperty("disabled", true);
  expect(button("Remove connector")).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("img", { name: "Algolia access verified" }),
  ).toBeTruthy();
  mounted.rerender(pair(b));
  await userEvent.click(button("Cancel sign-in"));
  expect(a.cancel).not.toHaveBeenCalled();
  expect(b.cancel).toHaveBeenCalledOnce();
  expect(controller.cancelAuthorization).not.toHaveBeenCalled();
  mounted.rerender(pair(null));
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  expect(button("Remove connector")).toHaveProperty("disabled", false);
});

it.each(["form", "summary"] as const)(
  "accepts current %s completion after normal close-ticket retirement",
  async (kind) => {
    const view = renewalView();
    const controller = nativeUiController(view);
    const done = deferred<typeof view>();
    controller.connect.mockImplementation(() => done.promise);
    controller.authorize.mockImplementation(async () => {
      await done.promise;
    });
    const props = {
      descriptor: signInDescriptor(),
      controller,
      ...callbacks(),
    };
    const ticket: NativeAuthorizationTicket = {
      method: "oauth",
      current: () => true,
      cancel: vi.fn(),
    };
    const content = (authorization: NativeAuthorizationTicket | null) =>
      kind === "form"
        ? form({ ...props, authorization })
        : summary({ ...props, view, authorization });
    const mounted = render(content(null));
    await userEvent.click(
      button(kind === "form" ? "Sign in to Algolia" : "Authorize Algolia"),
    );
    mounted.rerender(content(ticket));
    mounted.rerender(content(null));
    await act(async () => {
      done.resolve(view);
      await done.promise;
    });
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(controller.load).toHaveBeenCalledOnce();
    expect(props.onFlash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    );
  },
);

it.each(["success", "failure"] as const)(
  "ignores old form %s after keyed replacement and resets secret fields",
  async (outcome) => {
    const descriptor = signInDescriptor();
    descriptor.methods = [
      {
        ...descriptor.methods[0],
        fields: [
          {
            id: "secret",
            label: "Private test credential",
            kind: "text",
            secret: true,
            required: false,
          },
        ],
      },
    ];
    const a = nativeUiController();
    const b = nativeUiController();
    const done = deferred<ReturnType<typeof nativeUiView>>();
    a.connect.mockImplementation(() => done.promise);
    const old = callbacks();
    const mounted = render(
      form({ key: "A", descriptor, controller: a, ...old }),
    );
    await userEvent.type(
      screen.getByLabelText("Private test credential"),
      "local-only-test-secret",
    );
    await userEvent.click(button("Sign in to Algolia"));
    mounted.rerender(
      form({ key: "B", descriptor, controller: b, ...callbacks() }),
    );
    expect(screen.getByLabelText("Private test credential")).toHaveProperty(
      "value",
      "",
    );
    await act(async () => {
      if (outcome === "success") done.resolve(nativeUiView());
      else done.reject(new Error("Old form refused"));
      await Promise.allSettled([done.promise]);
    });
    expect(old.onChanged).not.toHaveBeenCalled();
    expect(old.onFlash).not.toHaveBeenCalled();
    expect(a.load).not.toHaveBeenCalled();
  },
);

it.each(["controller", "provider", "revision", "roads"] as const)(
  "does not let old summary completion affect B after a same-mounted %s change",
  async (change) => {
    const view = renewalView();
    const a = nativeUiController(view);
    const b = change === "controller" ? nativeUiController(view) : a;
    const old = deferred<void>();
    const next = deferred<void>();
    a.authorize.mockImplementationOnce(() => old.promise);
    b.authorize.mockImplementationOnce(() => next.promise);
    const before = callbacks();
    const after = callbacks();
    const descriptor = signInDescriptor();
    const mounted = render(
      summary({ descriptor, view, controller: a, ...before }),
    );
    await userEvent.click(button("Authorize Algolia"));
    const replacement = {
      ...view,
      revision: change === "revision" ? 2 : view.revision,
    };
    const changedDescriptor = {
      ...descriptor,
      providerId:
        change === "provider" ? "replacement-provider" : descriptor.providerId,
      methods:
        change === "roads"
          ? [
              ...descriptor.methods,
              {
                ...descriptor.methods[0],
                id: "oidc" as const,
                available: false,
              },
            ]
          : descriptor.methods,
    };
    mounted.rerender(
      summary({
        descriptor: changedDescriptor,
        view: replacement,
        controller: b,
        ...after,
      }),
    );
    expect(button("Authorize Algolia")).toHaveProperty("disabled", false);
    await userEvent.click(button("Authorize Algolia"));
    await act(async () => {
      if (change === "revision")
        old.reject(new Error("Stale summary revision failed"));
      else old.resolve();
      await Promise.allSettled([old.promise]);
    });
    expect(before.onChanged).not.toHaveBeenCalled();
    expect(before.onFlash).not.toHaveBeenCalled();
    expect(a.load).not.toHaveBeenCalled();
    expect(button("Authorize Algolia")).toHaveProperty("disabled", true);
    expect(button("Cancel sign-in")).toBeTruthy();
    await act(async () => {
      next.resolve();
      await next.promise;
    });
    expect(after.onChanged).toHaveBeenCalledOnce();
  },
);

it("does not publish nested removal success after the same-mounted owner changed", async () => {
  const view = nativeUiView();
  const a = nativeUiController(view);
  const b = nativeUiController(view);
  const done = deferred<void>();
  a.remove.mockImplementation(() => done.promise);
  const before = callbacks();
  const after = callbacks();
  const descriptor = nativeUiDescriptor();
  const mounted = render(
    summary({ descriptor, view, controller: a, ...before }),
  );
  await userEvent.click(button("Remove connector"));
  await userEvent.click(button("Confirm remove connector"));
  mounted.rerender(summary({ descriptor, view, controller: b, ...after }));
  await act(async () => {
    done.resolve();
    await done.promise;
  });
  expect(before.onRemoved).not.toHaveBeenCalled();
  expect(before.onFlash).not.toHaveBeenCalled();
  expect(before.onChanged).not.toHaveBeenCalled();
  expect(a.load).not.toHaveBeenCalled();
  expect(button("Remove connector")).toHaveProperty("disabled", false);
  expect(b.remove).not.toHaveBeenCalled();
});

it("never revives a capture across actual StrictMode effect replay", () => {
  const captures: ReturnType<
    ReturnType<typeof useNativeSignInUiLifetime>["begin"]
  >[] = [];
  const controller = nativeUiController();
  const descriptor = signInDescriptor();
  function Probe() {
    const lifetime = useNativeSignInUiLifetime({ controller, descriptor });
    useEffect(() => {
      captures.push(lifetime.begin());
    }, [lifetime.begin]);
    return null;
  }
  render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );
  expect(captures).toHaveLength(2);
  expect(captures[0]?.current()).toBe(false);
  expect(captures[1]?.current()).toBe(true);
  captures[0]?.finish();
  expect(captures[1]?.current()).toBe(true);
});
