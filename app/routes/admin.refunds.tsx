import { useEffect } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { asc, eq, inArray } from "drizzle-orm";
import {
  AlertTriangle,
  Clock,
  Receipt,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { db } from "~/db";
import {
  courses,
  payoutAttempts,
  purchases,
  refundRequests,
  RefundRequestStatus,
  refunds,
  RefundStatus,
  users,
  UserRole,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import {
  decideRefundRequest,
  RefundActionError,
  getWatchedSeconds,
  retryRefund,
} from "~/lib/refunds.server";
import { daysSince, formatPrice, formatRelativeTime } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

const decisionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("retry"),
    refundId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
    note: z.string().trim().optional(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    note: z
      .string({ required_error: "Tell the learner why you are declining." })
      .trim()
      .min(1, "Tell the learner why you are declining."),
  }),
]);

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Decide refund requests" },
  ];
}

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to manage refunds.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can manage refunds.", { status: 403 });
  }

  return currentUser;
}

function getOpenRefundRequests() {
  return db
    .select({
      id: refundRequests.id,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      reason: refundRequests.reason,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      requestedAt: refundRequests.requestedAt,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.status, RefundRequestStatus.Open))
    .orderBy(asc(refundRequests.requestedAt), asc(refundRequests.id))
    .all()
    .map(({ purchasedAt, ...request }) => ({
      ...request,
      daysSincePurchase: daysSince(purchasedAt),
      hoursWatched:
        Math.round(
          (getWatchedSeconds(request.learnerId, request.courseId) / 3600) * 10
        ) / 10,
    }));
}

// Every Refund in one status, each with the history of its Payout Attempts.
function getRefundsWithPayoutAttempts(status: RefundStatus) {
  const rows = db
    .select({
      refundId: refunds.id,
      refundRequestId: refunds.refundRequestId,
      learnerName: users.name,
      courseTitle: courses.title,
      amount: refunds.amount,
    })
    .from(refunds)
    .innerJoin(refundRequests, eq(refunds.refundRequestId, refundRequests.id))
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, status))
    .orderBy(asc(refunds.id))
    .all();

  const attempts =
    rows.length === 0
      ? []
      : db
          .select({
            id: payoutAttempts.id,
            refundId: payoutAttempts.refundId,
            sentAt: payoutAttempts.sentAt,
            settledAt: payoutAttempts.settledAt,
            result: payoutAttempts.result,
            failureReason: payoutAttempts.failureReason,
          })
          .from(payoutAttempts)
          .where(
            inArray(
              payoutAttempts.refundId,
              rows.map((refund) => refund.refundId)
            )
          )
          .orderBy(asc(payoutAttempts.id))
          .all();

  return rows.map((refund) => {
    const history = attempts
      .filter((attempt) => attempt.refundId === refund.refundId)
      .map(({ refundId: _refundId, ...attempt }) => attempt);
    return { ...refund, payoutAttempts: history, latestAttempt: history.at(-1) };
  });
}

function getPendingRefunds() {
  return getRefundsWithPayoutAttempts(RefundStatus.Pending)
    .map(({ latestAttempt, ...refund }) => ({
      ...refund,
      sentAt: latestAttempt?.sentAt ?? null,
    }))
    .sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""));
}

function getFailedRefunds() {
  return getRefundsWithPayoutAttempts(RefundStatus.Failed)
    .map(({ latestAttempt, ...refund }) => ({
      ...refund,
      failedAt: latestAttempt?.settledAt ?? null,
      failureReason: latestAttempt?.failureReason ?? null,
    }))
    .sort((a, b) => (a.failedAt ?? "").localeCompare(b.failedAt ?? ""));
}

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);

  return {
    adminId: admin.id,
    openRefundRequests: getOpenRefundRequests(),
    pendingRefunds: getPendingRefunds(),
    failedRefunds: getFailedRefunds(),
  };
}

