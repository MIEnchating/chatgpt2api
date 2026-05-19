"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

import { useAuthGuard } from "@/lib/use-auth-guard";

import { AnnouncementsCard } from "./components/announcements-card";
import { ConfigCard } from "./components/config-card";
import { ImageStorageGovernanceCard } from "./components/image-storage-governance-card";
import { LogGovernanceCard } from "./components/log-governance-card";
import { LoginPageImageCard } from "./components/login-page-image-card";
import { SettingsHeader } from "./components/settings-header";
import { VersionUpdateCard } from "./components/version-update-card";
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

function SettingsMasonryItem({ children }: { children: ReactNode }) {
  return <div className="mb-5 break-inside-avoid">{children}</div>;
}

function AdminSettingsPageContent({
  canManageSystem,
}: {
  canManageSystem: boolean;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 pb-8">
      <SettingsDataController />
      <SettingsHeader />
      <section className="columns-1 gap-5 md:columns-2">
        <SettingsMasonryItem>
          <VersionUpdateCard canManageSystem={canManageSystem} />
        </SettingsMasonryItem>
        <SettingsMasonryItem>
          <ConfigCard />
        </SettingsMasonryItem>
        <SettingsMasonryItem>
          <LogGovernanceCard />
        </SettingsMasonryItem>
        <SettingsMasonryItem>
          <ImageStorageGovernanceCard />
        </SettingsMasonryItem>
        <SettingsMasonryItem>
          <LoginPageImageCard />
        </SettingsMasonryItem>
        <SettingsMasonryItem>
          <AnnouncementsCard />
        </SettingsMasonryItem>
      </section>
    </div>
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

  return <AdminSettingsPageContent canManageSystem={session.role === "admin"} />;
}
