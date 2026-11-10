import path from "node:path";
import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { RouterContextProvider } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "~/db";
import {
  categories,
  courses,
  CourseStatus,
  enrollments,
  lessons,
  modules,
  payoutAttempts,
  purchases,
  refundRequests,
  RefundRequestStatus,
  refunds,
  users,
  UserRole,
  videoWatchEvents,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import {
  MockPaymentSystem,
  setPaymentSystem,
} from "~/lib/payment-system.server";
import { action, loader } from "./admin.refunds";
import { action as requestRefund } from "./courses.$slug.refund";
import { loader as settingsLoader } from "./settings";

vi.mock("~/db", async () => {
  const { default: SQLite } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schema = await import("~/db/schema");
  return { db: drizzle(new SQLite(":memory:"), { schema }) };
});

vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(),
}));

const LEARNER = 1;
const ADMIN = 2;
const INSTRUCTOR = 3;
const OTHER_ADMIN = 4;

const migrationsFolder = path.resolve("drizzle");
const adminUrl = "http://localhost/admin/refunds";

let paymentSystem: MockPaymentSystem;

function signInAs(userId: number) {
  vi.mocked(getCurrentUserId).mockResolvedValue(userId);
}

function routeArgs(request: Request) {
  return {
    request,
    params: {},
    url: new URL(request.url),
    pattern: "/admin/refunds",
    context: new RouterContextProvider(),
  };
}

function loadRefundsScreen() {
  return loader(routeArgs(new Request(adminUrl)));
}

function decide(fields: Record<string, string | number>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, String(value));
  }
  return action(
    routeArgs(new Request(adminUrl, { method: "POST", body: formData }))
  );
}

function loadSettings() {
  const request = new Request("http://localhost/settings");
  return settingsLoader({ ...routeArgs(request), pattern: "/settings" });
}

function raiseRefundRequest({
  userId = LEARNER,
  reason = "I bought the wrong course.",
  requestedAt = new Date().toISOString(),
} = {}) {
  const purchase = db
    .insert(purchases)
    .values({ userId, courseId: 1, amountPaid: 4500, country: "US" })
    .returning()
    .get();
  return db
    .insert(refundRequests)
    .values({ purchaseId: purchase.id, reason, requestedAt })
    .returning()
    .get();
}

