import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 在**本地工作树**上手动跑一次 ClawHub beta 安全审计，并给出审计结论。
 *
 * 与 `.github/workflows/clawhub-publish.yml` 的 `audit` job 等价，区别是：
 * - 直接审计当前工作树（包含未提交改动），不需要 push
 * - 使用本机 `clawhub` 登录态（`clawhub login`）
 * - 默认**保留**审计版本，便于 `openclaw plugins install clawhub:<pkg>@<version>` 烟测
 *
 * 用法：
 *   node scripts/clawhub-audit-local.mjs [options]
 *
 * 选项：
 *   --version <v>        指定审计版本号（默认 <package.json version>-beta.<timestamp>）
 *   --allow-suspicious   让 suspicious 也能通过门禁（P2 人工放行）
 *   --withdraw           审计结束后撤回审计版本（默认保留）
 *   --timeout <seconds>  --wait 等待安全审计的时限（默认 2400）
 *   --dry-run            只做本地打包预检，不上传、不产生版本
 *   --source-repo <r>    --source-repo 覆盖（默认从 git origin 推断）
 *   --source-ref <r>     --source-ref 覆盖（默认当前分支名）
 *   --help
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = resolve(REPO_ROOT, ".clawhub-audit");
const VERDICT_PATH = resolve(EVIDENCE_DIR, "verdict.json");
const GATE_RESULT_PATH = resolve(EVIDENCE_DIR, "gate-result.json");
const PUBLISH_PATH = resolve(EVIDENCE_DIR, "publish.json");
const DRY_RUN_PUBLISH_PATH = resolve(EVIDENCE_DIR, "publish-dry-run.json");
const REPORT_PATH = resolve(EVIDENCE_DIR, "scan-report.zip");
const GATE_SCRIPT = resolve(REPO_ROOT, "scripts/clawhub-beta-gate.mjs");
const CLAWHUB_CLI_PIN = "0.23.3";
/** `--wait` and restorable version withdrawal only exist from this release on. */
const MIN_CLI_VERSION = "0.23.2";
const AUDIT_TAG = "audit";
const SECURITY_ENDPOINT = "https://clawhub.ai/api/v1/packages";
const DEFAULT_TIMEOUT_SECONDS = 2400;
const VERDICT_RETRY_COUNT = 5;
const VERDICT_RETRY_DELAY_MS = 6000;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// `console` is this CLI's output contract: stdout carries the audit result and
// stderr carries operator diagnostics. The runtime logger is a host-injected
// service that only exists inside the plugin runtime, not in standalone scripts.
const log = (message) => console.log(`[audit] ${message}`);
const warn = (message) => console.warn(`[audit] ${message}`);

function parseArgs(argv) {
  const options = {
    allowSuspicious: false,
    dryRun: false,
    help: false,
    sourceRef: "",
    sourceRepo: "",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    version: "",
    withdraw: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--allow-suspicious":
        options.allowSuspicious = true;
        break;
      case "--withdraw":
        options.withdraw = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
        options.version = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--timeout":
        options.timeoutSeconds = Number(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--source-repo":
        options.sourceRepo = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--source-ref":
        options.sourceRef = argv[index + 1] ?? "";
        index += 1;
        break;
      default:
        throw new Error(`未知参数：${flag}（用 --help 查看可用选项）`);
    }
  }

  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error("--timeout 必须是正整数秒数");
  }
  return options;
}

