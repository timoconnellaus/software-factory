// Where the app serves a project's ruleset file (ADR 0280); see server/ruleset-download.ts.
export const rulesetDownloadPath = (projectId: string, kind: string) =>
  `/api/projects/${projectId}/rulesets/${kind}.json`;
