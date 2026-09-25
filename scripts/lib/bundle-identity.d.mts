export declare function sha256(contents: string | Uint8Array): string;

export declare function aggregateSha256(entries: Array<{ file: string; sha256: string }>): string;

export declare function identityOf(files: Array<{ file: string; contents: string | Uint8Array }>): {
  files: Array<{ file: string; sha256: string }>;
  graphSha256: string;
};
