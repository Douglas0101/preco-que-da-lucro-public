export interface SumsParsedArgs {
  verify: boolean;
  releaseGsec: boolean;
  root: string;
  error?: string;
}
export interface SumsEntry {
  hash: string;
  path: string;
}
export interface SumsBundleRef {
  name: string;
  dir: string;
  sumsPath: string;
}
export interface SumsVerifyFailure {
  path: string;
  expected: string;
  actual: string | null;
  labeled: boolean;
}
export interface SumsVerifyResult {
  total: number;
  ok: number;
  failed: SumsVerifyFailure[];
  missingPinned: string[];
  status: "GREEN" | "RED-LABELED" | "RED-UNLABELED";
}
export declare const GSEC_EXCEPTION: {
  bundle: string;
  label: string;
  marker: string;
  pins: Record<string, string>;
};
export declare function parseArgs(argv: string[]): SumsParsedArgs;
export declare function main(): void;
export declare function sha256OfFile(path: string): string;
export declare function discoverBundles(bundleRoot: string): SumsBundleRef[];
export declare function parseSums(text: string): { entries: SumsEntry[]; error?: string };
export declare function buildSumsContent(entries: SumsEntry[]): string;
export declare function verifyEntries(
  entries: SumsEntry[],
  options: { rootDir: string; bundleName: string; exceptionActive: boolean },
): SumsVerifyResult;
