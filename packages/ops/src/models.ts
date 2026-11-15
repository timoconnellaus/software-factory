// The models and effort levels a chat (and an agent) can choose (spec 70, "Chat"), in one place: what
// the Claude Code CLI on the person's runner accepts. `--model` takes an alias for the latest model of
// a family; `--effort` takes a level (Claude Code 2.1: `claude --help`). Aliases, never model ids:
// the runner's CLI resolves them, so this list doesn't age with each release. Nothing chosen (null)
// means the CLI's own default.
import { z } from "zod";

/** `claude --model` aliases, with the names the app shows. */
export const CHAT_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
] as const;

/** `claude --effort` levels, with the names the app shows. */
export const CHAT_EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
] as const;

/** What a new chat starts with when the person hasn't chosen. */
export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "high";

type Ids<T extends readonly { id: string }[]> = [T[number]["id"], ...T[number]["id"][]];
const ids = <T extends readonly { id: string }[]>(list: T) => list.map((m) => m.id) as Ids<T>;

/** A model alias, or null for the runner's default. Left out: unchanged. */
export const modelInput = z.enum(ids(CHAT_MODELS)).nullable().optional();
/** An effort level, or null for the runner's default. Left out: unchanged. */
export const effortInput = z.enum(ids(CHAT_EFFORTS)).nullable().optional();

/** What `flow.chat.options` answers: the app's pickers. */
export const chatOptions = () => ({
  models: CHAT_MODELS.map((m) => ({ ...m })),
  efforts: CHAT_EFFORTS.map((e) => ({ ...e })),
  defaultModel: DEFAULT_MODEL,
  defaultEffort: DEFAULT_EFFORT,
});
