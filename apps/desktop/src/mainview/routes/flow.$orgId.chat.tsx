// Chat in the new shell: a placeholder until its own change builds it here.
import { createRoute } from "@tanstack/react-router";
import { ComingNext } from "../components/flow/parts.tsx";
import { flowOrg } from "./flow.$orgId.tsx";

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "chat",
  component: () => <ComingNext title="Chat" />,
});
