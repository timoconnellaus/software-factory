// Settings' rows (spec 41, slice 6): repositories with their connection and protection, GitHub
// installations, and the devices and tokens that can act as you. Fixtures from the harness's door.
import type { OpOutput, Project, SetupStatus } from "@software-factory/client/ops";
import { describe, expect, it } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { sectionOf, tabTitle } from "../src/mainview/lib/places.ts";
import {
  deviceRows,
  installationText,
  projectsWithoutRepos,
  repoRows,
} from "../src/mainview/lib/settings-view.ts";

const projects = (ANSWERS["project.list"]?.({ orgId: "org_personal" }) as { projects: Project[] })
  .projects;
const setup = ANSWERS["setup.status"]?.({ orgId: "org_personal" }) as SetupStatus;

describe("repositories", () => {
  it("lists each project's repositories with connection and protection", () => {
    const red = {
      ...setup,
      projects: setup.projects.map((p) => ({
        ...p,
        protection: {
          state: "red" as const,
          problems: ["`factory/verify` is not required"],
          warnings: [],
          files: [],
          rulesetsUrl: "",
          branch: "main",
          viewerIsRepoAdmin: true,
          adminMessage: "",
        },
      })),
    };
    expect(repoRows(projects, [red])).toEqual([
      {
        id: "repo_software-factory",
        fullName: "example/software-factory",
        branch: "main",
        projectId: "prj_factory",
        projectName: "Factory",
        connection: { text: "Connected", dot: "done", manageUrl: null },
        protection: {
          text: "Not protected",
          dot: "waiting",
          detail: "`factory/verify` is not required",
        },
      },
    ]);
    expect(repoRows(projects, [setup])[0]?.protection).toBeNull();
    expect(projectsWithoutRepos([{ ...(projects[0] as Project), repositories: [] }])).toHaveLength(
      1,
    );
  });

  it("words a GitHub installation", () => {
    const [i] = setup.installations;
    expect(installationText(i as SetupStatus["installations"][number])).toEqual({
      text: "Installed on example, reaching the repositories you chose.",
      dot: "done",
    });
  });
});

describe("devices", () => {
  it("lists working devices and tokens, this Mac first", () => {
    const d = ANSWERS["desktopDevice.list"]?.({}) as OpOutput<"desktopDevice.list">;
    const t = ANSWERS["cliToken.list"]?.({}) as OpOutput<"cliToken.list">;
    const rows = deviceRows(d.devices, t.tokens, "dev_m5");
    expect(rows.map((r) => [r.name, r.kind, r.thisDevice, r.can, r.proves])).toEqual([
      ["M5", "desktop", true, "Read, write, approve", "Touch ID"],
      ["Mac mini", "desktop", false, "Read, write, approve", "Touch ID"],
      ["M5 terminal", "cli", false, "Read, write", "Can't approve"],
    ]);
  });

  it("leaves out expired tokens", () => {
    const rows = deviceRows(
      [],
      [
        {
          id: "clt_x",
          name: null,
          scope: "read",
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: "2026-02-01T00:00:00Z",
          revokedAt: null,
        },
      ],
      null,
      Date.parse("2026-03-01T00:00:00Z"),
    );
    expect(rows).toEqual([]);
  });

  it("puts the pages under Settings", () => {
    expect(sectionOf("/settings/devices")).toBe("settings");
    expect(tabTitle("/settings/repositories", () => null)).toBe("Repositories");
  });
});
