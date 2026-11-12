// The Settings section (spec 41): its nested list beside the page. Setup and This Mac exist today;
// members, connections and notifications come with slice 6.
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
        <ListGroup>Yours</ListGroup>
        <ListItem to="/settings" active={path === "/settings"} data-testid="nav-this-mac">
          This Mac
        </ListItem>
      </NestedList>
      <Outlet />
    </>
  );
}
