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
     first fetches from `mobile/nonce` (unsigned). It is one use, lives 5 minutes, and is
     stateless until used (amended 2026-11-12, second review: signed by the engine, recorded
     only as a hash when spent). So the attestation is fresh and tied to this sign-in.
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

## Amendment, 2026-11-12: as built in spec 60 PR 1a
The owner accepted spec 60's three loosenings and its six defaults (package `com.zerobsai.factory`;
no app lock; fingerprint only; an unlocked or unverified phone registers but can't approve; canary
and stable; one tap for answers on the phone only). Building PR 1a settled these details:
- **A software security level is refused, not stored as `software`.** Decision 4 said a phone that
  fails the security-level check registers as `software`; spec 60's acceptance criterion 1 says "a
  key from a software level" is refused. The stricter one is built. Only the boot state (not
  `Verified`, or the bootloader unlocked) registers a phone as `software`.
- **The challenge** is SHA-256 of the nonce's UTF-8 bytes (32 bytes). The nonce is stored only as
  its hash, when the sign-in that uses it spends it (see the second amendment).
- **The key checks** are made on the hardware-enforced list: EC P-256, `SIGN`, `origin` generated,
  `userAuthType` with the fingerprint bit and *without* the password bit (so the PIN can't stand in),
  no `authTimeout` (or 0), no `noAuthRequired` on either list. The app check needs exactly one
  package, ours, and every signature digest in `MOBILE_SIGNING_CERTS`. The key description must be
  in the leaf and nowhere else in the chain. Intermediates must be in date; the leaf's dates (often
  1970–2106) and the root's are not judged, because roots are pinned by key, not by certificate
  (Google has re-issued the RSA root's certificate with the same key several times).
- **The pinned roots** are Google's RSA-4096 hardware attestation root key and the ECDSA P-384 "Key
  Attestation CA1" key, as published on 2026-11-12 (`packages/core/src/attestation/roots.ts`).
- **The revocation list** is held in the engine's memory for a day; every listed serial refuses,
  whatever its status. If it can't be fetched and no copy younger than a day is held, sign-in is
  refused as `unavailable`.
- **The typed code** is ten Crockford base32 characters: the first two name the offer (unique among
  live offers) so a wrong code counts against that offer only, and the other eight are the secret
  (40 bits against five tries). Every try, right or wrong, counts toward the cap of 30 an hour.
  *(Changed by the review below: the caps are per caller and atomic.)*
- **The QR code** holds the App Link `https://<site>/mobile/pair?offer=<id>#secret=<secret>`: the
  secret stays in the fragment, which no server sees. The website's `/mobile/pair` and
  `/mobile/callback` only bounce to the app (an `intent://` link) when the App Link didn't catch
  them; the intent carries the fragment's values in its query, so the app reads them from either.
- **`mobile.pairOfferStatus`** is new: the Add a phone screen watches the offer with it and shows
  the paired phone's name and key storage with **Not my phone? Remove**.
- **`deviceDecidable(op, surface, input)`** is a function in `invoke()` over the existing
  `desktopDecidable` flag and a new `mobileDecidable` (true, or a function of the input), rather
  than a replacement of the flag, so planning PRs in flight that set `desktopDecidable` keep
  compiling. Everything desktop-decidable is also one tap on the phone. The gate decisions keep
  `presenceDecidable` (a proof on either device). The three operations that take a proof without
  being gate decisions set `presenceSurfaces` instead: `mobile.pairOffer` (`desktop` only),
  `mobile.renew` (`mobile` only) and `device.update` (both, when turning approvals on). So the
  desktop's own list of gate decisions, which mirrors `presenceDecidable`, is unchanged.
  `packages/core/test/decidability.test.ts` pins the table.
- **`review.merge`'s `headSha`** is compared with the head SHA in the merge gate's `pr.merge` input.
  A call from the `mobile` surface without one is refused as `invalid_input`.
- **`MOBILE_MIN_PROTOCOL`** is a constant in `apps/engine/src/mobile.ts`, starting at 1: no phone
  build predates the handshake, so a phone request without `x-sf-client-protocol` gets 426. It is
  recognised by the route (`mobile/*`) or the token's `sfm_` prefix, without a lookup.
- **Migration 0310** carries only what PR 1a uses. The push tables (`core_push_registrations`,
  `core_device_notification_settings`) and `core_project_policies.content_digest` come with PRs 2
  and 8, in the next migrations of block AL.
- **Not in PR 1a:** the desktop app's Add a phone dialog. The engine side is built and tested
  (`mobile.pairOffer` with a Touch ID proof); the dialog is a new component and a route hook in
  `apps/desktop`, which the desktop sessions own.

## Amendment, 2026-11-12: after the review of PR 1a
An independent review of PR 1a ran 200 parallel wrong typed codes against one offer: all were
recorded past the cap, and the offer ended with one attempt and never closed, because the counts
were read and then written back. The typed code was also read before the attestation, and a wrong
code didn't spend the nonce, so codes could be guessed with no phone at all. Fixed on the same PR:
- **The attestation comes first.** A typed code is looked at only for a key that passed every check
  above, so only a real phone running our app can guess. A bad chain is refused the same way
  whether the code was right or wrong.
- **A refusal spends the nonce.** Once the nonce is found, every answer spends it: a bad chain, a
  wrong code, a wrong QR secret, a limit. Another try needs a new nonce and so a new attested key.
  (If Google's revocation list can't be had, the engine can't judge anything and the nonce stays.)
- **Counted in SQL, in the call's batch.** A wrong code adds one to the offer its tag names in place
  (`attempts = attempts + 1`), and the fifth closes it in the same statement. A try is inserted only
  if the caps hold when the batch runs, and a wrong code counts against an offer only if its try
  was inserted. A right code consumes its offer guarded by `attempts < 5` and the offer being live.
- **Per caller and across the factory.** The caller is the network address the door sees
  (`cf-connecting-ip`, an IPv6 address by its /64), stored only as a hash. One caller gets ten typed
  codes an hour and holds at most ten unspent nonces (the engine two hundred). After thirty wrong
  codes in an hour, a caller who has already sent a wrong one this hour is held, but a caller's first
  code never is: other people's guessing can't stop the owner's right code, except by spending its
  offer's own five. Then the owner's right code answers "this code's offer was closed after too many
  wrong tries: make a new code on the desktop or the website".
- **The phone doesn't decide config changes or self-modify.** `approval.decide` from the `mobile`
  surface is refused, approving or rejecting, with or without a proof, for a pending `config.save`
  or `config.rollback` or any `self-modify` action: "approve this on the desktop app or the
  website". The fingerprint prompt reads only "Approve config.save on #n" until spec 60 PR 8 binds
  it to the version's digest. `invoke()` checks it (`phoneMayDecidePending`), and the decidability
  test pins the list.
- **Attestation, tightened.** `origin` must be present and GENERATED. Every issuer in the chain must
  carry basicConstraints `cA` and keyUsage `keyCertSign`. The attestation version must be KeyMint's
  (100 or above: Android 12 and later), and the OS patch level no older than 18 months
  (`MOBILE_MAX_PATCH_AGE_MONTHS`); a phone that fails these is refused, not downgraded.
- **What attestation can't catch.** A phone whose factory attestation key (its "keybox") has leaked
  and isn't on Google's revocation list yet, rooted so that a module answers for the Keystore,
  passes every check here, boot state included, because the leaked key signs whatever it is told.
  Requiring remotely provisioned (RKP) chains, whose keys Google issues per device and rotates
  within weeks, is the later answer; it would refuse phones from before Android 12's RKP.
- **The ECDSA root has a real chain behind it.** `testdata/tegu/sdk36/TEE_EC_2026_ROOT.pem` from
  Google's `android/keyattestation` (a preproduction Pixel 9a, RKP) ends at the pinned "Key
  Attestation CA1" key; it is a test fixture, and passes every check up to its key's authentication.
- **`DESKTOP_ALLOW_SOFTWARE_KEYS` is for Macs.** It lets a Mac's unsigned dev build decide on a local
  engine. A phone with a software key never decides, whatever it says.
- **Renewing isn't deciding.** `mobile.renew` takes a proof that the phone holds its key, so a phone
  with approvals off, or registered as `software`, renews too instead of lapsing after 30 days. The
  proof is for the renewal only.
- **Revoking a device closes its live socket at once** (the outbox's `device.revoked`, after commit),
  with close code 4401, instead of at its next call.
- **The emulator** signs in with a `dev` build flavour of its own package id that only a
  non-production engine accepts, as `software` (spec 60, "The dev build flavour"). The production
  engine knows one package, and no flag on it accepts a software attestation.

## Amendment, 2026-11-12: after the second review of PR 1a
The second review ran attacks against the fixes above. Five held; these didn't, and are changed on
the same PR (each has a test that failed before):
- **A self-modify merge could be approved from the phone.** The check sat in `invoke()` and looked
  only at `approval.decide`, but `review.merge` decides a merge gate whose risk is `self-modify`
  when the PR touches `.factory/`. The check now lives in `decidePending` (gates.ts), which every
  operation that decides a pending action goes through, keyed on the pending action's operation
  and risk class: from the `mobile` surface, a config change or anything `self-modify` is refused,
  whichever operation decides it. A test finds every deciding operation in core's source (and
  that only `decidePending` writes an approval), and fails until a new one is covered.
- **Nonces are stateless until used.** The 200-nonce engine cap was a single point anyone could
  fill from twenty addresses, blocking every phone sign-in (QR, typed and browser). A nonce is now
  `<expiry>.<random>.<HMAC>` under the engine's secret (`RUNNER_CHANNEL_SECRET`, label
  `sf-mobile:nonce:`, as runner keys are derived under it), and asking for one stores nothing
  shared. `mobile.authStart` checks the signature and expiry, then inserts the nonce's hash into
  `core_mobile_nonces` in a statement of its own, committed before anything is decided; the
  primary key makes it single use. What remains per caller (ten nonces every five minutes,
  `core_mobile_nonce_asks`) is a courtesy limit that holds only that caller.
- **Every wrong code counts against its offer**, in the statement that refuses it, whatever the
  caller caps say of the try (before, a try that missed the cap answered 403 and counted nothing).
- **One answer for every refused code.** A right code whose offer closed or was used on its way
  rolled the batch back into a 409 only a right code could produce, and left the nonce unspent for
  a replay. Now the nonce is already spent, and every refusal of a typed code or QR secret (wrong,
  used, expired, closed, raced) is the same 403 and body. `attemptsLeft` is gone: it told a
  guesser which tags were live. The owner sees "2 wrong tries so far, of 5" on the screen showing
  the code (`mobile.pairOfferStatus` `wrongTries`), and the offer's status says when it closed.
- **A live offer's tag is unique, in SQL.** The offer insert is guarded so two offers made at once
  never share a tag: one person's wrong codes never count against another person's offer.
- **Revoking a device refuses a decision in flight.** Every write from a desktop or phone token
  carries a guard in its own batch that the device isn't revoked, read before the call's writes.
- **The caller hash is keyed** (an HMAC under the engine's secret, label `sf-mobile:caller:`), so a
  stored hash can't be reversed by hashing the address space.
- **Certificates are DER, strictly.** A length or tag number not in its shortest form is refused,
  and so is a critical extension the checker doesn't read (anything but basicConstraints, keyUsage
  and the key description).

## Amendment, 2026-11-12: after the third review of PR 1a
Small follow-ups, on their own PR (migration 0311):
- **The nonce's courtesy limit is a Workers rate limiting binding.** The D1 counter
  (`core_mobile_nonce_asks`) wrote a row per caller and five minutes, so an attacker with many
  addresses could make the factory write about 19M rows a day. sf-engine's door now asks the
  `MOBILE_NONCE_LIMIT` binding (ten a minute per caller key, the same keyed hash of the address)
  before the call, so an over-limit caller is refused (503, `unavailable`) before anything touches
  D1. The binding counts per Cloudflare location and isn't exact; a courtesy limit doesn't need it
  to be. The table and its prune are gone, and `mobile.nonce`, which now writes nothing, is a read
  (so it isn't audited either). What still bounds abuse is unchanged: a nonce is stateless until
  `mobile.authStart` spends it, and the typed-code caps are counted in SQL.
- **Deciding a pending action is declared in the registry.** An operation that decides one sets
  `decidesPending`, and `decidePending` (the only place the phone's limit is checked) refuses to
  write from one that doesn't. Every other write of a pending action's `status` goes through
  `ctx.writePendingStatus` as a `close` (a take-back, a moved head, a cancelled item) or an
  `apply` (an approved one carried out); `ctx.write` refuses an UPDATE of `core_pending_actions`
  that sets `status`. The engine's test enumerates the registry's deciding operations and runs each
  from the phone; core's tests show the two refusals. This replaces the source grep.
- **The phone can't cancel an item while a config change or a self-modify action waits on it.**
  `workItem.cancel` rejects the item's open pending actions, which from the phone would decide what
  the phone may not. It is refused on the `mobile` surface with "cancel it on the desktop app or
  the website" (`decideElsewhere`), guarded in the batch against one opening meanwhile. A spec
  gate withdrawn because a person wrote on the phone (a take-back) is allowed: it decides nothing,
  and the planner asks again.
- **`RUNNER_CHANNEL_SECRET` serves two purposes**, kept apart by derivation label: runner channel
  keys (`sf-runner-channel:<runnerId>:v<keyVersion>`, ADR 0100) and the phone's HMACs
  (`sf-mobile:nonce:` for the stateless nonces, `sf-mobile:caller:` for the caller hash). Rotating
  it re-keys every runner (ADR 0100: each needs its new key), invalidates nonces not yet spent (at
  most five minutes' worth: a phone mid sign-in asks again), and changes every caller hash, so the
  per-caller typed-code cap and the nonce limit start afresh for everyone (at most an hour's
  counts are lost). Phone tokens, device keys and presence proofs don't depend on it. A split into
  two secrets would let one rotate without the other; not worth a second secret to provision yet.