function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}`);
  return value;
}

function theRefund() {
  return present(db.select().from(refunds).get(), "a Refund");
}

function lastEmail() {
  return String(vi.mocked(console.log).mock.calls.at(-1)?.[0]);
}

// Call before the first payout is sent: the Refund flow registers its result
// handler on the Payment System then.
function captureResultHandler() {
  const onResult = vi.spyOn(paymentSystem, "onResult");
  return () => present(onResult.mock.calls[0]?.[0], "a registered result handler");
}

beforeEach(() => {
  migrate(db, { migrationsFolder });
  db.insert(users)
    .values([
      {
        id: LEARNER,
        name: "Lena Learner",
        email: "lena@example.com",
        role: UserRole.Student,
      },
      {
        id: ADMIN,
        name: "Alex Admin",
        email: "alex@example.com",
        role: UserRole.Admin,
      },
      {
        id: INSTRUCTOR,
        name: "Ivy Instructor",
        email: "ivy@example.com",
        role: UserRole.Instructor,
      },
      {
        id: OTHER_ADMIN,
        name: "Olga Admin",
        email: "olga@example.com",
        role: UserRole.Admin,
      },
    ])
    .run();
  db.insert(categories).values({ id: 1, name: "Testing", slug: "testing" }).run();
  db.insert(courses)
    .values({
      id: 1,
      title: "Test course",
      slug: "test-course",
      description: "A test course",
      salesCopy: "Learn testing.",
      instructorId: INSTRUCTOR,
      categoryId: 1,
      status: CourseStatus.Published,
      price: 10000,
      pppEnabled: false,
    })
    .run();
  db.insert(enrollments).values({ userId: LEARNER, courseId: 1 }).run();

  paymentSystem = new MockPaymentSystem({ delayMs: 30_000 });
  setPaymentSystem(paymentSystem);
  signInAs(ADMIN);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  setPaymentSystem(null);
  db.delete(payoutAttempts).run();
  db.delete(refunds).run();
  db.delete(refundRequests).run();
  db.delete(videoWatchEvents).run();
  db.delete(lessons).run();
  db.delete(modules).run();
  db.delete(enrollments).run();
  db.delete(purchases).run();
  db.delete(courses).run();
  db.delete(categories).run();
  db.delete(users).run();
});

afterAll(() => db.$client.close());

describe("approving a Refund Request", () => {
  it("creates a Pending Refund for the full amount paid, sends it to the Payment System and keeps the learner's access", async () => {
    const sendPayout = vi.spyOn(paymentSystem, "sendPayout");
    const request = raiseRefundRequest();

    await decide({ intent: "approve", refundRequestId: request.id });

    const refund = theRefund();
    expect(refund).toMatchObject({
      refundRequestId: request.id,
      amount: 4500,
      status: "pending",
    });
    const attempts = db.select().from(payoutAttempts).all();
    expect(attempts).toMatchObject([
      {
        refundId: refund.id,
        settledAt: null,
        result: null,
        failureReason: null,
      },
    ]);
    expect(sendPayout).toHaveBeenCalledExactlyOnceWith({
      refundId: refund.id,
      payoutAttemptId: attempts[0].id,
      amount: 4500,
    });

    const screen = await loadRefundsScreen();
    expect(screen.openRefundRequests).toEqual([]);
    expect(screen.pendingRefunds).toMatchObject([
      { refundId: refund.id, learnerName: "Lena Learner", amount: 4500 },
    ]);
    expect(db.select().from(enrollments).all()).toHaveLength(1);
  });

  it("records who approved and when, emails the learner and keeps an optional note", async () => {
    const request = raiseRefundRequest();
    const before = new Date().toISOString();

    await decide({
      intent: "approve",
      refundRequestId: request.id,
      note: "Sorry it wasn't the right fit.",
    });

    const decided = db.select().from(refundRequests).get();
    expect(decided).toMatchObject({
      status: RefundRequestStatus.Approved,
      resolvedByUserId: ADMIN,
      decisionNote: "Sorry it wasn't the right fit.",
    });
    expect((decided?.resolvedAt ?? "") >= before).toBe(true);

    const email = lastEmail();
    expect(email).toContain("to=lena@example.com");
    expect(email).toContain("Refund request approved — Test course");
    expect(email).toContain("$45.00");
    expect(email).toContain("Sorry it wasn't the right fit.");
  });

  it("writes nothing and sends nothing if the first Payout Attempt can't be recorded", async () => {
    const sendPayout = vi.spyOn(paymentSystem, "sendPayout");
    const request = raiseRefundRequest();
    db.run(sql`
      CREATE TRIGGER reject_payout_attempts BEFORE INSERT ON payout_attempts
      BEGIN SELECT RAISE(ABORT, 'payout_attempts unavailable'); END
    `);

    try {
      await expect(
        decide({ intent: "approve", refundRequestId: request.id })
      ).rejects.toThrow("payout_attempts unavailable");
    } finally {
      db.run(sql`DROP TRIGGER reject_payout_attempts`);
    }

    expect(db.select().from(refunds).all()).toEqual([]);
    expect(db.select().from(refundRequests).get()?.status).toBe(
      RefundRequestStatus.Open
    );
    expect(sendPayout).not.toHaveBeenCalled();
  });
});

describe("declining a Refund Request", () => {
  it.each<Record<string, string>>([{}, { note: "" }, { note: "   " }])(
    "is rejected without a note (%o)",
    async (fields) => {
      const request = raiseRefundRequest();

      const result = await decide({
        intent: "decline",
        refundRequestId: request.id,
        ...fields,
      });

      expect(result).toMatchObject({
        data: { errors: { note: expect.any(String) } },
        init: { status: 400 },
      });
      expect(db.select().from(refundRequests).get()?.status).toBe(
        RefundRequestStatus.Open
      );
    }
  );

  it("creates no Refund, emails the note to the learner and lets them raise a new request", async () => {
    const sendPayout = vi.spyOn(paymentSystem, "sendPayout");
    const request = raiseRefundRequest();

    await decide({
      intent: "decline",
      refundRequestId: request.id,
      note: "You have finished most of the course.",
    });

    expect(db.select().from(refundRequests).get()).toMatchObject({
      status: RefundRequestStatus.Declined,
      resolvedByUserId: ADMIN,
      decisionNote: "You have finished most of the course.",
      amountRefunded: null,
    });
    expect(db.select().from(refunds).all()).toEqual([]);
    expect(sendPayout).not.toHaveBeenCalled();

    const email = lastEmail();
    expect(email).toContain("to=lena@example.com");
    expect(email).toContain("Refund request declined — Test course");
    expect(email).toContain("You have finished most of the course.");

    signInAs(LEARNER);
    const formData = new FormData();
    formData.set("reason", "I still want my money back, please.");
    const raised = await requestRefund({
      ...routeArgs(
        new Request("http://localhost/courses/test-course/refund", {
          method: "POST",
          body: formData,
        })
      ),
      params: { slug: "test-course" },
      pattern: "/courses/:slug/refund",
    });
    expect(raised).toBeInstanceOf(Response);
    expect(
      db
        .select()
        .from(refundRequests)
        .all()
        .map((row) => row.status)
    ).toEqual([RefundRequestStatus.Declined, RefundRequestStatus.Open]);
  });
});

describe("decision rules", () => {
  it.each(["approve", "decline"])(
    "a decided request can't be decided again (%s)",
    async (intent) => {
      const request = raiseRefundRequest();
      await decide({ intent: "approve", refundRequestId: request.id });
      const sendPayout = vi.spyOn(paymentSystem, "sendPayout");

      await expect(
        decide({
          intent,
          refundRequestId: request.id,
          note: "Second thoughts.",
        })
      ).rejects.toMatchObject({ init: { status: 409 } });
      expect(db.select().from(refundRequests).get()?.status).toBe(
        RefundRequestStatus.Approved
      );
      expect(db.select().from(refunds).all()).toHaveLength(1);
      expect(sendPayout).not.toHaveBeenCalled();
    }
  );

  it("an Admin can't decide their own Refund Request", async () => {
    const request = raiseRefundRequest({ userId: ADMIN });

    await expect(
      decide({ intent: "approve", refundRequestId: request.id })
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(db.select().from(refundRequests).get()?.status).toBe(
      RefundRequestStatus.Open
    );

    signInAs(OTHER_ADMIN);
    await decide({ intent: "approve", refundRequestId: request.id });
    expect(db.select().from(refundRequests).get()?.status).toBe(
      RefundRequestStatus.Approved
    );
  });

  it.each([LEARNER, INSTRUCTOR])(
    "anyone but an Admin gets a 403 on the screen and its actions (user %i)",
    async (userId) => {
      const request = raiseRefundRequest();
      signInAs(userId);

      await expect(loadRefundsScreen()).rejects.toMatchObject({
        init: { status: 403 },
      });
      await expect(
        decide({ intent: "approve", refundRequestId: request.id })
      ).rejects.toMatchObject({ init: { status: 403 } });
      expect(db.select().from(refundRequests).get()?.status).toBe(
        RefundRequestStatus.Open
      );
    }
  );
});

describe("the Refunds screen", () => {
  it("lists Open Refund Requests oldest first with the facts an Admin needs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
    try {
      db.insert(modules)
        .values({ id: 1, courseId: 1, title: "Module", position: 1 })
        .run();
      db.insert(lessons)
        .values([
          { id: 1, moduleId: 1, title: "One", position: 1 },
          { id: 2, moduleId: 1, title: "Two", position: 2 },
        ])
        .run();
      db.insert(videoWatchEvents)
        .values([
          { userId: LEARNER, lessonId: 1, eventType: "progress", positionSeconds: 1800 },
          { userId: LEARNER, lessonId: 1, eventType: "progress", positionSeconds: 3600 },
          { userId: LEARNER, lessonId: 2, eventType: "progress", positionSeconds: 1800 },
        ])
        .run();
      const newer = raiseRefundRequest({
        reason: "Newer request",
        requestedAt: "2026-03-09T12:00:00.000Z",
      });
      const older = raiseRefundRequest({
        reason: "Older request",
        requestedAt: "2026-03-08T12:00:00.000Z",
      });
      db.update(purchases)
        .set({ createdAt: "2026-03-05T12:00:00.000Z" })
        .run();

      const screen = await loadRefundsScreen();

      expect(screen.openRefundRequests).toEqual([
        {
          id: older.id,
          learnerId: LEARNER,
          learnerName: "Lena Learner",
          learnerEmail: "lena@example.com",
          courseId: 1,
          courseTitle: "Test course",
          reason: "Older request",
          amountPaid: 4500,
          requestedAt: "2026-03-08T12:00:00.000Z",
          daysSincePurchase: 5,
          hoursWatched: 1.5,
        },
        expect.objectContaining({ id: newer.id, reason: "Newer request" }),
      ]);
      expect(screen.pendingRefunds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("learner settings", () => {
  it("shows each past Decision alongside Open Refund Requests", async () => {
    const declined = raiseRefundRequest({ reason: "First try" });
    await decide({
      intent: "decline",
      refundRequestId: declined.id,
      note: "Please tell us more.",
    });
    const approved = raiseRefundRequest({ reason: "Second try" });
    await decide({ intent: "approve", refundRequestId: approved.id });
    const open = raiseRefundRequest({ reason: "Third try" });

    signInAs(LEARNER);
    const settings = await loadSettings();

    expect(settings.openRefundRequests).toMatchObject([{ id: open.id }]);
    expect(settings.decidedRefundRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: declined.id,
          courseTitle: "Test course",
          status: "Declined",
          note: "Please tell us more.",
        }),
        expect.objectContaining({
          id: approved.id,
          courseTitle: "Test course",
          status: "Approved — refund on its way",
          note: null,
        }),
      ])
    );
    expect(settings.decidedRefundRequests).toHaveLength(2);
  });
});
describe("the payout lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function settlePayouts() {
    vi.advanceTimersByTime(30_000);
  }

  async function learnerSettingsStatus() {
    signInAs(LEARNER);
    const settings = await loadSettings();
    signInAs(ADMIN);
    return settings.decidedRefundRequests[0]?.status;
  }

  it("approve → sent: the Refund is Issued, access is removed and the learner is emailed", async () => {
    const request = raiseRefundRequest();
    await decide({ intent: "approve", refundRequestId: request.id });
    expect(db.select().from(enrollments).all()).toHaveLength(1);

    settlePayouts();

    expect(db.select().from(refunds).get()?.status).toBe("issued");
    expect(db.select().from(payoutAttempts).all()).toMatchObject([
      { settledAt: expect.any(String), result: "sent", failureReason: null },
    ]);
    expect(db.select().from(enrollments).all()).toEqual([]);
    expect(lastEmail()).toContain("to=lena@example.com");
    expect(lastEmail()).toContain("Refund sent — Test course");
    expect(await learnerSettingsStatus()).toBe("Approved — refund issued");
    expect((await loadRefundsScreen()).pendingRefunds).toEqual([]);
  });

  it("approve → failed: the Refund is Failed, the request stays Approved and the learner keeps access", async () => {
    paymentSystem.scriptOutcome({ status: "failed", reason: "Card expired" });
    const request = raiseRefundRequest();
    await decide({ intent: "approve", refundRequestId: request.id });

    settlePayouts();

    const refund = theRefund();
    expect(refund.status).toBe("failed");
    expect(db.select().from(refundRequests).get()?.status).toBe(
      RefundRequestStatus.Approved
    );
    expect(db.select().from(payoutAttempts).all()).toMatchObject([
      { settledAt: expect.any(String), result: "failed", failureReason: "Card expired" },
    ]);
    expect(db.select().from(enrollments).all()).toHaveLength(1);
    expect(lastEmail()).toContain("to=lena@example.com");
    expect(lastEmail()).toContain("Refund failed — Test course");
    expect(await learnerSettingsStatus()).toBe("Refund failed — we're on it");

    const screen = await loadRefundsScreen();
    expect(screen.pendingRefunds).toEqual([]);
    expect(screen.failedRefunds).toMatchObject([
      {
        refundId: refund.id,
        learnerName: "Lena Learner",
        courseTitle: "Test course",
        amount: 4500,
        failureReason: "Card expired",
      },
    ]);
  });

  async function approveAndFail(reason = "Card expired") {
    paymentSystem.scriptOutcome({ status: "failed", reason });
    const request = raiseRefundRequest();
    await decide({ intent: "approve", refundRequestId: request.id });
    settlePayouts();
    return theRefund();
  }

  it("failed → retry → sent: a new Payout Attempt makes the Refund Pending, then Issued", async () => {
    const refund = await approveAndFail();
    const sendPayout = vi.spyOn(paymentSystem, "sendPayout");

    const result = await decide({ intent: "retry", refundId: refund.id });

    expect(result).toMatchObject({ success: true });
    const attempts = db.select().from(payoutAttempts).all();
    expect(sendPayout).toHaveBeenCalledExactlyOnceWith({
      refundId: refund.id,
      payoutAttemptId: attempts[1].id,
      amount: 4500,
    });
    expect(db.select().from(refunds).get()?.status).toBe("pending");
    expect(attempts).toMatchObject([
      { result: "failed", failureReason: "Card expired" },
      { settledAt: null, result: null },
    ]);
    const screen = await loadRefundsScreen();
    expect(screen.failedRefunds).toEqual([]);
    expect(screen.pendingRefunds).toMatchObject([{ refundId: refund.id }]);

    settlePayouts();

    expect(db.select().from(refunds).get()?.status).toBe("issued");
    expect(db.select().from(payoutAttempts).all()).toMatchObject([
      { result: "failed", failureReason: "Card expired" },
      { settledAt: expect.any(String), result: "sent", failureReason: null },
    ]);
    expect(db.select().from(enrollments).all()).toEqual([]);
    expect(lastEmail()).toContain("Refund sent — Test course");
    expect(await learnerSettingsStatus()).toBe("Approved — refund issued");
  });

  it("failed → retry → failed: the Refund is Failed again and the Admin sees every Payout Attempt", async () => {
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
    const refund = await approveAndFail("Card expired");
    paymentSystem.scriptOutcome({ status: "failed", reason: "Account closed" });

    await decide({ intent: "retry", refundId: refund.id });
    settlePayouts();

    expect(db.select().from(refunds).get()?.status).toBe("failed");
    expect(db.select().from(enrollments).all()).toHaveLength(1);
    expect(lastEmail()).toContain("Refund failed — Test course");
    expect(await learnerSettingsStatus()).toBe("Refund failed — we're on it");
    const screen = await loadRefundsScreen();
    expect(screen.failedRefunds).toMatchObject([
      {
        refundId: refund.id,
        failureReason: "Account closed",
        payoutAttempts: [
          {
            sentAt: "2026-03-10T12:00:00.000Z",
            settledAt: "2026-03-10T12:00:30.000Z",
            result: "failed",
            failureReason: "Card expired",
          },
          {
            sentAt: "2026-03-10T12:00:30.000Z",
            settledAt: "2026-03-10T12:01:00.000Z",
            result: "failed",
            failureReason: "Account closed",
          },
        ],
      },
    ]);
  });

  it("only a Failed Refund can be retried", async () => {
    const request = raiseRefundRequest();
    await decide({ intent: "approve", refundRequestId: request.id });
    const refund = theRefund();
    const sendPayout = vi.spyOn(paymentSystem, "sendPayout");

    await expect(
      decide({ intent: "retry", refundId: refund.id })
    ).rejects.toMatchObject({ init: { status: 409 } });
    settlePayouts();
    await expect(
      decide({ intent: "retry", refundId: refund.id })
    ).rejects.toMatchObject({ init: { status: 409 } });
    await expect(
      decide({ intent: "retry", refundId: 999 })
    ).rejects.toMatchObject({ init: { status: 404 } });

    expect(sendPayout).not.toHaveBeenCalled();
    expect(db.select().from(payoutAttempts).all()).toHaveLength(1);
  });

  it.each([LEARNER, INSTRUCTOR])(
    "anyone but an Admin gets a 403 when retrying (user %i)",
    async (userId) => {
      const refund = await approveAndFail();
      signInAs(userId);

      await expect(
        decide({ intent: "retry", refundId: refund.id })
      ).rejects.toMatchObject({ init: { status: 403 } });
      expect(db.select().from(refunds).get()?.status).toBe("failed");
    }
  );

  it("a Failed Refund can't be declined", async () => {
    const refund = await approveAndFail();

    await expect(
      decide({
        intent: "decline",
        refundRequestId: refund.refundRequestId,
        note: "Changed our mind.",
      })
    ).rejects.toMatchObject({ init: { status: 409 } });

    expect(db.select().from(refundRequests).get()?.status).toBe(
      RefundRequestStatus.Approved
    );
    expect(db.select().from(refunds).get()?.status).toBe("failed");
  });

  it("a result for a Payout Attempt that is already settled has no effect", async () => {
    const resultHandler = captureResultHandler();
    const request = raiseRefundRequest();
    await decide({ intent: "approve", refundRequestId: request.id });
    settlePayouts();
    const settled = db.select().from(payoutAttempts).all();
    const emailsSent = vi.mocked(console.log).mock.calls.length;

    resultHandler()({
      payoutAttemptId: settled[0].id,
      status: "failed",
      reason: "Late duplicate",
    });

    expect(db.select().from(refunds).get()?.status).toBe("issued");
    expect(db.select().from(payoutAttempts).all()).toEqual(settled);
    expect(vi.mocked(console.log).mock.calls).toHaveLength(emailsSent);
  });

  it("a late result for an earlier Payout Attempt doesn't settle the retry", async () => {
    const resultHandler = captureResultHandler();
    const refund = await approveAndFail();
    await decide({ intent: "retry", refundId: refund.id });
    const before = db.select().from(payoutAttempts).all();
    const emailsSent = vi.mocked(console.log).mock.calls.length;

    resultHandler()({ payoutAttemptId: before[0].id, status: "sent" });

    expect(theRefund().status).toBe("pending");
    expect(db.select().from(payoutAttempts).all()).toEqual(before);
    expect(before[1]).toMatchObject({ settledAt: null, result: null });
    expect(db.select().from(enrollments).all()).toHaveLength(1);
    expect(vi.mocked(console.log).mock.calls).toHaveLength(emailsSent);

    settlePayouts();
    expect(theRefund().status).toBe("issued");
  });
});

describe("the Refunds screen filters", () => {
  it("list each Pending and Failed Refund once, with its Payout Attempts, and leave out Issued ones", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const issuedRequest = raiseRefundRequest({ reason: "Issued" });
      await decide({ intent: "approve", refundRequestId: issuedRequest.id });
      vi.advanceTimersByTime(30_000);

      paymentSystem.scriptOutcome({ status: "failed", reason: "Card expired" });
      const failedRequest = raiseRefundRequest({ reason: "Failed" });
      await decide({ intent: "approve", refundRequestId: failedRequest.id });
      vi.advanceTimersByTime(30_000);

      paymentSystem.scriptOutcome({ status: "failed", reason: "Account closed" });
      const retriedRequest = raiseRefundRequest({ reason: "Retried" });
      await decide({ intent: "approve", refundRequestId: retriedRequest.id });
      vi.advanceTimersByTime(30_000);
      const retried = present(
        db
          .select()
          .from(refunds)
          .where(eq(refunds.refundRequestId, retriedRequest.id))
          .get(),
        "the retried Refund"
      );
      await decide({ intent: "retry", refundId: retried.id });

      const pendingRequest = raiseRefundRequest({ reason: "Pending" });
      await decide({ intent: "approve", refundRequestId: pendingRequest.id });

      const screen = await loadRefundsScreen();

      expect(screen.pendingRefunds).toMatchObject([
        {
          refundRequestId: retriedRequest.id,
          payoutAttempts: [
            { result: "failed", failureReason: "Account closed" },
            { settledAt: null, result: null },
          ],
        },
        {
          refundRequestId: pendingRequest.id,
          payoutAttempts: [{ settledAt: null, result: null }],
        },
      ]);
      expect(screen.pendingRefunds).toHaveLength(2);
      expect(screen.failedRefunds).toMatchObject([
        {
          refundRequestId: failedRequest.id,
          failureReason: "Card expired",
          payoutAttempts: [{ result: "failed", failureReason: "Card expired" }],
        },
      ]);
      expect(screen.failedRefunds).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
