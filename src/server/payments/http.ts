import { PaymentGatewayError, PaymentNetworkError } from "./paymentErrors";

/**
 * HTTP dependency injection for payment adapters.
 *
 * Adapters never call the global `fetch` directly. They receive a
 * `PaymentHttpClient`, which in production wraps `fetch` with a timeout and in
 * tests is a plain stub. That is what makes the provider tests deterministic
 * and, more importantly, honest about scope: **no test in this directory can
 * reach a real payment API**, because there is no code path from an adapter to
 * the network that a test does not have to opt into explicitly.
 *
 * The injected surface is deliberately minimal (`fetch`-shaped, POST + JSON
 * body) so a stub is a few lines and cannot drift from the real behaviour in
 * a way that hides a bug: status codes and body text are the only things the
 * adapters are allowed to branch on.
 */

/** The subset of `Response` adapters may use. */
export interface PaymentHttpResponse {
  status: number;
  text(): Promise<string>;
}

export interface PaymentHttpRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export type PaymentHttpFetch = (
  url: string,
  init: PaymentHttpRequestInit,
) => Promise<PaymentHttpResponse>;

/** Default per-request timeout. Gateways answer or they do not. */
export const PAYMENT_HTTP_TIMEOUT_MS = 15_000;

export interface PaymentHttpOptions {
  /** Injected transport. Defaults to the global `fetch`, wrapped in a timeout. */
  fetch?: PaymentHttpFetch;
  /** Abort budget per request. Defaults to `PAYMENT_HTTP_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface PaymentHttpClient {
  readonly fetch: PaymentHttpFetch;
  readonly timeoutMs: number;
}

/**
 * Production transport: global `fetch` plus an `AbortController` timeout.
 *
 * A hung gateway connection must not hold a serverless function or a checkout
 * request open indefinitely, so every request is aborted at `timeoutMs`. An
 * abort surfaces as a thrown error and is mapped to `PaymentNetworkError` by
 * `postJson`, i.e. "retriable, not a business answer".
 */
export function createTimeoutFetch(timeoutMs: number): PaymentHttpFetch {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      return { status: response.status, text: () => response.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Builds a client from options, defaulting to the timeout-wrapped global fetch. */
export function createPaymentHttpClient(options?: PaymentHttpOptions): PaymentHttpClient {
  const timeoutMs = options?.timeoutMs ?? PAYMENT_HTTP_TIMEOUT_MS;
  return {
    fetch: options?.fetch ?? createTimeoutFetch(timeoutMs),
    timeoutMs,
  };
}

/** Body of a JSON POST, as adapters build it. */
export interface JsonPostBody {
  [key: string]: unknown;
}

/**
 * POSTs a JSON body and returns the parsed JSON response.
 *
 * Failure mapping — this is the single place transport and protocol problems
 * become typed payment errors, so every adapter reports them identically:
 *
 *   - the transport threw (DNS, TLS, reset, timeout/abort)
 *       → `PaymentNetworkError`
 *   - a non-2xx status
 *       → `PaymentGatewayError` with `httpStatus`
 *   - a body that is not valid JSON
 *       → `PaymentGatewayError` (a gateway that answers HTML is broken)
 *
 * The raw body is never interpolated into an error message: it can contain
 * merchant identifiers, and it is not something to echo to a user or a log
 * aggregator that may be visible to support staff outside the app.
 *
 * @throws PaymentNetworkError / PaymentGatewayError
 */
export async function postJson<T>(
  client: PaymentHttpClient,
  url: string,
  body: JsonPostBody,
  context: { providerId: string },
): Promise<T> {
  let response: PaymentHttpResponse;
  try {
    response = await client.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new PaymentNetworkError("Could not reach the payment gateway", {
      providerId: context.providerId,
      cause: error,
    });
  }

  if (response.status < 200 || response.status >= 300) {
    throw new PaymentGatewayError("The payment gateway returned an unexpected response", {
      providerId: context.providerId,
      httpStatus: response.status,
    });
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new PaymentGatewayError("The payment gateway returned an unreadable response", {
      providerId: context.providerId,
      httpStatus: response.status,
      cause: error,
    });
  }
}
