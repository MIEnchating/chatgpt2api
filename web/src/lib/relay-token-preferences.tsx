"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { fetchImageGenerationPreferences, updateRelayTokenPreferences } from "@/lib/api";
import {
  EMPTY_RELAY_TOKEN_NAMES,
  relayTokenNamesFromPreferences,
  relayTokenPreferenceField,
  type RelayTokenKind,
  type RelayTokenNames,
} from "@/lib/relay-token-selection";
import {
  AUTH_SESSION_CHANGE_EVENT,
  getCachedAuthSession,
  getVerifiedAuthSession,
} from "@/lib/session";
import type { StoredAuthSession } from "@/store/auth";
import { RelayTokenPreferencesContext } from "@/lib/use-relay-token-preferences";

export function RelayTokenPreferencesProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredAuthSession | null>(() => getCachedAuthSession() ?? null);
  const sessionKey = session?.key || "";
  const [tokenNames, setTokenNames] = useState<RelayTokenNames>(EMPTY_RELAY_TOKEN_NAMES);
  const tokenNamesRef = useRef<RelayTokenNames>(EMPTY_RELAY_TOKEN_NAMES);
  const [isReady, setIsReady] = useState(false);
  const updateVersions = useRef<Record<RelayTokenKind, number>>({ text: 0, image: 0, video: 0, audio: 0 });

  useEffect(() => {
    let active = true;
    const refreshSession = async () => {
      const verified = await getVerifiedAuthSession();
      if (active) setSession(verified);
    };
    const handleSessionChange = () => {
      setSession(getCachedAuthSession() ?? null);
    };
    void refreshSession();
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
      active = false;
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    setIsReady(false);
    tokenNamesRef.current = EMPTY_RELAY_TOKEN_NAMES;
    setTokenNames(EMPTY_RELAY_TOKEN_NAMES);
    if (!sessionKey) {
      return () => { ignore = true; };
    }
    void fetchImageGenerationPreferences()
      .then(({ preferences }) => {
        if (!ignore) {
          const loaded = relayTokenNamesFromPreferences(preferences);
          tokenNamesRef.current = loaded;
          setTokenNames(loaded);
        }
      })
      .catch(() => {
        if (!ignore) {
          tokenNamesRef.current = EMPTY_RELAY_TOKEN_NAMES;
          setTokenNames(EMPTY_RELAY_TOKEN_NAMES);
        }
      })
      .finally(() => {
        if (!ignore) setIsReady(true);
      });
    return () => { ignore = true; };
  }, [sessionKey]);

  const setTokenName = useCallback(async (kind: RelayTokenKind, tokenName: string) => {
    const normalizedName = tokenName.trim();
    const version = updateVersions.current[kind] + 1;
    updateVersions.current[kind] = version;
    const previousName = tokenNamesRef.current[kind];
    tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: normalizedName };
    setTokenNames(tokenNamesRef.current);
    try {
      const field = relayTokenPreferenceField(kind);
      const { preferences } = await updateRelayTokenPreferences({ [field]: normalizedName });
      if (updateVersions.current[kind] === version) {
        const savedName = relayTokenNamesFromPreferences(preferences)[kind];
        tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: savedName };
        setTokenNames(tokenNamesRef.current);
      }
    } catch (error) {
      if (updateVersions.current[kind] === version) {
        tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: previousName };
        setTokenNames(tokenNamesRef.current);
      }
      throw error;
    }
  }, []);

  return (
    <RelayTokenPreferencesContext.Provider value={{ isReady, tokenNames, setTokenName }}>
      {children}
    </RelayTokenPreferencesContext.Provider>
  );
}
