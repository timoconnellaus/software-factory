// A container per job (ADR 0430): runner-local's tmux session, status hook, events and steering,
// with the job's Claude in its own Docker container. The tmux pane runs `container.sh`, which
// `exec`s `docker run -it … /bin/sh <runDir>/launch.sh`, so `tmux attach` still takes the live
// Claude over and the status hook still lands in the run dir. What changes:
//
// - the workspace is a self-contained job repo (`job-repo.ts`), not a worktree of the checkout;
// - the container sees only that repo, a fresh home, its temp dirs and the run dir (read only);
// - its only way out is the job's egress proxy, which allows the stage's hosts and the model API;
// - the launch check reads the process inside the container and compares the container itself;
// - when the session ends the containers stop, the job's git dir is checked and the credential
//   scanned for, before the host's git (push with the job token, diff) touches the repo.
//
// Planning sessions still run on the host (their relay is on the host's loopback, ADR 0350).
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_HARNESS_ACCOUNT,
  type HarnessAccount,
  type LaunchRecord,
  PID_FILE,
  projectHarness,
  type ReadCommand,
  readLaunchRecord,
  removeRunDir,
  STATUS_FILE,
  verifyLaunch,
} from "@software-factory/harness-claude";
import type {
  AdapterEvent,
  Artifact,
  CapabilityManifest,
  Job,
  RunnerAdapter,
} from "@software-factory/runner-contract";
import {
  createLocalRunner,
  DEFAULT_CAPABILITIES,
  type LocalRunnerConfig,
  type LocalSession,
  type LocalWorkspace,
} from "../adapter.ts";
import { findCheckout, isUnder } from "../checkouts.ts";
import { nodeExec } from "../exec.ts";
import { sessionName } from "../tmux.ts";
import { execInCheckContainer } from "./check-exec.ts";
import { egressAllowlist } from "./egress.ts";
import { ensureImage, IMAGE_CONTEXT, IMAGE_NODE } from "./image.ts";
import { checkJobGitDir, createJobRepo, HOST_FETCH_NAMESPACE, scanForSecrets } from "./job-repo.ts";
import { type ContainerRuntime, dockerRuntime, type Mount } from "./runtime.ts";
import {
  agentMounts,
  agentSpec,
  CONTAINER_RECORD,
  CONTAINER_SCRIPT,
  type ContainerRecord,
  containerNames,
  containerProblems,
  containerScript,
  JOB_LABEL,
  jobDirs,
  PROXY_ALIAS,
  proxySpec,
  secretsFile,
} from "./spec.ts";

/**
 * The model credential that goes into the container (ADR 0430 §8, ADR 0023): environment
 * variables, the one secret inside. It comes from the job's Claude account (ADR 0410).
 */
export interface ModelCredential {
  env: Record<string, string>;
}

/** The variables a credential may set. */
export const CREDENTIAL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** The credential from a source of variables (runner.json's `container.env`, the host's env). */
export function credentialFrom(
  ...sources: Array<Record<string, string | undefined> | undefined>
): ModelCredential | null {
  for (const source of sources) {
    for (const name of CREDENTIAL_VARS) {
      const value = source?.[name]?.trim();
      if (value) return { env: { [name]: value } };
    }
  }
  return null;
}

/** The job's Claude account can't go into a container (a login account). */
export class ContainerAccountError extends Error {
  override name = "ContainerAccountError";
}

/**
 * The credential a container job gets from its Claude account (ADR 0410, 0430 §8):
 * - a **token** account: its token, read from its 0600 file, in its own variable;
 * - a **login** account: refused. Its login lives in the macOS Keychain or in its config dir next
 *   to the account's other state, and mounting that dir would hand the agent a refreshable login
 *   and every other conversation on the account. Use a token account (`claude setup-token`);
 * - `default`: `fallback` (runner.json's `container.env`, else the host's environment).
 */
