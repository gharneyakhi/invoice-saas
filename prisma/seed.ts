/**
 * Seed script — Plans, Features, PlanFeatures.
 * Prices are read from env so nothing financial is hard-coded into source.
 * Run: npm run prisma:seed
 */
import { PrismaClient, PlanKey } from "@prisma/client";

const prisma = new PrismaClient();

const FEATURES = [
  { key: "PDF_EXPORT", name: "PDF Export", description: "Export invoice as PDF" },
  { key: "PRINT", name: "Print", description: "Print-optimized invoice layout" },
  { key: "IMAGE_EXPORT", name: "Image Export", description: "Export invoice as image" },
  { key: "EXCEL_EXPORT", name: "Excel Export", description: "Export invoices as XLSX" },
  { key: "EMAIL_SEND", name: "Email Sending", description: "Send invoice via Gmail" },
  { key: "MULTI_BUSINESS", name: "Multi Business", description: "Manage more than one business" },
  { key: "ADVANCED_REPORTS", name: "Advanced Reports", description: "Cross-business reporting" },
  { key: "PARTIAL_PAYMENTS", name: "Partial Payments", description: "Record partial invoice payments" },
  { key: "PAYMENT_REMINDERS", name: "Payment Reminders", description: "Automatic due-date reminders" },
  { key: "RECURRING_INVOICES", name: "Recurring Invoices", description: "Auto-generate recurring invoices" },
  { key: "PROFORMA", name: "Proforma Invoices", description: "Create non-binding proforma invoices" },
  { key: "DRAFT_INVOICES", name: "Draft Invoices", description: "Save invoices as drafts" },
  { key: "INVOICE_DUPLICATION", name: "Invoice Duplication", description: "Duplicate an invoice as a new draft" },
] as const;

const PLANS: Array<{
  key: PlanKey;
  name: string;
  description: string;
  priceEnvVar: string;
  businessLimit: number;
  invoiceLimit: number;
  features: string[];
}> = [
  {
    key: "FREE",
    name: "رایگان",
    description: "برای شروع و آزمایش سامانه",
    priceEnvVar: "PLAN_PRICE_FREE",
    businessLimit: 1,
    invoiceLimit: 3,
    features: ["PDF_EXPORT", "PRINT", "IMAGE_EXPORT", "PROFORMA", "DRAFT_INVOICES"],
  },
  {
    key: "BASIC",
    name: "پایه",
    description: "برای کسب‌وکارهای کوچک",
    priceEnvVar: "PLAN_PRICE_BASIC",
    businessLimit: 1,
    invoiceLimit: 10,
    features: [
      "PDF_EXPORT",
      "PRINT",
      "IMAGE_EXPORT",
      "EXCEL_EXPORT",
      "EMAIL_SEND",
      "PROFORMA",
      "DRAFT_INVOICES",
      "INVOICE_DUPLICATION",
    ],
  },
  {
    key: "PRO",
    name: "حرفه‌ای",
    description: "برای کسب‌وکارهای چندشعبه‌ای",
    priceEnvVar: "PLAN_PRICE_PRO",
    businessLimit: 3,
    invoiceLimit: 50,
    features: [
      "PDF_EXPORT",
      "PRINT",
      "IMAGE_EXPORT",
      "EXCEL_EXPORT",
      "EMAIL_SEND",
      "PROFORMA",
      "DRAFT_INVOICES",
      "INVOICE_DUPLICATION",
      "MULTI_BUSINESS",
      "ADVANCED_REPORTS",
      "PARTIAL_PAYMENTS",
      "PAYMENT_REMINDERS",
      "RECURRING_INVOICES",
    ],
  },
];

async function main() {
  console.log("Seeding features...");
  const featureRecords: Record<string, string> = {};
  for (const f of FEATURES) {
    const rec = await prisma.feature.upsert({
      where: { key: f.key },
      update: { name: f.name, description: f.description },
      create: f,
    });
    featureRecords[f.key] = rec.id;
  }

  console.log("Seeding plans...");
  for (const p of PLANS) {
    const price = Number(process.env[p.priceEnvVar] ?? "0");
    const plan = await prisma.plan.upsert({
      where: { key: p.key },
      update: {
        name: p.name,
        description: p.description,
        price,
        businessLimit: p.businessLimit,
        invoiceLimit: p.invoiceLimit,
      },
      create: {
        key: p.key,
        name: p.name,
        description: p.description,
        price,
        currency: "IRR",
        businessLimit: p.businessLimit,
        invoiceLimit: p.invoiceLimit,
      },
    });

    for (const featureKey of p.features) {
      await prisma.planFeature.upsert({
        where: { planId_featureId: { planId: plan.id, featureId: featureRecords[featureKey] } },
        update: { enabled: true },
        create: { planId: plan.id, featureId: featureRecords[featureKey], enabled: true },
      });
    }
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
