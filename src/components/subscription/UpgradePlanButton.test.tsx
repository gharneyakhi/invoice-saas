import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { postSubscriptionCheckout, UpgradePlanButton } from "./UpgradePlanButton";

/**
 * The interactive logic lives in `postSubscriptionCheckout()` — a thin,
 * pure-over-`fetch` seam — so the gateway contract is tested here without a
 * DOM, and the component itself is asserted at render level (same split the
 * invoice editor tests use: mock the I/O boundary, render the markup).
 */

function okResponse(redirectUrl: string) {
  return new Response(JSON.stringify({ success: true, data: { paymentId: "pay-1", redirectUrl } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("postSubscriptionCheckout", () => {
  it("POSTs only the planKey and returns the gateway redirect URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse("https://gateway.example/pay?authority=abc"));

    const redirectUrl = await postSubscriptionCheckout("BASIC", fetchImpl as unknown as typeof fetch);

    expect(redirectUrl).toBe("https://gateway.example/pay?authority=abc");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/subscriptions/payment/create");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ planKey: "BASIC" });
  });

  it("throws the server-authored safe message on a domain error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      errorResponse(409, "SUBSCRIPTION_ALREADY_ACTIVE", "This account already has an active subscription"),
    );

    await expect(postSubscriptionCheckout("PRO", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "This account already has an active subscription",
    );
  });

  it("throws a safe message when the network fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(postSubscriptionCheckout("BASIC", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "اتصال به سرور برقرار نشد",
    );
  });

  it("throws a safe message when the response body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>gateway error</html>", { status: 502 }));

    await expect(postSubscriptionCheckout("BASIC", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "پاسخ نامعتبری از سرور دریافت شد",
    );
  });

  it("throws a safe fallback when success is reported without a redirect URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { paymentId: "pay-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(postSubscriptionCheckout("BASIC", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "در انجام پرداخت مشکلی پیش آمد",
    );
  });
});

describe("UpgradePlanButton (render)", () => {
  it("renders the plan name and the buy label in its initial state", () => {
    const html = renderToStaticMarkup(<UpgradePlanButton planKey="BASIC" planName="پایه" />);

    expect(html).toContain("انتخاب و پرداخت — پلن پایه");
    expect(html).toContain('type="button"');
    expect(html).not.toContain("aria-busy=\"true\"");
    expect(html).not.toContain("role=\"alert\"");
  });

  it("does not embed any price or gateway detail in its initial markup", () => {
    const html = renderToStaticMarkup(<UpgradePlanButton planKey="PRO" planName="حرفه‌ای" />);

    expect(html).toContain("پلن حرفه‌ای");
    expect(html).not.toContain("IRR");
    expect(html).not.toContain("merchant");
    expect(html).not.toContain("authority");
  });
});
