import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isFailingNextPayout,
  MockPaymentSystem,
  setPaymentSystem,
} from "~/lib/payment-system.server";
import { action } from "./api.set-fail-next-payout";

function toggle(fields: Record<string, string>, redirectTo?: string) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  const url = new URL("http://localhost/api/set-fail-next-payout");
  if (redirectTo !== undefined) url.searchParams.set("redirectTo", redirectTo);
  const request = new Request(url, { method: "POST", body: formData });
  return action({
    request,
    params: {},
    url,
    pattern: "/api/set-fail-next-payout",
    context: new RouterContextProvider(),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  setPaymentSystem(null);
});

describe("the DevUI fail-next-payout toggle", () => {
  it("turns the mock's next payout failure on and off, then goes back to the page", async () => {
    setPaymentSystem(new MockPaymentSystem({ delayMs: 0 }));

    const on = await toggle({ fail: "on" }, "/admin/refunds?tab=failed");
    expect(isFailingNextPayout()).toBe(true);
    expect(on.headers.get("Location")).toBe("/admin/refunds?tab=failed");

    await toggle({});
    expect(isFailingNextPayout()).toBe(false);
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"])(
    "only redirects to a path on this site (%s)",
    async (redirectTo) => {
      const response = await toggle({ fail: "on" }, redirectTo);

      expect(response.headers.get("Location")).toBe("/");
    }
  );

  it("doesn't exist outside development", async () => {
    vi.stubEnv("DEV", false);
    setPaymentSystem(new MockPaymentSystem({ delayMs: 0 }));

    await expect(toggle({ fail: "on" })).rejects.toMatchObject({
      init: { status: 404 },
    });
    expect(isFailingNextPayout()).toBe(false);
  });
});
