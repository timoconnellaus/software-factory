// The engine's secrets. `wrangler types` can't see them (they are set by the deploy workflow, not in
// wrangler.jsonc: a `secrets.required` list would fail the deploy until they exist), so they are
// declared here and read only through `secrets()`. Either may be unset; callers degrade to
// `unavailable`.
export interface EngineSecrets {
  /** Master secret the runner channel keys are derived from (ADR 0016, spike ADR 0100). */
  RUNNER_CHANNEL_SECRET?: string;
  /** The GitHub App's private key, PEM (ADR 0025, 0033). */
  GH_APP_PRIVATE_KEY?: string;
}

export function secrets(env: Env): EngineSecrets {
  return env as Env & EngineSecrets;
}
