import { createContext, useContext } from "react";
import type { Me } from "./types";

export interface AppState {
  me: Me;
  refreshMe: () => void;
  pending: number;
  setPending: (n: number) => void;
}

export const AppContext = createContext<AppState | null>(null);
export function useApp(): AppState {
  const v = useContext(AppContext);
  if (!v) throw new Error("AppContext missing");
  return v;
}
