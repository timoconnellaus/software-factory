// Settings in the new shell: a placeholder until its own change builds it here. The old settings
// (This Mac, devices, repositories) are under Old factory until then.
import { createRoute } from "@tanstack/react-router";
import { ComingNext } from "../components/flow/parts.tsx";
import { flowOrg } from "./flow.$orgId.tsx";

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "settings",
  component: () => <ComingNext title="Settings" />,
});
