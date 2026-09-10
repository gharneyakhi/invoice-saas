import { asPaymentProvider, type PaymentProvider } from "../PaymentProvider";
import {
  assertPaymentAmount,
  createPaymentAmount,
  paymentAmountEquals,
} from "../money";
import {
  PaymentAmountMismatchError,
  PaymentNotFoundError,
  PaymentValidationError,
} from "../paymentErrors";
import type { PaymentHttpOptions } from "../http";
import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  GetPaymentStatusRequest,
  PaymentProviderCapabilities,
  PaymentStatus,
  PaymentStatusResult,
  RefundPaymentRequest,
  RefundPaymentResult,
  VerifyPaymentRequest,
  VerifyPaymentResult,
} from "../types";

/**
 * Sandbox payment provider — a deterministic, in-memory gateway stand-in for
 * local development and tests.
 *
 * What it is for: exercising the whole checkout path (create → redirect →
 * verify → status → refund) with no network, no credentials and no third
 * party, while still going through the *same* `PaymentProvider` interface and
 * the *same* normalized DTOs as ZarinPal. A flow that works against this
 * adapter is wired correctly; it says nothing about the real gateway.
 *
 * Non-negotiables:
 *
 *   1. **No network, ever.** This module imports no HTTP client. Its
 *      `redirectUrl` points at a reserved `.invalid` TLD (RFC 2606), so even a
 *      mis-wired browser redirect cannot reach a real host — the URL is
 *      visibly a placeholder rather than something a payer could be sent to.
 *   2. **Deterministic.** Authorities and reference ids come from an
 *      incrementing counter, not `Math.random()`/`crypto`, so a test asserting
 *      on them does not flake. `options.idFactory` exists for tests that need
 *      a specific shape.
 *   3. **Same integrity rules as the real thing.** Verifying with an amount
 *      that differs from the one the charge was created with throws
 *      `PaymentAmountMismatchError`, and verifying an unknown authority throws
 *      `PaymentNotFoundError`. A sandbox that accepted anything would hide
 *      exactly the bugs the checkout flow needs caught.
 *   4. **Never used in production.** The factory refuses to construct this
 *      provider when `NODE_ENV` is `production` (see `../factory`): faking
 *      payments in production is the one failure mode this module must make
 *      impossible by construction, not by convention.
 *
 * State lives in the instance, so each construction starts empty. Tests that
 * share an instance call `reset()`.
 */

export const SANDBOX_PROVIDER_ID = "sandbox" as const;

/**
 * Reserved-invalid origin (RFC 2606 `.invalid`): a redirect target that can
 * never resolve, so nothing can accidentally send a payer somewhere real.
 */
export const SANDBOX_GATEWAY_ORIGIN = "https://sandbox.payments.invalid";
export const SANDBOX_PAY_PATH = "/pg/pay/";

/** Sandbox reference ids are prefixed so they are unmistakable in logs. */
export const SANDBOX_AUTHORITY_PREFIX = "SBX-AUTH-";
export const SANDBOX_REFERENCE_PREFIX = "SBX-REF-";

/** Internal record of one sandbox charge. */
interface SandboxCharge {
  authority: string;
  orderId: string;
  amount: ReturnType<typeof assertPaymentAmount>;
  callbackUrl: string;
  status: PaymentStatus;
  referenceId: string | null;
}

export interface SandboxProviderOptions {
  /**
   * Deterministic id source. Called with the prefix and the sequence number
   * (starting at 1), so the default `SBX-AUTH-1` / `SBX-AUTH-2` … shape holds.
   */
  idFactory?: (prefix: string, sequence: number) => string;
  /**
   * Accepted for signature parity with the gateway adapters so a caller can
   * build either provider from one options object. The sandbox performs no
   * I/O, so the transport is intentionally ignored.
   */
  http?: PaymentHttpOptions;
}

const SANDBOX_CAPABILITIES: PaymentProviderCapabilities = {
  refund: true,
  statusQuery: true,
};

function defaultIdFactory(prefix: string, sequence: number): string {
  return `${prefix}${sequence}`;
}

export class SandboxPaymentProvider implements PaymentProvider {
  readonly id = SANDBOX_PROVIDER_ID;
  /** Always true: this provider only ever simulates. */
  readonly sandbox = true;
  readonly capabilities = SANDBOX_CAPABILITIES;

  private readonly charges = new Map<string, SandboxCharge>();
  private readonly idFactory: (prefix: string, sequence: number) => string;
  private sequence = 0;

  constructor(options?: SandboxProviderOptions) {
    this.idFactory = options?.idFactory ?? defaultIdFactory;
  }

  /** Number of charges created so far. Useful in tests. */
  get size(): number {
    return this.charges.size;
  }

