import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  GetPaymentStatusRequest,
  PaymentProviderCapabilities,
  PaymentProviderId,
  PaymentStatusResult,
  RefundPaymentRequest,
  RefundPaymentResult,
  VerifyPaymentRequest,
  VerifyPaymentResult,
} from "./types";

/**
 * The payment-provider abstraction.
 *
 * `README.md` (section "Payment gateway account") states that this file
 * defines the interface (`createPayment`, `verifyPayment`, `getPaymentStatus`,
 * `refundPayment`) so the provider is swappable without touching business
 * logic. This is that contract.
 *
 * Rules every implementation obeys:
 *
 *   1. **Normalized DTOs only.** Implementations accept and return the shapes
 *      in `./types` and nothing else. Provider-specific fields stay inside the
 *      adapter; a caller that wants a new provider must not have to change.
 *   2. **Failures are typed.** Implementations throw subclasses of
 *      `PaymentError` (`./paymentErrors`) and never a raw `Error`, a stringly
 *      typed message, or a provider SDK error.
 *   3. **Capabilities are declared, not discovered.** An operation with no
 *      real provider API behind it throws `PaymentUnsupportedOperationError`
 *      rather than returning a fabricated success, and advertises `false` in
 *      `capabilities` so callers can degrade to the manual flow up front.
 *   4. **Verification is idempotent.** Re-verifying an already-verified charge
 *      resolves with `status: "SUCCEEDED"` and `alreadyVerified: true` instead
 *      of throwing, because gateways retry callbacks and workers retry jobs.
 *      Callers must not double-credit on `alreadyVerified`.
 *   5. **No side effects on invoices.** This layer talks to gateways only.
 *      Marking an invoice paid remains the job of the payment domain service
 *      (`src/server/payment/paymentService.ts`), which owns the row locks,
 *      overpayment guard and denormalized `paidAmount` recalculation.
 *
 * Note on naming: `src/server/payment/` (singular) is the existing
 * `InvoicePayment` CRUD domain layer backed by Prisma; `src/server/payments/`
 * (plural) is this gateway abstraction. They are deliberately separate layers
 * and neither imports the other.
 */
export interface PaymentProvider {
  /** Stable identifier, matching `PAYMENT_PROVIDER_IDS`. */
  readonly id: PaymentProviderId;

  /** True when this instance talks to the provider's sandbox/test endpoint. */
  readonly sandbox: boolean;

  /** What this provider can really do. Checked before calling. */
  readonly capabilities: PaymentProviderCapabilities;

  /**
   * Creates a charge at the gateway and returns where to send the payer.
   *
   * The returned `redirectUrl` is for the browser only — the server never
   * fetches it.
   *
   * @throws PaymentValidationError / PaymentNetworkError / PaymentGatewayError
   */
  createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult>;

  /**
   * Confirms with the gateway that a charge was really paid, and returns the
   * gateway's settlement reference.
   *
   * This is the ONLY call whose `SUCCEEDED` result may be used to mark an
   * invoice paid: a callback's query string is attacker-controlled, so the
   * authority alone proves nothing.
   *
   * @throws PaymentValidationError / PaymentNotFoundError /
   *         PaymentNetworkError / PaymentGatewayError /
   *         PaymentAmountMismatchError
   */
  verifyPayment(request: VerifyPaymentRequest): Promise<VerifyPaymentResult>;

  /**
   * Read-only status lookup, where the provider has such an API.
   *
   * @throws PaymentUnsupportedOperationError when
   *         `capabilities.statusQuery` is `false`
   */
  getPaymentStatus(request: GetPaymentStatusRequest): Promise<PaymentStatusResult>;

  /**
   * Refunds a previously successful charge, in full or in part.
   *
   * @throws PaymentUnsupportedOperationError when `capabilities.refund` is
   *         `false`
   */
  refundPayment(request: RefundPaymentRequest): Promise<RefundPaymentResult>;
}

/**
 * Compile-time check that a value satisfies the interface.
 *
 * Adapters assign themselves to a `PaymentProvider`-typed constant via this
 * helper, so a missing method is a build error rather than a runtime
 * `TypeError` in the checkout flow.
 */
export function asPaymentProvider(provider: PaymentProvider): PaymentProvider {
  return provider;
}
