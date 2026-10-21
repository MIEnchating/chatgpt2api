"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { toast } from "sonner";

import { fetchImageGenerationPreferences, fetchRelayModels, updateRelayTokenPreferences } from "@/lib/api";
import {
  EMPTY_RELAY_TOKEN_NAMES,
  relayTokenNamesFromPreferences,
  relayTokenNameForModel,
  nextRelayTokenNameForModel,
  relayTokenRouteForModel,
  relayTokenPreferenceField,
  type RelayTokenKind,
  type RelayTokenNames,
} from "@/lib/relay-token-selection";
import {
  getCachedAuthSession,
  getVerifiedAuthSession,
} from "@/lib/session";
import { AUTH_SESSION_CHANGE_EVENT, type StoredAuthSession } from "@/lib/auth-session";
import { RelayTokenPreferencesContext } from "@/lib/use-relay-token-preferences";
import { RelayTokenPreferenceMutationTracker } from "@/lib/relay-token-preference-mutations";
import {
  createRelayTokenModelLoader,
  EMPTY_RELAY_TOKEN_MODEL_SNAPSHOT,
} from "@/lib/relay-token-models";
import {
  dismissImageGenerationPreferencesLoadError,
  IMAGE_GENERATION_PREFERENCES_RETRY_EVENT,
  showImageGenerationPreferencesLoadError,
} from "@/lib/image-generation-preferences-retry";

export function RelayTokenPreferencesProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [session, setSession] = useState<StoredAuthSession | null>(() => getCachedAuthSession() ?? null);
  const sessionKey = session?.key || "";
  const [tokenNames, setSelectedTokenNames] = useState<RelayTokenNames>(EMPTY_RELAY_TOKEN_NAMES);
  const lastTokenByModelRef = useRef(new Map<string, string>());
  const tokenNamesRef = useRef<RelayTokenNames>(EMPTY_RELAY_TOKEN_NAMES);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const modelScope = JSON.stringify([sessionKey, preferencesReady, tokenNames, pathname]);
  const [modelState, setModelState] = useState({ scope: "", snapshot: EMPTY_RELAY_TOKEN_MODEL_SNAPSHOT });
  const modelLoaderRef = useRef<ReturnType<typeof createRelayTokenModelLoader> | null>(null);
  const modelSnapshot = modelState.scope === modelScope ? modelState.snapshot : EMPTY_RELAY_TOKEN_MODEL_SNAPSHOT;
  const { modelsByToken, failedModelTokenNames, ready: routingReady, refreshing: modelsRefreshing } = modelSnapshot;
  const [preferencesLoadVersion, setPreferencesLoadVersion] = useState(0);
  const [mutationTracker] = useState(() => new RelayTokenPreferenceMutationTracker());

  useLayoutEffect(() => {
    mutationTracker.activateSession(sessionKey);
    lastTokenByModelRef.current.clear();
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
    setModelState({ scope: "", snapshot: EMPTY_RELAY_TOKEN_MODEL_SNAPSHOT });
    tokenNamesRef.current = EMPTY_RELAY_TOKEN_NAMES;
    setSelectedTokenNames(EMPTY_RELAY_TOKEN_NAMES);
    if (!sessionKey) {
      dismissImageGenerationPreferencesLoadError();
      return () => { ignore = true; };
    }
    void fetchImageGenerationPreferences()
      .then(({ preferences, relay_onboarding_warnings }) => {
        if (!ignore) {
          if (relay_onboarding_warnings?.length) {
            toast.warning("默认分组 Key 初始化未完成", { id: "relay-group-initialization", description: relay_onboarding_warnings.join("；") });
          }
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
    if (!preferencesReady || !sessionKey) return;
    const names = Array.from(new Set(Object.values(tokenNames).flat()));
    const loader = createRelayTokenModelLoader({
      tokenNames: names,
      load: fetchRelayModels,
      onChange: (snapshot) => setModelState({ scope: modelScope, snapshot }),
    });
    modelLoaderRef.current = loader;
    void loader.refresh();
    return () => {
      loader.dispose();
      if (modelLoaderRef.current === loader) modelLoaderRef.current = null;
    };
  }, [modelScope, preferencesReady, sessionKey, tokenNames]);

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

  const nextTokenNameForModel = useCallback((kind: RelayTokenKind, model: string) => {
    const key = `${kind}:${model.trim().toLowerCase()}`;
    const name = nextRelayTokenNameForModel(tokenNamesRef.current[kind], model, modelsByToken, lastTokenByModelRef.current.get(key) || "");
    if (name) lastTokenByModelRef.current.set(key, name);
    return name;
  }, [modelsByToken]);

  const refreshTokenModels = useCallback(() => { void modelLoaderRef.current?.refresh(); }, []);
  const routeForModel = useCallback((kind: RelayTokenKind, model: string) => {
    const route = relayTokenRouteForModel(tokenNamesRef.current[kind], model, modelsByToken, failedModelTokenNames, preferencesReady && routingReady);
    if (modelsRefreshing && (route.status === "model-list-error" || route.status === "model-unavailable")) {
      return { status: "loading" as const, tokenName: "" };
    }
    return route;
  }, [failedModelTokenNames, modelsByToken, modelsRefreshing, preferencesReady, routingReady]);

  return (
    <RelayTokenPreferencesContext.Provider value={{ failedModelTokenNames, isReady: preferencesReady && routingReady, modelsByToken, nextTokenNameForModel, refreshTokenModels, routeForModel, setTokenNames, tokenNames, tokenNameForModel }}>
      {children}
    </RelayTokenPreferencesContext.Provider>
  );
}
