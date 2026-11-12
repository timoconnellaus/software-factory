# ADR 0541: Phone devices: an attested Keystore key, pairing by QR or browser, fingerprint presence proofs

Status: proposed, 2026-11-12. Spec [60](../specs/60-mobile-app.md). **Amends**
[ADR 0391](0391-the-client-door-desktop-devices-and-presence.md). Loosens one rule there (decision 6)
and so needs the owner's explicit sign-off at the merge gate on the PR that adds this ADR.

## Context
The owner decided that every plan approval and merge on the phone takes a fingerprint, with the key
in the phone's secure hardware. Ordinary planning answers are one tap. The phone signs in by
scanning a QR code shown by the desktop app or the website, or with GitHub in the phone's browser.
It is registered as a device with its own key and can be revoked.

ADR 0391 already has what this needs: one-time challenges, a summary the engine writes, a signature
over `nonce ‖ op ‖ inputDigest ‖ summary`, and redemption at the door. It was written for one
platform, macOS, where the server can't tell a Secure Enclave key from a software one. Android can
prove where a key lives: Keystore key attestation is a certificate chain to Google's roots that
describes the key.

## Decision
1. **A phone is a device like a Mac.**
   - Devices gain a `platform` (`macos`, `android`) and an `attestation` record.
   - `key_storage` widens to `secure-enclave | strongbox | tee | software`.
   - Tokens gain a third kind, `mobile`, with the prefix `sfm_`.
   - `mobile` joins `SURFACES`, and the token's kind sets it. Nothing in a request does.
   - Everything ADR 0391 says about desktop devices holds for phones unless stated here: the audit
     records `origin.deviceId`, and revoking a device revokes its tokens.
2. **The key.**
   - An EC P-256 signing key in Android Keystore, generated in StrongBox when the phone has it,
     else in the TEE.
   - It is **biometric-bound and per use**: `setUserAuthenticationRequired(true)` with
     `BIOMETRIC_STRONG` only and no time window (on API 29, a validity of `-1`; from API 30,
     `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`). Every signature needs its own
     fingerprint, given through `BiometricPrompt` with a `CryptoObject`. The PIN is not a fallback.
   - It is `setInvalidatedByBiometricEnrollment(true)`, so adding a fingerprint destroys the key.
     Someone who learns the PIN can't enrol their own finger and approve. The phone then has to
     pair again.
   - Generation passes `setAttestationChallenge(challenge)`. The challenge is a nonce the phone
     first fetches from `mobile/nonce` (unsigned). It is one use, lives 5 minutes, and is stored
     as a hash. So the attestation is fresh and tied to this sign-in.
3. **The engine checks the attestation at sign-in.** The phone sends the certificate chain with
   `mobile.authStart`, and the engine verifies all of the following:
   - **The chain** ends at one of Google's hardware attestation root keys, pinned in core. The
     engine checks the published revocation list, cached for a day; if it can't be fetched, the
     sign-in is refused.
   - **The challenge** in the key description equals the one this request derives.
   - **The security level** (`attestationSecurityLevel` and `keyMintSecurityLevel`) is
     `TrustedEnvironment` or `StrongBox`. It is recorded as `key_storage`.
   - **The key**: P-256, purpose `SIGN`, `userAuthType` includes fingerprint (biometric),
     `noAuthRequired` absent, no auth timeout.
   - **The app**: `attestationApplicationId` names our package and one of the signing certificates
     listed in `MOBILE_SIGNING_CERTS` (SHA-256, engine config). Another app, or our app signed by
     someone else, can't register.
   - **The boot state**: `rootOfTrust.verifiedBootState` is `Verified` and `deviceLocked` is true.
     Otherwise the device registers with `key_storage = software` (see 4). Open question 4 in
     spec 60 asks the owner whether to refuse instead.
   - The parsed record (security level, OS and patch level, boot state, the key fingerprint) is
     stored as `attestation`. The approval page and the You tab show it.
   - The engine checks only the attestation. Play Integrity isn't used: the APK doesn't come from
     Play, so it would call every install unrecognised.
4. **Software keys can't decide, on phones too.**
   - A phone whose attestation fails the security level or boot state check is stored with
     `key_storage = software`. A failed chain, challenge, key or app check refuses the sign-in.
   - As ADR 0391 decision 4 says, `presence.redeem` refuses proofs from software keys unless the
     engine runs with `DESKTOP_ALLOW_SOFTWARE_KEYS=1`. That covers the Android emulator in tests.
     No deployed config sets it.
