import { describe, it, expect } from "vitest";
import { toSlug } from "../index";

describe("toSlug", () => {
  it("lowercases and hyphenates a title", () => {
    expect(toSlug("  Hello, Deep Modules!  ", [])).toBe("hello-deep-modules");
  });

  it("adds the first free suffix when the slug is taken", () => {
    expect(toSlug("Hello", ["hello", "hello-2"])).toBe("hello-3");
  });
});
