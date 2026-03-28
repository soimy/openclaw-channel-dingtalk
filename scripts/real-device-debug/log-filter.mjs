import fs from "node:fs";
import path from "node:path";

const CONTEXT_KEYWORDS = ["[DingTalk]", "sendMessage", "sendBySession", "handleDingTalkMessage"];

function shouldKeepLine(line, traceToken) {
    if (line.includes(traceToken)) {
        return true;
    }
    return CONTEXT_KEYWORDS.some((keyword) => line.includes(keyword));
}

export function filterSessionLog({ sessionDir, traceToken }) {
    const openclawLogPath = path.join(sessionDir, "logs", "openclaw.log");
    const filteredLogPath = path.join(sessionDir, "logs", "filtered.log");
    const raw = fs.existsSync(openclawLogPath) ? fs.readFileSync(openclawLogPath, "utf8") : "";
    const filtered = raw
        .split(/\r?\n/)
        .filter((line) => line && shouldKeepLine(line, traceToken))
        .join("\n");

    fs.writeFileSync(filteredLogPath, filtered ? `${filtered}\n` : "", "utf8");
    return {
        filteredLogPath,
    };
}
