import { parentPort, workerData } from "node:worker_threads";
import { collectReportContent, type FeedbackContentRequest } from "./feedback-reporting-content";

// Read-only entry: no receiver endpoint, credentials, outbox writes, or HTTP transport.
if (parentPort && workerData?.kind === "dingtalk-feedback-detail") {
  const port = parentPort;
  void collectReportContent(workerData.request as FeedbackContentRequest)
    .then(
      (content) => port.postMessage({ kind: "content", content }),
      () => port.postMessage({ kind: "error", code: "read_failed" }),
    )
    .finally(() => port.close());
}
