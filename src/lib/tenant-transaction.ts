import { ApplicationError } from "@/lib/api-error";
import type { RequestContext, RequestIdentity } from "@/lib/request-context";

export type TenantTransactionRunner = <T>(
  identity: RequestIdentity,
  operation: (transaction: RequestContext["transaction"]) => Promise<T>,
) => Promise<T>;

export function numberSetting(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function requestContext(
  identity: RequestIdentity,
  transaction: RequestContext["transaction"],
): RequestContext {
  return { ...identity, transaction };
}

export function createTenantTransaction(
  transactionRunner: TenantTransactionRunner,
): <T>(
  identity: RequestIdentity,
  operation: (context: RequestContext) => Promise<T>,
) => Promise<T> {
  return async function inTenantTransaction<T>(
    identity: RequestIdentity,
    operation: (context: RequestContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await transactionRunner(identity, (transaction) =>
        operation(requestContext(identity, transaction)),
      );
    } catch (error) {
      if (error instanceof ApplicationError || error instanceof Response) throw error;
      throw new ApplicationError("DATABASE_ERROR", { cause: error });
    }
  };
}
