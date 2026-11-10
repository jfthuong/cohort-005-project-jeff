import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MockPaymentSystem,
  getPaymentSystem,
  isFailingNextPayout,
  setFailNextPayout,
  setPaymentSystem,
  type PayoutResult,
} from "./payment-system.server";

describe("MockPaymentSystem", () => {
  let results: PayoutResult[];

  beforeEach(() => {
    vi.useFakeTimers();
    results = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a payout as sent once the delay has passed", () => {
    const paymentSystem = new MockPaymentSystem({ delayMs: 30_000 });
    paymentSystem.onResult((result) => results.push(result));

    paymentSystem.sendPayout({ refundId: 7, payoutAttemptId: 70, amount: 4900 });

    vi.advanceTimersByTime(29_999);
    expect(results).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(results).toEqual([{ payoutAttemptId: 70, status: "sent" }]);
  });

  it("reports scripted outcomes for payouts in the order they are sent", () => {
    const paymentSystem = new MockPaymentSystem({ delayMs: 1_000 });
    paymentSystem.onResult((result) => results.push(result));
    paymentSystem.scriptOutcome({ status: "failed", reason: "Card expired" });
    paymentSystem.scriptOutcome({ status: "sent" });

    paymentSystem.sendPayout({ refundId: 1, payoutAttemptId: 1, amount: 100 });
    paymentSystem.sendPayout({ refundId: 2, payoutAttemptId: 2, amount: 200 });
    paymentSystem.sendPayout({ refundId: 3, payoutAttemptId: 3, amount: 300 });
    vi.advanceTimersByTime(1_000);

    expect(results).toEqual([
      { payoutAttemptId: 1, status: "failed", reason: "Card expired" },
      { payoutAttemptId: 2, status: "sent" },
      { payoutAttemptId: 3, status: "sent" },
    ]);
  });

  it("fails only the next payout when told to, then resets", () => {
    const paymentSystem = new MockPaymentSystem({ delayMs: 1_000 });
    paymentSystem.onResult((result) => results.push(result));

    paymentSystem.failNextPayout(true);
    expect(paymentSystem.isNextPayoutFailing()).toBe(true);

    paymentSystem.sendPayout({ refundId: 1, payoutAttemptId: 1, amount: 100 });
    expect(paymentSystem.isNextPayoutFailing()).toBe(false);
    paymentSystem.sendPayout({ refundId: 2, payoutAttemptId: 2, amount: 200 });
    vi.advanceTimersByTime(1_000);

    expect(results).toEqual([
      {
        payoutAttemptId: 1,
        status: "failed",
        reason: "Payout declined by the Payment System",
      },
      { payoutAttemptId: 2, status: "sent" },
    ]);
  });

  it("reports each payout's result exactly once", () => {
    const paymentSystem = new MockPaymentSystem({ delayMs: 1_000 });
    paymentSystem.onResult((result) => results.push(result));

    paymentSystem.sendPayout({ refundId: 1, payoutAttemptId: 1, amount: 100 });
    vi.advanceTimersByTime(1_000);
    paymentSystem.sendPayout({ refundId: 2, payoutAttemptId: 2, amount: 200 });
    vi.advanceTimersByTime(60_000);

    expect(results).toEqual([
      { payoutAttemptId: 1, status: "sent" },
      { payoutAttemptId: 2, status: "sent" },
    ]);
  });

  it("settles after about 30 seconds by default", () => {
    const paymentSystem = new MockPaymentSystem();
    paymentSystem.onResult((result) => results.push(result));

    paymentSystem.sendPayout({ refundId: 1, payoutAttemptId: 1, amount: 100 });
    vi.advanceTimersByTime(29_999);
    expect(results).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(results).toEqual([{ payoutAttemptId: 1, status: "sent" }]);
  });
});

describe("getPaymentSystem", () => {
  afterEach(() => {
    setPaymentSystem(null);
  });

  it("returns the Payment System injected with setPaymentSystem", () => {
    const injected = new MockPaymentSystem({ delayMs: 0 });
    setPaymentSystem(injected);

    expect(getPaymentSystem()).toBe(injected);
  });

  it("defaults to a single shared mock Payment System", () => {
    const first = getPaymentSystem();

    expect(first).toBeInstanceOf(MockPaymentSystem);
    expect(getPaymentSystem()).toBe(first);
  });

  it("lets the DevUI toggle fail the shared mock's next payout", () => {
    vi.useFakeTimers();
    const results: PayoutResult[] = [];
    const mock = new MockPaymentSystem({ delayMs: 0 });
    mock.onResult((result) => results.push(result));
    setPaymentSystem(mock);

    setFailNextPayout(true);
    expect(isFailingNextPayout()).toBe(true);
    mock.sendPayout({ refundId: 1, payoutAttemptId: 1, amount: 100 });
    vi.runAllTimers();
    vi.useRealTimers();

    expect(isFailingNextPayout()).toBe(false);
    expect(results[0]).toMatchObject({ payoutAttemptId: 1, status: "failed" });
  });
});
