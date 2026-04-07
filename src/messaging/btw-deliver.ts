export function buildBtwBlockquote(senderName: string, rawQuestion: string): string {
  const senderPrefix = senderName ? `${senderName}: ` : "";
  return `> ${senderPrefix}${rawQuestion}\n\n`;
}
