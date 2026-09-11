"use client";

import * as React from "react";
import clsx from "clsx";
import { Button } from "@/components/ui/button";
import { CreditCardIcon, AlertCircleIcon } from "@/components/icons";

/**
 * Starts a SaaS subscription checkout for one plan and redirects the payer
 * to the gateway.
 *
 * The ONLY client input ever sent is `planKey` — exactly the contract of
 * `POST /api/subscriptions/payment/create` (the server resolves the plan row,
 * its price and the provider; a tampered price or amount cannot exist). On
 * success the browser navigates to the gateway URL; the post-payment
 * landing/retry experience is owned by the callback flow, not this button.
 *
 * Error handling shows the server's own `error.message` string, which the
 * route guarantees is server-authored (domain errors) or one fixed generic
 * gateway message — never a gateway envelope or configuration detail.
 */

/** Response shape of `POST /api/subscriptions/payment/create`. */
interface CreateCheckoutResponse {
  success: boolean;
  data?: { paymentId: string; redirectUrl: string };
  error?: { code: string; message: string };
}

/**
 * Calls the checkout endpoint and returns the gateway redirect URL.
 *
 * Exported separately from the component so the network contract is unit
 * testable without a DOM (same split as the server-action tests in this repo).
 *
 * @throws Error when the request fails or the route reports `success: false`
 *   (the message is the route's safe, server-authored string).
 */
export async function postSubscriptionCheckout(
  planKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl("/api/subscriptions/payment/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planKey }),
    });
  } catch {
    throw new Error("اتصال به سرور برقرار نشد. لطفاً اتصال اینترنت خود را بررسی کرده و دوباره تلاش کنید.");
  }

  let payload: CreateCheckoutResponse;
  try {
    payload = (await response.json()) as CreateCheckoutResponse;
  } catch {
    throw new Error("پاسخ نامعتبری از سرور دریافت شد. لطفاً دوباره تلاش کنید.");
  }

  if (!payload.success || !payload.data?.redirectUrl) {
    throw new Error(
      payload.error?.message || "در انجام پرداخت مشکلی پیش آمد. لطفاً دوباره تلاش کنید.",
    );
  }
  return payload.data.redirectUrl;
}

export interface UpgradePlanButtonProps {
  /** The `plans.key` of the plan to purchase (the only value sent). */
  planKey: string;
  /** Short human label of the plan, e.g. "پایه". */
  planName: string;
  className?: string;
}

type UpgradeState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string };

export function UpgradePlanButton({ planKey, planName, className }: UpgradePlanButtonProps) {
  const [state, setState] = React.useState<UpgradeState>({ phase: "idle" });

  async function handleClick() {
    if (state.phase === "loading") return;
    setState({ phase: "loading" });
    try {
      const redirectUrl = await postSubscriptionCheckout(planKey);
      // The gateway page takes over from here; the callback flow owns the
      // post-payment landing. Keep the button busy until navigation starts.
      window.location.assign(redirectUrl);
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "در انجام پرداخت مشکلی پیش آمد.",
      });
    }
  }

  const loading = state.phase === "loading";

  return (
    <div className={clsx("space-y-1.5", className)}>
      <Button
        type="button"
        variant="primary"
        className="w-full gap-2"
        onClick={handleClick}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            <span>در حال آماده‌سازی پرداخت…</span>
          </>
        ) : (
          <>
            <CreditCardIcon size={15} />
            <span>انتخاب و پرداخت — پلن {planName}</span>
          </>
        )}
      </Button>
      {state.phase === "error" && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-700" role="alert">
          <AlertCircleIcon size={13} className="shrink-0 mt-0.5" />
          <span>{state.message}</span>
        </p>
      )}
    </div>
  );
}
