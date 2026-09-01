import { describe, expect, test } from "bun:test";

import {
  createAppMetaLoadMerge,
  defaultAppMeta,
  normalizeAppMeta,
} from "../src/lib/app-meta.ts";

describe("app meta load lifecycle", () => {
  test("an update emitted during the initial load wins without dropping other loaded fields", async () => {
    const merge = createAppMetaLoadMerge();
    let resolveLoaded;
    const pendingLoad = new Promise((resolve) => {
      resolveLoaded = resolve;
    }).then((loaded) => merge.applyLoaded(loaded));
    const applyEvent = merge.prepareUpdate({
      app_title: "新标题",
      project_name: "新标题",
    });
    resolveLoaded(normalizeAppMeta({
      app_title: "旧标题",
      project_name: "旧标题",
      site_icon_url: "/site-icons/current.png",
    }));

    await expect(pendingLoad).resolves.toMatchObject({
      app_title: "新标题",
      project_name: "新标题",
      site_icon_url: "/site-icons/current.png",
    });
    expect(applyEvent(defaultAppMeta).app_title).toBe("新标题");
  });

  test("multiple update events merge in order over a late initial snapshot", () => {
    const merge = createAppMetaLoadMerge();
    merge.prepareUpdate({ app_title: "新标题" });
    merge.prepareUpdate({ site_icon_url: "/site-icons/new.png" });

    expect(merge.applyLoaded(normalizeAppMeta({
      app_title: "旧标题",
      site_icon_url: "/site-icons/old.png",
      login_page_image_url: "/login-page-images/current.png",
    }))).toMatchObject({
      app_title: "新标题",
      site_icon_url: "/site-icons/new.png",
      login_page_image_url: "/login-page-images/current.png",
    });
  });

  test("a failed initial load cannot erase a newer update event", () => {
    const merge = createAppMetaLoadMerge();
    expect(merge.failureFallback()).toBe(defaultAppMeta);

    merge.prepareUpdate({ app_title: "新标题" });

    expect(merge.failureFallback()).toBeNull();
  });
});
