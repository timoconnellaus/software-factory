# Captured Android key attestation chains

Real certificate chains from Android devices, used by `../../mobile.test.ts` to check the parser
and the chain verification against Google's pinned root keys
(`packages/core/src/attestation/roots.ts`).

They come from Google's `android-key-attestation` repository, `src/test/resources/pem/`
(<https://github.com/google/android-key-attestation>, Apache License 2.0), copied unchanged on
2026-11-12:

- `ec-tee/`: `algorithm_EC_SecurityLevel_TEE` — an EC key in the TEE of a device whose chain ends at
  Google's RSA hardware attestation root. Its key has `noAuthRequired` and the device's bootloader
  is unlocked, so the engine refuses it at the key's authentication check.
- `ec-strongbox/`: `algorithm_EC_SecurityLevel_StrongBox` — a StrongBox chain whose root is not one
  of Google's published roots: the engine refuses it as an untrusted root.

`cert0.pem` is the leaf (the attested key), `cert3.pem` the root.

Neither chain was made with our package, our signing certificate or our challenge, so neither can
register. The full sign-in flow is tested with chains generated under a test root that only the
tests trust (`../../attestation.ts`). A chain from the owner's own phone has to be checked by hand
(spec 60 PR 1b, acceptance 6).
