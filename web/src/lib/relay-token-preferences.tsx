"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { fetchImageGenerationPreferences, fetchRelayModels, updateRelayTokenPreferences } from "@/lib/api";
import {
  EMPTY_RELAY_TOKEN_NAMES,
  relayTokenNamesFromPreferences,
  relayTokenNameForModel,
  relayTokenRouteForModel,
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
  const [tokenNames, setSelectedTokenNames] = useState<RelayTokenNames>(EMPTY_RELAY_TOKEN_NAMES);
  const tokenNamesRef = useRef<RelayTokenNames>(EMPTY_RELAY_TOKEN_NAMES);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [routingReady, setRoutingReady] = useState(false);
  const [modelsByToken, setModelsByToken] = useState<Record<string, string[]>>({});
  const [failedModelTokenNames, setFailedModelTokenNames] = useState<string[]>([]);
  const [modelRefreshVersion, setModelRefreshVersion] = useState(0);
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
    setPreferencesReady(false);
    tokenNamesRef.current = EMPTY_RELAY_TOKEN_NAMES;
    setSelectedTokenNames(EMPTY_RELAY_TOKEN_NAMES);
    if (!sessionKey) {
      return () => { ignore = true; };
    }
    void fetchImageGenerationPreferences()
      .then(({ preferences }) => {
        if (!ignore) {
          const loaded = relayTokenNamesFromPreferences(preferences);
          tokenNamesRef.current = loaded;
          setSelectedTokenNames(loaded);
        }
      })
      .catch(() => {
        if (!ignore) {
          tokenNamesRef.current = EMPTY_RELAY_TOKEN_NAMES;
          setSelectedTokenNames(EMPTY_RELAY_TOKEN_NAMES);
        }
      })
      .finally(() => {
        if (!ignore) setPreferencesReady(true);
      });
    return () => { ignore = true; };
  }, [sessionKey]);

  useEffect(() => {
    if (!preferencesReady) return;
    const names = Array.from(new Set(Object.values(tokenNames).flat()));
    let ignore = false;
    setRoutingReady(false);
    setFailedModelTokenNames([]);
    if (names.length === 0) {
      setModelsByToken({});
      setRoutingReady(true);
      return () => { ignore = true; };
    }
    void Promise.all(names.map(async (name) => {
      try {
        const response = await fetchRelayModels({ tokenName: name });
        return { failed: false, models: (response.data || []).map((model) => String(model.id || "").trim()).filter(Boolean), name };
      } catch {
        return { failed: true, models: [] as string[], name };
      }
    })).then((entries) => {
      if (!ignore) {
        setModelsByToken(Object.fromEntries(entries.map((entry) => [entry.name, entry.models])));
        setFailedModelTokenNames(entries.filter((entry) => entry.failed).map((entry) => entry.name));
      }
    }).finally(() => {
      if (!ignore) setRoutingReady(true);
    });
    return () => { ignore = true; };
  }, [modelRefreshVersion, preferencesReady, tokenNames]);

  const setTokenNames = useCallback(async (kind: RelayTokenKind, names: string[]) => {
    const normalizedNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 20);
    const version = updateVersions.current[kind] + 1;
    updateVersions.current[kind] = version;
    const previousNames = tokenNamesRef.current[kind];
    tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: normalizedNames };
    setSelectedTokenNames(tokenNamesRef.current);
    try {
      const field = relayTokenPreferenceField(kind);
      const { preferences } = await updateRelayTokenPreferences({ [field]: normalizedNames });
      if (updateVersions.current[kind] === version) {
        const savedNames = relayTokenNamesFromPreferences(preferences)[kind];
        tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: savedNames };
        setSelectedTokenNames(tokenNamesRef.current);
      }
    } catch (error) {
      if (updateVersions.current[kind] === version) {
        tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: previousNames };
        setSelectedTokenNames(tokenNamesRef.current);
      }
      throw error;
    }
  }, []);

  const tokenNameForModel = useCallback((kind: RelayTokenKind, model: string) => (
    relayTokenNameForModel(tokenNamesRef.current[kind], model, modelsByToken)
  ), [modelsByToken]);

  const refreshTokenModels = useCallback(() => setModelRefreshVersion((version) => version + 1), []);
  const routeForModel = useCallback((kind: RelayTokenKind, model: string) => (
    relayTokenRouteForModel(tokenNamesRef.current[kind], model, modelsByToken, failedModelTokenNames, preferencesReady && routingReady)
  ), [failedModelTokenNames, modelsByToken, preferencesReady, routingReady]);

  return (
    <RelayTokenPreferencesContext.Provider value={{ failedModelTokenNames, isReady: preferencesReady && routingReady, modelsByToken, refreshTokenModels, routeForModel, setTokenNames, tokenNames, tokenNameForModel }}>
      {children}
    </RelayTokenPreferencesContext.Provider>
  );
}
