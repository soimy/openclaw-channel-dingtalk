import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// `console` is this CLI's output contract: the terminal state goes to stdout for
// the workflow to capture, and progress goes to stderr so stdout stays one word.

/**
 * 解析 ClawHub 某个精确版本的发布状态，并等待到终态。
 *
 * 为什么需要它：`wait_for_publication` 超时只会让 workflow 失败，**不会取消服务端的
 * publication attempt**。此时 `GET /versions/{version}` 仍可能是 404，但版本可能在本
 * 次运行结束之后才真正发布 —— 审计的临时版本就会逃逸自动撤回。
 * `GET /versions/{version}/publication` 能区分 absent / pending / published / failed，
 * 所以"要不要撤回"必须以它为准，不能拿版本端点的 404 当"从未创建"。
 *
 * 输入（环境变量）：
 * - `PACKAGE_NAME` / `BETA_VERSION`：待判定的包名与版本
 * - `CLAWHUB_SITE`：站点地址，默认 https://clawhub.ai
 * - `PUBLICATION_TIMEOUT_SECONDS`：等待终态的上限，默认 900
 * - `PUBLICATION_POLL_SECONDS`：轮询间隔，默认 15
 *
 * 输出：
 * - stdout：终态（`published` / `absent` / `failed`），供 shell 捕获
 * - `publication-state.json`：完整采样记录，供 CI 归档
 * - 退出码：0 = 到达终态；1 = 超时仍 pending / 未知状态 / 端点不可用（fail-closed）
 */

/** publication 端点的新状态集合；未知取值一律 fail-closed。 */
const KNOWN_STATES = new Set(["absent", "pending", "published", "failed"]);

const site = (process.env.CLAWHUB_SITE?.trim() || "https://clawhub.ai").replace(/\/+$/, "");
const packageName = process.env.PACKAGE_NAME?.trim() || "";
const version = process.env.BETA_VERSION?.trim() || "";
const timeoutSeconds = Number(process.env.PUBLICATION_TIMEOUT_SECONDS ?? "900");
const pollSeconds = Number(process.env.PUBLICATION_POLL_SECONDS ?? "15");

const evidencePath = "publication-state.json";

const log = (message) => console.error(`[ClawHub publication] ${message}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一次 GET。用 `node:http(s)` 而不是 `fetch`：全局 undici 会把连接留在 keep-alive
 * 池里，脚本打印完状态后还要等几秒才退出；`agent: false` 用完即关，进程立刻结束。
 */
const requestJson = (url) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "http:" ? httpRequest : httpsRequest;
    const request = send(
      target,
      { headers: { accept: "application/json" }, agent: false, timeout: 20_000 },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("请求超时")));
    request.on("error", reject);
    request.end();
  });

/**
 * 读取一次发布状态。契约来自上游 `docs/http-api.md`：
 * - publication 端点 200 且带 `state` → 以此为准
 * - 老服务端可能在该路径返回 404 或普通 version JSON → 回退 version 端点
 *   （200 = published，404 = absent）
 * - 其它非 2xx → 抛错，交给调用方按重试处理
 */
const readState = async () => {
  const encodedPackage = encodeURIComponent(packageName);
  const base = `${site}/api/v1/packages/${encodedPackage}/versions/${version}`;
  const publication = await requestJson(`${base}/publication`);

  if (publication.status === 200 && typeof publication.body?.state === "string") {
    const state = publication.body.state;
    if (!KNOWN_STATES.has(state)) {
      throw new Error(`publication 端点返回未知状态 ${JSON.stringify(state)}，按 fail-closed 处理`);
    }
    return {
      state,
      stage: typeof publication.body.stage === "string" ? publication.body.stage : null,
      attemptId: typeof publication.body.attemptId === "string" ? publication.body.attemptId : null,
      source: "publication",
    };
  }

  if (publication.status === 200 || publication.status === 404) {
    const fallback = await requestJson(base);
    if (fallback.status === 200) {
      return { state: "published", stage: null, attemptId: null, source: "version-fallback" };
    }
    if (fallback.status === 404) {
      return { state: "absent", stage: null, attemptId: null, source: "version-fallback" };
    }
    throw new Error(`version 端点返回 HTTP ${fallback.status}，无法判定发布状态`);
  }

  throw new Error(`publication 端点返回 HTTP ${publication.status}，无法判定发布状态`);
};

const main = async () => {
  if (!packageName || !version) {
    throw new Error("PACKAGE_NAME 与 BETA_VERSION 都必须设置");
  }
  for (const [name, value] of [
    ["PUBLICATION_TIMEOUT_SECONDS", timeoutSeconds],
    ["PUBLICATION_POLL_SECONDS", pollSeconds],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} 必须是正数（实际：${value}）`);
    }
  }

  log(`${packageName}@${version} 等待终态（上限 ${timeoutSeconds}s，间隔 ${pollSeconds}s）`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  const samples = [];
  let settled = null;
  let lastError = null;

  while (!settled) {
    try {
      const sample = await readState();
      samples.push({ ...sample, checkedAt: new Date().toISOString() });
      log(
        `state=${sample.state}${sample.stage ? ` stage=${sample.stage}` : ""} (${sample.source})`,
      );
      if (sample.state !== "pending") {
        settled = sample;
      }
    } catch (error) {
      lastError = error;
      log(`读取失败：${error.message}`);
    }
    if (settled || Date.now() >= deadline) {
      break;
    }
    await sleep(pollSeconds * 1000);
  }

  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        packageName,
        version,
        state: settled?.state ?? "pending",
        settled: settled !== null,
        samples,
        lastError: lastError?.message ?? null,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (!settled) {
    // 超时或端点一直不可用：既不能当作"没发布过"静默结束，也不能在这里盲目撤回
    // （pending 时删除会失败）。留下证据并让运行失败，由人工确认后再清理。
    const last = samples.at(-1);
    const detail = last?.attemptId
      ? `（attemptId=${last.attemptId}）`
      : last?.stage
        ? `（stage=${last.stage}）`
        : lastError
          ? `（最后一次读取失败：${lastError.message}）`
          : "";
    throw new Error(
      `等待 ${timeoutSeconds}s 后仍未进入终态${detail}：服务端 publication attempt 不会随 workflow 结束而取消，` +
        `该版本仍可能稍后发布。确认状态后手动清理：clawhub package delete ${packageName} --version ${version} --yes`,
    );
  }

  console.log(settled.state);
};

try {
  await main();
} catch (error) {
  log(error.message);
  process.exitCode = 1;
}
