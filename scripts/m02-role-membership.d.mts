export interface RoleMembershipParsedArgs {
  targetEnv?: string;
  kind?: "drill-branch" | "cutover-window";
  dryRun: boolean;
  out?: string;
  error?: string;
}
export interface FreezeWindowResult {
  ok: boolean;
  reason: string;
}
export function parseArgs(argv: string[]): RoleMembershipParsedArgs;
export function validateFreezeWindow(
  env: Record<string, string | undefined>,
  now?: Date,
): FreezeWindowResult;
export function membershipState(client: unknown): Promise<Record<string, unknown>>;
