"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, Bell, Database, ImageIcon, ListChecks, LoaderCircle, ScrollText, Settings2, Sparkles } from "lucide-react";

import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";
import { ScrollArea } from "@/components/ui/scroll-area";

import { ConfigCard } from "./components/config-card";
import { AnnouncementsCard } from "./components/announcements-card";
import { ImageStorageGovernanceCard } from "./components/image-storage-governance-card";
import { StorageProvidersCard } from "./components/storage-providers-card";
import { LogGovernanceCard } from "./components/log-governance-card";
import { LoginPageImageCard } from "./components/login-page-image-card";
import { ModelConfigCard } from "./components/model-config-card";
import { PromptSourcesCard } from "./components/prompt-sources-card";
import { useSettingsStore } from "./store";

function SettingsDataController() {
  const didLoadRef = useRef(false);
  const initialize = useSettingsStore((state) => state.initialize);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void initialize();
  }, [initialize]);

  return null;
}

function AdminSettingsPageContent({ session }: { session: StoredAuthSession }) {
  const settingsItems = [
    { id: "config", label: "基础与数据库", icon: Settings2, content: <ConfigCard isAdmin={session.role === "admin"} /> },
    { id: "model-config", label: "模型配置", icon: Sparkles, content: <ModelConfigCard session={session} /> },
		{ id: "image-object-storage", label: "存储配置", icon: Database, content: <StorageProvidersCard /> },
		{ id: "media-storage-governance", label: "媒体治理", icon: Archive, content: <ImageStorageGovernanceCard /> },
    ...(session.role === "admin" ? [{ id: "announcements", label: "公告管理", icon: Bell, content: <AnnouncementsCard /> }] : []),
    ...(session.role === "admin" ? [{ id: "prompt-sources", label: "提示词来源", icon: ListChecks, content: <PromptSourcesCard /> }] : []),
    { id: "log-governance", label: "日志治理", icon: ScrollText, content: <LogGovernanceCard /> },
    { id: "login-page-image", label: "登录页图片", icon: ImageIcon, content: <LoginPageImageCard /> },
  ];
  const sectionFromHash = () => {
    if (typeof window === "undefined") return settingsItems[0].id;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash === "database-connection") return "config";
    if (hash === "image-storage-governance") return "media-storage-governance";
    return settingsItems.some((item) => item.id === hash) ? hash : settingsItems[0].id;
  };
  const initialSection = sectionFromHash();
  const [activeSection, setActiveSection] = useState(initialSection);
  const activeItem = settingsItems.find((item) => item.id === activeSection) || settingsItems[0];

  useEffect(() => {
    const handleHashChange = () => setActiveSection(sectionFromHash());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  });

  const selectSection = (id: string) => {
    setActiveSection(id);
    const nextURL = `${window.location.pathname}${window.location.search}#${encodeURIComponent(id)}`;
    window.history.replaceState(window.history.state, "", nextURL);
  };

  return (
    <ScrollArea className="h-full min-h-0">
      <div data-settings-layout className="w-full pr-1">
        <SettingsDataController />
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-5 2xl:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="rounded-lg border border-border bg-background p-2 lg:sticky lg:top-0">
            <div className="px-2 pb-2 pt-1 lg:pb-3">
              <h1 className="text-base font-semibold text-foreground">系统设置</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">按类别管理站点配置</p>
            </div>
            <nav className="flex gap-1 overflow-x-auto pb-1 lg:grid lg:overflow-visible lg:pb-0" aria-label="系统设置分类">
              {settingsItems.map((item) => {
                const Icon = item.icon;
                const active = item.id === activeItem.id;
                return <button key={item.id} type="button" onClick={() => selectSection(item.id)} className={`flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-left text-sm transition lg:w-full lg:gap-2.5 ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon className="size-4" /><span>{item.label}</span></button>;
              })}
            </nav>
          </aside>
          <main id={activeItem.id} className="min-w-0">{activeItem.content}</main>
        </div>
      </div>
    </ScrollArea>
  );
}

export default function SettingsPage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/settings");

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <AdminSettingsPageContent session={session} />;
}
