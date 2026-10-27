import http from "node:http";
import https from "node:https";
import { validateReportAck, type FeedbackReportEnvelope } from "./feedback-reporting-protocol";

/** No redirects, unbounded responses, inherited proxy pools, or credential logging. */
export async function postFeedbackReport(
  endpoint: string,
  token: string,
  envelope: FeedbackReportEnvelope,
  timeoutMs: number,
) {
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body) > 300 * 1024) {
    throw new Error("request_size_limit");
  }
  return await new Promise<ReturnType<typeof validateReportAck>>((resolve, reject) => {
    const url = new URL(endpoint);
    const send = url.protocol === "https:" ? https.request : http.request;
    const request = send(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "content-length": Buffer.byteLength(body),
          "idempotency-key": `${envelope.recordId}:${envelope.revision}`,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.destroy();
          reject(new Error(`http_${status}`));
          return;
        }
        let length = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 8192) {
            response.destroy(new Error("response_size_limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(
              validateReportAck(JSON.parse(Buffer.concat(chunks).toString("utf8")), envelope),
            );
          } catch {
            reject(new Error("invalid_ack"));
          }
        });
      },
    );
    // Covers DNS, connect, TLS, headers and body, not just socket inactivity.
    const deadline = setTimeout(() => request.destroy(new Error("request_timeout")), timeoutMs);
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
    request.end(body);
  });
}
