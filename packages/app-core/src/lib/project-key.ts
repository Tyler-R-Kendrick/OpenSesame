/** The personal project retains legacy names; other projects use distinct namespaces. */
export function projectKey(base: string, projectId: string): string {
  return projectId === "personal" ? base : `project.${projectId}.${base}`;
}
