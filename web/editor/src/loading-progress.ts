export interface AssetProgress {
  completedBytes: number;
  totalBytes: number;
  activeFiles: number;
}
export function assetProgress(value: unknown): AssetProgress | null {
  if (!value || typeof value !== "object") return null;
  const { completedBytes, totalBytes, activeFiles } = value as AssetProgress;
  if (
    ![completedBytes, totalBytes, activeFiles].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    totalBytes === 0 ||
    completedBytes > totalBytes
  )
    return null;
  return { completedBytes, totalBytes, activeFiles };
}
