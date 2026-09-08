-- Invoice Editor / Branding / Currency snapshot V2
-- Additive only: never rewrite the init migration.
--
-- 1. footerBackgroundColor on the live profile AND the immutable seller snapshot
--    so finalized invoices keep the footer colour they were issued with.
-- 2. Invoice.currency — snapshotted at finalization. Drafts stay NULL and keep
--    reading InvoiceSettings.currency. Existing finalized rows are backfilled
--    from the current settings so they freeze at the value they currently show.

-- AlterTable
ALTER TABLE "business_profiles" ADD COLUMN "footerBackgroundColor" TEXT;

-- AlterTable
ALTER TABLE "invoice_seller_snapshots" ADD COLUMN "footerBackgroundColor" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "currency" TEXT;

-- Backfill finalized / cancelled invoices from the business InvoiceSettings
-- they currently render with, so a later settings change cannot rewrite them.
UPDATE "invoices" AS i
SET "currency" = COALESCE(s."currency", 'IRR')
FROM "invoice_settings" AS s
WHERE i."businessId" = s."businessId"
  AND i."finalizedAt" IS NOT NULL
  AND i."currency" IS NULL;
