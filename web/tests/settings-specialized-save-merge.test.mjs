import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  LOGIN_PAGE_IMAGE_CONFIG_FIELDS,
  mergeUnchangedConfigFields,
  SITE_ICON_CONFIG_FIELDS,
} from "../src/app/settings/specialized-config-merge.ts";

const storeSource = await readFile(
  new URL("../src/app/settings/store.ts", import.meta.url),
  "utf8",
);

const requestSnapshot = {
  proxy: "server-proxy",
  app_title: "Server title",
  site_icon_url: "/site-icons/old.png",
  login_page_image_url: "/login-page-images/old.png",
  login_page_image_mode: "cover",
  login_page_image_zoom: 1,
  login_page_image_position_x: 50,
  login_page_image_position_y: 50,
};

describe("specialized settings saves", () => {
  test("site icon responses update only the icon and preserve other pending drafts", () => {
    const current = {
      ...requestSnapshot,
      proxy: "unsaved proxy draft",
      app_title: "Unsaved title draft",
    };
    const responseSnapshot = {
      ...requestSnapshot,
      proxy: "stale server proxy",
      app_title: "Stale server title",
      site_icon_url: "/site-icons/new.png",
    };

    expect(mergeUnchangedConfigFields(
      current,
      requestSnapshot,
      responseSnapshot,
      SITE_ICON_CONFIG_FIELDS,
    )).toEqual({
      ...current,
      site_icon_url: "/site-icons/new.png",
    });
  });

  test("login image responses preserve drafts made during the request", () => {
    const current = {
      ...requestSnapshot,
      proxy: "unsaved proxy draft",
      login_page_image_zoom: 1.75,
    };
    const responseSnapshot = {
      ...requestSnapshot,
      proxy: "stale server proxy",
      login_page_image_url: "/login-page-images/new.png",
      login_page_image_mode: "contain",
      login_page_image_zoom: 1,
      login_page_image_position_x: 40,
      login_page_image_position_y: 60,
    };

    expect(mergeUnchangedConfigFields(
      current,
      requestSnapshot,
      responseSnapshot,
      LOGIN_PAGE_IMAGE_CONFIG_FIELDS,
    )).toEqual({
      ...current,
      login_page_image_url: "/login-page-images/new.png",
      login_page_image_mode: "contain",
      login_page_image_position_x: 40,
      login_page_image_position_y: 60,
    });
  });

  test("a delayed specialized response cannot restore a cleared config", () => {
    expect(mergeUnchangedConfigFields(
      null,
      requestSnapshot,
      { ...requestSnapshot, site_icon_url: "/site-icons/new.png" },
      SITE_ICON_CONFIG_FIELDS,
    )).toBeNull();
  });

  test("both specialized save paths use field-owned response merging", () => {
    expect(storeSource).toContain(
      "mergeUnchangedConfigFields(state.config, config, nextConfig, SITE_ICON_CONFIG_FIELDS)",
    );
    expect(storeSource).toContain(
      "mergeUnchangedConfigFields(state.config, config, nextConfig, LOGIN_PAGE_IMAGE_CONFIG_FIELDS)",
    );
  });
});
