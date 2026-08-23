"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";

import { ConfigCard } from "./components/config-card";
import { AnnouncementsCard } from "./components/announcements-card";
import { ImageStorageGovernanceCard } from "./components/image-storage-governance-card";
import { ImageObjectStorageCard } from "./components/image-object-storage-card";
import { LogGovernanceCard } from "./components/log-governance-card";
import { LoginPageImageCard } from "./components/login-page-image-card";
import { ModelConfigCard } from "./components/model-config-card";
import { SiteIconCard } from "./components/site-icon-card";
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

const SETTINGS_MASONRY_ROW_HEIGHT = 1;
const SETTINGS_MASONRY_GAP = 20;

function SettingsMasonry({
  items,
}: {
  items: Array<{ content: ReactNode; id: string }>;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [rowSpans, setRowSpans] = useState<Record<string, number>>({});

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;

    const updateSpan = (element: Element) => {
      const id = element.getAttribute("data-settings-masonry-content");
      if (!id) return;
      const height = element.getBoundingClientRect().height;
      const span = Math.max(
        1,
        Math.ceil((height + SETTINGS_MASONRY_GAP) / SETTINGS_MASONRY_ROW_HEIGHT),
      );
      setRowSpans((current) => current[id] === span ? current : { ...current, [id]: span });
    };

    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => updateSpan(entry.target));
    });
    const elements = Array.from(grid.querySelectorAll("[data-settings-masonry-content]"));
    elements.forEach((element) => {
      observer.observe(element);
      updateSpan(element);
    });
    return () => observer.disconnect();
  }, [items.length]);

  return (
    <section
      ref={gridRef}
      className="grid min-w-0 items-start gap-x-5 gap-y-0 grid-flow-row-dense lg:grid-cols-2 [grid-auto-rows:1px]"
    >
      {items.map(({ content, id }) => (
        <div
          key={id}
          className="min-w-0"
          style={{ gridRowEnd: `span ${rowSpans[id] || 1}` }}
        >
          <div data-settings-masonry-content={id} className="min-w-0">
            {content}
          </div>
        </div>
      ))}
    </section>
  );
}

function AdminSettingsPageContent({ session }: { session: StoredAuthSession }) {
  const settingsItems = [
    { id: "config", content: <ConfigCard /> },
    { id: "model-config", content: <ModelConfigCard session={session} /> },
    { id: "image-object-storage", content: <ImageObjectStorageCard /> },
    { id: "image-storage-governance", content: <ImageStorageGovernanceCard /> },
    ...(session.role === "admin" ? [{ id: "site-icon", content: <SiteIconCard /> }] : []),
    ...(session.role === "admin" ? [{ id: "announcements", content: <AnnouncementsCard /> }] : []),
    ...(session.role === "admin" ? [{ id: "prompt-sources", content: <PromptSourcesCard /> }] : []),
    { id: "log-governance", content: <LogGovernanceCard /> },
    { id: "login-page-image", content: <LoginPageImageCard /> },
  ];

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 pb-8 pr-1">
        <SettingsDataController />
        <SettingsMasonry items={settingsItems} />
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

  return <AdminSettingsPageContent session={session} />;
}
