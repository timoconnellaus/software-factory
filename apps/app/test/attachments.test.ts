// Attachments end to end in the app (spec wi-1, ADR 0260): a pasted clipboard image goes through
// the upload route to the real operations (core's invoke, D1 and a real R2 binding in workerd),
// shows up in the list, and is served back with safe headers. Refusals store nothing, and anyone
// without access gets the same 404 as for a missing file.
import { env } from "cloudflare:workers";
import { invoke, isOperationError, r2AttachmentBlobs, toRefusal } from "@software-factory/core";
import { fakeServices } from "@software-factory/core/testing";
import { describe, expect, it } from "vitest";
import { filesFromClipboard, uploadAttachment } from "#/lib/attachments";
import { runReads } from "#/server/app-api";
import { routeAttachments } from "#/server/attachments";
import type { EngineRpc } from "#/server/engine";
import { signIn, testEnv, uid } from "./helpers.ts";

const ORIGIN = "http://localhost";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7, 7]);

/** sf-engine's EngineApi.invoke, for real: core's pipeline on this D1 and R2. */
const realEngine: EngineRpc = {
  async invoke(name, input, options) {
    try {
      const result = await invoke(
        {
          d1: env.DB,
          services: { ...fakeServices(env.DB), attachments: r2AttachmentBlobs(env.ATTACHMENTS) },
        },
        name,
        input,
        options,
      );
      return { ok: true, result };
    } catch (error) {
      if (isOperationError(error)) return { ok: false, error: toRefusal(error) };
      throw error;
    }
  },
};

