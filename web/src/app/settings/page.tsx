"use client";

import { useLayoutEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { LoadingState } from "@/components/ui/loading-state";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { AUTH_SESSION_CHANGE_EVENT, type StoredAuthSession } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { getSystemSettingsSections } from "@/lib/settings-navigation";

import { ConfigCard } from "./components/config-card";
import { AnnouncementsCard } from "./components/announcements-card";
import { ImageStorageGovernanceCard } from "./components/image-storage-governance-card";
import { StorageProvidersCard } from "./components/storage-providers-card";
import { LogGovernanceCard } from "./components/log-governance-card";
import { LoginPageImageCard } from "./components/login-page-image-card";
import { ModelConfigCard } from "./components/model-config-card";
import { PromptSourcesCard } from "./components/prompt-sources-card";
import { VideoModelContractsCard } from "./components/video-model-contracts-card";
import { useSettingsStore } from "./store";

function SettingsDataController({ children, sessionKey }: { children: ReactNode; sessionKey: string }) {
  const activeSessionKey = useSettingsStore((state) => state.activeSessionKey);
  const activateSession = useSettingsStore((state) => state.activateSession);
  const deactivateSession = useSettingsStore((state) => state.deactivateSession);
  const initialize = useSettingsStore((state) => state.initialize);

  useLayoutEffect(() => {
    activateSession(sessionKey);
    void initialize(sessionKey);
    const handleSessionChange = () => {
      if (getCachedAuthSession()?.key !== sessionKey) deactivateSession(sessionKey);
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
      deactivateSession(sessionKey);
    };
  }, [activateSession, deactivateSession, initialize, sessionKey]);

  return activeSessionKey === sessionKey ? children : null;
}

function settingsSectionFromHash(rawHash: string, items: readonly { id: string }[]) {
  let hash: string;
  try { hash = decodeURIComponent(rawHash.slice(1)); }
  catch { return items[0].id; }
  if (hash === "database-connection") return "config";
  if (hash === "image-storage-governance") return "media-storage-governance";
  return items.some((item) => item.id === hash) ? hash : items[0].id;
}

function AdminSettingsPageContent({ session }: { session: StoredAuthSession }) {
  const { hash } = useLocation();
  const settingsItems = useMemo(() => {
    const panels: Record<string, ReactNode> = {
      config: <ConfigCard isAdmin={session.role === "admin"} />,
      "model-config": <ModelConfigCard session={session} />,
      "video-model-contracts": <VideoModelContractsCard key={session.key} sessionKey={session.key} />,
      "image-object-storage": <StorageProvidersCard />,
      "media-storage-governance": <ImageStorageGovernanceCard />,
      announcements: <AnnouncementsCard key={session.key} sessionKey={session.key} />,
      "prompt-sources": <PromptSourcesCard />,
      "log-governance": <LogGovernanceCard />,
      "login-page-image": <LoginPageImageCard />,
    };
    return getSystemSettingsSections(session).map((item) => ({ ...item, content: panels[item.id] }));
  }, [session]);
  if (settingsItems.length === 0) return null;
  const activeSection = settingsSectionFromHash(hash, settingsItems);
  const activeItem = settingsItems.find((item) => item.id === activeSection) || settingsItems[0];

  return <SettingsDataController sessionKey={session.key}>
    <div data-settings-layout className="h-full min-h-0">
      <SettingsWorkspace items={settingsItems} title="系统设置" activeId={activeItem.id}>{activeItem.content}</SettingsWorkspace>
    </div>
  </SettingsDataController>;
}

export default function SettingsPage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/settings");
  const sessionRevision = useAuthSessionRevision();

  if (isCheckingAuth || !session || getCachedAuthSession()?.key !== session.key) {
    return (
      <LoadingState label="正在加载系统设置" />
    );
  }

  return <AdminSettingsPageContent key={`${session.key}:${sessionRevision}`} session={session} />;
}
