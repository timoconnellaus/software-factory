export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "sf-engine" });
    }
    return new Response("Not found", { status: 404 });
  },
  // Placeholder: lease expiry and stuck-run sweeps arrive with the MVP stage.
  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {},
} satisfies ExportedHandler<Env>;
