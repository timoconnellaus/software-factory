// The desktop's own session (the main process's sign-in state: signed in, login, the device key),
// kept in the query cache and updated when the main process says it changed.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { bun, onSession } from "../bridge.ts";

export function useDesktopSession() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ["session"], queryFn: () => bun.session({}) });
  useEffect(() => onSession((s) => client.setQueryData(["session"], s)), [client]);
  return q.data;
}
