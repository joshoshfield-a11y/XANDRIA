export function measure(payload = {}) {
  let score = 0;
  if (payload.intent) score += 1;
  if (Array.isArray(payload.generatedFiles) && payload.generatedFiles.length > 0) score += 1;
  return { score };
}
