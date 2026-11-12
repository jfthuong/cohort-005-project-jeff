import { describe, expect, it } from "vitest";
import { rewriteLinks } from "./seed-wayfinder-issues";

const opts = {
  repo: "me/my-copy",
  from: "ai-hero-dev/cohort-005-project",
  gistUrl: "https://gist.github.com/x/abc",
  numbers: { "12": { number: 1 }, "13": { number: 2 } },
};

describe("rewriteLinks", () => {
  it("renumbers course issue URLs and #N refs to the new repo", () => {
    expect(
      rewriteLinks(
        "See #12 and https://github.com/ai-hero-dev/cohort-005-project/issues/13.",
        opts
      )
    ).toBe("See #1 and https://github.com/me/my-copy/issues/2.");
  });

  it("points research docs at the gist", () => {
    expect(
      rewriteLinks(
        "https://github.com/ai-hero-dev/cohort-005-project/blob/research/abc/docs/research/sse-vs-ws.md",
        opts
      )
    ).toBe("https://gist.github.com/x/abc#file-sse-vs-ws-md");
  });

  it("leaves unknown numbers, HTML entities, URL fragments and words alone", () => {
    const text = "#99 &#12; /#12 a#12 x #12abc";
    expect(rewriteLinks(text, opts)).toBe(text);
  });
});
