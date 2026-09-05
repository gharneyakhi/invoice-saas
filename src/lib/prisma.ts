import { PrismaClient } from "@prisma/client";

// Standard Next.js dev-mode singleton pattern: without this, every hot
// reload would open a brand new PrismaClient (and a new DB connection
// pool) on top of the old one.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
