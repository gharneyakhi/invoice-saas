import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PAYMENT_HTTP_TIMEOUT_MS, postJson } from "./http";
import { PaymentProviderUnavailableError } from "./paymentErrors";

/**
 * Unit tests for the gateway HTTP client. The global fetch is replaced with a
 * stub; behaviour pinned here: JSON POST round-trip, timeout → unavailable,
 * network failure → unavailable (with NO underlying detail), non-JSON →
 * unavailable.
 */
describe("payments/http — postJson", () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("POSTs the payload as JSON and returns status + parsed body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await postJson<{ ok: number }>("https://gw.example/api", { a: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: 1 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example/api");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("reports the HTTP status for a non-2xx JSON response (adapter decides)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: true }, 503)));

    const response = await postJson("https://gw.example/api", {});
    expect(response.status).toBe(503);
  });

  it("maps a network failure to PaymentProviderUnavailableError without leaking the cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED 10.0.0.1:443 with secret headers");
      }),
    );

    await expect(postJson("https://gw.example/api", {})).rejects.toThrow(
      PaymentProviderUnavailableError,
    );
  });

  it("maps a timeout (aborted request) to PaymentProviderUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted")),
            );
          }),
      ),
    );

    await expect(
      postJson("https://gw.example/api", {}, { timeoutMs: 20 }),
    ).rejects.toThrow(PaymentProviderUnavailableError);
  });

  it("maps a non-JSON response to PaymentProviderUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway exploded</html>", { status: 200 })),
    );

    await expect(postJson("https://gw.example/api", {})).rejects.toThrow(
      PaymentProviderUnavailableError,
    );
  });

  it("aborts the request after the configured timeout", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            observedSignal = init.signal;
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const pending = postJson("https://gw.example/api", {}, { timeoutMs: 5_000 });
    // Fake time must fire the abort at the configured deadline.
    vi.advanceTimersByTime(5_000);
    await expect(pending).rejects.toThrow(PaymentProviderUnavailableError);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("defaults to a 15s timeout", () => {
    expect(DEFAULT_PAYMENT_HTTP_TIMEOUT_MS).toBe(15_000);
  });
});
