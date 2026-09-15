import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// `console` is this CLI's output contract: the rendered verdict goes to stdout
// for CI logs and the GitHub step summary, and blocking reasons go to stderr.
// The runtime logger is a host-injected service that only exists inside the
// plugin runtime, so it is not available to a standalone gate script.

/**
 * ClawHub beta 审计门禁判定（P2：suspicious 需人工放行）。
 *
 * 输入：`GET /api/v1/packages/{name}/versions/{version}/security` 的响应 JSON
 * （这个端点是公开、免鉴权、版本精确的安装信任面，OpenClaw 安装插件前读的就是它）。
 *
 * 输出：
 * - stdout / `GITHUB_STEP_SUMMARY`：人类可读的审计摘要
 * - `gate-result.json`：机器可读的判定结果，供 CI 归档
 * - 退出码：0 = 放行，1 = 拦截
 *
 * 判定分档：
 * - 硬失败（fail-closed）：blockedFromDownload / malicious / quarantined / revoked /
 *   pending / stale / not-run / 未知 scanStatus / 响应结构不合法
 * - 软失败（P2）：scanStatus = suspicious 时默认拦截，仅当 `ALLOW_SUSPICIOUS=1` 放行
 * - 通过：scanStatus = clean
 */

/** ClawHub `trust.scanStatus` 的完整取值集合，未知取值按 fail-closed 处理。 */
const KNOWN_SCAN_STATUSES = new Set(["clean", "suspicious", "malicious", "not-run", "pending"]);

/** 会直接封锁版本的人工审核状态。 */
const BLOCKING_MODERATION_STATES = new Set(["quarantined", "revoked"]);

const OVERRIDE_ENV = "ALLOW_SUSPICIOUS";

const verdictPath = process.argv[2] ?? "verdict.json";

const isEnabled = (value) =>
  ["1", "true", "yes"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
const allowSuspicious = isEnabled(process.env.ALLOW_SUSPICIOUS);
const auditMode = process.env.AUDIT_MODE === "manual" ? "manual" : "release-gate";
const packageName = process.env.PACKAGE_NAME?.trim() || "unknown-package";
const betaVersion = process.env.BETA_VERSION?.trim() || "unknown-version";
const auditUrl = process.env.SECURITY_AUDIT_URL?.trim() || "";

/** 读取并解析审计结论，任何读取/解析失败都视为 fail-closed。 */
const readVerdict = (path) => {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { error: `无法读取审计结论 ${path}：${error.message}` };
  }
  try {
    return { verdict: JSON.parse(raw) };
  } catch (error) {
    return { error: `审计结论 ${path} 不是合法 JSON：${error.message}` };
  }
};

/** 按 P2 策略评估一份 trust 响应。 */
const evaluateTrust = (trust) => {
  const hardFailures = [];
  const warnings = [];

  if (trust === null || typeof trust !== "object" || Array.isArray(trust)) {
    return {
      hardFailures: ["响应缺少 trust 对象，按 fail-closed 处理"],
      warnings,
      scanStatus: null,
      moderationState: null,
    };
  }

  const scanStatus = typeof trust.scanStatus === "string" ? trust.scanStatus : null;
  const moderationState = typeof trust.moderationState === "string" ? trust.moderationState : null;

  // Every trust field the verdict depends on is validated for presence and type
  // before it is used, so a malformed upstream payload can never read as "no
  // blocking signal found".
  const readBoolean = (key) => {
    const value = trust[key];
    if (typeof value !== "boolean") {
      hardFailures.push(
        `trust.${key} 缺失或不是布尔值（实际：${JSON.stringify(value ?? null)}），按 fail-closed 处理`,
      );
      return null;
    }
    return value;
  };

  const blockedFromDownload = readBoolean("blockedFromDownload");
  const pending = readBoolean("pending");
  const stale = readBoolean("stale");

  if (blockedFromDownload === true) {
    hardFailures.push("trust.blockedFromDownload = true：ClawHub 已阻止该版本下载");
  }
  if (scanStatus === null) {
    hardFailures.push("trust.scanStatus 缺失或不是字符串，按 fail-closed 处理");
  } else if (!KNOWN_SCAN_STATUSES.has(scanStatus)) {
    hardFailures.push(`trust.scanStatus = ${scanStatus} 不是已知取值，按 fail-closed 处理`);
  } else if (scanStatus === "malicious") {
    hardFailures.push("trust.scanStatus = malicious：ClawHub 判定该版本为恶意");
  } else if (scanStatus === "not-run") {
    hardFailures.push("trust.scanStatus = not-run：该版本没有可用的安全扫描结论");
  } else if (scanStatus === "pending") {
    hardFailures.push("trust.scanStatus = pending：安全审计尚未完成");
  }

  if (pending === true) {
    hardFailures.push("trust.pending = true：仍有安全审计输入未完成");
  }
  if (stale === true) {
    hardFailures.push("trust.stale = true：审计结论已过期，需重新扫描后再判定");
  }
  if (
    !("moderationState" in trust) ||
    (trust.moderationState !== null && moderationState === null)
  ) {
    hardFailures.push(
      `trust.moderationState 缺失或不是字符串/null（实际：${JSON.stringify(trust.moderationState ?? null)}），按 fail-closed 处理`,
    );
  } else if (BLOCKING_MODERATION_STATES.has(moderationState)) {
    hardFailures.push(`trust.moderationState = ${moderationState}：人工审核状态已封锁该版本`);
  }
  if (!Array.isArray(trust.reasons)) {
    hardFailures.push("trust.reasons 缺失或不是数组，按 fail-closed 处理");
  }
  if (scanStatus === "suspicious") {
    warnings.push("trust.scanStatus = suspicious：ClawScan 认为该版本需要人工复核");
    if (!allowSuspicious) {
      hardFailures.push(
        `检测到 suspicious 且未开启人工放行：确认风险后设置 ${OVERRIDE_ENV}=1 重新运行`,
      );
    }
  }

  return { hardFailures, warnings, scanStatus, moderationState };
};

