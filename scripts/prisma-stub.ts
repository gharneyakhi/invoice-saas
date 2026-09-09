/**
 * Prisma stub for the PDF visual-verify script (`pdf-rtl-verify.ts`), which
 * renders fabricated models and must never touch a database. Any access
 * throws loudly so a script regression cannot silently query.
 *
 * Deliberately NOT typed as `any` (and therefore needing no eslint-disable):
 * the inferred `{}` type means no property access through this stub can
 * typecheck, which matches the runtime contract that any access throws.
 * (Nothing imports this type anyway — the vite alias in
 * `vite.verify.config.ts` swaps `@/lib/prisma` for this file at runtime
 * only; tsc still resolves the real client for typechecking.)
 */
export const prisma = new Proxy(
  {},
  {
    get: (_target, property): never => {
      throw new Error(`[verify] unexpected prisma access: ${String(property)}`);
    },
  },
);
