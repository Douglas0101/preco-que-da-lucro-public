import type { RequestContext } from "@/lib/request-context";
import { conversationService } from "@/server/services/conversation.service";

export {
  createTenantTransaction,
  numberSetting,
  type TenantTransactionRunner,
} from "@/lib/tenant-transaction";

/** Adapter de compatibilidade (M02-3): a implementação vive em
 * `conversation.repository.ts` + `conversation.service.ts`; este módulo
 * permanece apenas como superfície de re-export até a remoção. */
export function getConversation(context: RequestContext) {
  return conversationService.findForUser(context);
}

export function getOrCreateConversation(context: RequestContext) {
  return conversationService.getOrCreate(context);
}

export function validateCurrentProduct(context: RequestContext, productId: string | null) {
  return conversationService.validateProduct(context, productId);
}
