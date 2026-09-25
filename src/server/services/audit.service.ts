import type { RequestContext } from "@/lib/request-context";
import {
  auditRepository,
  type AuditEventWrite,
  type AuditRepository,
} from "@/server/repositories/audit.repository";

/** Append-only audit trail. The service owns the contract and stays free of
 * SQL: every write goes through the repository, which uses the tenant
 * transaction from the request context. */
export interface AuditService {
  append(context: RequestContext, input: AuditEventWrite): Promise<void>;
}

export class DefaultAuditService implements AuditService {
  constructor(private readonly repository: AuditRepository) {}

  append(context: RequestContext, input: AuditEventWrite) {
    return this.repository.append(context, input);
  }
}

export const auditService: AuditService = new DefaultAuditService(auditRepository);
