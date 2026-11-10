import { redirect } from "react-router";
import type { Route } from "./+types/api.set-fail-next-payout";
import { setFailNextPayout } from "~/lib/payment-system.server";

export async function action({ request, url }: Route.ActionArgs) {
  const formData = await request.formData();
  setFailNextPayout(formData.get("fail") === "on");

  return redirect(url.searchParams.get("redirectTo") ?? "/");
}
