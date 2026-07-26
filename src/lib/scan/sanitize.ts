const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_PATTERN = /\b(?:ya29\.|eyJ)[A-Za-z0-9._-]+\b/g;

export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(EMAIL_PATTERN, "[email]")
    .replace(TOKEN_PATTERN, "[credential]")
    .slice(0, 240);
}
