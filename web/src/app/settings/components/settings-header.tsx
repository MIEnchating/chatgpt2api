"use client";

import { LoaderCircle, Save } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

import { useSettingsStore } from "../store";

export function SettingsHeader() {
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  return (
    <PageHeader
      title="设置"
      className="sticky top-0 z-20 border-b border-border/70 bg-background/95 py-2 backdrop-blur"
      actions={
        <Button type="button" onClick={() => void saveConfig()} disabled={isSavingConfig}>
          {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          保存配置
        </Button>
      }
    />
  );
}