  /** Empties the in-memory ledger and rewinds the id sequence. */
  reset(): void {
    this.charges.clear();
    this.sequence = 0;
  }

  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const orderId = requireText(request.orderId, "orderId");
    requireText(request.description, "description");
    const callbackUrl = requireText(request.callbackUrl, "callbackUrl");
    const amount = assertPaymentAmount(request.amount);
    assertAbsoluteUrl(callbackUrl, "callbackUrl");

    const authority = this.nextId(SANDBOX_AUTHORITY_PREFIX);
    this.charges.set(authority, {
      authority,
      orderId,
      amount,
      callbackUrl,
      status: "CREATED",
      referenceId: null,
    });

    return {
      providerId: SANDBOX_PROVIDER_ID,
      providerReference: authority,
      redirectUrl: `${SANDBOX_GATEWAY_ORIGIN}${SANDBOX_PAY_PATH}${encodeURIComponent(authority)}`,
      amount,
      sandbox: true,
    };
  }

  async verifyPayment(request: VerifyPaymentRequest): Promise<VerifyPaymentResult> {
    const providerReference = requireText(request.providerReference, "providerReference");
    const amount = assertPaymentAmount(request.amount);
    const charge = this.requireCharge(providerReference);

    // Integrity check, mirroring the real adapter: a verification for a
    // different amount than the one created must not succeed.
    if (!paymentAmountEquals(charge.amount, amount)) {
      throw new PaymentAmountMismatchError({
        expectedAmount: charge.amount.amount,
        actualAmount: amount.amount,
        providerId: SANDBOX_PROVIDER_ID,
      });
    }

    if (charge.status === "SUCCEEDED" || charge.status === "REFUNDED") {
      // Idempotent re-verification, exactly like the gateway's `101`.
      return {
        providerId: SANDBOX_PROVIDER_ID,
        providerReference,
        status: charge.status === "REFUNDED" ? "REFUNDED" : "SUCCEEDED",
        referenceId: charge.referenceId,
        amount: charge.amount,
        alreadyVerified: true,
        sandbox: true,
      };
    }

    charge.status = "SUCCEEDED";
    charge.referenceId = this.nextId(SANDBOX_REFERENCE_PREFIX);

    return {
      providerId: SANDBOX_PROVIDER_ID,
      providerReference,
      status: "SUCCEEDED",
      referenceId: charge.referenceId,
      amount: charge.amount,
      alreadyVerified: false,
      sandbox: true,
    };
  }

  async getPaymentStatus(request: GetPaymentStatusRequest): Promise<PaymentStatusResult> {
    const providerReference = requireText(request.providerReference, "providerReference");
    const charge = this.requireCharge(providerReference);

    return {
      providerId: SANDBOX_PROVIDER_ID,
      providerReference,
      status: charge.status,
      referenceId: charge.referenceId,
      amount: charge.amount,
      sandbox: true,
    };
  }

  async refundPayment(request: RefundPaymentRequest): Promise<RefundPaymentResult> {
    const providerReference = requireText(request.providerReference, "providerReference");
    const charge = this.requireCharge(providerReference);

    if (charge.status !== "SUCCEEDED") {
      throw new PaymentValidationError(
        `Only a successful payment can be refunded (current status: ${charge.status})`,
        { providerId: SANDBOX_PROVIDER_ID },
      );
    }

    const refundedAmount =
      request.amount === undefined || request.amount === null
        ? charge.amount
        : assertPaymentAmount(request.amount);

    charge.status = "REFUNDED";

    return {
      providerId: SANDBOX_PROVIDER_ID,
      providerReference,
      status: "REFUNDED",
      refundedAmount: createPaymentAmount(refundedAmount.amount, refundedAmount.currency),
      sandbox: true,
    };
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return this.idFactory(prefix, this.sequence);
  }

  private requireCharge(providerReference: string): SandboxCharge {
    const charge = this.charges.get(providerReference);
    if (!charge) {
      throw new PaymentNotFoundError("This payment does not exist in the sandbox ledger", {
        providerId: SANDBOX_PROVIDER_ID,
      });
    }
    return charge;
  }
}

/** Builds the sandbox adapter, pinned to the `PaymentProvider` interface. */
export function createSandboxProvider(options?: SandboxProviderOptions): PaymentProvider {
  return asPaymentProvider(new SandboxPaymentProvider(options));
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new PaymentValidationError(`${field} is required`, {
      providerId: SANDBOX_PROVIDER_ID,
    });
  }
  return text;
}

function assertAbsoluteUrl(value: string, field: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new PaymentValidationError(`${field} must use http or https`, {
        providerId: SANDBOX_PROVIDER_ID,
      });
    }
  } catch (error) {
    if (error instanceof PaymentValidationError) throw error;
    throw new PaymentValidationError(`${field} must be an absolute URL`, {
      providerId: SANDBOX_PROVIDER_ID,
    });
  }
}
