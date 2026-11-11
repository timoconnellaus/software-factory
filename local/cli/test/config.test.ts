import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearToken,
  configFile,
  DEFAULT_APP_URL,
  DEFAULT_URL,
  loadConfig,
  saveConfig,
  settings,
} from "../src/config.ts";
import { configPath, scratchHome } from "./helpers.ts";

describe("config", () => {
  it("lives under XDG_CONFIG_HOME, else ~/.config", () => {
    expect(configFile({ HOME: "/h", XDG_CONFIG_HOME: "/x" })).toBe("/x/software-factory/cli.json");
    expect(configFile({ HOME: "/h" })).toBe("/h/.config/software-factory/cli.json");
  });

  it("saves the token 0600 in a 0700 directory and reads it back", async () => {
    const home = await scratchHome();
    const file = configPath(home);
    const config = {
      url: "https://e.test",
      appUrl: "https://a.test",
      token: "sfc_secret",
      tokenId: "clt_1",
      scope: "write" as const,
      login: "tim",
      expiresAt: "2026-12-12T00:00:00Z",
    };
    await saveConfig(file, config);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "software-factory"))).mode & 0o777).toBe(0o700);
    expect(await loadConfig(file)).toEqual(config);

    // An existing, looser file is tightened on save.
    await writeFile(file, "{}", { mode: 0o644 });
    await saveConfig(file, config);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("is empty when missing, and an error when it isn't ours", async () => {
    const home = await scratchHome();
    expect(await loadConfig(configPath(home))).toEqual({});
    await mkdir(join(home, "software-factory"), { recursive: true });
    await writeFile(configPath(home), "not json");
    await expect(loadConfig(configPath(home))).rejects.toThrow(/isn't valid JSON/);
  });

  it("forgets the token on logout but keeps where the factory is", async () => {
    const home = await scratchHome();
    const file = configPath(home);
    const config = { url: "https://e.test", token: "t", tokenId: "clt_1", scope: "read" as const };
    await saveConfig(file, config);
    await clearToken(file, config);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ url: "https://e.test" });
  });

  it("lets SF_TOKEN, SF_URL and SF_APP_URL override the file", () => {
    const config = { url: "https://e.test/", token: "stored" };
    expect(settings(config, {})).toEqual({
      url: "https://e.test",
      appUrl: DEFAULT_APP_URL,
      token: "stored",
      tokenSource: "config",
    });
    expect(
      settings(config, {
        SF_TOKEN: "agent",
        SF_URL: "https://other.test",
        SF_APP_URL: "https://a",
      }),
    ).toEqual({
      url: "https://other.test",
      appUrl: "https://a",
      token: "agent",
      tokenSource: "env",
    });
    expect(settings({}, {})).toEqual({
      url: DEFAULT_URL,
      appUrl: DEFAULT_APP_URL,
      token: null,
      tokenSource: null,
    });
  });
});
