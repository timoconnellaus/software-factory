// All orgs (the org strip's top button): what needs you, what is working and each org's counts. Not
// built yet: another change builds it here.
import { createRoute } from "@tanstack/react-router";
import { ComingNext } from "../components/flow/parts.tsx";
import { flowLayout } from "./flow.tsx";

export const Route = createRoute({
  getParentRoute: () => flowLayout,
  path: "orgs",
  component: () => <ComingNext title="All orgs" />,
});
