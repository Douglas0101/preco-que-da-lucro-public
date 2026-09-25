import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * "Como calculamos?" disclosure for financial KPIs (plan mestre §18.3).
 * CSP-safe by design: native details/summary, no event handlers, no inline styles.
 */
const CalcExplainer = React.forwardRef<
  HTMLDetailsElement,
  React.HTMLAttributes<HTMLDetailsElement> & { summary?: string }
>(({ className, summary = "Como calculamos?", children, ...props }, ref) => (
  <details ref={ref} className={cn("group text-xs text-muted-foreground", className)} {...props}>
    <summary className="cursor-pointer select-none font-medium underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      {summary}
    </summary>
    <div className="mt-2 space-y-1.5 rounded-lg border bg-muted/40 p-3 leading-relaxed">
      {children}
    </div>
  </details>
));
CalcExplainer.displayName = "CalcExplainer";

export { CalcExplainer };
