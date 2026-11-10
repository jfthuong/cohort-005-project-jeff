import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.set-fail-next-payout";
import { setFailNextPayout } from "~/lib/payment-system.server";
import { parseFormData } from "~/lib/validation";

const toggleSchema = z.object({
  fail: z.literal("on").optional(),
});

// A path on this site only: "//host" and "/\host" would leave it.
const redirectToSchema = z
  .string()
  .regex(/^\/(?![/\\])/)
  .catch("/");

export async function action({ request, url }: Route.ActionArgs) {
  if (!import.meta.env.DEV) {
    throw data("Not found", { status: 404 });
  }

  const parsed = parseFormData(await request.formData(), toggleSchema);
  if (!parsed.success) {
    throw data("Invalid toggle value", { status: 400 });
  }

  setFailNextPayout(parsed.data.fail === "on");

  return redirect(
    redirectToSchema.parse(url.searchParams.get("redirectTo") ?? "/")
  );
}