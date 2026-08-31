import type { SettingsConfig } from "@/lib/api";

export const SITE_ICON_CONFIG_FIELDS = ["site_icon_url"] as const;

export const LOGIN_PAGE_IMAGE_CONFIG_FIELDS = [
  "login_page_image_url",
  "login_page_image_mode",
  "login_page_image_zoom",
  "login_page_image_position_x",
  "login_page_image_position_y",
] as const;

export function mergeUnchangedConfigFields(
  current: SettingsConfig | null,
  requestSnapshot: SettingsConfig,
  responseSnapshot: SettingsConfig,
  fields: readonly string[],
): SettingsConfig | null {
  if (!current) return null;

  let merged = current;
  for (const field of fields) {
    if (
      Object.is(current[field], requestSnapshot[field])
      && !Object.is(current[field], responseSnapshot[field])
    ) {
      if (merged === current) merged = { ...current };
      merged[field] = responseSnapshot[field];
    }
  }
  return merged;
}
