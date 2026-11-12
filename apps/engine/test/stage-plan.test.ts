// Spec 52, build plan PR (a): today's path expressed as stage lists changes nothing. For a table of
// project configs, sizes and domains, the plan made from the compiled definition is exactly the
// Workflow's own `planWorkflow()`.
import { parseProjectPolicy } from "@software-factory/core";
import {
  compileProjectWorkflow,
  planFromDefinition,
  validateWorkflow,
} from "@software-factory/core/stages";
import { describe, expect, it } from "vitest";
import { planWorkflow } from "../src/workflow/work-item.ts";

const AGENTS = [
  { name: "Builder", role: "implement", tier: "light", instructions: "Run pnpm test first." },
  { name: "Fast builder", role: "implement", tier: "light", instructions: "" },
  {
    name: "Security",
    role: "review",
    tier: "light",
    instructions: "Look hard at auth.",
    requires: ["browser"],
  },
  { name: "Notes", role: "summarise", tier: "standard", instructions: "" },
];

const CONFIGS: Record<string, object> = {
  "no workflow, no agents": {},
  "no workflow, the default builder": { agents: AGENTS },
  "slots in every position": {
    agents: AGENTS,
    workflows: [
      {
        name: "Ship a feature",
        description: "New behaviour",
        slots: {
          afterSpec: [
            {
              id: "design",
              kind: "gate",
              name: "Design",
              approver: "octocat",
              instructions: "Check the mockups.",
            },
          ],
          beforeVerify: [
            {
              id: "security",
              kind: "work",
              name: "Security review",
              agent: "Security",
              when: { domain: "auth" },
            },
            { id: "notes", kind: "work", name: "Release notes", agent: "Notes" },
          ],
          afterVerify: [
            { id: "sign-off", kind: "gate", name: "Sign-off", when: { sizeAtLeast: "large" } },
          ],
        },
        core: { build: "Fast builder" },
      },
    ],
    workflow: "Ship a feature",
  },
  "a workflow whose builder isn't an implementer": {
    agents: AGENTS,
    workflows: [{ name: "Odd", core: {} }],
    workflow: "Odd",
  },
};

const SIZES = ["small", "medium", "large", null] as const;
const DOMAINS = [[], ["auth"], ["billing", "auth"]];

describe("the compiled Software definition plans exactly as Workflow v7 does", () => {
  for (const [what, extra] of Object.entries(CONFIGS)) {
    it(what, () => {
      const parsed = parseProjectPolicy(
        JSON.stringify({ version: 1, autonomyPolicy: "balanced", ...extra }),
      );
      if (!parsed.ok) throw new Error(parsed.error);
      const policy = parsed.policy;
      const def = compileProjectWorkflow(policy, policy.workflow);
      expect(validateWorkflow(def, { agents: policy.agents }).valid).toBe(true);
      for (const size of SIZES) {
        for (const domains of DOMAINS) {
          const today = planWorkflow(policy, policy.workflow, size, JSON.stringify(domains));
          const fromDef = planFromDefinition(
            def,
            policy.agents,
            size,
            domains,
            today?.name ?? null,
          );
          expect(fromDef).toEqual(today);
        }
      }
    });
  }
});
