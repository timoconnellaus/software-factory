// Updates (spec 40 M4, ADR 0390): signed canary and stable builds on downloads.zerobsai.com.
// Electrobun's Updater reads `<channel>-macos-arm64-update-v2.json` from the build's release
// baseUrl. A new version is downloaded in the background; applying it restarts the app, so it waits
// for the person to choose "Restart to update" (the runner is stopped cleanly first). Dev builds
// never update.
import { Updater } from "electrobun/main";

export interface UpdateState {
  ready: boolean;
  version: string | null;
  error: string | null;
}

const EVERY_MS = 6 * 3_600_000;

export class Updates {
  state: UpdateState = { ready: false, version: null, error: null };
  constructor(private readonly onChange: (s: UpdateState) => void) {}

  async start(): Promise<void> {
    if ((await Updater.localInfo.channel()) === "dev") return;
    await this.check();
    setInterval(() => void this.check(), EVERY_MS);
  }

  private async check(): Promise<void> {
    if (this.state.ready) return;
    try {
      const info = await Updater.checkForUpdate();
      if (info.error) throw new Error(info.error);
      if (!info.updateAvailable) return;
      await Updater.downloadUpdate();
      this.state = { ready: true, version: info.version, error: null };
    } catch (error) {
      this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
    }
    this.onChange(this.state);
  }

  /** Restarts into the downloaded version. Call after the runner is stopped. */
  apply(): Promise<void> {
    return Updater.applyUpdate();
  }
}
