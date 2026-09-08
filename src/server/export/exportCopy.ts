/**
 * Shared Persian copy for Export & Sharing V1.
 *
 * Leaf module (no server imports): safe to import from PDF/image/Excel
 * generators, share-text builders and client components alike without
 * pulling the database or auth layers into the bundle.
 */

/**
 * Persian draft notice shared by every export surface (PDF banner,
 * Telegram/Gmail text, UI hints): exporting a draft must never imply it
 * is officially issued.
 */
export const DRAFT_EXPORT_NOTICE = "این فاکتور پیش‌نویس است و جنبه رسمی ندارد.";
