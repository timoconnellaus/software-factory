// The web terminal's relay (ADR 0440): what the runner host, the job's TerminalRelay Durable Object
// in sf-engine and a browser send each other over their WebSockets. Output is binary frames (the
// terminal's raw bytes); everything else is a small JSON text frame with a `t` field.
//
//   host → relay     binary output; { t: "size", size }; { t: "ended", reason }
//   relay → host     { t: "open", size | null }; { t: "input", data }; { t: "resize", size };
//                    { t: "redraw" }; { t: "close", reason }
//   viewer → relay   { t: "input", data } and { t: "resize", size } (the runner's owner only);
//                    "ping" (answered "pong" without waking the relay)
//   relay → viewer   binary output; { t: "hello", mode, viewers, host }; { t: "size", size };
//                    { t: "viewers", viewers, host }; { t: "ended", reason }
//
// Runtime-neutral (zod only): the relay (Workers), the host (Node) and the page share it.
import { z } from "zod";

/** How long the cloud holds a terminal call with nobody waiting (ADR 0440). */
export const TERMINAL_WAIT_MAX_MS = 25_000;
/** Most viewers of one job's terminal at once. */
export const TERMINAL_MAX_VIEWERS = 8;
/** Most characters of one input message; longer ones are dropped. */
export const TERMINAL_INPUT_MAX = 4_096;
/** Largest output frame the relay forwards; the host sends at most TERMINAL_HOST_FRAME. */
export const TERMINAL_FRAME_MAX = 64 * 1024;
/** Largest output frame the host sends (it coalesces output up to this). */
export const TERMINAL_HOST_FRAME = 32 * 1024;
/** How long a socket ticket lasts; each works once. */
export const TERMINAL_TICKET_TTL_MS = 60_000;
/** The host stops sending output while its socket buffers more than this… */
export const TERMINAL_HIGH_WATER = 1024 * 1024;
/** …and redraws once it is back under this. */
export const TERMINAL_LOW_WATER = 256 * 1024;

/** The relay's sockets on sf-engine (ADR 0440). `host` is public; `view` only through the binding. */
export const TERMINAL_PATHS = {
  host: (jobId: string) => `/terminal/v1/jobs/${encodeURIComponent(jobId)}/host`,
  view: (jobId: string) => `/terminal/v1/jobs/${encodeURIComponent(jobId)}/view`,
} as const;

/** Parses `/terminal/v1/jobs/<id>/<host|view>`. */
export function parseTerminalPath(path: string): { jobId: string; role: "host" | "view" } | null {
  const m = path.match(/^\/terminal\/v1\/jobs\/([^/]+)\/(host|view)$/);
  if (!m) return null;
  return { jobId: decodeURIComponent(m[1] ?? ""), role: m[2] as "host" | "view" };
}

export const TERMINAL_COLS = { min: 20, max: 400 } as const;
export const TERMINAL_ROWS = { min: 5, max: 200 } as const;

export const terminalSizeSchema = z.object({
  cols: z.number().int(),
  rows: z.number().int(),
});
export type TerminalSize = z.infer<typeof terminalSizeSchema>;

/** A size clamped to what the relay and tmux accept. */
export function clampSize(size: TerminalSize): TerminalSize {
  const clamp = (n: number, r: { min: number; max: number }) =>
    Math.min(r.max, Math.max(r.min, Math.round(Number.isFinite(n) ? n : r.min)));
  return { cols: clamp(size.cols, TERMINAL_COLS), rows: clamp(size.rows, TERMINAL_ROWS) };
}

/** `type`: the runner's owner, who may type and resize; `watch`: everyone else. */
export const TERMINAL_MODES = ["type", "watch"] as const;
export type TerminalMode = (typeof TERMINAL_MODES)[number];

export const hostToRelaySchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("size"), size: terminalSizeSchema }),
  z.object({ t: z.literal("ended"), reason: z.string().max(500) }),
]);
export type HostToRelay = z.infer<typeof hostToRelaySchema>;

export const relayToHostSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("open"), size: terminalSizeSchema.nullable() }),
  z.object({ t: z.literal("input"), data: z.string().max(TERMINAL_INPUT_MAX) }),
  z.object({ t: z.literal("resize"), size: terminalSizeSchema }),
  z.object({ t: z.literal("redraw") }),
  z.object({ t: z.literal("close"), reason: z.string() }),
]);
export type RelayToHost = z.infer<typeof relayToHostSchema>;

export const viewerToRelaySchema = z.discriminatedUnion("t", [
  // Not capped here: the relay drops an input over TERMINAL_INPUT_MAX rather than refusing the frame.
  z.object({ t: z.literal("input"), data: z.string() }),
  z.object({ t: z.literal("resize"), size: terminalSizeSchema }),
]);
export type ViewerToRelay = z.infer<typeof viewerToRelaySchema>;

export const relayToViewerSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    mode: z.enum(TERMINAL_MODES),
    viewers: z.number(),
    host: z.boolean(),
  }),
  z.object({ t: z.literal("size"), size: terminalSizeSchema }),
  z.object({ t: z.literal("viewers"), viewers: z.number(), host: z.boolean() }),
  z.object({ t: z.literal("ended"), reason: z.string() }),
]);
export type RelayToViewer = z.infer<typeof relayToViewerSchema>;

/** Parses one JSON control frame against a schema; null when it isn't one. */
export function parseTerminalMessage<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
