"use client";

import { lazy, Suspense, useLayoutEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { RefreshCw, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { AUTH_SESSION_CHANGE_EVENT, type StoredAuthSession } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SettingsPanel } from "@/components/settings-panel";
import { getSystemSettingsSections } from "@/lib/settings-navigation";

import { ConfigCard } from "./components/config-card";
import { AnnouncementsCard } from "./components/announcements-card";
import { ImageStorageGovernanceCard } from "./components/image-storage-governance-card";
import { StorageProvidersCard } from "./components/storage-providers-card";
import { LogGovernanceCard } from "./components/log-governance-card";
import { LoginPageImageCard } from "./components/login-page-image-card";
import { ModelConfigCard } from "./components/model-config-card";
import { PromptSourcesCard } from "./components/prompt-sources-card";
import { useSettingsStore } from "./store";

const VideoModelContractsCard = lazy(async () => ({
  default: (await import("./components/video-model-contracts-card")).VideoModelContractsCard,
}));

function SettingsDataController({ children, sessionKey }: { children: ReactNode; sessionKey: string }) {
  const activeSessionKey = useSettingsStore((state) => state.activeSessionKey);
  const activateSession = useSettingsStore((state) => state.activateSession);
  const deactivateSession = useSettingsStore((state) => state.deactivateSession);
  const loadConfig = useSettingsStore((state) => state.loadConfig);

  useLayoutEffect(() => {
    activateSession(sessionKey);
    void loadConfig();
    const handleSessionChange = () => {
      if (getCachedAuthSession()?.key !== sessionKey) deactivateSession(sessionKey);
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleSessionChange);
      deactivateSession(sessionKey);
    };
  }, [activateSession, deactivateSession, loadConfig, sessionKey]);

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

function SettingsSection({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const config = useSettingsStore((state) => state.config);
  const configLoadError = useSettingsStore((state) => state.configLoadError);
  const loadConfig = useSettingsStore((state) => state.loadConfig);

  if (id === "announcements" || id === "video-model-contracts" || config) return children;
  return (
    <SettingsPanel title={label}>
      {configLoadError ? (
        <EmptyState compact role="alert" icon={Settings2} title="无法加载系统配置" description={configLoadError}
          action={<Button variant="outline" size="sm" onClick={() => void loadConfig()}><RefreshCw />重试</Button>} />
      ) : <LoadingState label="正在加载系统配置" />}
    </SettingsPanel>
  );
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
      <SettingsWorkspace items={settingsItems} title="系统设置" activeId={activeItem.id}>
        <Suspense fallback={<LoadingState label="正在加载设置分区" />}>
          <SettingsSection id={activeItem.id} label={activeItem.label}>{activeItem.content}</SettingsSection>
        </Suspense>
      </SettingsWorkspace>
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
