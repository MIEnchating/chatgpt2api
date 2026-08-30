"use client";

import { createContext, useContext } from "react";

import type { RelayTokenKind, RelayTokenModels, RelayTokenNames, RelayTokenRoute } from "@/lib/relay-token-selection";

export type RelayTokenPreferencesContextValue = {
  isReady: boolean;
  tokenNames: RelayTokenNames;
  modelsByToken: RelayTokenModels;
  failedModelTokenNames: string[];
  refreshTokenModels: () => void;
  routeForModel: (kind: RelayTokenKind, model: string) => RelayTokenRoute;
  setTokenNames: (kind: RelayTokenKind, tokenNames: string[]) => Promise<void>;
  tokenNameForModel: (kind: RelayTokenKind, model: string) => string;
};

export const RelayTokenPreferencesContext = createContext<RelayTokenPreferencesContextValue | null>(null);

export function useRelayTokenPreferences() {
  const value = useContext(RelayTokenPreferencesContext);
  if (!value) throw new Error("useRelayTokenPreferences must be used inside RelayTokenPreferencesProvider");
  return value;
}
