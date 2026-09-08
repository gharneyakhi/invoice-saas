import { z } from "zod";
import type { Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { CustomerDTO } from "@/server/actions/dto";

/**
 * Client-side validation for the customer create/edit form (UX feedback only).
 *
 * Mirrors the *rules* of the authoritative server schemas in
 * `src/server/customer/schema.ts` — required name, the same max lengths and
 * the same email rule — so obvious mistakes are caught in the browser with
 * Persian, field-level messages. It is NOT a second source of truth: every
 * value is re-validated server-side by `customerService` before anything is
 * persisted, and the server is deliberately the only place that normalizes
 * (`""` → `null`) and rejects unknown keys.
 *
 * Deliberately lenient where the server is lenient: `mobile`, `phone`,
 * `nationalId` and `economicCode` are free text capped at 50 characters
 * server-side, so the browser must not impose a stricter format (e.g. an
 * `09…` mobile pattern) that would block input the server accepts.
 */

export interface CustomerFormFields {
  name: string;
  mobile: string;
  phone: string;
  email: string;
  address: string;
  nationalId: string;
  economicCode: string;
  notes: string;
}

const NAME_MAX_LENGTH = 200;
const SHORT_TEXT_MAX_LENGTH = 50;
const EMAIL_MAX_LENGTH = 320;
const ADDRESS_MAX_LENGTH = 500;
const NOTES_MAX_LENGTH = 2000;

const nameField = z
  .string({
    required_error: "نام مشتری الزامی است",
    invalid_type_error: "نام مشتری نامعتبر است",
  })
  .trim()
  .min(1, "نام مشتری الزامی است")
  .max(NAME_MAX_LENGTH, `نام مشتری حداکثر ${NAME_MAX_LENGTH} کاراکتر است`);

/** Optional trimmed text; empty stays `""` in the form (server maps it to null). */
const optionalText = (label: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${label} نامعتبر است` })
    .trim()
    .max(maxLength, `${label} حداکثر ${maxLength} کاراکتر است`)
    .optional()
    .default("");

const emailField = z
  .string({ invalid_type_error: "ایمیل نامعتبر است" })
  .trim()
  .max(EMAIL_MAX_LENGTH, `ایمیل حداکثر ${EMAIL_MAX_LENGTH} کاراکتر است`)
  .refine((value) => value === "" || z.string().email().safeParse(value).success, {
    message: "ایمیل وارد شده معتبر نیست",
  })
  .optional()
  .default("");

export const customerFormSchema = z.object({
  name: nameField,
  mobile: optionalText("موبایل", SHORT_TEXT_MAX_LENGTH),
  phone: optionalText("تلفن ثابت", SHORT_TEXT_MAX_LENGTH),
  email: emailField,
  address: optionalText("آدرس", ADDRESS_MAX_LENGTH),
  nationalId: optionalText("کد ملی", SHORT_TEXT_MAX_LENGTH),
  economicCode: optionalText("کد اقتصادی", SHORT_TEXT_MAX_LENGTH),
  notes: optionalText("یادداشت", NOTES_MAX_LENGTH),
});

/**
 * Ready-to-use React Hook Form resolver. The `.optional().default("")`
 * fields make Zod infer the input as optional while the form always carries
 * strings; the single cast bridges that phantom typing gap — no runtime
 * effect (same pattern as `businessSettingsFormResolver`).
 */
export const customerFormResolver = zodResolver(
  customerFormSchema,
) as unknown as Resolver<CustomerFormFields, undefined, CustomerFormFields>;

export function emptyCustomerFormValues(): CustomerFormFields {
  return {
    name: "",
    mobile: "",
    phone: "",
    email: "",
    address: "",
    nationalId: "",
    economicCode: "",
    notes: "",
  };
}

/** Maps a server DTO onto form values (`null` → `""` for controlled inputs). */
export function customerToFormValues(customer: CustomerDTO): CustomerFormFields {
  return {
    name: customer.name,
    mobile: customer.mobile ?? "",
    phone: customer.phone ?? "",
    email: customer.email ?? "",
    address: customer.address ?? "",
    nationalId: customer.nationalId ?? "",
    economicCode: customer.economicCode ?? "",
    notes: customer.notes ?? "",
  };
}

/**
 * Payload for `createCustomer`. Only the client-writable columns of
 * `model Customer` — values are already trimmed by the schema; the server
 * normalizes `""` to `null` and rejects anything else.
 */
export function toCreateCustomerPayload(values: CustomerFormFields): Record<string, string> {
  return {
    name: values.name,
    mobile: values.mobile,
    phone: values.phone,
    email: values.email,
    address: values.address,
    nationalId: values.nationalId,
    economicCode: values.economicCode,
    notes: values.notes,
  };
}

/**
 * Payload for `updateCustomer`. All writable columns are sent so clearing a
 * field in the form clears it in the database (`""` → `null` server-side);
 * unchanged fields are simply rewritten with the same value.
 */
export function toUpdateCustomerPayload(values: CustomerFormFields): Record<string, string> {
  return toCreateCustomerPayload(values);
}
