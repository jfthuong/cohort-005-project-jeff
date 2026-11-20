import { MAX_NOTE_LENGTH } from "~/lib/notes";

export type NoteDraftState = "blank" | "unsaved" | "saved";

export type NoteDraft = {
  length: number;
  limit: number;
  tooLong: boolean;
  state: NoteDraftState;
  canSave: boolean;
};

export function summarizeDraft(
  draft: string,
  savedBody: string | null
): NoteDraft {
  const trimmed = draft.trim();
  const tooLong = trimmed.length > MAX_NOTE_LENGTH;
  // The server trims before it stores, so trailing whitespace is not a change.
  const dirty = trimmed !== (savedBody ?? "");
  const state: NoteDraftState = dirty
    ? "unsaved"
    : savedBody === null
      ? "blank"
      : "saved";

  return {
    length: trimmed.length,
    limit: MAX_NOTE_LENGTH,
    tooLong,
    state,
    canSave: dirty && trimmed.length > 0 && !tooLong,
  };
}
