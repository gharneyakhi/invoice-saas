/**
 * Public surface of the payment-provider layer.
 *
 * Import from here rather than reaching into the files: the boundary is
 * "normalized DTOs + typed errors + a provider instance", and keeping one
 * barrel makes it obvious which shapes the rest of the app may depend on.
 *
 * Server-side only (`src/server/`). No module in this directory is imported by
 * client code, and nothing here reads a `NEXT_PUBLIC_` variable.
 */

export {
  PaymentErrorCode,
  PaymentError,
  PaymentNotConfiguredError,
  PaymentProviderUnknownError,
  PaymentValidationError,
  PaymentNetworkError,
  PaymentGatewayError,
  PaymentNotFoundError,
  PaymentUnsupportedOperationError,
  PaymentAmountMismatchError,
  isPaymentError,
} from "./paymentErrors";

export {
  PAYMENT_CURRENCIES,
  PAYMENT_CURRENCY_EXPONENTS,
  MAX_PAYMENT_AMOUNT,
  MAX_PAYMENT_DECIMAL_PLACES,
  RIAL_PER_TOMAN,
  createPaymentAmount,
  assertPaymentAmount,
  isPaymentAmount,
  paymentAmountToDecimal,
  toProviderUnits,
  rialValue,
  comparePaymentAmounts,
  paymentAmountEquals,
  assertGatewayMinimum,
  formatPaymentAmountForLog,
  type PaymentAmount,
  type PaymentCurrency,
  type PaymentRoundingPolicy,
} from "./money";

export {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_STATUSES,
  isPaymentProviderId,
  type PaymentProviderId,
  type PaymentStatus,
  type PaymentProviderCapabilities,
  type PaymentPayerContact,
  type CreatePaymentRequest,
  type CreatePaymentResult,
  type VerifyPaymentRequest,
  type VerifyPaymentResult,
  type GetPaymentStatusRequest,
  type PaymentStatusResult,
  type RefundPaymentRequest,
  type RefundPaymentResult,
} from "./types";

export { asPaymentProvider, type PaymentProvider } from "./PaymentProvider";

export {
  PAYMENT_HTTP_TIMEOUT_MS,
  createPaymentHttpClient,
  createTimeoutFetch,
  postJson,
  type PaymentHttpFetch,
  type PaymentHttpClient,
  type PaymentHttpOptions,
  type PaymentHttpRequestInit,
  type PaymentHttpResponse,
} from "./http";

export {
  createZarinPalProvider,
  ZarinPalPaymentProvider,
  ZARINPAL_PROVIDER_ID,
  ZARINPAL_LIVE_API_ORIGIN,
  ZARINPAL_SANDBOX_API_ORIGIN,
  ZARINPAL_LIVE_GATEWAY_ORIGIN,
  ZARINPAL_SANDBOX_GATEWAY_ORIGIN,
  ZARINPAL_REQUEST_PATH,
  ZARINPAL_VERIFY_PATH,
  ZARINPAL_STARTPAY_PATH,
  ZARINPAL_SUCCESS_CODE,
  ZARINPAL_ALREADY_VERIFIED_CODE,
  ZARINPAL_NOT_FOUND_CODE,
  ZARINPAL_MIN_AMOUNT_RIAL,
  ZARINPAL_MERCHANT_ID_PATTERN,
  type ZarinPalProviderConfig,
  type ZarinPalProviderOptions,
} from "./providers/zarinpal";

export {
  createSandboxProvider,
  SandboxPaymentProvider,
  SANDBOX_PROVIDER_ID,
  SANDBOX_GATEWAY_ORIGIN,
  SANDBOX_PAY_PATH,
  SANDBOX_AUTHORITY_PREFIX,
  SANDBOX_REFERENCE_PREFIX,
  type SandboxProviderOptions,
} from "./providers/sandbox";

export {
  DEFAULT_PAYMENT_PROVIDER_ID,
  isProductionEnvironment,
  parseSandboxFlag,
  readPaymentProviderConfig,
  assertPaymentProviderConfig,
  createPaymentProvider,
  getPaymentProvider,
  resetPaymentProviderCache,
  isPaymentProviderConfigured,
  type PaymentProviderConfig,
  type CreatePaymentProviderOptions,
} from "./factory";
