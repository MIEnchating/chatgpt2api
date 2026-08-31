"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
import { RelayTokenPreferenceMutationTracker } from "@/lib/relay-token-preference-mutations";
import {
  dismissImageGenerationPreferencesLoadError,
  IMAGE_GENERATION_PREFERENCES_RETRY_EVENT,
  showImageGenerationPreferencesLoadError,
} from "@/lib/image-generation-preferences-retry";

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
  const [preferencesLoadVersion, setPreferencesLoadVersion] = useState(0);
  const [mutationTracker] = useState(() => new RelayTokenPreferenceMutationTracker());

  useLayoutEffect(() => {
    mutationTracker.activateSession(sessionKey);
  }, [mutationTracker, sessionKey]);

  useEffect(() => {
    let active = true;
    const refreshSession = async () => {
      const verified = await getVerifiedAuthSession();
      if (active) setSession(verified);
    };
    const handleSessionChange = () => {
      setSession(getCachedAuthSession() ?? null);
    };
    void refreshSession().catch(() => undefined);
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
      active = false;
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    };
  }, []);

  useEffect(() => {
    const handleRetry = () => setPreferencesLoadVersion((version) => version + 1);
    window.addEventListener(IMAGE_GENERATION_PREFERENCES_RETRY_EVENT, handleRetry);
    return () => window.removeEventListener(IMAGE_GENERATION_PREFERENCES_RETRY_EVENT, handleRetry);
  }, []);

  useEffect(() => {
    let ignore = false;
    setPreferencesReady(false);
    setRoutingReady(false);
    setModelsByToken({});
    setFailedModelTokenNames([]);
    tokenNamesRef.current = EMPTY_RELAY_TOKEN_NAMES;
    setSelectedTokenNames(EMPTY_RELAY_TOKEN_NAMES);
    if (!sessionKey) {
      dismissImageGenerationPreferencesLoadError();
      return () => { ignore = true; };
    }
    void fetchImageGenerationPreferences()
      .then(({ preferences }) => {
        if (!ignore) {
          const loaded = relayTokenNamesFromPreferences(preferences);
          tokenNamesRef.current = loaded;
          setSelectedTokenNames(loaded);
          setPreferencesReady(true);
          dismissImageGenerationPreferencesLoadError();
        }
      })
      .catch((error) => {
        if (!ignore) showImageGenerationPreferencesLoadError(error);
      });
    return () => { ignore = true; };
  }, [preferencesLoadVersion, sessionKey]);

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
    mutationTracker.activateSession(sessionKey);
    const mutation = mutationTracker.begin(kind);
    const normalizedNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 20);
    const previousNames = tokenNamesRef.current[kind];
    tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: normalizedNames };
    setSelectedTokenNames(tokenNamesRef.current);
    try {
      const field = relayTokenPreferenceField(kind);
      const { preferences } = await updateRelayTokenPreferences({ [field]: normalizedNames });
      if (mutationTracker.isCurrent(mutation)) {
        const savedNames = relayTokenNamesFromPreferences(preferences)[kind];
        tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: savedNames };
        setSelectedTokenNames(tokenNamesRef.current);
      }
    } catch (error) {
      if (mutationTracker.isCurrent(mutation)) {
        tokenNamesRef.current = { ...tokenNamesRef.current, [kind]: previousNames };
        setSelectedTokenNames(tokenNamesRef.current);
      }
      throw error;
    }
  }, [mutationTracker, sessionKey]);

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
