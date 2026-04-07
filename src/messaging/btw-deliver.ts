const MAX_QUESTION_LENGTH = 80;
const LEADING_MENTIONS_RE = /^(?:@\S+\s+)*/u;

export function buildBtwBlockquote(senderName: string, rawQuestion: string): string {
  const stripped = rawQuestion.replace(LEADING_MENTIONS_RE, "");
  const truncated =
    stripped.length > MAX_QUESTION_LENGTH ? `${stripped.slice(0, MAX_QUESTION_LENGTH)}…` : stripped;
  const senderPrefix = senderName ? `${senderName}: ` : "";
  return `> ${senderPrefix}${truncated}\n\n`;
}