const read = readVerdict(verdictPath);
const verdict = read.verdict ?? null;
const { hardFailures, warnings, scanStatus, moderationState } = read.error
  ? { hardFailures: [read.error], warnings: [], scanStatus: null, moderationState: null }
  : evaluateTrust(verdict?.trust);

const overrideApplied = hardFailures.length === 0 && scanStatus === "suspicious";
const ok = hardFailures.length === 0;
const decision = ok ? (overrideApplied ? "pass-with-override" : "pass") : "fail";

const trust = verdict?.trust && typeof verdict.trust === "object" ? verdict.trust : {};
const reasons = Array.isArray(trust.reasons) ? trust.reasons.map(String) : [];
const overview = typeof verdict?.overview === "string" ? verdict.overview.trim() : "";
const resolvedAuditUrl =
  typeof verdict?.securityAuditUrl === "string" ? verdict.securityAuditUrl : auditUrl;

const rows = [
  ["判定结果", decision],
  ["包", `${packageName}@${betaVersion}`],
  ["运行模式", auditMode === "manual" ? "手动审计（保留 beta）" : "发版门禁（自动撤回 beta）"],
  ["scanStatus", scanStatus ?? "(缺失)"],
  ["moderationState", moderationState ?? "null"],
  ["blockedFromDownload", String(trust.blockedFromDownload ?? "(缺失)")],
  ["pending", String(trust.pending ?? "(缺失)")],
  ["stale", String(trust.stale ?? "(缺失)")],
  ["reasons", reasons.length > 0 ? reasons.join(", ") : "(无)"],
  ["人工放行", allowSuspicious ? `已开启（${OVERRIDE_ENV}=1）` : "未开启"],
];

const markdown = [
  `## ClawHub beta 安全审计${ok ? "通过" : "未通过"}`,
  "",
  "| 字段 | 值 |",
  "| --- | --- |",
  ...rows.map(([key, value]) => `| ${key} | ${String(value).replaceAll("|", "\\|")} |`),
  "",
  ...(resolvedAuditUrl ? [`审计报告页：${resolvedAuditUrl}`, ""] : []),
  ...(hardFailures.length > 0
    ? ["### 拦截原因", "", ...hardFailures.map((item) => `- ${item}`), ""]
    : []),
  ...(warnings.length > 0 && hardFailures.length === 0
    ? ["### 警告", "", ...warnings.map((item) => `- ${item}`), ""]
    : []),
  ...(overview
    ? ["### ClawScan 结论", "", ...overview.split("\n").map((line) => `> ${line}`), ""]
    : []),
].join("\n");

console.log(`[ClawHub beta gate] ${packageName}@${betaVersion}`);
for (const [key, value] of rows) {
  console.log(`  ${key}: ${value}`);
}
if (hardFailures.length > 0) {
  console.log("  拦截原因:");
  for (const item of hardFailures) {
    console.log(`    - ${item}`);
  }
}
if (warnings.length > 0) {
  console.log("  警告:");
  for (const item of warnings) {
    console.log(`    - ${item}`);
  }
}
if (resolvedAuditUrl) {
  console.log(`  审计报告页: ${resolvedAuditUrl}`);
}
if (overview) {
  console.log("  ClawScan 结论:");
  for (const line of overview.split("\n")) {
    console.log(`    ${line}`);
  }
}

writeFileSync(
  "gate-result.json",
  `${JSON.stringify(
    {
      ok,
      decision,
      packageName,
      betaVersion,
      auditMode,
      allowSuspicious,
      scanStatus,
      moderationState,
      blockedFromDownload: trust.blockedFromDownload ?? null,
      pending: trust.pending ?? null,
      stale: trust.stale ?? null,
      reasons,
      securityAuditUrl: resolvedAuditUrl || null,
      hardFailures,
      warnings,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
}

if (!ok) {
  console.error(
    `[ClawHub beta gate] 拦截 ${packageName}@${betaVersion}：${hardFailures.length} 项硬失败/未放行的软失败`,
  );
  process.exitCode = 1;
}
