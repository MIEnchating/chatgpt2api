"use client";

import { createContext, useContext } from "react";

import type { RelayTokenKind, RelayTokenNames } from "@/lib/relay-token-selection";

export type RelayTokenPreferencesContextValue = {
  isReady: boolean;
  tokenNames: RelayTokenNames;
  setTokenName: (kind: RelayTokenKind, tokenName: string) => Promise<void>;
};

export const RelayTokenPreferencesContext = createContext<RelayTokenPreferencesContextValue | null>(null);

export function useRelayTokenPreferences() {
  const value = useContext(RelayTokenPreferencesContext);
  if (!value) throw new Error("useRelayTokenPreferences must be used inside RelayTokenPreferencesProvider");
  return value;
}
