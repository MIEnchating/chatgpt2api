import type { RefObject } from "react";
import { mergeImageConversationSnapshot, nextImageConversationRevision } from "@/lib/image-task-state";
import {
  compareImageConversations,
  discardFailedImageConversationSave,
  saveImageConversation,
  saveImageConversationCoalesced,
  type ImageConversation,
} from "@/store/image-conversations";

type ConversationWriteOptions = { persist?: boolean | "coalesced" | "durable" };

type ConversationWrites = {
  conversations: RefObject<ImageConversation[]>;
  active: RefObject<boolean>;
  pending: RefObject<number>;
  destructiveEpoch: RefObject<number>;
  deletedIDs: RefObject<Set<string>>;
  chains: Map<string, Promise<void>>;
  reservations: Map<string, number>;
  onCommit: (items: ImageConversation[]) => void;
  onFinish: () => void;
  onSaveError: () => void;
};

export async function writeStudioConversation(
  state: ConversationWrites,
  id: string,
  update: (current: ImageConversation | null) => ImageConversation,
  { persist = true }: ConversationWriteOptions = {},
) {
  const epoch = state.destructiveEpoch.current;
  const previous = state.chains.get(id);
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  state.chains.set(id, promise);
  try {
    if (previous) await previous;
    if (!state.active.current || epoch !== state.destructiveEpoch.current || state.deletedIDs.current.has(id)) return null;
    const current = state.conversations.current.find((item) => item.id === id) ?? null;
    const candidate = update(current);
    if (candidate === current) return current;

    const revision = persist === false
      ? Math.max(Number(current?.revision || 0), Number(candidate.revision || 0)) || 0
      : nextImageConversationRevision(current?.revision, candidate.revision, state.reservations.get(id));
    if (persist !== false) state.reservations.set(id, revision);
    const next = { ...candidate, revision, updatedAt: new Date().toISOString() };
    const commit = (conversation: ImageConversation) => state.onCommit([
      conversation,
      ...state.conversations.current.filter((item) => item.id !== id),
    ].sort(compareImageConversations));

    if (persist === false) {
      commit(next);
      return next;
    }

    state.pending.current += 1;
    try {
      if (persist === "durable") {
        const saved = await saveImageConversation(next);
        if (!state.active.current || epoch !== state.destructiveEpoch.current || state.deletedIDs.current.has(id)) return null;
        const latest = state.conversations.current.find((item) => item.id === id);
        const committed = latest ? mergeImageConversationSnapshot(latest, saved) : saved;
        state.reservations.set(id, Math.max(state.reservations.get(id) || 0, Number(committed.revision || 0)));
        commit(committed);
        return committed;
      }
      commit(next);
      if (persist === "coalesced") await saveImageConversationCoalesced(next);
      else await saveImageConversation(next);
      return next;
    } catch (error) {
      if (persist === "durable") discardFailedImageConversationSave(id, error);
      if (persist !== true && state.active.current && epoch === state.destructiveEpoch.current && !state.deletedIDs.current.has(id)) {
        state.onSaveError();
      }
      if (persist === "coalesced") return next;
      throw error;
    } finally {
      state.onFinish();
    }
  } finally {
    release();
    if (state.chains.get(id) === promise) state.chains.delete(id);
  }
}
