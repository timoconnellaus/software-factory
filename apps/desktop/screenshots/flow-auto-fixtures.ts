// Auto's fixtures (spec 70, .kim/mockups/auto-schedules.html) for the screenshot harness, the
// behaviour tests and the route tests: the Personal org's schedules (one that made an item, one that
// failed, one that is off), and none in the Client org. Times are this machine's, so "Next" reads
// as it would in the app.
import type { FlowAutoOpMap, FlowSchedule } from "@software-factory/client/flow-auto";
import { viewerTimeZone } from "@software-factory/client/flow-auto";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

/** The next local `hour:minute` (on `weekday`, 0 Sunday, if given) after now, as ISO. */
function nextLocal(hour: number, minute: number, weekday?: number): string {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hour, minute);
  while (d.getTime() <= now || (weekday !== undefined && d.getDay() !== weekday)) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString();
}

const zone = viewerTimeZone();

const schedule = (
  over: Partial<FlowSchedule> & Pick<FlowSchedule, "id" | "name">,
): FlowSchedule => ({
  orgId: "org_personal",
  projectId: "fprj_api",
  title: over.name,
  body: "",
  every: "day",
  atMinute: 0,
  atHour: 9,
  onDay: null,
  timeZone: zone,
  enabled: true,
  nextAt: null,
  lastAt: null,
  lastItemId: null,
  lastError: null,
  createdBy: "usr_owner",
  createdAt: ago(60 * 24 * 20),
  updatedAt: ago(60 * 24 * 20),
  projectName: "API Platform",
  projectKey: "API",
  lastItemNumber: null,
  ...over,
});

export const SCHEDULES: FlowSchedule[] = [
  schedule({
    id: "fsch_deps",
    name: "Dependency bumps",
    title: "Bump the dependencies",
    every: "week",
    onDay: 1,
    atHour: 9,
    nextAt: nextLocal(9, 0, 1),
    lastAt: ago(60 * 24 * 3),
    lastItemId: "fitm_postgres",
    lastItemNumber: 8,
  }),
  schedule({
    id: "fsch_flaky",
    name: "Flaky tests",
    title: "Look for flaky tests",
    every: "hour",
    atMinute: 15,
    atHour: null,
    nextAt: new Date(now + 37 * 60_000).toISOString(),
    lastAt: ago(23),
    lastItemId: "fitm_flaky",
    lastItemNumber: 11,
  }),
  schedule({
    id: "fsch_launch",
    name: "Launch checklist",
    title: "Run the launch checklist",
    every: "weekday",
    atHour: 8,
    atMinute: 30,
    enabled: false,
    projectId: "fprj_launch",
    projectName: "Autopilots launch",
    projectKey: "AL",
  }),
  schedule({
    id: "fsch_triage",
    name: "Nightly triage",
    title: "Triage new customer feedback",
    body: "Sort what came in since yesterday and tag each by area.",
    atHour: 2,
    nextAt: nextLocal(2, 0),
    lastAt: ago(60 * 14),
    lastItemId: "fitm_usage",
    lastItemNumber: 5,
  }),
  schedule({
    id: "fsch_digest",
    name: "Weekly digest",
    title: "Write the weekly digest",
    every: "week",
    onDay: 5,
    atHour: 17,
    // Its project was deleted: it records why each week, and keeps its time.
    projectId: "fprj_gone",
    projectName: null,
    projectKey: null,
    nextAt: nextLocal(17, 0, 5),
    lastAt: ago(60 * 24 * 2),
    lastError: "Its project no longer exists.",
  }),
];

type AutoAnswers = {
  [N in keyof FlowAutoOpMap]: (input: FlowAutoOpMap[N]["input"]) => FlowAutoOpMap[N]["output"];
};

export const AUTO_ANSWERS: AutoAnswers = {
  "flow.schedule.list": (input) => ({
    schedules: SCHEDULES.filter((s) => s.orgId === input.orgId),
  }),
  "flow.schedule.save": (input) => {
    const found = SCHEDULES.find((s) => s.id === input.scheduleId);
    return schedule({
      ...found,
      ...input,
      id: input.scheduleId ?? "fsch_new",
      atHour: input.atHour ?? null,
      onDay: input.onDay ?? null,
    });
  },
  "flow.schedule.delete": () => ({ ok: true }),
  "flow.schedule.runNow": () => ({ id: "fitm_new", number: 13 }),
};