// A rule the Refund action broke becomes a thrown response with its status.
function throwingRefundActionErrors(run: () => void) {
  try {
    run();
  } catch (error) {
    if (error instanceof RefundActionError) {
      throw data(error.message, { status: error.status });
    }
    throw error;
  }
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, decisionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const input = parsed.data;

  if (input.intent === "retry") {
    throwingRefundActionErrors(() => retryRefund(input.refundId));
    return {
      success: true,
      message: "Retrying. The refund is on its way to the Payment System again.",
    };
  }

  throwingRefundActionErrors(() =>
    decideRefundRequest({
      refundRequestId: input.refundRequestId,
      adminId: admin.id,
      decision: input.intent,
      note: input.note || null,
    })
  );

  return {
    success: true,
    message:
      input.intent === "approve"
        ? "Approved. The refund is on its way to the Payment System."
        : "Declined. The learner has been emailed.",
  };
}

type OpenRefundRequest = Route.ComponentProps["loaderData"]["openRefundRequests"][number];

type ActionData =
  | { success: boolean; message: string }
  | { errors: Record<string, string | undefined> };

function useActionToast(state: string, result: ActionData | undefined) {
  useEffect(() => {
    if (state !== "idle" || !result) return;
    if ("success" in result) toast.success(result.message);
    if ("errors" in result) {
      const firstError = Object.values(result.errors)[0];
      if (firstError) toast.error(firstError);
    }
  }, [state, result]);
}

