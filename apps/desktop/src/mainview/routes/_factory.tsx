// The Factory section (spec 41, slice 5): its nested list beside the page. Only screens with an
// operation behind them are listed: Skills and Autopilots (spec 52) have no server side yet.
import { createRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { ListItem, NestedList } from "../components/shell-list.tsx";
import { appRoute } from "./_app.tsx";

export const factoryLayout = createRoute({
  getParentRoute: () => appRoute,
  id: "_factory",
  component: FactorySection,
});

/** The section's pages, in the design's order. */
export const FACTORY_PAGES = [
  { to: "/factory", label: "Overview", testId: "nav-factory-overview" },
  { to: "/factory/incidents", label: "Checks and incidents", testId: "nav-factory-incidents" },
  { to: "/factory/runners", label: "Runners", testId: "nav-factory-runners" },
] as const;

function FactorySection() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <NestedList title="Factory">
        {FACTORY_PAGES.map((p) => (
          <ListItem key={p.to} to={p.to} active={path === p.to} data-testid={p.testId}>
            {p.label}
          </ListItem>
        ))}
      </NestedList>
      <Outlet />
    </>
  );
}
