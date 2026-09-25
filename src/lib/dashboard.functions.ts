import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireDatabaseAuth } from "@/middleware/request-context";
import {
  getDashboardSummary as getDashboardSummaryService,
  type DashboardPeriod,
} from "@/server/services/dashboard.service";

export type { DashboardPeriod };

const dashboardInput = z
  .object({
    period: z.enum(["month", "quarter", "year"]).optional(),
  })
  .optional();

/** Server-side aggregate used by the dashboard route. */
export const getDashboardSummary = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => dashboardInput.parse(input))
  .handler(async ({ data, context }) =>
    getDashboardSummaryService(context.requestContext, data?.period ?? "month"),
  );
