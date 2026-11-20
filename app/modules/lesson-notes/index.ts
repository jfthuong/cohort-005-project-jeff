import { summarizeDraft } from "./lib/draft";

export type { NoteDraft, NoteDraftState } from "./lib/draft";

/**
 * What the Lesson note editor shows for what the Student has typed, given the
 * body last saved (`null` when they have never saved a Note on the Lesson).
 */
export function describeNoteDraft(draft: string, savedBody: string | null) {
  return summarizeDraft(draft, savedBody);
}
