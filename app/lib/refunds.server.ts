import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessons,
  modules,
  PayoutAttemptResult,
  payoutAttempts,
  purchases,
  refundRequests,
  RefundRequestStatus,
  refunds,
  RefundStatus,
  users,
  videoWatchEvents,
} from "~/db/schema";
import {
  getPaymentSystem,
  type PaymentSystem,
  type Payout,
  type PayoutOutcome,
  type PayoutResult,
} from "~/lib/payment-system.server";
import { formatPrice } from "~/lib/utils";

export type Decision = "approve" | "decline";

/**
 * Why an Admin's Decision or retry can't go ahead. The route turns it into a
 * thrown response with this status.
 */
export class RefundActionError extends Error {
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

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Records a new Payout Attempt for a Refund, inside the caller's transaction.
 * Hand the returned Payout to sendPayout once that transaction has committed.
 */
function recordPayoutAttempt(
  tx: Transaction,
  refund: { id: number; amount: number }
): Payout {
  const attempt = tx
    .insert(payoutAttempts)
    .values({ refundId: refund.id })
    .returning({ id: payoutAttempts.id })
    .get();
  return { refundId: refund.id, payoutAttemptId: attempt.id, amount: refund.amount };
}

// The result comes back later through the Payment System's result callback.
function sendPayout(payout: Payout) {
  paymentSystem().sendPayout(payout);
}

const systemsReportingToUs = new WeakSet<PaymentSystem>();

// onResult replaces any earlier callback, so register on whichever Payment
// System is current (tests and the dev server can swap it) before sending.
function paymentSystem() {
  const system = getPaymentSystem();
  if (!systemsReportingToUs.has(system)) {
    system.onResult(handlePayoutResult);
    systemsReportingToUs.add(system);
  }
  return system;
}

function handlePayoutResult(result: PayoutResult) {
  try {
    settleRefund(result);
  } catch (error) {
    console.error(
      `[payments] could not settle payout attempt ${result.payoutAttemptId}`,
      error
    );
  }
}

/**
 * Records what the Payment System reported for one Payout Attempt. A result
 * for an attempt that is already settled, or unknown, is ignored.
 */
function settleRefund(result: PayoutResult) {
  const sent = result.status === "sent";

  const settled = db.transaction((tx) => {
    const attempt = tx
      .select({ id: payoutAttempts.id, refundId: payoutAttempts.refundId })
      .from(payoutAttempts)
      .where(
        and(
          eq(payoutAttempts.id, result.payoutAttemptId),
          isNull(payoutAttempts.settledAt)
        )
      )
      .get();
    if (!attempt) return null;

    tx.update(payoutAttempts)
      .set({
        settledAt: new Date().toISOString(),
        result: sent ? PayoutAttemptResult.Sent : PayoutAttemptResult.Failed,
        failureReason: sent ? null : result.reason,
      })
      .where(eq(payoutAttempts.id, attempt.id))
      .run();

    tx.update(refunds)
      .set({ status: sent ? RefundStatus.Issued : RefundStatus.Failed })
      .where(eq(refunds.id, attempt.refundId))
      .run();

    const refund = tx
      .select({
        amount: refunds.amount,
        learnerId: users.id,
        learnerName: users.name,
        learnerEmail: users.email,
        courseId: courses.id,
        courseTitle: courses.title,
      })
      .from(refunds)
      .innerJoin(refundRequests, eq(refunds.refundRequestId, refundRequests.id))
      .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
      .innerJoin(users, eq(purchases.userId, users.id))
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(eq(refunds.id, attempt.refundId))
      .get();
    if (!refund) {
      throw new Error(`Refund ${attempt.refundId} has no learner or course`);
    }

    // The learner loses access to the course only once the money has gone.
    if (sent) {
      tx.delete(enrollments)
        .where(
          and(
            eq(enrollments.userId, refund.learnerId),
            eq(enrollments.courseId, refund.courseId)
          )
        )
        .run();
    }

    return refund;
  });

  if (!settled) return;

  logEmail(buildPayoutEmail({ ...settled, outcome: result }));
}

/**
 * An Admin hands a Failed Refund to the Payment System again as a new Payout
 * Attempt. Only a Failed Refund can be retried.
 */
export function retryRefund(refundId: number) {
  const payout = db.transaction((tx) => {
    const refund = tx
      .update(refunds)
      .set({ status: RefundStatus.Pending })
      .where(
        and(eq(refunds.id, refundId), eq(refunds.status, RefundStatus.Failed))
      )
      .returning()
      .get();

    if (!refund) {
      const exists = tx
        .select({ id: refunds.id })
        .from(refunds)
        .where(eq(refunds.id, refundId))
        .get();
      throw exists
        ? new RefundActionError("Only a Failed Refund can be retried.", 409)
        : new RefundActionError("Refund not found.", 404);
    }

    return recordPayoutAttempt(tx, refund);
  });

  sendPayout(payout);
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
    throw new RefundActionError("Refund request not found.", 404);
  }
  if (request.learnerId === input.adminId) {
    throw new RefundActionError("You can't decide your own refund request.", 403);
  }
  if (request.status !== RefundRequestStatus.Open) {
    throw new RefundActionError("This refund request has already been decided.", 409);
  }

  const approved = input.decision === "approve";

  const payout = db.transaction((tx) => {
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
      throw new RefundActionError(
        "This refund request has already been decided.",
        409
      );
    }

    if (!approved) return null;

    const refund = tx
      .insert(refunds)
      .values({
        refundRequestId: request.id,
        amount: request.amountPaid,
        status: RefundStatus.Pending,
      })
      .returning()
      .get();
    return recordPayoutAttempt(tx, refund);
  });

  if (payout) sendPayout(payout);

  logEmail(buildDecisionEmail({ ...request, approved, note: input.note }));
}

type Email = { to: string; subject: string; body: string };

// There is no mail transport wired up yet, so emails go to the server log.
function logEmail(email: Email) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

/**
 * The email telling the learner about a Decision.
 */
function buildDecisionEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amountPaid: number;
  approved: boolean;
  note: string | null;
}): Email {
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

/**
 * The email telling the learner what the Payment System reported for their
 * Refund.
 */
function buildPayoutEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
  outcome: PayoutOutcome;
}): Email {
  const sent = input.outcome.status === "sent";
  const body = sent
    ? [
        `Hi ${input.learnerName},`,
        "",
        `Your refund of ${formatPrice(input.amount)} for "${input.courseTitle}" has been sent.`,
        "Your access to the course has now ended.",
      ]
    : [
        `Hi ${input.learnerName},`,
        "",
        `We couldn't send your refund of ${formatPrice(input.amount)} for "${input.courseTitle}".`,
        "Our team is on it and will try again. You keep access to the course in the meantime.",
      ];

  return {
    to: input.learnerEmail,
    subject: sent
      ? `Refund sent — ${input.courseTitle}`
      : `Refund failed — ${input.courseTitle}`,
    body: [...body, "", "— The Cadence team"].join("\n"),
  };
}
