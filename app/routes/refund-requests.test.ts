import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
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
  purchases,
  refundRequests,
  RefundRequestStatus,
  users,
  UserRole,
} from "~/db/schema";
import { loader as courseLoader } from "./courses.$slug";
import { action as requestRefund } from "./courses.$slug.refund";
import { loader as settingsLoader } from "./settings";

vi.mock("~/db", async () => {
  const { default: SQLite } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schema = await import("~/db/schema");
  return { db: drizzle(new SQLite(":memory:"), { schema }) };
});

vi.mock("~/lib/session", () => ({
  getCurrentUserId: vi.fn(async () => 1),
}));

vi.mock("~/lib/country.server", () => ({
  resolveCountry: vi.fn(async () => "US"),
}));

const migrationsFolder = path.resolve("drizzle");
const args = {
  params: { slug: "test-course" },
  request: new Request("http://localhost/courses/test-course"),
  url: new URL("http://localhost/courses/test-course"),
  pattern: "/courses/:slug",
  context: new RouterContextProvider(),
};

beforeEach(() => {
  migrate(db, { migrationsFolder });
  db.insert(users)
    .values({
      id: 1,
      name: "Learner",
      email: "learner@example.com",
      role: UserRole.Student,
    })
    .run();
  db.insert(categories)
    .values({ id: 1, name: "Testing", slug: "testing" })
    .run();
  db.insert(courses)
    .values({
      id: 1,
      title: "Test course",
      slug: args.params.slug,
      description: "A test course",
      salesCopy: "Learn testing.",
      instructorId: 1,
      categoryId: 1,
      status: CourseStatus.Published,
      price: 10000,
      pppEnabled: false,
    })
    .run();
  db.insert(enrollments).values({ userId: 1, courseId: 1 }).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.delete(refundRequests).run();
  db.delete(enrollments).run();
  db.delete(purchases).run();
  db.delete(courses).run();
  db.delete(categories).run();
  db.delete(users).run();
});

afterAll(() => db.$client.close());

function buyCourse(country: string | null = "US") {
  return db
    .insert(purchases)
    .values({ userId: 1, courseId: 1, amountPaid: 4500, country })
    .returning()
    .get();
}

function submitRequest() {
  const formData = new FormData();
  formData.set("reason", "I bought the wrong course.");
  return requestRefund({
    ...args,
    url: new URL("http://localhost/courses/test-course/refund"),
    pattern: "/courses/:slug/refund",
    request: new Request("http://localhost/courses/test-course/refund", {
      method: "POST",
      body: formData,
    }),
  });
}

describe("course refund requests", () => {
  it.each(["US", "IN", null])(
    "uses actual payment for the offer, acknowledgement and open request (%s)",
    async (country) => {
      const purchase = buyCourse(country);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const before = await courseLoader(args);
      expect(before.refundRequestOffer?.requestedAmount).toBe(4500);

      const response = await submitRequest();
      if (!(response instanceof Response)) {
        throw new Error("Expected a redirect after a valid refund request");
      }
      expect(response.headers.get("Location")).toBe("/settings");
      const saved = db.select().from(refundRequests).get();
      expect(saved).toMatchObject({
        purchaseId: purchase.id,
        status: RefundRequestStatus.Open,
        amountRefunded: null,
        resolvedAt: null,
      });
      expect(db.select().from(purchases).get()).toEqual(purchase);
      expect(db.select().from(enrollments).all()).toHaveLength(1);

      const acknowledgement = log.mock.calls[0][0] as string;
      expect(acknowledgement).toContain(
        "Refund request received — Test course"
      );
      expect(acknowledgement).toContain("Requested refund amount: $45.00");
      expect(acknowledgement).toContain(
        "does not mean your request has been approved"
      );
      expect(acknowledgement).not.toMatch(
        /Reversal|Chargeback|we will email|back to the card|\$100\.00/i
      );

      expect((await courseLoader(args)).refundRequestOffer).toBeNull();
      expect((await settingsLoader(args)).openRefundRequests).toMatchObject([
        { id: saved!.id, requestedAmount: 4500 },
      ]);
      await expect(submitRequest()).rejects.toMatchObject({
        init: { status: 409 },
      });
      expect(db.select().from(refundRequests).all()).toHaveLength(1);
    }
  );

  it.each([RefundRequestStatus.Approved, RefundRequestStatus.Declined])(
    "does not treat a %s request as open",
    async (status) => {
      const purchase = buyCourse();
      db.insert(refundRequests)
        .values({ purchaseId: purchase.id, status, reason: "Previous request" })
        .run();

      expect((await settingsLoader(args)).openRefundRequests).toEqual([]);
      expect(
        (await courseLoader(args)).refundRequestOffer?.requestedAmount
      ).toBe(4500);
    }
  );

  it("migrates existing requests without losing decisions, returned amounts or references", () => {
    const sqlite = new Database(":memory:");
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const renameMigration = 11;
      for (const migration of migrations.slice(0, renameMigration)) {
        for (const statement of migration.sql) sqlite.exec(statement);
      }
      sqlite.exec(`
        INSERT INTO users (id, name, email, role, created_at)
        VALUES (1, 'Learner', 'learner@example.com', 'student', '2026-01-01');
        INSERT INTO categories (id, name, slug) VALUES (1, 'Testing', 'testing');
        INSERT INTO courses (id, title, slug, description, sales_copy, instructor_id,
          category_id, status, price, created_at, updated_at)
        VALUES (1, 'Test', 'test', 'Test', 'Test', 1, 1, 'published', 10000,
          '2026-01-01', '2026-01-01');
        INSERT INTO purchases (id, user_id, course_id, amount_paid, created_at)
        VALUES (1, 1, 1, 4500, '2026-01-01');
      `);
      const insert = sqlite.prepare(`
        INSERT INTO refunds (id, purchase_id, status, reason, amount_refunded,
          requested_at, resolved_at, resolved_by_user_id)
        VALUES (?, 1, ?, 'Original reason', ?, '2026-01-02', ?, ?)
      `);
      insert.run(1, "requested", null, null, null);
      insert.run(2, "approved", 4500, "2026-01-03", 1);
      insert.run(3, "declined", null, "2026-01-03", 1);
      const original = sqlite
        .prepare("SELECT * FROM refunds ORDER BY id")
        .all();
      sqlite.pragma("foreign_keys = ON");

      for (const statement of migrations[renameMigration].sql) {
        sqlite.exec(statement);
      }

      expect(
        sqlite.prepare("SELECT * FROM refund_requests ORDER BY id").all()
      ).toEqual(
        original.map((row) => ({
          ...(row as Record<string, unknown>),
          status:
            (row as { status: string }).status === "requested"
              ? "open"
              : (row as { status: string }).status,
        }))
      );
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(
        sqlite.prepare("PRAGMA index_list('refund_requests')").all()
      ).toMatchObject([{ name: "refund_requests_purchase_idx" }]);
      sqlite.exec(`
        INSERT INTO refund_requests (purchase_id, reason, requested_at)
        VALUES (1, 'Another request', '2026-01-04');
      `);
      expect(
        sqlite
          .prepare("SELECT id, status FROM refund_requests ORDER BY id DESC")
          .get()
      ).toEqual({ id: 4, status: "open" });
    } finally {
      sqlite.close();
    }
  });
});
