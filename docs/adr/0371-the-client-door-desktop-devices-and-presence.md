# ADR 0371: One client door; desktop devices decide gates with a presence proof

Status: accepted, 2026-11-12. Spec [30](../specs/30-desktop-app.md). Amends
[ADR 0340](0340-a-cli-for-people-gates-stay-in-the-browser.md) (gate decisions are browser-only).

## Context
The desktop app replaces the browser for day-to-day use, gate decisions included. The interview chose
"the signed-in token alone" for gate decisions, on the basis that a token in the Keychain is readable
only by the signed app. The spike showed it isn't. The app's main process is the bundled `bun`, and
any process of the same user can run that binary with its own script and read the token silently.
A Developer ID signature doesn't change that, because the signature trusts the interpreter, not the
script. So on the machine where builds run, a desktop token proves "this Mac, this user", which is
exactly what ADR 0340 refused to treat as a person.

## Decision
1. **One door for token clients.** `sf-engine` serves `/client/v1`; `/cli/v1` stays as an alias.
   - The token's kind sets the surface: a CLI token is `cli`, a desktop token is `desktop`.
   - Nothing in the request sets the actor or the surface.
   - `call` takes one operation; `batch` takes up to 20 `read`-risk calls and runs them like the
     app's `callReads` (ADR 0241).
   - MCP will be a third kind.
2. **A desktop device is registered by a browser sign-in.**
   - The app makes a P-256 key in the Secure Enclave, created with user presence (Touch ID, or the
     password). Its private half never leaves the chip.
   - The app calls `desktop.authStart` with the public key, a device name and a PKCE challenge, then
     opens the website's `/desktop/connect?request=…`.
   - The person approves there (`desktop.approveDevice`, browser-only). The site redirects to
     `sf://auth/callback?code=…&state=…`.
   - The app calls `desktop.authExchange` with the code and the PKCE verifier, and gets a desktop
     token (scope `write`, 30 days, only its SHA-256 stored) bound to the device.
   - Devices are listed and revoked from the website (`desktopDevice.list`, `desktopDevice.revoke`).
     Revoking a device revokes its tokens.
3. **Gate decisions from a desktop need a presence proof for that exact call.**
   - The app asks for `presence.challenge { op, inputDigest }` and gets a one-time nonce that lives
     60 s.
   - It signs `nonce ‖ op ‖ inputDigest` with the device key. The OS asks for Touch ID; the app
     doesn't.
   - It sends the signature with the call. The door verifies the signature against the device's
     public key, consumes the nonce, and checks that the digest is the SHA-256 of the call's own
     input. Only then does it set `origin.presence` to that op and digest.
   - `invoke()` lets a human on the `desktop` surface run a browser-only operation only if the
     operation is **presence-decidable** and `origin.presence` names this op and this input.
     Without the proof, the call is refused as before (`forbidden`, `browserOnly: true`).
   - **Presence-decidable:** spec and merge decisions, `approval.decide`, answering questions and
     accepting their defaults.
   - **Still browser-only:** approving a runner, CLI or desktop login; registering a runner or
     rotating its key; turning a kill switch off. These grant authority, and the website is where
     devices are managed.
4. **The audit journal records the device** (`origin.deviceId`) for every desktop call and the
   presence proof for each decision.

## Consequences
- The interview's "token only, no per-decision prompt" is replaced by one Touch ID per decision.
  Approving several things in a row can later use LocalAuthentication's reuse window (up to 5
  minutes), recorded per device. The owner can still choose to loosen this; that is a human-only
  change to this ADR, not a setting.
- An agent on the same Mac with the desktop token can do what a CLI `write` token can do, and no
  more. It can't produce the presence signature.
- The Secure Enclave key needs a signed app, with `keychain-access-groups` under the Developer ID
  team. The server can't tell a Secure Enclave key from a software one: macOS has no attestation for
  it. So the app declares where its key lives (`keyStorage`), the approval page shows that with the
  key's fingerprint, and the device list marks software keys. An unsigned dev build has a software
  key that a local process could read. The trust anchor is the person approving the device on the
  website, as for a CLI login.
