# ADR 0391: One client door; desktop devices decide gates with a presence proof

Status: accepted, 2026-11-12. Spec [40](../specs/40-desktop-app.md). Amends
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
   - The app asks for `presence.challenge { op, inputDigest }`. It gets a one-time nonce that lives
     60 s, and a **summary** the engine writes from the call itself (for example
     `Merge #12 "Fix the inbox count" into main`).
   - The device key signs `nonce ‖ op ‖ inputDigest ‖ summary`. The OS asks for Touch ID, and **the
     prompt shows that summary**.
   - Only the key helper (`sf-keys`) is signed with the keychain access group, so only it can use
     the key. The app's `bun` can't. The helper accepts only a presence message and builds the
     prompt from the message's own summary line. It takes no prompt text from its caller.
   - The app sends the signature with the call. The door verifies it against the device's public
     key and the stored summary, consumes the nonce, and checks that the digest is the SHA-256 of
     the call's own input. Only then does it set `origin.presence` to that op and digest.
   - `invoke()` lets a human on the `desktop` surface run a browser-only operation only if the
     operation is **presence-decidable** and `origin.presence` names this op and this input.
     Without the proof, the call is refused as before (`forbidden`, `browserOnly: true`).
   - **Presence-decidable:** spec and merge decisions, `approval.decide`, answering questions and
     accepting their defaults.
   - **Still browser-only:** approving a runner, CLI or desktop login; registering a runner or
     rotating its key; turning a kill switch off. These grant authority, and the website is where
     devices are managed.
4. **Software keys can't decide.** A device that registered a software key (an unsigned build)
   can sign in and act, but `presence.redeem` refuses its proofs. The only exception is an engine
   started with `DESKTOP_ALLOW_SOFTWARE_KEYS=1`, which no deployed config sets; a test checks that
   the default refuses. This fails closed.
5. **The audit journal records the device** (`origin.deviceId`) for every desktop call, and the
   presence proof (challenge and summary) for each decision.

## Consequences
- **What a proof shows:** a person at this Mac confirmed, with Touch ID or the login password, a
  prompt that named this decision. It doesn't show that they meant it. A same-user process holding
  the token can ask for a challenge for a call of its own choosing and so make a prompt appear,
  but the prompt names that call truthfully. Only an unexpected prompt the person approves gets
  through. **An unexpected Touch ID prompt is a reason to stop and check, not to approve.**
- **`.userPresence` allows the login password as a fallback** to Touch ID, so the proof is as
  strong as the Mac's password. `.biometryCurrentSet` would remove the fallback but lock out Macs
  without Touch ID; revisit if that trade-off changes.
- **No reuse window.** LocalAuthentication can skip the prompt for up to 5 minutes after one, which
  would let a same-user process sign silently in that window. It is **not adopted**. Adopting it
  later means revisiting this ADR, not flipping a setting.
- **This loosens ADR 0340's boundary**, from "browser only" to "browser, or desktop with a
  presence proof". It needs the owner's explicit sign-off, which is the merge gate on the PR that
  adds this ADR. Any further loosening is a human-only change to this ADR.
- An agent on the same Mac with the desktop token can do what a CLI `write` token can do. It can't
  make a gate decision without a person confirming a prompt that names it.
- The Secure Enclave key needs a signed build. The server can't tell a Secure Enclave key from a
  software one, because macOS has no attestation for it, so the app declares where its key lives.
  The approval page shows that with the key's fingerprint, and software keys can't decide (4).
  Registering a device at all needs a person to approve it on the website, as for a CLI login.

## Amendment, 2026-11-12 (spec 40 M3)
- The door carries bytes as `{ "$bytes": "<base64>" }`: it decodes them in a call's input after
  digesting it (so a proof covers the input as sent) and encodes every `Uint8Array` in an output.
  This is what lets the desktop upload and show attachments.
- The desktop's main process refuses a presence-decidable operation sent through `call`; the view
  sends those through `decide` only. `org.list` returns the caller's user id.

## Amendment, 2026-11-12: planning answers on the desktop need no presence proof
Decided by the owner on 2026-11-12, in his words: "touch id approvals is overkill. We'll assume the
user's computer is secure." Answering a planning session's questions, one at a time
(`planning.answer`, which also skips) or in bulk (`planning.acceptDefaults`), is an ordinary member
write from the desktop: these operations are `desktopDecidable` and ask for no presence proof,
except for security, privacy and irreversible questions, which keep it until the owner decides
otherwise (review, 2026-11-12). They
stay `browserOnly` everywhere else, so a CLI or MCP token still can't answer for a person. Bulk accept
still never covers security, privacy or irreversible questions. `question.answer` and
`question.acceptDefaults` (questions outside a planning session) and every gate (spec, merge,
approval) keep their presence proof. Whether gates keep it is a separate decision. Spec 26, [ADR
0470](0470-planning-steering.md).

## Amendment, 2026-11-12: the key helper on signed builds
On a Developer ID build the helper can only carry the keychain access group as its own bundle with an
embedded Developer ID provisioning profile (a bare executable with that entitlement is killed). That
is [ADR 0394](0394-the-key-helper-is-its-own-signed-bundle.md). The key stays `.userPresence`
(Touch ID, or the login password) with no reuse window, as decided above; the owner kept gate
approvals on the desktop with Touch ID.
