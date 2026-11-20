import { useState } from "react";
import { useFetcher } from "react-router";
import { Check, Lock, NotebookPen } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { cn, formatRelativeTime } from "~/lib/utils";
import { describeNoteDraft, type NoteDraftState } from "~/modules/lesson-notes";

export type SavedLessonNote = { body: string; updatedAt: string } | null;

/** The Student's private Note, styled to sit with Questions & Discussion. */
export function LessonNote({ note }: { note: SavedLessonNote }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [body, setBody] = useState(note?.body ?? "");
  const isSaving = fetcher.state !== "idle";
  const error = fetcher.state === "idle" ? fetcher.data?.error : undefined;
  const draft = describeNoteDraft(body, note?.body ?? null);

  return (
    <Card className="mb-8">
      <CardContent className="px-6">
        <NoteHeader />

        <fetcher.Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="save-note" />
          <Textarea
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Jot down what clicked, what to revisit, or a question to ask below..."
            aria-label="Your notes"
            aria-invalid={draft.tooLong || undefined}
            className="min-h-28 resize-y"
          />

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              disabled={isSaving || !draft.canSave}
            >
              {isSaving ? "Saving..." : "Save note"}
            </Button>

            <NoteStatus
              error={error}
              state={draft.state}
              updatedAt={note?.updatedAt}
            />

            <span
              className={cn(
                "ml-auto text-xs",
                draft.tooLong ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {draft.length} / {draft.limit}
            </span>
          </div>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

function NoteStatus({
  error,
  state,
  updatedAt,
}: {
  error: string | undefined;
  state: NoteDraftState;
  updatedAt: string | undefined;
}) {
  if (error) {
    return <span className="text-xs text-destructive">{error}</span>;
  }
  if (state === "unsaved") {
    return (
      <span className="text-xs text-muted-foreground">Unsaved changes</span>
    );
  }
  if (state === "saved" && updatedAt) {
    return (
      <span
        suppressHydrationWarning
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Check className="size-3 text-green-600" />
        Saved {formatRelativeTime(updatedAt)}
      </span>
    );
  }
  return null;
}

function NoteHeader() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex items-center gap-2">
        <NotebookPen className="size-5 text-primary" />
        <h2 className="text-xl font-semibold">Your notes</h2>
      </div>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Lock className="size-3" />
        Only you can see these
      </span>
    </div>
  );
}