function DecisionForm({
  refundRequest,
  isOwnRequest,
}: {
  refundRequest: OpenRefundRequest;
  isOwnRequest: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const noteId = `note-${refundRequest.id}`;
  const noteErrorId = `${noteId}-error`;
  const noteError =
    fetcher.state === "idle" && fetcher.data && "errors" in fetcher.data
      ? fetcher.data.errors.note
      : undefined;
  const busy = fetcher.state !== "idle";

  useActionToast(fetcher.state, fetcher.data);

  if (isOwnRequest) {
    return (
      <p className="text-sm text-muted-foreground">
        This is your own request — another Admin has to decide it.
      </p>
    );
  }

  return (
    <fetcher.Form method="post" className="space-y-2">
      <input type="hidden" name="refundRequestId" value={refundRequest.id} />
      <Label htmlFor={noteId}>Note to the learner</Label>
      <Textarea
        id={noteId}
        name="note"
        rows={2}
        placeholder="Required when declining, optional when approving."
        aria-invalid={noteError ? true : undefined}
        aria-describedby={noteError ? noteErrorId : undefined}
      />
      {noteError && (
        <p id={noteErrorId} className="text-sm text-destructive">
          {noteError}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" name="intent" value="approve" size="sm" disabled={busy}>
          Approve
        </Button>
        <Button
          type="submit"
          name="intent"
          value="decline"
          size="sm"
          variant="outline"
          disabled={busy}
        >
          Decline
        </Button>
      </div>
    </fetcher.Form>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { adminId, openRefundRequests, pendingRefunds, failedRefunds } =
    loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refunds</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Decide Open Refund Requests, follow Pending Refunds and retry Failed
          Refunds
        </p>
      </div>

      <section className="mb-10">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
          <Receipt className="size-4" />
          Open Refund Requests ({openRefundRequests.length})
        </h2>
        {openRefundRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No refund requests are waiting on a Decision.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {openRefundRequests.map((refundRequest) => (
              <Card key={refundRequest.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{refundRequest.learnerName}</p>
                      <p className="text-sm text-muted-foreground">
                        {refundRequest.learnerEmail}
                      </p>
                    </div>
                    <span
                      className="shrink-0 text-xs text-muted-foreground"
                      suppressHydrationWarning
                    >
                      waiting since {formatRelativeTime(refundRequest.requestedAt)}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Course</dt>
                    <dd>{refundRequest.courseTitle}</dd>
                    <dt className="text-muted-foreground">Amount paid</dt>
                    <dd>{formatPrice(refundRequest.amountPaid)}</dd>
                    <dt className="text-muted-foreground">Since purchase</dt>
                    <dd>
                      {refundRequest.daysSincePurchase}{" "}
                      {refundRequest.daysSincePurchase === 1 ? "day" : "days"}
                    </dd>
                    <dt className="text-muted-foreground">Hours watched</dt>
                    <dd>{refundRequest.hoursWatched}</dd>
                  </dl>
                  <p className="rounded-md bg-muted/50 p-3 text-sm">
                    {refundRequest.reason}
                  </p>
                  <DecisionForm
                    refundRequest={refundRequest}
                    isOwnRequest={refundRequest.learnerId === adminId}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
          <Clock className="size-4" />
          Pending Refunds ({pendingRefunds.length})
        </h2>
        {pendingRefunds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Refunds are waiting on the Payment System.
          </p>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Learner</th>
                    <th className="px-4 py-3 font-medium">Course</th>
                    <th className="px-4 py-3 font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">Sent</th>
                    <th className="px-4 py-3 font-medium">Payout Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingRefunds.map((refund) => (
                    <tr key={refund.refundId} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">{refund.learnerName}</td>
                      <td className="px-4 py-3">{refund.courseTitle}</td>
                      <td className="px-4 py-3">{formatPrice(refund.amount)}</td>
                      <td className="px-4 py-3" suppressHydrationWarning>
                        {refund.sentAt ? formatRelativeTime(refund.sentAt) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <details>
                          <summary className="cursor-pointer text-muted-foreground">
                            {refund.payoutAttempts.length}{" "}
                            {refund.payoutAttempts.length === 1
                              ? "attempt"
                              : "attempts"}
                          </summary>
                          <PayoutAttemptHistory attempts={refund.payoutAttempts} />
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </section>

      <section className="mt-10">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
          <XCircle className="size-4" />
          Failed Refunds ({failedRefunds.length})
        </h2>
        {failedRefunds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Refunds have failed.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {failedRefunds.map((refund) => (
              <Card key={refund.refundId}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{refund.learnerName}</p>
                      <p className="text-sm text-muted-foreground">
                        {refund.courseTitle} · {formatPrice(refund.amount)}
                      </p>
                    </div>
                    {refund.failedAt && (
                      <span
                        className="shrink-0 text-xs text-muted-foreground"
                        suppressHydrationWarning
                      >
                        failed {formatRelativeTime(refund.failedAt)}
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {refund.failureReason ?? "No reason given."}
                  </p>
                  <PayoutAttemptHistory attempts={refund.payoutAttempts} />
                  <RetryForm refundId={refund.refundId} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

type PayoutAttempt =
  Route.ComponentProps["loaderData"]["failedRefunds"][number]["payoutAttempts"][number];

function PayoutAttemptHistory({ attempts }: { attempts: PayoutAttempt[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left uppercase tracking-wider text-muted-foreground">
          <th className="py-1 font-medium">Sent</th>
          <th className="py-1 font-medium">Settled</th>
          <th className="py-1 font-medium">Result</th>
          <th className="py-1 font-medium">Reason</th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((attempt) => (
          <tr key={attempt.id} className="border-t border-border">
            <td className="py-1" suppressHydrationWarning>
              {new Date(attempt.sentAt).toLocaleString()}
            </td>
            <td className="py-1" suppressHydrationWarning>
              {attempt.settledAt
                ? new Date(attempt.settledAt).toLocaleString()
                : "—"}
            </td>
            <td className="py-1">{attempt.result ?? "pending"}</td>
            <td className="py-1">{attempt.failureReason ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RetryForm({ refundId }: { refundId: number }) {
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.state, fetcher.data);

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="refundId" value={refundId} />
      <Button
        type="submit"
        name="intent"
        value="retry"
        size="sm"
        disabled={fetcher.state !== "idle"}
      >
        <RotateCcw className="mr-1 size-4" />
        Retry
      </Button>
    </fetcher.Form>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refunds.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
