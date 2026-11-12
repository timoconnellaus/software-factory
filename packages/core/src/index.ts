// @software-factory/core: the operations registry, the invoke() pipeline and gate, autonomy policy
// and the floor, model roles and the work-item model (ADR 0003, 0004, 0008, 0018).
export * from "./actors.ts";
export * from "./attachments.ts";
export * from "./attestation/android.ts";
export { DerError, readDer } from "./attestation/der.ts";
export { GOOGLE_ATTESTATION_ROOTS, type PinnedRoot } from "./attestation/roots.ts";
export { type Certificate, parseCertificate } from "./attestation/x509.ts";
export * from "./errors.ts";
export * from "./ids.ts";
export * from "./improve.ts";
export * from "./incidents/classify.ts";
export * from "./invoke.ts";
export * from "./model-roles.ts";
export * from "./operation.ts";
export {
  type AttachmentView,
  SWEEP_CURSOR_KEY,
  sweepStrayAttachmentBlobs,
} from "./operations/attachments.ts";
export {
  CLI_APPROVE_PATH,
  CLI_DEVICE_ACTOR,
  CLI_TOKEN_PREFIX,
  resolveCliToken,
} from "./operations/cli.ts";
export {
  DESKTOP_APPROVE_PATH,
  DESKTOP_CALLBACK_URL,
  DESKTOP_DEVICE_ACTOR,
  DESKTOP_TOKEN_PREFIX,
  presenceMessage,
  rawSignature,
  resolveDesktopToken,
} from "./operations/desktop.ts";
export { DEVICE_LOGIN_ACTOR, normalizeUserCode } from "./operations/devices.ts";
export {
  PHONE_REFUSES_CANCEL,
  PHONE_REFUSES_PENDING,
  phoneMayDecidePending,
} from "./operations/gates.ts";
export * as operations from "./operations/index.ts";
export {
  formatPairCode,
  MOBILE_APPROVE_PATH,
  MOBILE_CALLBACK_PATH,
  MOBILE_DEVICE_ACTOR,
  MOBILE_PAIR_PATH,
  MOBILE_TOKEN_PREFIX,
  type MobileAttestationService,
  normalizePairCode,
  PAIR_CODE_REFUSED,
  resolveMobileToken,
} from "./operations/mobile.ts";
export { PROTECTION_RECHECK_MS } from "./operations/protection.ts";
export { NEVER_BULK_ACCEPTED_DOMAINS } from "./operations/questions.ts";
export { LEASE_TTL_MS } from "./operations/runners.ts";
export { ATTACHED_SKIP_REASON } from "./operations/shared.ts";
export { RUNNER_OFFLINE_MS, WIP_WAIT_REASON } from "./operations/work-items.ts";
export {
  OPEN_SESSION,
  PLANNING_SESSION_TIMEOUT_MS,
  PRESENCE_TTL_MS,
  planningReadyEvent,
} from "./planning.ts";
export * from "./policy/gate.ts";
export * from "./policy/impact.ts";
export * from "./policy/project-policy.ts";
export * from "./registry.ts";
export * from "./scope.ts";
export * from "./services.ts";
export * from "./verify/index.ts";
export * from "./workflow-events.ts";
export * from "./workflow-features.ts";
