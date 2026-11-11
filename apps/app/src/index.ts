export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, worker: "sf-app" });
    }
    // Placeholder: the TanStack Start dashboard and the /mcp surface arrive with stage R1/MVP.
    return new Response("Software Factory: not built yet", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
