export function getByteRangeHeader(rangeStart?: number, rangeEnd?: number) {
  const start = rangeStart ?? 0;
  if (rangeEnd === undefined || rangeEnd <= start) return undefined;
  return `bytes=${start}-${rangeEnd - 1}`;
}
