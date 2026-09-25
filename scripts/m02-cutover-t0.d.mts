export interface CutoverT0ParsedArgs {
  outDir?: string;
  skipSnapshot: boolean;
  error?: string;
}
export function parseArgs(argv: string[]): CutoverT0ParsedArgs;
