/** @vitest-environment jsdom */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { NativeConnectorFields } from "./NativeConnectorFields.js";
import {
  NativeProviderInstructions,
  nativeProviderInstructionText,
} from "./NativeProviderInstructions.js";
import {
  nativeInitialValues,
  nativeMethodForEdit,
} from "./native-connector-edit-values.js";
import { nativeNextValues } from "./native-connector-ui-values.js";
import type { NativeMethodDescriptor } from "./native-connector-ui.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

afterEach(cleanup);

it("keeps status help readable without rendering link targets or Markdown controls", () => {
  expect(
    nativeProviderInstructionText(
      "Open [Railway](https://railway.com/account/tokens), select **No workspace**, use `listIndexes`.",
    ),
  ).toBe("Open Railway, select No workspace, use listIndexes.");
});

it("renders safe official links, emphasis and code without exposing Markdown syntax", () => {
  render(
    <NativeProviderInstructions
      text="Open [Railway](https://railway.com/account/tokens), select **No workspace**, and use `listIndexes`."
      origins={["https://railway.com"]}
    />,
  );
  const link = screen.getByRole("link", { name: "Railway" });
  expect(link.getAttribute("href")).toBe("https://railway.com/account/tokens");
  expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  expect(screen.getByText("No workspace").tagName).toBe("STRONG");
  expect(screen.getByText("listIndexes").tagName).toBe("CODE");
  expect(document.body.textContent).not.toMatch(/\*\*|`|\[Railway\]/);
});

it("denies unreviewed origins, active schemes and embedded credentials", () => {
  render(
    <NativeProviderInstructions
      text="[Active](javascript:alert(1)) [Credentials](https://user:password@railway.com/x) [Other](https://unreviewed.example/x) [HTTP](http://railway.com/x)"
      origins={["https://railway.com"]}
    />,
  );
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(document.body.textContent).not.toContain("password");
});

it("keeps raw HTML inert and requires explicit link authority", () => {
  render(
    <NativeProviderInstructions text='<img src=x onerror="alert(1)"> [Railway](https://railway.com/account/tokens)' />,
  );
  expect(document.querySelector("img")).toBeNull();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(document.body.textContent).toContain("<img");
});

it("changes the actual compiled Railway setup guide with the selected credential type", async () => {
  const plan = connectPlan("railway");
  if (!plan) throw new Error("Railway compiled contract missing");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: true },
    oauth: { available: false },
    mcp: { available: false, actor: "user" },
  });
  const method = descriptor.methods.find((entry) => entry.id === "api-key");
  if (!method) throw new Error("Railway API contract missing");
  expect(method.available).toBe(false);
  render(<ReadOnlyContractFields method={method} />);
  await userEvent.click(screen.getByText("Provider setup guide"));
  expect(screen.getByText("No workspace")).toBeDefined();
  await userEvent.selectOptions(
    screen.getByLabelText("Credential type"),
    "workspace",
  );
  expect(screen.queryByText("No workspace")).toBeNull();
  expect(
    screen.getByText(/This token can access only that workspace’s resources/),
  ).toBeDefined();
  expect(
    screen
      .getByRole("link", { name: "Railway Account → Tokens" })
      .getAttribute("href"),
  ).toBe("https://railway.com/account/tokens");
  await userEvent.selectOptions(
    screen.getByLabelText("Credential type"),
    "project",
  );
  expect(screen.getByText("project settings → Tokens")).toBeDefined();
  expect(
    screen.queryByText(/This token can access only that workspace’s resources/),
  ).toBeNull();
});

/** Reviewing a compiled contract does not authorize its blocked browser route. */
function ReadOnlyContractFields({
  method,
}: { method: NativeMethodDescriptor }) {
  const [values, setValues] = useState(() => nativeInitialValues(method));
  return (
    <NativeConnectorFields
      method={nativeMethodForEdit(method, null, values)}
      values={values}
      scopes={{}}
      onValue={(id, value) =>
        setValues(nativeNextValues(method.fields, values, id, value))
      }
      onScopes={() => {}}
    />
  );
}
