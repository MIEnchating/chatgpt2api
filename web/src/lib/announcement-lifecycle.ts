export type AnnouncementLoadToken = Readonly<{
  sessionKey: string;
  generation: number;
}>;

export type AnnouncementPreferenceSnapshot = Readonly<{
  seen_versions?: readonly string[];
  permanent_versions?: readonly string[];
  snoozed_dates?: Readonly<Record<string, string>>;
}>;

export type AnnouncementPreferenceMutation = Readonly<{
  version: string;
  action: "seen" | "today" | "forever";
  localDate?: string;
}>;

export class AnnouncementLoadLifecycle {
  private sessionKey: string;
  private generation = 0;
  private lastSuccessfulAt = 0;
  private automaticPromptHandled = false;

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
  }

  activateSession(sessionKey: string) {
    if (this.sessionKey === sessionKey) return false;
    this.sessionKey = sessionKey;
    this.generation += 1;
    this.lastSuccessfulAt = 0;
    this.automaticPromptHandled = false;
    return true;
  }

  deactivateSession(sessionKey: string) {
    if (this.sessionKey !== sessionKey) return;
    this.sessionKey = "";
    this.generation += 1;
    this.lastSuccessfulAt = 0;
    this.automaticPromptHandled = false;
  }

  invalidateLoads(sessionKey: string) {
    if (this.sessionKey !== sessionKey) return;
    this.generation += 1;
  }

  beginLoad(sessionKey: string): AnnouncementLoadToken {
    this.activateSession(sessionKey);
    this.generation += 1;
    return { sessionKey, generation: this.generation };
  }

  completeLoad(token: AnnouncementLoadToken, loadedAt: number) {
    if (!this.isCurrent(token)) return false;
    this.lastSuccessfulAt = loadedAt;
    return true;
  }

  shouldLoad(sessionKey: string, now: number, refreshInterval: number) {
    return this.sessionKey !== sessionKey
      || this.lastSuccessfulAt === 0
      || now - this.lastSuccessfulAt >= refreshInterval;
  }

  consumeAutomaticPrompt(sessionKey: string) {
    if (this.sessionKey !== sessionKey || this.automaticPromptHandled) return false;
    this.automaticPromptHandled = true;
    return true;
  }

  private isCurrent(token: AnnouncementLoadToken) {
    return token.sessionKey === this.sessionKey && token.generation === this.generation;
  }
}

export async function loadAnnouncementSnapshot<Announcements, Preferences>(
  loadAnnouncements: () => Promise<Announcements>,
  loadPreferences: () => Promise<Preferences>,
) {
  const [announcements, preferences] = await Promise.all([
    loadAnnouncements(),
    loadPreferences(),
  ]);
  return { announcements, preferences };
}

export function mergeAnnouncementPreferenceMutation(
  current: AnnouncementPreferenceSnapshot,
  response: AnnouncementPreferenceSnapshot,
  mutation: AnnouncementPreferenceMutation,
) {
  const seenVersions = new Set([
    ...(response.seen_versions || []),
    ...(current.seen_versions || []),
    mutation.version,
  ]);
  const permanentVersions = new Set([
    ...(response.permanent_versions || []),
    ...(current.permanent_versions || []),
  ]);
  const snoozedDates = { ...response.snoozed_dates };
  Object.entries(current.snoozed_dates || {}).forEach(([version, localDate]) => {
    if (!snoozedDates[version] || localDate > snoozedDates[version]) {
      snoozedDates[version] = localDate;
    }
  });

  if (mutation.action === "today") {
    const localDate = mutation.localDate || "";
    if (!snoozedDates[mutation.version] || localDate > snoozedDates[mutation.version]) {
      snoozedDates[mutation.version] = localDate;
    }
  } else if (mutation.action === "forever") {
    permanentVersions.add(mutation.version);
  }
  permanentVersions.forEach((version) => delete snoozedDates[version]);

  return {
    seen_versions: [...seenVersions],
    permanent_versions: [...permanentVersions],
    snoozed_dates: snoozedDates,
  };
}
