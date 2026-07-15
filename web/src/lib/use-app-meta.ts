"use client";

import { useEffect, useState } from "react";

import {
  APP_META_UPDATED_EVENT,
  defaultAppMeta,
  fetchAppMeta,
  normalizeAppMeta,
  resolveSiteIconSrc,
  type AppMeta,
} from "@/lib/app-meta";

export function useAppMeta() {
  const [appMeta, setAppMeta] = useState<AppMeta>(defaultAppMeta);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const data = await fetchAppMeta();
        if (active) {
          setAppMeta(data);
        }
      } catch {
        if (active) {
          setAppMeta(defaultAppMeta);
        }
      }
    };

    const handleUpdated = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : {};
      setAppMeta((current) => normalizeAppMeta({ ...current, ...detail }));
    };

    void load();
    window.addEventListener(APP_META_UPDATED_EVENT, handleUpdated);
    return () => {
      active = false;
      window.removeEventListener(APP_META_UPDATED_EVENT, handleUpdated);
    };
  }, []);

  useEffect(() => {
    document.title = appMeta.app_title;
  }, [appMeta.app_title]);

  useEffect(() => {
    const iconUrl = resolveSiteIconSrc(appMeta.site_icon_url);
    const iconLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    const links = iconLinks.length > 0 ? iconLinks : [document.createElement("link")];
    links.forEach((link) => {
      link.rel = "icon";
      link.href = iconUrl;
      link.removeAttribute("type");
      if (!link.isConnected) {
        document.head.appendChild(link);
      }
    });
  }, [appMeta.site_icon_url]);

  return appMeta;
}
