import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  lessons,
  modules,
  payoutAttempts,
  purchases,
  refundRequests,
  RefundRequestStatus,
  refunds,
  RefundStatus,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { getPaymentSystem } from "~/lib/payment-system.server";
import { formatPrice } from "~/lib/utils";

export type Decision = "approve" | "decline";

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409
  ) {
    super(message);
  }
}

/**
 * How far the learner got into a course's videos: the furthest position
 * reached in each lesson, added up.
 */
export function getWatchedSeconds(userId: number, courseId: number): number {
  const lessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

/**
 * Hands a Refund to the Payment System as a new Payout Attempt. Its result
 * comes back later through the Payment System's result callback.
 */
export function sendRefund(refund: { id: number; amount: number }) {
  db.insert(payoutAttempts).values({ refundId: refund.id }).run();
  getPaymentSystem().sendPayout({ refundId: refund.id, amount: refund.amount });
}

function getRefundRequestForDecision(refundRequestId: number) {
  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      amountPaid: purchases.amountPaid,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.id, refundRequestId))
    .get();
}

/**
 * An Admin's Decision on an Open Refund Request. Approving creates the Refund
 * for the full amount paid and sends it to the Payment System; declining
 * creates nothing. Either way the learner is emailed.
 */
export function decideRefundRequest(input: {
  refundRequestId: number;
  adminId: number;
  decision: Decision;
  note: string | null;
}) {
  const request = getRefundRequestForDecision(input.refundRequestId);

  if (!request) {
    throw new DecisionError("Refund request not found.", 404);
  }
  if (request.learnerId === input.adminId) {
    throw new DecisionError("You can't decide your own refund request.", 403);
  }
  if (request.status !== RefundRequestStatus.Open) {
    throw new DecisionError("This refund request has already been decided.", 409);
  }

  const approved = input.decision === "approve";

  const refund = db.transaction((tx) => {
    const decided = tx
      .update(refundRequests)
      .set({
        status: approved
          ? RefundRequestStatus.Approved
          : RefundRequestStatus.Declined,
        amountRefunded: approved ? request.amountPaid : null,
        decisionNote: input.note,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: input.adminId,
      })
      .where(
        and(
          eq(refundRequests.id, request.id),
          eq(refundRequests.status, RefundRequestStatus.Open)
        )
      )
      .run();

    if (decided.changes === 0) {
      throw new DecisionError(
        "This refund request has already been decided.",
        409
      );
    }

    if (!approved) return null;

    return tx
      .insert(refunds)
      .values({
        refundRequestId: request.id,
        amount: request.amountPaid,
        status: RefundStatus.Pending,
      })
      .returning()
      .get();
  });

  if (refund) sendRefund(refund);

  const email = buildDecisionEmail({ ...request, approved, note: input.note });
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

/**
 * The email telling the learner about a Decision. There is no mail transport
 * wired up yet, so the built message goes to the server log.
 */
function buildDecisionEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amountPaid: number;
  approved: boolean;
  note: string | null;
}) {
  const noteLines = input.note ? ["", "A note from our team:", input.note] : [];
  const body = input.approved
    ? [
        `Hi ${input.learnerName},`,
        "",
        `Your refund request for "${input.courseTitle}" has been approved.`,
        `We are sending your refund of ${formatPrice(input.amountPaid)}. We will email you again once it has been sent.`,
        "You keep access to the course until then.",
        ...noteLines,
      ]
    : [
        `Hi ${input.learnerName},`,
        "",
        `Your refund request for "${input.courseTitle}" has been declined.`,
        ...noteLines,
        "",
        "If something has changed, you can raise a new refund request from the course page.",
      ];

  return {
    to: input.learnerEmail,
    subject: input.approved
      ? `Refund request approved — ${input.courseTitle}`
      : `Refund request declined — ${input.courseTitle}`,
    body: [...body, "", "— The Cadence team"].join("\n"),
  };
}
