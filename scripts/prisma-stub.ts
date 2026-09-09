/**
 * Prisma stub for the PDF visual-verify script (`pdf-rtl-verify.ts`), which
 * renders fabricated models and must never touch a database. Any access
 * throws loudly so a script regression cannot silently query.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const prisma: any = new Proxy(
  {},
  {
    get: (_target, property): never => {
      throw new Error(`[verify] unexpected prisma access: ${String(property)}`);
    },
  },
);
