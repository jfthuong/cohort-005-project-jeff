import { describe, it, expect } from "vitest";
import { MAX_NOTE_LENGTH } from "~/lib/notes";
import { describeNoteDraft } from "../index";

describe("describeNoteDraft", () => {
  it("is blank, and cannot be saved, before the Student writes anything", () => {
    expect(describeNoteDraft("", null)).toEqual({
      length: 0,
      limit: MAX_NOTE_LENGTH,
      tooLong: false,
      state: "blank",
      canSave: false,
    });
  });

  it("is unsaved, and can be saved, once the Student starts a new note", () => {
    const draft = describeNoteDraft("Generics are", null);
    expect(draft.state).toBe("unsaved");
    expect(draft.canSave).toBe(true);
    expect(draft.length).toBe(12);
  });

  it("is saved when the draft matches the stored body", () => {
    const draft = describeNoteDraft("Generics are neat", "Generics are neat");
    expect(draft.state).toBe("saved");
    expect(draft.canSave).toBe(false);
  });

  it("ignores surrounding whitespace, which the server trims anyway", () => {
    const draft = describeNoteDraft(
      "  Generics are neat\n",
      "Generics are neat"
    );
    expect(draft.state).toBe("saved");
    expect(draft.length).toBe(17);
  });

  it("is unsaved after an edit to a saved note", () => {
    const draft = describeNoteDraft("Generics are great", "Generics are neat");
    expect(draft.state).toBe("unsaved");
    expect(draft.canSave).toBe(true);
  });

  it("cannot save a saved note cleared to nothing", () => {
    const draft = describeNoteDraft("   ", "Generics are neat");
    expect(draft.state).toBe("unsaved");
    expect(draft.canSave).toBe(false);
  });

  it("allows a note exactly at the limit", () => {
    const draft = describeNoteDraft("a".repeat(MAX_NOTE_LENGTH), null);
    expect(draft.tooLong).toBe(false);
    expect(draft.canSave).toBe(true);
  });

  it("refuses a note one character over the limit", () => {
    const draft = describeNoteDraft("a".repeat(MAX_NOTE_LENGTH + 1), null);
    expect(draft.tooLong).toBe(true);
    expect(draft.canSave).toBe(false);
  });
});
