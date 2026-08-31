export type AnnouncementLoadToken = Readonly<{
  sessionKey: string;
  generation: number;
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
