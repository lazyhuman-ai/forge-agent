export function mergeVoiceDraft(current: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return current;
  if (!current.trim()) return text;
  const separator = /[\s\n]$/.test(current) ? "" : " ";
  return `${current}${separator}${text}`;
}

export function mergeRollingTranscript(existing: string, transcript: string): string {
  const current = existing.trim();
  const next = transcript.trim();
  if (!next) return current;
  if (!current) return next;
  if (current.includes(next)) return current;
  const max = Math.min(current.length, next.length);
  for (let size = max; size >= 2; size -= 1) {
    if (current.endsWith(next.slice(0, size))) {
      return `${current}${next.slice(size)}`.trim();
    }
  }
  const separator = /[，。！？,.!?\s]$/.test(current) ? "" : " ";
  return `${current}${separator}${next}`.trim();
}
