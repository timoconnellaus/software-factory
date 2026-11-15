// @software-factory/core: the platform's operations (sign-in through the doors, devices and presence
// proofs, runners, orgs and the GitHub connection), the operations registry and the invoke()
// pipeline (ADR 0003, 0004). The workflow engine itself is the new core (packages/flow, ops, store,
// plugins; spec 70).
export * from "./actors.ts";
export * from "./attestation/android.ts";
export { DerError, readDer } from "./attestation/der.ts";
export { GOOGLE_ATTESTATION_ROOTS, type PinnedRoot } from "./attestation/roots.ts";
export { type Certificate, parseCertificate } from "./attestation/x509.ts";
export * from "./errors.ts";
export * from "./ids.ts";
export * from "./invoke.ts";
export * from "./operation.ts";
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
  PRESENCE_TTL_MS,
  presenceMessage,
  rawSignature,
  resolveDesktopToken,
} from "./operations/desktop.ts";
export { DEVICE_LOGIN_ACTOR, normalizeUserCode } from "./operations/devices.ts";
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
export * from "./registry.ts";
export * from "./services.ts";
