"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

import { useAuthGuard } from "@/lib/use-auth-guard";

import { ConfigCard } from "./components/config-card";
import { ImageStorageGovernanceCard } from "./components/image-storage-governance-card";
import { LogGovernanceCard } from "./components/log-governance-card";
import { LoginPageImageCard } from "./components/login-page-image-card";
import { SettingsHeader } from "./components/settings-header";
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

function AdminSettingsPageContent() {
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 pb-8 pr-1">
        <SettingsDataController />
        <SettingsHeader />
        <section className="grid items-start gap-5 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-5">
            <ConfigCard />
            <ImageStorageGovernanceCard />
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <LogGovernanceCard />
            <LoginPageImageCard />
          </div>
        </section>
      </div>
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

  return <AdminSettingsPageContent />;
}
