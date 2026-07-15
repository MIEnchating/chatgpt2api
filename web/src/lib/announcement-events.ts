export const ANNOUNCEMENTS_UPDATED_EVENT = "chatgpt2api:announcements-updated";

export function dispatchAnnouncementsUpdated() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(ANNOUNCEMENTS_UPDATED_EVENT));
  }
}