5. **The proof is the ADR 0391 proof.**
   - The phone asks `presence.challenge { op, inputDigest }` and signs
     `nonce ‖ "\n" ‖ op ‖ "\n" ‖ inputDigest ‖ "\n" ‖ summary` after the fingerprint. The door
     redeems it the same way. `presenceAllows` accepts `desktop` and `mobile`.
   - **What takes a fingerprint on the phone** (the owner's rule: plan approvals, merges and policy
     changes): `spec.approve`, `review.merge`, `approval.decide` (approving), `config.approve`
     ([ADR 0543](0543-policy-changes-are-approved-on-the-phone-with-a-fingerprint.md)),
     `mobile.renew` and `device.update` when it turns approvals on.
   - **What is one tap on the phone** (the owner's rule: "ordinary answers are one tap"; the
     designs show Send back and a build's question without a fingerprint):
     - `planning.answer` and `planning.acceptDefaults`, which ADR 0470 already made decidable
       without a proof on the desktop;
     - `question.answer` and `question.acceptDefaults` (questions from a run);
     - `review.sendBack`, `spec.requestChanges`, and `approval.decide` when rejecting. These only
       ever hold work back.
   - The flag ADR 0470 calls `desktopDecidable` becomes `deviceDecidable(surface, input)`. For
     `mobile` it covers the list above. **Security, privacy and irreversible questions still need
     the fingerprint**, as bulk accept never covers them (ADR 0042).
   - **This differs from the desktop.** There, `question.answer`, `question.acceptDefaults`,
     `review.sendBack` and `spec.requestChanges` keep their Touch ID until the owner decides
     otherwise. It is a loosening for `mobile` only, which the owner signs off at this PR's merge
     gate. A CLI or MCP token still can't do any of it.
   - **The prompt.** `BiometricPrompt` shows the title "Approve with your fingerprint" and,
     as its description, the summary from the challenge, verbatim. Android has no separate signer
     process like the Mac's `sf-keys`, so the app builds the prompt. On Android that is safe enough:
     Keystore keys belong to one app's UID, no other app can use them, and no agent runs on the
     phone. The danger ADR 0391 guards against, a same-user process asking for a prompt, doesn't
     arise.
   - Android Protected Confirmation, which would bind the text in hardware, isn't used. Few phones
     have it, and Android has deprecated it.
6. **Pairing has two ways in, and both end in an approval by a person.**
   - **Browser:**
     1. The phone calls `mobile.authStart` with the public key, the attestation chain, a device
        name and a PKCE challenge.
     2. It opens `/mobile/connect?request=…` in a Custom Tab, where the person signs in with GitHub
        on the website and approves (`mobile.approveDevice`, browser-only).
     3. The site redirects to the App Link `https://<site>/mobile/callback?code=…&state=…`,
        verified through `/.well-known/assetlinks.json`, so no other app can catch it.
     4. The phone calls `mobile.authExchange` with the code and the PKCE verifier.
   - **QR** (`docs/design/mobile/Pair.html`, `PairConfirm.html`):
     1. On the desktop app or the website, the person chooses Settings → Devices → **Add a phone**.
        That calls `mobile.pairOffer`, which **is the approval**: it is made by a person who is
        signed in on the website, or on the desktop with Touch ID. The offer is one use, lives 5
        minutes, names that person, and is stored only as a hash.
     2. The screen shows a QR code (the engine's URL and a 128-bit secret) and, for the typed
        fallback, a 10-character code (base32, about 50 bits).
     3. The phone scans or types it, then calls `mobile.authStart` with the secret, the key and
        the attestation, and then `mobile.authExchange`.
     4. Typed codes are rate-limited: 5 wrong attempts per offer close it, and the engine refuses
        more than 30 tries an hour from anywhere.
     5. The phone shows "Code accepted", the account and its orgs, and asks for a name. The
        desktop or website screen that showed the code changes to the phone's name, attested model
        and security level, with **Not my phone? Remove**.
   - In both ways, the token is minted only once, and only after a person approves.
   - **The loosening.** Offering a pairing from the **desktop** makes `mobile.pairOffer`
     presence-decidable on `desktop`. Its Touch ID prompt reads `Add a phone to your account`.
     ADR 0391 kept device approvals browser-only because they grant authority. This makes one
     exception, a phone offered from a device that already proves presence, for an offer that is
     one use, short-lived, and shown on the person's own screen. Approving runners, CLI logins and
     other desktops stays browser-only.
   - **Approvals can be off.** `PairConfirm` has a switch for fingerprint approvals. Off means
     the device is stored with `decides = false`, and `presence.challenge` refuses it. Everything
     one tap still works. Turning it on later is `device.update { decides: true }`, which is
     itself proved with a fingerprint.
7. **Tokens last 30 days and renew with a fingerprint.**
   - In its last 7 days, the app offers to renew the token. `mobile.renew` is presence-decidable.
     It mints a new token for the same device and revokes the old one.
   - A token that runs out needs a new pairing.
8. **Revocation.**
   - A phone can be revoked from the You tab (itself), the desktop's Settings → Devices, or the
     website (`device.list`, `device.revoke`, which replace and alias `desktopDevice.*`).
   - Revoking a device revokes its tokens and deletes its push registration.
   - The engine also sends one last push of type `device.revoked`. When the app gets that push, or
     an `unauthenticated` answer from the door, it deletes the key, the token, the cache and the
     capture queue.

## Consequences
- **What a phone proof shows:** a person whose fingerprint is enrolled on this phone, enrolled
  before it was paired, confirmed a prompt that named this decision. On an unmodified phone this is
  stronger than the Mac's: no password fallback, attested hardware, and no agents on the device.
- A broken fingerprint sensor or a new enrolment means pairing again, or deciding on the desktop.
- Pinning Google's roots and the revocation list is ongoing work. Google has announced root
  rotations before; the roots live in one core module with a test that runs a captured real chain.
- The emulator has no hardware attestation. Tests and screenshots use the software-key allowance,
  which is off in every deployed config. A test checks the default refuses.
- ADR 0392's consequence ("approving a gate from a phone would need its own presence proof
  (WebAuthn)") is answered by this ADR instead: the phone app's own key, not WebAuthn in a browser.
