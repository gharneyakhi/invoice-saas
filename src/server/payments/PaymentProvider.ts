import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderName,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from "./types";

/**
 * The payment gateway abstraction (one interface, many adapters).
 *
 * A `PaymentProvider` is a stateless adapter around one gateway. Implementations:
 *   - `providers/zarinpal.ts` — real ZarinPal v4 REST adapter;
 *   - `providers/sandbox.ts`  — deterministic in-process gateway for
 *     development and tests (no network).
 *
 * Rules every implementer and caller must keep:
 *   - Providers are obtained ONLY through `getPaymentProvider()`
 *     (`factory.ts`), which resolves the gateway from server configuration.
 *     No request-scoped code may pass a caller-chosen provider name.
 *   - `createPayment()` NEVER moves money by itself: it opens a gateway
 *     checkout session and returns where to redirect the payer. Money moves
 *     only after the payer completes the gateway flow and the (future)
 *     callback/verify step confirms it — which is why a checkout is persisted
 *     as PENDING first and verified later.
 *   - `verifyPayment()` exists on the interface so the callback step (next
 *     phase) can confirm payments through the same abstraction. Nothing in
 *     this step's subscription flow calls it yet.
 *   - Implementations must throw only the typed errors from
 *     `paymentErrors.ts` and must never include raw gateway responses,
 *     merchant IDs or credentials in any returned value or error.
 */
export interface PaymentProvider {
  /** Stable adapter identifier (stored on `SubscriptionPayment.provider`). */
  readonly name: PaymentProviderName;

  /**
   * Opens a payment at the gateway.
   *
   * @throws PaymentProviderNotConfiguredError when the adapter's configuration
   *   is missing/invalid (checked again here so a provider built earlier from
   *   different env never sends a request half-configured).
   * @throws PaymentProviderError when the gateway refuses the request.
   * @throws PaymentProviderUnavailableError when the gateway is unreachable.
   * @throws InvalidPaymentAmountError / UnsupportedCurrencyError via the
   *   amount validation shared with `money.ts`.
   */
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;

  /**
   * Asks the gateway whether a payment was completed for the given authority
   * and amount. Unused in this step (callback/verify comes later); part of
   * the interface so adapters are complete and testable now.
   */
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
}
