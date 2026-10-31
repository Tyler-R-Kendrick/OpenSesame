import { expect, it } from "vitest";
import { offlineAppRequests } from "./offline-app-requests.mjs";
const origin = "http://localhost:41911";
const base = "/OpenSesame/";
function request(
  path,
  method = "GET",
  errorText = "net::ERR_CONNECTION_REFUSED",
) {
  return {
    url: () => new URL(path, origin).href,
    method: () => method,
    failure: () => ({ errorText }),
  };
}
it("accounts for only owned app GET fallbacks started during intentional offline cold load", () => {
  const policy = offlineAppRequests(origin, base);
  const before = request(`${base}capability-graph.json`);
  policy.observe(before);
  policy.begin();
  expect(policy.expected(before)).toBe(false);
  for (const path of [
    "settings/connections/tailscale",
    "os-runtime-config.json",
    "capability-graph.json",
  ]) {
    const current = request(`${base}${path}`);
    policy.observe(current);
    expect(policy.expected(current)).toBe(true);
    policy.end();
    expect(policy.expected(current)).toBe(false);
    policy.begin();
  }
});
it.each([
  ["https://control.fixture.test/OpenSesame/capability-graph.json"],
  ["http://localhost:41912/OpenSesame/capability-graph.json"],
  ["http://user:pass@localhost:41911/OpenSesame/capability-graph.json"],
  ["/other/capability-graph.json"],
  ["/OpenSesame/assets/missing.js"],
  ["/OpenSesame/capability-graph.json?unowned=1"],
  ["/OpenSesame/capability-graph.json#fragment"],
  ["/OpenSesame/capability-graph.json", "POST"],
  ["/OpenSesame/capability-graph.json", "GET", "net::ERR_FAILED"],
])("keeps unexpected request failures actionable: %s %s %s", (...args) => {
  const policy = offlineAppRequests(origin, base);
  const current = request(...args);
  policy.begin();
  policy.observe(current);
  expect(policy.expected(current)).toBe(false);
});