export async function credentialForAccount(
  account: HarnessAccount,
  fallback: () => ModelCredential | null = () => null,
): Promise<ModelCredential | null> {
  if (account.token) {
    const value = (await readFile(account.token.file, "utf8")).trim();
    if (!value)
      throw new ContainerAccountError(`the token file of account "${account.name}" is empty`);
    return { env: { [account.token.env]: value } };
  }
  if (account.configDir) {
    throw new ContainerAccountError(
      `Claude account "${account.name}" is a login, and container isolation needs a token account: add one with \`claude setup-token | sf-runner account add <name> --token-stdin\` and \`sf-runner account use <name>\``,
    );
  }
  return fallback();
}

export interface ContainerOptions {
  /** The runtime (default: Docker over its CLI, `bin`). */
  runtime?: ContainerRuntime;
  /** The `docker` CLI (default `docker` on PATH). */
  bin?: string;
  /** Job dirs (`<containersDir>/sf-<jobId>/`) and the credential's env files. */
  containersDir: string;
  /**
   * The credential for a job, from the Claude account it took when its workspace was prepared
   * (default: `credentialForAccount` with no fallback).
   */
  modelCredential?: (
    job: Job,
    account: HarnessAccount,
  ) => Promise<ModelCredential | null> | ModelCredential | null;
  /** More egress hosts for every job on this runner. */
  allowedHosts?: string[];
  /**
   * Where the host fetched the item and default branches in the checkout (runner-host's
   * `FETCH_NAMESPACE`); they are copied into the job repo for the host's merge (ADR 0320).
   */
  fetchNamespace?: string;
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
  /** `uid:gid` the agent runs as (default: this process's, so its files are the host user's). */
  user?: string;
  /** The `claude` the launch script runs inside the image (default `claude`). */
  claudeBin?: string;
  /** The image's build context (default `packages/runner-local/container/`). */
  imageContext?: string;
  /** Tests: more mounts for the agent (a stand-in claude). */
  extraMounts?: Mount[];
  /** Tests: `--add-host` entries for the proxy (`host.docker.internal:host-gateway` on Linux). */
  proxyAddHosts?: string[];
  /** Tests: how the live command line is read from the container (default `docker exec … ps`). */
  readCommand?: (runtime: ContainerRuntime, container: string) => ReadCommand;
  log?: (message: string) => void;
}

export interface ContainerRunnerConfig extends LocalRunnerConfig {
  container: ContainerOptions;
}

export interface ContainerWorkspace extends LocalWorkspace {
  container: ContainerRecord;
  /**
   * The host's Claude account the job took (ADR 0410). `account` itself names it with the
   * container's own config dir (`<home>/.claude`), where the run's transcript is.
   */
  hostAccount: HarnessAccount;
  /** `<containersDir>/sf-<jobId>`. */
  jobRoot: string;
}

const isContainer = (ws: LocalWorkspace | undefined): ws is ContainerWorkspace =>
  !!ws && "container" in ws;

/** `ps` inside the container: the process's argv, or null when it is gone. */
export function containerReadCommand(runtime: ContainerRuntime, container: string): ReadCommand {
  return async (pid) => {
    const r = await runtime.exec(container, ["ps", "-ww", "-o", "command=", "-p", String(pid)]);
    const line = r.stdout.replace(/\n$/, "");
    return r.code === 0 && line ? line : null;
  };
}

/** Claude's own state in the job's fresh home: onboarding done, the working tree trusted. */
export function claudeStateSeed(work: string, credential: ModelCredential | null) {
  const key = credential?.env.ANTHROPIC_API_KEY;
  return {
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      [work]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        allowedTools: [],
      },
    },
    ...(key ? { customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] } } : {}),
  };
}

/** The container side of the launch check: the agent container and its egress proxy. */
export async function containerChecks(
  runtime: ContainerRuntime,
  record: ContainerRecord,
): Promise<string[]> {
  const problems = containerProblems(record.agent, await runtime.inspect(record.agent.name));
  const proxy = await runtime.inspect(record.proxy.name);
  const cmd = [...(proxy?.Config?.Entrypoint ?? []), ...(proxy?.Config?.Cmd ?? [])];
  if (!proxy || proxy.State?.Running === false) {
    problems.push(`the egress proxy ${record.proxy.name} isn't running`);
  } else if (
    proxy.Image !== record.proxy.image ||
    cmd.join("\0") !== [record.proxy.entrypoint, ...record.proxy.command].join("\0")
  ) {
    problems.push(`the egress proxy ${record.proxy.name} isn't the one the runner started`);
  }
  return problems;
}

