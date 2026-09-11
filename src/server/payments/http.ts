import { PaymentProviderUnavailableError } from "./paymentErrors";

/**
 * Minimal HTTP client for the payment gateway adapters.
 *
 * One narrow POST/JSON helper so every adapter gets identical behaviour:
 *   - a hard timeout via `AbortController` (a hung gateway must never hang a
 *     request handler);
 *   - network failures, timeouts and unparseable responses all become the
 *     SAME safe `PaymentProviderUnavailableError`, with no URL, no status
 *     text, no response body and no underlying cause attached — the error
 *     travels through service layers that must never leak gateway internals;
 *   - a successful transport round-trip returns `{ status, body }` and lets
 *     the ADAPTER decide what the gateway's status codes mean.
 *
 * The bundled `fetch` is the Node 18+/Next.js global; no gateway SDK is used.
 */

export const DEFAULT_PAYMENT_HTTP_TIMEOUT_MS = 15_000;

export interface PaymentHttpPostOptions {
  /** Hard timeout in milliseconds. Defaults to `DEFAULT_PAYMENT_HTTP_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Extra request headers (content-type/accept are always set). */
  headers?: Record<string, string>;
}

export interface PaymentHttpResponse<T> {
  /** HTTP status code as reported by the transport. */
  status: number;
  /** Parsed JSON body. */
  body: T;
}

/**
 * POSTs `payload` as JSON and parses the response as JSON.
 *
 * @throws PaymentProviderUnavailableError on network failure, timeout, or a
 *   response that is not valid JSON.
 */
export async function postJson<T>(
  url: string,
  payload: unknown,
  options: PaymentHttpPostOptions = {},
): Promise<PaymentHttpResponse<T>> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAYMENT_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    // Network error or timeout (abort). The cause is deliberately dropped.
    throw new PaymentProviderUnavailableError();
  } finally {
    clearTimeout(timer);
  }

  let body: T;
  try {
    body = (await response.json()) as T;
  } catch {
    throw new PaymentProviderUnavailableError();
  }

  return { status: response.status, body };
}
