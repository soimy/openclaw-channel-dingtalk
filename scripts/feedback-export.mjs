#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
// Local administrative export. No network access, model calls, or mutation.
import { parseArgs } from "node:util";

try {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      account: { type: "string" },
      user: { type: "string" },
      days: { type: "string", default: "90" },
      format: { type: "string", default: "json" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/feedback-export.mjs --state-dir <dingtalk-state> --account <id> [--user <UserId>] [--days 90] [--format json|csv]\n",
    );
    process.exit(0);
  }
  const days = Number(values.days);
  if (
    !values["state-dir"] ||
    !values.account ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365 ||
    !["json", "csv"].includes(values.format)
  ) {
    throw new Error("Provide --state-dir, --account, days 1..365, and format json or csv.");
  }
  const now = Date.now();
  const prefix = `feedback.ratings.account-${Buffer.from(values.account).toString("base64url")}.target-`;
  const records = [];
  for (const file of await readdir(values["state-dir"])) {
    if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(path.join(values["state-dir"], file), "utf8"));
    if (data.version !== 1 || !Array.isArray(data.reasons))
      throw new Error("Invalid feedback record; export aborted.");
    if (
      data.accountId !== values.account ||
      !data.completedAt ||
      data.expiresAt <= now ||
      data.createdAt < now - days * 86400000 ||
      (values.user && data.ownerUserId !== values.user)
    )
      continue;
    records.push({
      cardId: data.outTrackId,
      ownerUserId: data.ownerUserId,
      agentId: data.agentId,
      conversationId: data.conversationId,
      sourceMsgId: data.sourceMsgId ?? "",
      sessionKey: data.sessionKey,
      transcriptStatus: data.transcript?.status ?? "not-recorded",
      transcriptReason: data.transcript?.reason ?? "",
      sessionId: data.transcript?.status === "linked" ? data.transcript.sessionId : "",
      userMessageId: data.transcript?.status === "linked" ? data.transcript.userMessageId : "",
      assistantMessageId:
        data.transcript?.status === "linked" ? data.transcript.assistantMessageId : "",
      createdAt: new Date(data.createdAt).toISOString(),
      vote: data.vote,
      reasons: data.vote === "dislike" ? data.reasons : [],
      answerHash: data.answerHash ?? "",
    });
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (values.format === "json") {
    process.stdout.write(
      JSON.stringify({ account: values.account, days, count: records.length, records }, null, 2) +
        "\n",
    );
  } else {
    const columns = [
      "cardId",
      "ownerUserId",
      "agentId",
      "conversationId",
      "sourceMsgId",
      "sessionKey",
      "transcriptStatus",
      "transcriptReason",
      "sessionId",
      "userMessageId",
      "assistantMessageId",
      "createdAt",
      "vote",
      "reasons",
      "answerHash",
    ];
    const cell = (input) => {
      let text = Array.isArray(input) ? input.join("|") : String(input ?? "");
      if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    process.stdout.write(
      [
        columns.join(","),
        ...records.map((row) => columns.map((key) => cell(row[key])).join(",")),
      ].join("\n") + "\n",
    );
  }
} catch (error) {
  process.stderr.write(`Feedback export failed: ${error.message}\n`);
  process.exitCode = 1;
}