/** The checks on a running container job: the process inside, the settings, the containers. */
export async function containerLaunchProblems(
  runtime: ContainerRuntime,
  record: ContainerRecord,
  launch: LaunchRecord,
  readCommand: ReadCommand = containerReadCommand(runtime, record.agent.name),
): Promise<string[]> {
  return [
    ...(await verifyLaunch(launch, readCommand)),
    ...(await containerChecks(runtime, record)),
  ];
}

export async function readContainerRecord(runDir: string): Promise<ContainerRecord | null> {
  try {
    return JSON.parse(await readFile(join(runDir, CONTAINER_RECORD), "utf8")) as ContainerRecord;
  } catch {
    return null;
  }
}

/**
 * The launch and container check for a running container job (for `sf-runner doctor`). Null when
 * the run dir has no container record (not a container job, or not launched yet).
 */
export async function checkRunningContainer(
  runDir: string,
  runtime: ContainerRuntime = dockerRuntime(),
): Promise<{ record: LaunchRecord; problems: string[] } | null> {
  const container = await readContainerRecord(runDir);
  const launch = await readLaunchRecord(runDir);
  if (!container || !launch) return null;
  return { record: launch, problems: await containerLaunchProblems(runtime, container, launch) };
}

export function createContainerRunner(
  config: ContainerRunnerConfig,
): RunnerAdapter<LocalWorkspace, LocalSession> {
  const exec = config.exec ?? nodeExec;
  const options = config.container;
  const runtime =
    options.runtime ?? dockerRuntime({ exec, ...(options.bin ? { bin: options.bin } : {}) });
  const local = createLocalRunner(config);
  const capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
  const log = options.log ?? (() => {});
  const user = options.user ?? `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const search = {
    dirs: config.checkouts ?? [],
    exclude: [
      config.worktreesDir,
      options.containersDir,
      ...(config.ownReposDir ? [config.ownReposDir] : []),
    ],
    exec,
  };
  /** The credential's values per running job, for the scan after the session. */
  const secrets = new Map<string, string[]>();

  async function checkoutFor(job: Job): Promise<string> {
    const found = await findCheckout(job, search);
    if (found) return found.path;
    const clone = await config.resolveRepoPath(job);
    return realpath(clone).catch(() => clone);
  }

  async function containersRoot(): Promise<string> {
    await mkdir(options.containersDir, { recursive: true, mode: 0o700 });
    return realpath(options.containersDir);
  }

  /** Stops a job's containers and removes its network. Gone is fine. */
  async function stopContainers(name: string): Promise<void> {
    const names = containerNames(name);
    await runtime.remove(names.agent);
    await runtime.remove(names.proxy);
    await runtime.removeNetwork(names.network);
  }

  /** Removes everything a container job left on the host, by name. Safe twice. */
  async function cleanUp(job: Job, ws: ContainerWorkspace | undefined): Promise<string[]> {
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        errors.push(`${what}: ${err instanceof Error ? err.message : err}`);
      }
    };
    const name = ws?.name ?? sessionName(job.jobId);
    const root = await containersRoot().catch(() => options.containersDir);
    await attempt("stop containers", () => stopContainers(name));
    await attempt("remove credential", () => rm(secretsFile(root, name), { force: true }));
    await attempt("remove job dir", async () => {
      const dir = ws?.jobRoot ?? jobDirs(root, name).root;
      if (!isUnder(dir, root)) throw new Error(`refusing to remove ${dir}: not under ${root}`);
      // Plain file operations, never git: a tampered job repo can't run anything here.
      await rm(dir, { recursive: true, force: true });
    });
    await attempt("remove run dir", () =>
      removeRunDir(ws?.runDir ?? join(config.runsDir, job.jobId)),
    );
    if (ws) await attempt("remove attachments", () => removeRunDir(ws.attachmentsDir));
    secrets.delete(job.jobId);
    return errors;
  }

  /** After the containers stopped: the git dir check and the credential scan (ADR 0430 §8, §9). */
  async function afterSession(job: Job, ws: ContainerWorkspace): Promise<string[]> {
    const dirs = jobDirs(dirname(ws.jobRoot), ws.name);
    const proxyLog = await runtime.logs(containerNames(ws.name).proxy).catch(() => "");
    if (proxyLog) await writeFile(dirs.egressLog, proxyLog).catch(() => {});
    await stopContainers(ws.name);
    const problems = await checkJobGitDir(ws.container.repo);
    if (problems.length === 0) {
      const leaked = await scanForSecrets(exec, ws.path, ws.baseSha, secrets.get(job.jobId) ?? []);
      if (leaked.length) {
        problems.push(`the model credential is in ${leaked.slice(0, 10).join(", ")}`);
      }
    }
    return problems;
  }

  const active = new Map<string, ContainerWorkspace>();

  return {
    async manifest(): Promise<CapabilityManifest> {
      const base = await local.manifest();
      return {
        ...base,
        capabilities: [...new Set([...base.capabilities, "container-isolation" as const])],
      };
    },

    capacity: () => local.capacity(),

    resolveCheckout: (job) => local.resolveCheckout?.(job) ?? Promise.resolve(null),

    async prepareWorkspace(job, signal, prepareOptions): Promise<LocalWorkspace> {
      if (job.stage === "planning") return local.prepareWorkspace(job, signal, prepareOptions);
      const name = sessionName(job.jobId);
      const root = await containersRoot();
      const dirs = jobDirs(root, name);
      const names = containerNames(name);
      const runDir = join(config.runsDir, job.jobId);
      const attachmentsDir = join(
        config.attachmentsDir ?? join(dirname(config.runsDir), "attachments"),
        job.jobId,
      );
      // Whatever a crashed run of this same job left goes first.
      await cleanUp(job, undefined);
      try {
        // The host's active Claude account, now: the job keeps it (ADR 0410). A login account
        // can't go into a container: say so before anything is made.
        const hostAccount = (await config.account?.(job)) ?? DEFAULT_HARNESS_ACCOUNT;
        if (hostAccount.configDir && !hostAccount.token) {
          await credentialForAccount(hostAccount);
        }
        // A clear failure when Docker isn't running, before anything else is made.
        await runtime.version();
        const image = await ensureImage(runtime, {
          context: options.imageContext ?? IMAGE_CONTEXT,
          log,
        });
        if (signal.aborted) throw signal.reason;
        const checkout = await checkoutFor(job);
        const start = config.startPoint ? await config.startPoint(job, checkout) : job.repo.baseRef;
        for (const dir of [dirs.home, dirs.tmp, dirs.pnpmStore]) {
          await mkdir(dir, { recursive: true, mode: 0o700 });
        }
        const attachments = capabilities.includes("work-item-attachments");
        if (attachments) await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
        const repo = await createJobRepo({
          exec,
          checkout,
          work: dirs.work,
          gitDir: dirs.gitDir,
          jobId: job.jobId,
          branch: job.branch,
          start,
          refs: [job.repo.baseRef, job.repo.defaultBranch]
            .filter((b): b is string => !!b)
            .map((b) => `${options.fetchNamespace ?? HOST_FETCH_NAMESPACE}/${b}`),
        });
        const projected = await projectHarness(job, {
          worktree: dirs.work,
          runDir,
          runTmp: dirs.tmp,
          protectPaths: [...new Set([...(config.protectPaths ?? []), checkout])],
          git: { commonDir: dirs.gitDir, gitDir: dirs.gitDir },
          ...(attachments ? { attachmentsDir } : {}),
          // Inside the image: its Node runs the status hook, its claude is launched.
          statusHook: { node: IMAGE_NODE },
          claudeBin: options.claudeBin ?? "claude",
          isolation: "container",
          // The agent runs on the image's Linux, whatever the host is.
          platform: "linux",
          ...(config.identity ? { identity: config.identity } : {}),
        });
        // The two files the container writes into the (read-only) run dir must exist to be mounted.
        await writeFile(join(runDir, STATUS_FILE), "", { mode: 0o600 });
        await writeFile(join(runDir, PID_FILE), "", { mode: 0o600 });
        const allow = egressAllowlist(job.harness.profile, options.allowedHosts);
        const agent = agentSpec({
          name: names.agent,
          image: image.id,
          user,
          work: dirs.work,
          home: dirs.home,
          launchScript: projected.scriptPath,
          mounts: agentMounts({
            work: dirs.work,
            gitDir: dirs.gitDir,
            runDir,
            home: dirs.home,
            tmp: dirs.tmp,
            pnpmStore: dirs.pnpmStore,
            ...(attachments ? { attachmentsDir } : {}),
            ...(options.extraMounts ? { extra: options.extraMounts } : {}),
          }),
          network: names.network,
          jobId: job.jobId,
          envFile: secretsFile(root, name),
          ...(options.pidsLimit ? { pidsLimit: options.pidsLimit } : {}),
          ...(options.cpus ? { cpus: options.cpus } : {}),
          ...(options.memory ? { memory: options.memory } : {}),
        });
        const proxy = proxySpec({
          name: names.proxy,
          image: image.id,
          jobId: job.jobId,
          allow,
          ...(options.proxyAddHosts ? { addHosts: options.proxyAddHosts } : {}),
        });
        const record: ContainerRecord = {
          jobId: job.jobId,
          runtime: runtime.kind,
          imageTag: image.tag,
          agent,
          proxy,
          allow,
          repo: {
            work: repo.work,
            gitDir: repo.gitDir,
            dotGit: repo.dotGit,
            configHash: repo.configHash,
          },
        };
        await writeFile(join(runDir, CONTAINER_RECORD), `${JSON.stringify(record, null, 2)}\n`, {
          mode: 0o600,
        });
        const script = join(runDir, CONTAINER_SCRIPT);
        await writeFile(script, containerScript(job.jobId, runtime.runArgv(agent)), {
          mode: 0o700,
        });
        const readCommand = (options.readCommand ?? containerReadCommand)(runtime, names.agent);
        const ws: ContainerWorkspace = {
          jobId: job.jobId,
          path: dirs.work,
          branch: job.branch,
          baseSha: repo.baseSha,
          checkout,
          name,
          runDir,
          runTmp: dirs.tmp,
          launch: projected.launch,
          // The tmux pane runs the container; the harness's launch script runs inside it.
          launchScript: script,
          statusFile: projected.statusFile ?? join(runDir, STATUS_FILE),
          attachmentsDir,
          readCommand,
          launchChecks: () => containerChecks(runtime, record),
          container: record,
          hostAccount,
          account: { name: hostAccount.name, configDir: join(dirs.home, ".claude") },
          jobRoot: dirs.root,
        };
        return ws;
      } catch (err) {
        await cleanUp(job, undefined).catch(() => {});
        throw err;
      }
    },

    attachFiles: local.attachFiles
      ? (job, workspace, files) => local.attachFiles?.(job, workspace, files) ?? Promise.resolve("")
      : undefined,

    async startSession(job, workspace, signal): Promise<LocalSession> {
      if (!isContainer(workspace)) return local.startSession(job, workspace, signal);
      const { agent, proxy } = workspace.container;
      const names = containerNames(workspace.name);
      await stopContainers(workspace.name);
      const credential = await (options.modelCredential ?? ((_job, a) => credentialForAccount(a)))(
        job,
        workspace.hostAccount,
      );
      if (!credential || Object.keys(credential.env).length === 0) {
        throw new Error(
          "container isolation needs a model credential on this host: make a token account active (`claude setup-token | sf-runner account add <name> --token-stdin`, then `sf-runner account use <name>`), or for the default account set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in runner.json `container.env`",
        );
      }
      for (const [k, v] of Object.entries(credential.env)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n]/.test(v)) {
          throw new Error(`the model credential's ${k} can't go in an env file`);
        }
      }
      secrets.set(job.jobId, Object.values(credential.env));
      const envFile = agent.envFile ?? secretsFile(dirname(workspace.jobRoot), workspace.name);
      try {
        await runtime.createNetwork(names.network, {
          internal: true,
          labels: { [JOB_LABEL]: job.jobId },
        });
        await runtime.start(proxy);
        await runtime.connect(names.network, proxy.name, PROXY_ALIAS);
        const ready = Date.now() + 15_000;
        while (!/"listening"/.test(await runtime.logs(proxy.name))) {
          if (Date.now() > ready) throw new Error("the egress proxy didn't start");
          await sleep(100, undefined, { signal }).catch(() => {});
          if (signal.aborted) throw signal.reason;
        }
        await mkdir(dirname(envFile), { recursive: true, mode: 0o700 });
        await chmod(dirname(envFile), 0o700);
        await writeFile(
          envFile,
          `${Object.entries(credential.env)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")}\n`,
          { mode: 0o600 },
        );
        await writeFile(
          join(workspace.jobRoot, "home", ".claude.json"),
          `${JSON.stringify(claudeStateSeed(workspace.path, credential), null, 2)}\n`,
          { mode: 0o600 },
        );
        active.set(job.jobId, workspace);
        return await local.startSession(job, workspace, signal);
      } catch (err) {
        active.delete(job.jobId);
        // Whatever ran in the container, the host's git may still run on the repo (the diff).
        await stopContainers(workspace.name).catch(() => {});
        await checkJobGitDir(workspace.container.repo).catch(() => {});
        throw err;
      } finally {
        await rm(envFile, { force: true });
      }
    },

    async *events(job, session, signal): AsyncIterable<AdapterEvent> {
      const ws = active.get(job.jobId);
      if (!ws) {
        yield* local.events(job, session, signal);
        return;
      }
      let ended: Extract<AdapterEvent, { type: "session.ended" }> | null = null;
      for await (const event of local.events(job, session, signal)) {
        if (event.type === "session.ended") {
          ended = event;
          break;
        }
        yield event;
      }
      ended ??= { type: "session.ended", outcome: signal.aborted ? "cancelled" : "failed" };
      // The containers stop before the host's git runs on the repo, then the repo is checked.
      const problems = await afterSession(job, ws).catch((err) => [
        `checking the job repo: ${err instanceof Error ? err.message : err}`,
      ]);
      active.delete(job.jobId);
      if (problems.length === 0) {
        yield ended;
        return;
      }
      yield {
        type: "session.ended",
        outcome: "failed",
        summary: [
          ended.summary,
          `Not pushing: ${problems.join("; ")}. The job repo was put back and the run failed (ADR 0430).`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    },

    async collectArtifacts(job, workspace, session): Promise<Artifact[]> {
      const artifacts = await local.collectArtifacts(job, workspace, session);
      if (isContainer(workspace)) {
        const text = await readFile(join(workspace.jobRoot, "egress.log"), "utf8").catch(() => "");
        if (text.trim()) {
          artifacts.push({
            kind: "log",
            name: "egress-log",
            text: text.length > 60_000 ? `${text.slice(-60_000)}` : text,
          });
        }
      }
      return artifacts;
    },

    async release(job, workspace, session): Promise<void> {
      if (workspace && !isContainer(workspace)) return local.release(job, workspace, session);
      active.delete(job.jobId);
      const errors: string[] = [];
      // The tmux session (by name): runner-local's release without a workspace only kills it.
      await local.release(job, undefined, session).catch((err) => {
        errors.push(`kill session: ${err instanceof Error ? err.message : err}`);
      });
      errors.push(...(await cleanUp(job, workspace)));
      if (errors.length > 0) throw new Error(errors.join("; "));
    },

    steer: local.steer
      ? (session, text) => local.steer?.(session, text) ?? Promise.resolve()
      : undefined,

    // The project's checks run in a fresh container over the job repo, never on the host (ADR
    // 0451). No `continueSession`: the agent's container stops when its turn ends, so a failing
    // check goes to a person rather than back into the session.
    async exec(_job, workspace, command, signal) {
      if (!isContainer(workspace)) throw new Error("this job has no container to run checks in");
      return execInCheckContainer(runtime, exec, workspace.container.agent, command, signal);
    },
  };
}
