// The Settings section (spec 41): its nested list beside the page. Setup, Repositories and
// Connections (the factory's), This Mac and Devices (yours). Members and notifications have no
// operations yet (slice 6), so they aren't listed. Setup carries the orange dot while it's unfinished.
import { createRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { ListGroup, ListItem, NestedList } from "../components/shell-list.tsx";
import { SetupDot, useSetupUnfinished } from "../components/shell-sidebar.tsx";
import { appRoute } from "./_app.tsx";

export const settingsLayout = createRoute({
  getParentRoute: () => appRoute,
  id: "_settings",
  component: SettingsSection,
});

function SettingsSection() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const setupUnfinished = useSetupUnfinished();
  return (
    <>
      <NestedList title="Settings">
        <ListGroup>The factory</ListGroup>
        <ListItem to="/setup" active={path === "/setup"} data-testid="nav-setup">
          <span className="flex items-center">
            Setup
            {setupUnfinished && <SetupDot className="ml-auto" />}
          </span>
        </ListItem>
        <ListItem
          to="/settings/repositories"
          active={path === "/settings/repositories"}
          data-testid="nav-repositories"
        >
          Repositories
        </ListItem>
        <ListItem
          to="/settings/connections"
          active={path === "/settings/connections"}
          data-testid="nav-connections"
        >
          Connections
        </ListItem>
        <ListGroup>Yours</ListGroup>
        <ListItem to="/settings" active={path === "/settings"} data-testid="nav-this-mac">
          This Mac
        </ListItem>
        <ListItem
          to="/settings/devices"
          active={path === "/settings/devices"}
          data-testid="nav-devices"
        >
          Devices
        </ListItem>
      </NestedList>
      <Outlet />
    </>
  );
}
