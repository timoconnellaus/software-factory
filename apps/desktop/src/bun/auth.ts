// Signing the desktop app in (ADR 0391): a device key, PKCE, the website approval, the sf://
// callback and the exchange. The token goes to the keychain and stays in the main process.
import type { Session } from "../shared/rpc.ts";
import { createDeviceKey, type DeviceKey, forgetDeviceKey, loadDeviceKey } from "./device-key.ts";
import type { Door } from "./door.ts";
import { deleteSecret, getSecret, setSecret } from "./keychain.ts";
import { pkcePair, randomUrlSafe } from "./pkce.ts";

const TOKEN_SERVICE = "com.software-factory.desktop.token";
const IDENTITY_SERVICE = "com.software-factory.desktop.identity";

interface Identity {
  login: string | null;
  deviceId: string;
  tokenId: string;
}

export class Auth {
  private pending: { verifier: string; state: string } | null = null;
  private token: string | null = getSecret(TOKEN_SERVICE);
  private identity: Identity | null = (() => {
    const raw = getSecret(IDENTITY_SERVICE);
    return raw ? (JSON.parse(raw) as Identity) : null;
  })();
  key: DeviceKey | null = null;
  error: string | null = null;

  constructor(
    private readonly door: () => Door,
    private readonly deviceName: string,
  ) {}

  currentToken = () => this.token;

  async init(): Promise<void> {
    this.key = await loadDeviceKey();
  }

  session(): Session {
    return {
      signedIn: !!this.token,
      login: this.identity?.login ?? null,
      deviceId: this.identity?.deviceId ?? null,
      keyStorage: this.key?.storage ?? null,
      signingIn: !!this.pending,
      error: this.error,
    };
  }

  /** Starts a sign-in and returns the website page to open. */
  async start(): Promise<string> {
    this.error = null;
    // A new key per sign-in: a revoked device's key is never reused.
    this.key = await createDeviceKey();
    const { verifier, challenge } = await pkcePair();
    const state = randomUrlSafe(16);
    const started = await this.door().signInCall<{ approveUrl: string }>("desktop/start", {
      deviceName: this.deviceName,
      publicKey: this.key.publicKey,
      keyStorage: this.key.storage,
      codeChallenge: challenge,
      state,
    });
    this.pending = { verifier, state };
    return started.approveUrl;
  }

  /** The sf://auth/callback half. */
  async finish(code: string, state: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.state !== state) {
      this.error = "That sign-in link wasn't for this sign-in. Start again.";
      return;
    }
    this.pending = null;
    try {
      const got = await this.door().signInCall<{
        token: string;
        tokenId: string;
        deviceId: string;
        login: string | null;
      }>("desktop/exchange", { code, codeVerifier: pending.verifier });
      setSecret(TOKEN_SERVICE, got.token);
      const identity = { login: got.login, deviceId: got.deviceId, tokenId: got.tokenId };
      setSecret(IDENTITY_SERVICE, JSON.stringify(identity));
      this.token = got.token;
      this.identity = identity;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Sign-in failed";
    }
  }

  /** Sign out: revoke this device (its token stops working), then forget everything locally. */
  async signOut(): Promise<void> {
    if (this.token && this.identity) {
      await this.door()
        .call("desktopDevice.revoke", { deviceId: this.identity.deviceId })
        .catch(() => undefined);
    }
    this.forget();
    await forgetDeviceKey();
    this.key = null;
  }

  /** The server said the token is no good: drop it. */
  forget(): void {
    deleteSecret(TOKEN_SERVICE);
    deleteSecret(IDENTITY_SERVICE);
    this.token = null;
    this.identity = null;
  }
}
