export interface PerfStats {
  n: number;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
}

export interface PerfRouteSummary {
  route: string;
  samples: number;
  ready: PerfStats;
  ttfb: PerfStats;
  fcp: PerfStats;
  lcp: PerfStats;
  cls: PerfStats;
  load: PerfStats;
  serverFn: PerfStats;
  errors: number;
}

export interface PerfQuerySummary {
  route: string;
  events: number;
  roundTrips: number;
  duration: PerfStats;
  outcomes: Record<string, number>;
}

export interface PerfReport {
  schemaVersion: number;
  label: string;
  generatedAt: string;
  sectionTitles: string[];
  meta: Record<string, unknown>;
  routes: PerfRouteSummary[];
  query: PerfQuerySummary[];
  chat: { samples: number; send: PerfStats };
  ai: {
    latency: PerfStats;
    byOutcome: Record<string, number>;
    byModel: Array<{ model: string } & PerfStats>;
    bySource: Record<string, number>;
  };
  bundle: {
    budget: Record<string, number> | null;
    entries: Array<{
      file: string;
      minifiedBytes: number;
      gzipBytes: number;
      brotliBytes: number;
      passed: boolean;
      initialGraph: {
        files: number | null;
        minifiedBytes: number;
        gzipBytes: number;
        brotliBytes: number;
        limitBytes: number;
      } | null;
    }>;
  } | null;
  gaps: string[];
}

export interface PerfRaw {
  meta?: Record<string, unknown>;
  routeSamples?: Array<Record<string, unknown>>;
  chatSamples?: Array<Record<string, unknown>>;
  contextTx?: Array<Record<string, unknown>>;
  aiAttempts?: Array<Record<string, unknown>>;
  bundleReport?: Record<string, unknown> | null;
}

export function percentile(values: number[], p: number): number | null;
export function summarize(raw: PerfRaw): PerfReport;
export function renderReport(data: PerfReport): string;
export function summarizeDir(dir?: string): Promise<{ reportPath: string; report: PerfReport }>;
export function parseArgs(argv: string[]): { dir: string; help?: boolean };
export function main(argv?: string[]): Promise<number>;
