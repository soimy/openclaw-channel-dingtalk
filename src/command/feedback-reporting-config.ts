import { createHash } from "node:crypto";
import { z } from "zod";
import { buildSecretInputSchema, type SecretInput } from "../platform/secret-input";

export const FeedbackReportingSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().max(2048).optional(),
  tenantId: z.string().min(1).max(128).optional(),
  instanceId: z.string().min(1).max(128).optional(),
  token: buildSecretInputSchema().optional(),
  allowInsecureHttp: z.boolean().optional(),
  idleMs: z.number().int().min(1000).max(60000).optional(),
  requestTimeoutMs: z.number().int().min(500).max(10000).optional(),
  maxTranscriptBytes: z
    .number()
    .int()
    .min(65536)
    .max(32 * 1024 * 1024)
    .optional(),
  maxContentBytes: z
    .number()
    .int()
    .min(1024)
    .max(256 * 1024)
    .optional(),
  workerMemoryMb: z.number().int().min(64).max(256).optional(),
});
export type FeedbackReportingConfig = z.infer<typeof FeedbackReportingSchema>;
export type ResolvedFeedbackReporting = {
  endpoint: string;
  tenantId: string;
  instanceId: string;
  destinationKey: string;
  token: SecretInput;
  idleMs: number;
  requestTimeoutMs: number;
  maxTranscriptBytes: number;
  maxContentBytes: number;
  workerMemoryMb: number;
};
/** Pure validation. Invalid reporting configuration must not prevent channel startup. */
export function resolveFeedbackReporting(
  value: FeedbackReportingConfig | undefined,
): ResolvedFeedbackReporting | undefined {
  if (!value?.enabled) {
    return undefined;
  }
  const config = FeedbackReportingSchema.parse(value);
  if (!config.endpoint || !config.tenantId || !config.instanceId || !config.token) {
    throw new Error("Reporting requires endpoint, tenantId, instanceId and token");
  }
  const url = new URL(config.endpoint);
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("Reporting URL cannot contain credentials, query or fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (loopback || config.allowInsecureHttp))
  ) {
    throw new Error("Reporting requires HTTPS (or explicit private HTTP opt-in)");
  }
  const endpoint = url.toString();
  return {
    endpoint,
    tenantId: config.tenantId,
    instanceId: config.instanceId,
    token: config.token,
    destinationKey: createHash("sha256")
      .update(JSON.stringify([endpoint, config.tenantId, config.instanceId]))
      .digest("hex"),
    idleMs: config.idleMs ?? 5000,
    requestTimeoutMs: config.requestTimeoutMs ?? 5000,
    maxTranscriptBytes: config.maxTranscriptBytes ?? 8 * 1024 * 1024,
    maxContentBytes: config.maxContentBytes ?? 128 * 1024,
    workerMemoryMb: config.workerMemoryMb ?? 128,
  };
}
