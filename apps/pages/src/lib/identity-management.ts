import {
  AgentResponseSchema,
  RegisterAgentResponseSchema,
} from "@opensesame/contracts";
import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { call } from "./directory.js";

export type DirectoryUser = {
  id: string;
  userName: string;
  displayName: string;
  active: boolean;
};
export function directoryUser(value: BoundaryValue): DirectoryUser {
  if (
    !isJsonObject(value) ||
    !isString(value.id) ||
    !isString(value.userName) ||
    !isBoolean(value.active)
  ) {
    throw new Error("Identity returned an invalid directory user.");
  }
  return {
    id: value.id,
    userName: value.userName,
    displayName: isString(value.displayName) ? value.displayName : "",
    active: value.active,
  };
}

function usersPath(organization: string) {
  return `/v1/organizations/${encodeURIComponent(organization)}/scim/v2/Users`;
}
export function listDirectoryUsers(organization: string) {
  return call(usersPath(organization), {}, (body) => {
    if (!isJsonObject(body) || !Array.isArray(body.Resources))
      throw new Error("Identity returned an invalid directory.");
    return body.Resources.map(directoryUser);
  });
}
export function createDirectoryUser(
  organization: string,
  userName: string,
  displayName: string,
) {
  return call(
    usersPath(organization),
    {
      method: "POST",
      body: JSON.stringify({ userName, displayName, active: true }),
    },
    directoryUser,
  );
}
export function updateDirectoryUser(organization: string, user: DirectoryUser) {
  return call(
    `${usersPath(organization)}/${encodeURIComponent(user.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        Operations: [
          {
            op: "replace",
            value: {
              userName: user.userName,
              displayName: user.displayName,
              active: user.active,
            },
          },
        ],
      }),
    },
    directoryUser,
  );
}

export function listManagedAgents() {
  return call("/v1/agents", {}, (body) => {
    if (!isJsonObject(body) || !Array.isArray(body.agents))
      throw new Error("Identity returned an invalid agent directory.");
    return body.agents.map((agent) => AgentResponseSchema.parse(agent));
  });
}
export function registerManagedAgent(
  displayName: string,
  publicKeyJkt: string,
) {
  return call(
    "/v1/agents",
    {
      method: "POST",
      body: JSON.stringify({ displayName, publicKeyJkt }),
    },
    (body) => {
      const registration = RegisterAgentResponseSchema.parse(body);
      // The UI needs the registration ID, not the claim bearer returned to agent runtimes.
      return { id: registration.agentId };
    },
  );
}
export function updateManagedAgent(
  id: string,
  patch: { displayName?: string; state?: "revoked" },
) {
  return call(
    `/v1/agents/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
    (body) => AgentResponseSchema.parse(body),
  );
}

export function updateApplication(
  id: string,
  displayName: string,
  redirectUris: string[],
) {
  return call(
    `/v1/oauth/clients/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ displayName, redirectUris }),
    },
    () => undefined,
  );
}
