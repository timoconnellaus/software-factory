// Back off claiming under load (spec 43, ADR 0532; incident #11 (2026-11-12)). On a shared machine
// the factory's own sessions are not the only load: when the 1-minute load average passes a
// multiple of the CPU count, the host stops claiming heavy jobs (build, verify) first, then light
// ones (triage, spec, planning), and resumes each below a lower threshold (hysteresis), so a load
// hovering at the line doesn't flap. Running jobs are never touched. The reason rides on the
// heartbeat's capacity (`paused: { reason: "load", pools, load1, cores }`).
import { availableParallelism, loadavg } from "node:os";
import type { CapacityPaused } from "@software-factory/runner-contract";
import { z } from "zod";

/** `runner.json` `load`. Multiples of the CPU count. */
export const loadPolicySchema = z
  .object({
    /** Off: claim whatever the load. Default on. */
    enabled: z.boolean().default(true),
    /** Stop claiming heavy jobs when the 1-minute load passes this × cores (default 1.5). */
    heavyStop: z.number().min(0.1).max(100).default(1.5),
    /** Stop claiming light jobs too when it passes this × cores (default 2.0). */
    lightStop: z.number().min(0.1).max(100).default(2.0),
    /** A stopped pool resumes once the load is below its stop × this (default 0.8). */
    resumeFactor: z.number().min(0.1).max(1).default(0.8),
  })
  .refine((p) => p.lightStop >= p.heavyStop, "lightStop must be at least heavyStop");

export type LoadPolicy = z.output<typeof loadPolicySchema>;

export const DEFAULT_LOAD_POLICY: LoadPolicy = loadPolicySchema.parse({});

export interface LoadReading {
  load1: number;
  cores: number;
}

export const hostLoad = (): LoadReading => ({
  load1: loadavg()[0] ?? 0,
  cores: Math.max(1, availableParallelism()),
});

/** Decides, reading by reading, which pools are paused for load. */
export class LoadGate {
  private heavy = false;
  private light = false;

  constructor(
    private readonly policy: LoadPolicy = DEFAULT_LOAD_POLICY,
    private readonly read: () => LoadReading = hostLoad,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** The pause for the current load, or null when every pool takes work. */
  check(): CapacityPaused | null {
    if (!this.policy.enabled) return null;
    const { load1, cores } = this.read();
    const per = load1 / cores;
    const { heavyStop, lightStop, resumeFactor } = this.policy;
    const was = this.describe();
    this.heavy = this.heavy ? per >= heavyStop * resumeFactor : per > heavyStop;
    this.light = this.light ? per >= lightStop * resumeFactor : per > lightStop;
    // Light never runs while heavy is stopped for a lower load.
    if (this.light) this.heavy = true;
    const now = this.describe();
    if (now !== was) {
      this.log(
        `load ${load1.toFixed(1)} on ${cores} cores (${per.toFixed(2)}×): ${now === "none" ? "claiming again" : `not claiming ${now} jobs`}`,
      );
    }
    if (!this.heavy && !this.light) return null;
    return {
      reason: "load",
      pools: this.light ? ["heavy", "light"] : ["heavy"],
      load1: Math.round(load1 * 100) / 100,
      cores,
    };
  }

  private describe() {
    return this.light ? "heavy or light" : this.heavy ? "heavy" : "none";
  }
}
