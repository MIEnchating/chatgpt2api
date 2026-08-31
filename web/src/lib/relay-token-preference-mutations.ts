import type { RelayTokenKind } from "@/lib/relay-token-selection";

type RelayTokenPreferenceMutation = {
  kind: RelayTokenKind;
  kindVersion: number;
  sessionKey: string;
  sessionVersion: number;
};

const INITIAL_KIND_VERSIONS: Record<RelayTokenKind, number> = {
  text: 0,
  image: 0,
  video: 0,
  audio: 0,
};

export class RelayTokenPreferenceMutationTracker {
  private sessionKey = "";
  private sessionVersion = 0;
  private kindVersions = { ...INITIAL_KIND_VERSIONS };

  activateSession(sessionKey: string) {
    if (sessionKey === this.sessionKey) return;
    this.sessionKey = sessionKey;
    this.sessionVersion += 1;
    this.kindVersions = { ...INITIAL_KIND_VERSIONS };
  }

  begin(kind: RelayTokenKind): RelayTokenPreferenceMutation {
    const kindVersion = this.kindVersions[kind] + 1;
    this.kindVersions[kind] = kindVersion;
    return {
      kind,
      kindVersion,
      sessionKey: this.sessionKey,
      sessionVersion: this.sessionVersion,
    };
  }

  isCurrent(mutation: RelayTokenPreferenceMutation) {
    return mutation.sessionKey === this.sessionKey
      && mutation.sessionVersion === this.sessionVersion
      && mutation.kindVersion === this.kindVersions[mutation.kind];
  }
}