function printHelp() {
  console.log(`在本地工作树上跑一次 ClawHub beta 安全审计。

用法：
  node scripts/clawhub-audit-local.mjs [options]

选项：
  --version <v>        指定审计版本号（默认 <package.json version>-beta.<timestamp>）
  --allow-suspicious   让 suspicious 也能通过门禁（P2 人工放行）
  --withdraw           审计结束后撤回审计版本（默认保留，便于烟测）
  --timeout <seconds>  --wait 等待安全审计的时限（默认 ${DEFAULT_TIMEOUT_SECONDS}）
  --dry-run            只做本地打包预检，不上传、不产生版本
  --source-repo <r>    --source-repo 覆盖（默认从 git origin 推断）
  --source-ref <r>     --source-ref 覆盖（默认当前分支名）
  --help

前置条件：
  - 本机已登录 ClawHub，且账号对目标 publisher 有 publish 权限：npx clawhub@${CLAWHUB_CLI_PIN} login
  - 有 ClawHub CLI 可用：全局安装（npm i -g clawhub@${CLAWHUB_CLI_PIN}）或自动回退到 npx
`);
}

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function detectSourceRepo() {
  const remote = git(["remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[:/](?<repo>[^/]+\/[^/]+?)(?:\.git)?$/u);
  return match?.groups?.repo ?? "";
}

/** Compare dotted numeric versions; true when `version` is at least `minimum`. */
function isAtLeastVersion(version, minimum) {
  const parse = (value) =>
    String(value)
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(version);
  const right = parse(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const current = left[index] ?? 0;
    const required = right[index] ?? 0;
    if (current !== required) {
      return current > required;
    }
  }
  return true;
}

/** Read `clawhub --cli-version`; returns null when the probe fails or prints nothing usable. */
function probeCliVersion(bin, args) {
  const probe = spawnSync(bin, [...args, "--cli-version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (probe.error || probe.status !== 0) {
    return null;
  }
  const match = String(probe.stdout ?? "").match(/\d+\.\d+\.\d+/u);
  return match ? match[0] : null;
}

function resolveClawhubCommand() {
  const pinned = {
    args: ["--yes", `clawhub@${CLAWHUB_CLI_PIN}`],
    bin: "npx",
    label: `npx clawhub@${CLAWHUB_CLI_PIN}`,
  };

  // An explicitly configured CLI is honored only when it can actually run the
  // audit: older releases lack `--wait` and use different delete semantics, so
  // silently accepting one would make the local audit unreliable.
  if (process.env.CLAWHUB_CLI) {
    const explicit = { args: [], bin: process.env.CLAWHUB_CLI, label: process.env.CLAWHUB_CLI };
    const version = probeCliVersion(explicit.bin, explicit.args);
    if (!version || !isAtLeastVersion(version, MIN_CLI_VERSION)) {
      throw new Error(
        `CLAWHUB_CLI=${explicit.bin} 的版本为 ${version ?? "未知"}，低于审计所需的最低版本 ${MIN_CLI_VERSION}（--wait 与可撤回的版本删除语义从该版本开始提供）。`,
      );
    }
    return explicit;
  }

  const globalVersion = probeCliVersion("clawhub", []);
  if (globalVersion && isAtLeastVersion(globalVersion, MIN_CLI_VERSION)) {
    return { args: [], bin: "clawhub", label: `clawhub@${globalVersion}` };
  }
  if (globalVersion) {
    warn(`全局 clawhub@${globalVersion} 低于最低要求 ${MIN_CLI_VERSION}，改用 ${pinned.label}`);
  } else {
    warn(
      `未找到可用的全局 clawhub，回退到 ${pinned.label}（如需加速：npm i -g clawhub@${CLAWHUB_CLI_PIN}）`,
    );
  }
  return pinned;
}

function runClawhub(command, args, { capture = false } = {}) {
  const result = spawnSync(command.bin, [...command.args, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (result.error) {
    throw new Error(`无法执行 ${command.bin}：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command.bin} ${args.join(" ")} 退出码 ${result.status}`);
  }
  return capture ? (result.stdout ?? "") : "";
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function fetchVerdict(packageName, version) {
  const url = `${SECURITY_ENDPOINT}/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}/security`;
  let last = { ok: false, status: 0, text: "" };

  for (let attempt = 1; attempt <= VERDICT_RETRY_COUNT; attempt += 1) {
    last = await fetchJson(url);
    if (last.ok) {
      return { ...last, url };
    }
    log(
      `审计结论暂不可用（HTTP ${last.status}），${VERDICT_RETRY_DELAY_MS / 1000}s 后重试（${attempt}/${VERDICT_RETRY_COUNT}）`,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, VERDICT_RETRY_DELAY_MS));
  }
  return { ...last, url };
}

async function assertVersionUnused(packageName, version) {
  const url = `${SECURITY_ENDPOINT}/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}`;
  const response = await fetch(url);
  if (response.status !== 404) {
    throw new Error(
      `审计版本 ${version} 已存在（HTTP ${response.status}）。用 --version 指定一个没用过的版本号。`,
    );
  }
}

function evaluateGate(env) {
  const result = spawnSync(process.execPath, [GATE_SCRIPT, "verdict.json"], {
    cwd: EVIDENCE_DIR,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

  let gateResult = null;
  try {
    gateResult = readJson(GATE_RESULT_PATH);
  } catch {
    warn("未能读取 gate-result.json（门禁脚本未产出判定），按未通过处理。");
  }
  return { gateCode: result.status ?? 1, gateResult };
}

/** 由包名推断 ClawHub 审计页地址，作为响应未带 securityAuditUrl 时的兜底。 */
function fallbackAuditUrl(packageName, version) {
  const [scope, slug] = packageName.startsWith("@")
    ? packageName.slice(1).split("/")
    : ["", packageName];
  const owner = scope || "soimy";
  return `https://clawhub.ai/${owner}/plugins/${slug}/security-audit?version=${version}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  const packageJsonPath = resolve(REPO_ROOT, "package.json");
  const originalPackageJson = readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(originalPackageJson);
  const packageName = packageJson.name;
  const baseVersion = packageJson.version;
  const auditVersion = options.version || `${baseVersion}-beta.${Date.now()}`;
  const sourceRepo = options.sourceRepo || detectSourceRepo();
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const sourceRef = options.sourceRef || git(["rev-parse", "--abbrev-ref", "HEAD"], "HEAD");
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;

  const clawhub = resolveClawhubCommand();

  log(`ClawHub CLI：${clawhub.label}`);
  log(`包：${packageName}`);
  log(`基准版本：${baseVersion} → 审计版本：${auditVersion}`);
  log(`源码：${sourceRepo || "(未识别)"}@${sourceCommit.slice(0, 12)} (${sourceRef})`);
  if (dirty > 0) {
    warn(
      `工作树有 ${dirty} 项未提交改动：只有 package.json "files" 白名单内的内容会进包，但 --source-commit 仍指向 HEAD。`,
    );
  }
  if (baseVersion.includes("-")) {
    warn(
      `基准版本 ${baseVersion} 已是预发布版本，审计版本会变成 ${auditVersion}（仍是合法 semver）。`,
    );
  }

  if (!packageName || !baseVersion) {
    throw new Error("package.json 缺少 name 或 version");
  }
  if (!options.dryRun && !sourceRepo) {
    throw new Error("无法从 git origin 推断 --source-repo，code-plugin 发布必填，请显式传入。");
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true });

  log("构建运行时产物…");
  execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

  if (!options.dryRun) {
    log("检查审计版本号是否可用…");
    await assertVersionUnused(packageName, auditVersion);
  }

  let gateCode = 0;
  try {
    log(`写入审计版本号（仅在本地工作树，结束后自动还原）…`);
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify({ ...packageJson, version: auditVersion }, null, 2)}\n`,
      "utf8",
    );

    const publishArgs = [
      "package",
      "publish",
      ".",
      "--tags",
      AUDIT_TAG,
      "--source-repo",
      sourceRepo,
      "--source-commit",
      sourceCommit,
      "--source-ref",
      sourceRef,
      "--source-path",
      ".",
      "--json",
    ];

    if (options.dryRun) {
      log("打包预检（--dry-run，不上传）…");
      const output = runClawhub(clawhub, [...publishArgs, "--dry-run"], { capture: true });
      writeFileSync(DRY_RUN_PUBLISH_PATH, output, "utf8");
      console.log(output);
      log("预检完成：未上传任何版本。去掉 --dry-run 即会真实发布审计版本。");
      return 0;
    }

    log(`发布审计版本并等待 ClawHub 安全审计（最多 ${options.timeoutSeconds}s）…`);
    let publishFailed = false;
    try {
      const publishOutput = runClawhub(
        clawhub,
        [...publishArgs, "--wait", "--wait-timeout", String(options.timeoutSeconds)],
        { capture: true },
      );
      writeFileSync(PUBLISH_PATH, publishOutput, "utf8");
      console.log(publishOutput);
      log(`ClawHub 已接受 ${packageName}@${auditVersion}（dist-tag: ${AUDIT_TAG}）。`);
    } catch (error) {
      publishFailed = true;
      warn(`${error.message}`);
      warn("发布未成功；仍会尝试拉取该版本的审计结论，用于定位被拦截的原因。");
    }

    log("拉取审计结论…");
    const verdict = await fetchVerdict(packageName, auditVersion);
    writeFileSync(VERDICT_PATH, verdict.text, "utf8");
    log(`GET /security → HTTP ${verdict.status}`);

    log("按 P2 策略判定…");
    const evaluation = evaluateGate({
      ALLOW_SUSPICIOUS: options.allowSuspicious ? "1" : "0",
      AUDIT_MODE: "manual",
      BETA_VERSION: auditVersion,
      PACKAGE_NAME: packageName,
    });
    gateCode = publishFailed ? 1 : evaluation.gateCode;

    log("下载审计报告…");
    const download = spawnSync(
      clawhub.bin,
      [
        ...clawhub.args,
        "scan",
        "download",
        packageName,
        "--version",
        auditVersion,
        "--kind",
        "plugin",
        "--output",
        REPORT_PATH,
      ],
      { cwd: REPO_ROOT, stdio: "inherit" },
    );
    if (download.status !== 0) {
      warn("审计报告下载失败（审计版本可能仍被安全流程拦截）；其余结果不受影响。");
    }

    const auditUrl =
      evaluation.gateResult?.securityAuditUrl || fallbackAuditUrl(packageName, auditVersion);
    console.log("");
    log(
      `审计结论：${evaluation.gateResult?.decision ?? "unknown"}（scanStatus=${evaluation.gateResult?.scanStatus ?? "?"}）`,
    );
    log(`审计页：${auditUrl}`);
    log(
      `证据目录：.clawhub-audit/（publish.json / verdict.json / gate-result.json${download.status === 0 ? " / scan-report.zip" : ""}）`,
    );
    log(`烟测：openclaw plugins install clawhub:${packageName}@${auditVersion}`);

    if (options.withdraw) {
      log("撤回审计版本…");
      const withdraw = spawnSync(
        clawhub.bin,
        [
          ...clawhub.args,
          "package",
          "delete",
          packageName,
          "--version",
          auditVersion,
          "--yes",
          "--json",
        ],
        { cwd: REPO_ROOT, stdio: "inherit" },
      );
      if (withdraw.status !== 0) {
        warn(
          `撤回失败：请手动执行 clawhub package delete ${packageName} --version ${auditVersion} --yes`,
        );
      } else {
        log(
          `已撤回 ${packageName}@${auditVersion}（版本号保留，可用 clawhub package undelete 恢复）。`,
        );
      }
    } else {
      log("审计版本已保留（dist-tag: audit）。审计完成后可手动撤回：");
      log(`  clawhub package delete ${packageName} --version ${auditVersion} --yes`);
    }

    return gateCode;
  } finally {
    writeFileSync(packageJsonPath, originalPackageJson, "utf8");
    log("package.json 版本号已还原。");
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[audit] 失败：${error.message}`);
    process.exitCode = 1;
  });