/** A signed-in person with a project and a work item in their Personal org. */
async function world(logins: string[]) {
  const appEnv = testEnv(realEngine, logins.join(","));
  const { user, headers } = await signIn(appEnv, logins[0] as string);
  const org = await env.DB.prepare(
    "SELECT organization_id AS id FROM core_member WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ id: string }>();
  if (!org) throw new Error("no personal org");
  const hex = () => crypto.randomUUID().replaceAll("-", "");
  const factoryId = `fac_${hex()}`;
  const projectId = `prj_${hex()}`;
  const workItemId = `wi_${hex()}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_factories (id, org_id, name, created_at, created_by) VALUES (?, ?, 'f', ?, ?)",
    ).bind(factoryId, org.id, now, user.id),
    env.DB.prepare(
      `INSERT INTO core_projects (id, org_id, factory_id, name, slug, repo_owner, repo_name, created_at, created_by)
       VALUES (?, ?, ?, 'p', ?, 'acme', ?, ?, ?)`,
    ).bind(projectId, org.id, factoryId, uid("p-"), uid("repo-"), now, user.id),
    env.DB.prepare(
      `INSERT INTO core_work_items (id, org_id, project_id, workflow_id, number, slug, title, requester_user_id, source, branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'x', 'Fix the header', ?, 'app', 'factory/1-x', ?, ?)`,
    ).bind(workItemId, org.id, projectId, workItemId, user.id, now, now),
  ]);
  /** The browser: same origin, with the session cookie. */
  const browser: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const withCookie = new Headers(request.headers);
    withCookie.set("cookie", headers.get("cookie") ?? "");
    const response = routeAttachments(appEnv, new Request(request, { headers: withCookie }));
    if (!response) throw new Error(`not an attachment route: ${request.url}`);
    return response;
  };
  return { appEnv, user, headers, orgId: org.id, workItemId, browser };
}

/** A paste event's clipboard: a screenshot (unnamed image) and some plain text. */
function clipboard(file: File) {
  return {
    items: [
      { kind: "file", type: file.type, getAsFile: () => file },
      { kind: "string", type: "text/plain", getAsFile: () => null },
    ],
  } as unknown as DataTransfer;
}

async function blobKeys(prefix: string) {
  return (await env.ATTACHMENTS.list({ prefix })).objects.map((o) => o.key);
}

describe("attachments in the app", () => {
  it("pastes a clipboard image, uploads it, lists it, and serves it inline with safe headers", async () => {
    const login = uid("gh-");
    const w = await world([login]);

    const files = filesFromClipboard(
      clipboard(new File([PNG], "image.png", { type: "image/png" })),
      new Date("2026-11-11T09:30:00.000Z"),
    );
    expect(files.map((f) => f.name)).toEqual(["pasted-image-2026-11-11_09-30-00-000.png"]);

    const uploaded = await uploadAttachment(w.workItemId, files[0] as File, {
      fetch: w.browser,
      origin: ORIGIN,
    });
    if (!uploaded.ok) throw new Error(uploaded.message);
    expect(uploaded.attachment).toMatchObject({
      filename: "pasted-image-2026-11-11_09-30-00-000.png",
      contentType: "image/png",
      sizeBytes: PNG.byteLength,
      uploader: { type: "human", id: w.user.id },
    });
    expect(await blobKeys(`${w.orgId}/${w.workItemId}/`)).toEqual([
      `${w.orgId}/${w.workItemId}/${uploaded.attachment.id}`,
    ]);

    // The list the page renders (thumbnail for images: the served URL).
    const [listed] = await runReads(w.appEnv, w.headers, [
      { name: "workItem.attachment.list", input: { workItemId: w.workItemId } },
    ]);
    expect(listed).toMatchObject({
      ok: true,
      output: { attachments: [{ id: uploaded.attachment.id, contentType: "image/png" }] },
    });

    const served = await w.browser(`${ORIGIN}/api/attachments/${uploaded.attachment.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(served.headers.get("content-disposition")).toMatch(/^inline; filename="pasted-image-/);
    expect(served.headers.get("cache-control")).toMatch(/^private/);
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...PNG]);
  });

  it("refuses HTML, SVG, mismatched and oversized uploads with the limit named, storing nothing", async () => {
    const w = await world([uid("gh-")]);
    const prefix = `${w.orgId}/${w.workItemId}/`;
    const upload = (name: string, type: string, body: BlobPart) =>
      uploadAttachment(w.workItemId, new File([body], name, { type }), {
        fetch: w.browser,
        origin: ORIGIN,
      });
    expect(await upload("x.html", "text/html", "<script>alert(1)</script>")).toMatchObject({
      ok: false,
      limit: "contentType",
    });
    expect(await upload("x.svg", "image/svg+xml", "<svg onload=alert(1)/>")).toMatchObject({
      ok: false,
      limit: "contentType",
    });
    expect(await upload("x.txt", "text/plain", "<html><script>1</script>")).toMatchObject({
      ok: false,
      limit: "contentMismatch",
    });
    expect(await upload("x.png", "image/png", "GIF89a")).toMatchObject({
      ok: false,
      limit: "contentMismatch",
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(await upload("big.png", "image/png", big)).toMatchObject({
      ok: false,
      limit: "maxFileBytes",
    });
    expect(await blobKeys(prefix)).toEqual([]);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_attachments WHERE work_item_id = ?",
    )
      .bind(w.workItemId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("never serves stored HTML or SVG inline, even if one got past the operations", async () => {
    const w = await world([uid("gh-")]);
    for (const [type, body] of [
      ["text/html", "<script>alert(1)</script>"],
      ["image/svg+xml", "<svg onload=alert(1)/>"],
    ] as const) {
      const id = `att_${crypto.randomUUID().replaceAll("-", "")}`;
      const key = `${w.orgId}/${w.workItemId}/${id}`;
      await env.ATTACHMENTS.put(key, body);
      await env.DB.prepare(
        `INSERT INTO core_attachments (id, work_item_id, org_id, project_id, filename, content_type, size_bytes, sha256, blob_key, uploader_type, uploader_id, created_at)
         SELECT ?, id, org_id, project_id, 'evil', ?, ?, 'x', ?, 'human', ?, ? FROM core_work_items WHERE id = ?`,
      )
        .bind(id, type, body.length, key, w.user.id, new Date().toISOString(), w.workItemId)
        .run();
      const served = await w.browser(`${ORIGIN}/api/attachments/${id}`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("application/octet-stream");
      expect(served.headers.get("content-disposition")).toMatch(/^attachment; /);
      expect(served.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("answers the same 404 to another org, a signed-out visitor and a missing id", async () => {
    const owner = uid("gh-");
    const stranger = uid("gh-");
    const w = await world([owner, stranger]);
    const up = await uploadAttachment(
      w.workItemId,
      new File([PNG], "a.png", { type: "image/png" }),
      { fetch: w.browser, origin: ORIGIN },
    );
    if (!up.ok) throw new Error(up.message);
    const other = await signIn(w.appEnv, stranger);
    const get = (id: string, cookie: string | null) =>
      routeAttachments(
        w.appEnv,
        new Request(`${ORIGIN}/api/attachments/${id}`, {
          headers: cookie ? { cookie } : {},
        }),
      ) as Promise<Response>;
    const missing = "att_00000000000000000000000000000000";
    const answers = await Promise.all([
      get(up.attachment.id, other.headers.get("cookie")),
      get(up.attachment.id, null),
      get(missing, w.headers.get("cookie")),
    ]);
    for (const r of answers) {
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found");
    }
    // The stranger can't list or add to it either: the same not-found as a missing item.
    const [listed] = await runReads(w.appEnv, other.headers, [
      { name: "workItem.attachment.list", input: { workItemId: w.workItemId } },
    ]);
    expect(listed).toMatchObject({
      ok: false,
      code: "not_found",
      message: `no work item ${w.workItemId}`,
    });
    const added = await routeAttachments(
      w.appEnv,
      new Request(`${ORIGIN}/api/work/${w.workItemId}/attachments`, {
        method: "POST",
        headers: {
          cookie: other.headers.get("cookie") ?? "",
          origin: ORIGIN,
          "x-sf-upload": "1",
          "content-type": "image/png",
        },
        body: PNG,
      }),
    );
    expect(added?.status).toBe(404);
  });

  it("refuses a cross-site upload before reading it", async () => {
    const w = await world([uid("gh-")]);
    const attempts: Record<string, string>[] = [
      { origin: "https://evil.example", "x-sf-upload": "1" },
      { origin: ORIGIN },
    ];
    for (const headers of attempts) {
      const response = await w.browser(`${ORIGIN}/api/work/${w.workItemId}/attachments`, {
        method: "POST",
        headers: { ...headers, "content-type": "image/png" },
        body: PNG,
      });
      expect(response.status).toBe(403);
    }
    expect(await blobKeys(`${w.orgId}/`)).toEqual([]);
  });
});
