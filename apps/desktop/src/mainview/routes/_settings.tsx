// The Settings section (spec 41): its nested list beside the page. Setup, Repositories and
// Connections (the factory's), This Mac and Devices (yours). Members and notifications have no
// operations yet (slice 6), so they aren't listed.
import { createRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { ListGroup, ListItem, NestedList } from "../components/shell-list.tsx";
import { appRoute } from "./_app.tsx";

export const settingsLayout = createRoute({
  getParentRoute: () => appRoute,
  id: "_settings",
  component: SettingsSection,
});

function SettingsSection() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <NestedList title="Settings">
        <ListGroup>The factory</ListGroup>
        <ListItem to="/setup" active={path === "/setup"} data-testid="nav-setup">
          Setup
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
