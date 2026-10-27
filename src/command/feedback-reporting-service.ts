import { opendir, unlink, stat, readFile } from "node:fs/promises";
import { freemem } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getConfig, listDingTalkAccountIds } from "../platform/config";
import { resolveSecretInputString } from "../platform/secret-input";
import { resolveNamespacePath } from "../shared/persistence-store";
import { stopFeedbackDetailReads } from "./feedback-detail-reader";
import {
  resolveFeedbackReporting,
  type ResolvedFeedbackReporting,
} from "./feedback-reporting-config";
import { onFeedbackReportPending, onFeedbackForegroundActivity } from "./feedback-reporting-events";
import { readSmallJson, reportPaths, writeReportJson } from "./feedback-reporting-io";
import {
  REPORT_MAINTENANCE_VERSION,
  type ReportJob,
  type ReportReceipt,
  type ReportResult,
} from "./feedback-reporting-protocol";
import { FeedbackRetryIndex } from "./feedback-reporting-retry-index";
import type { FeedbackRecord, FeedbackScope } from "./feedback-store";

type Account = { scope: FeedbackScope; config: ResolvedFeedbackReporting };
type Pending = {
  account: Account;
  cardId: string;
  due: number;
  failures: number;
  generation: number;
  eventHint: boolean;
};
type Retry = Omit<Pending, "generation">;
const MAX_QUEUE = 128;
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
const queueKey = (scope: FeedbackScope, id: string) =>
  JSON.stringify([scope.storePath, scope.accountId, id]);

export class FeedbackReportingService {
  private readonly queue = new Map<string, Pending>();
  private readonly retries = new FeedbackRetryIndex<Retry>();
  private readonly activeRuns = new Set<string>();
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private lagSampling = false;
  private timer?: NodeJS.Timeout;
  private timerAt = 0;
  private ticking = false;
  private worker?: Worker;
  private workerIdleTimer?: NodeJS.Timeout;
  private workerBudgetMb?: number;
  private stopped = true;
  private processing = false;
  private scanning = false;
  private scanAbort = new AbortController();
  private scanTask?: Promise<void>;
  private processingTask?: Promise<void>;
  private needsScan = true;
  private scanAt = 0;
  private quietAfter = 0;
  private unsubscribe?: () => void;
  private unsubscribeAgent?: () => void;
  private unsubscribeActivity?: () => void;
  private readonly accounts: Account[];
  private readonly tokens = new Map<string, { value: string; until: number }>();
  private pressureAt = 0;
  private cachedPressure = false;
  private resourcePaused = false;
  private throttled = 0;
  private pressureInitialized = false;
  private counters = {
    delivered: 0,
    superseded: 0,
    deferred: 0,
    failures: 0,
    workersStarted: 0,
    scansStarted: 0,
  };

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly options: {
      startupDelayMs?: number;
      tickMs?: number;
      scanPauseMs?: number;
      taskTimeoutMs?: number;
      workerUrl?: URL;
      now?: () => number;
    } = {},
  ) {
    this.accounts = (
      listDingTalkAccountIds(api.config).length ? listDingTalkAccountIds(api.config) : ["default"]
    ).flatMap((accountId) => {
      try {
        const channel = getConfig(api.config, accountId);
        if (!channel.feedbackEnabled || channel.enabled === false) {
          return [];
        }
        const config = resolveFeedbackReporting(channel.feedbackReporting);
        return config
          ? [
              {
                config,
                scope: {
                  accountId,
                  storePath: api.runtime.channel.session.resolveStorePath(
                    api.config.session?.store,
                    { agentId: accountId },
                  ),
                },
              },
            ]
          : [];
      } catch {
        api.logger.warn(
          `[DingTalk][FeedbackReport] account=${accountId} reporting configuration unavailable; channel remains enabled`,
        );
        return [];
      }
    });
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  start(): void {
    if (!this.stopped || !this.accounts.length) {
      return;
    }
    this.stopped = false;
    this.scanAbort = new AbortController();
    this.needsScan = true;
    this.scanAt = this.now() + (this.options.startupDelayMs ?? 30_000 + Math.random() * 60_000);
    this.quietAfter = this.now() + Math.max(...this.accounts.map((a) => a.config.idleMs));
    this.unsubscribe = onFeedbackReportPending((scope, cardId) => {
      const account = this.accounts.find(
        (a) => a.scope.accountId === scope.accountId && a.scope.storePath === scope.storePath,
      );
      if (account) {
        this.enqueue(account, cardId, this.now() + account.config.idleMs);
      }
    });
    this.unsubscribeActivity = onFeedbackForegroundActivity((id, active) =>
      this.setForeground(id, active),
    );
    this.unsubscribeAgent = this.api.runtime.events?.onAgentEvent?.((event) => {
      if (event.stream !== "lifecycle") {
        return;
      }
      if (event.data.phase === "start") {
        void this.setForeground(event.runId, true);
      } else if (["end", "error", "aborted"].includes(String(event.data.phase))) {
        void this.setForeground(event.runId, false);
      }
    });
    this.schedule();
  }
  /** Public for deterministic resource/foreground acceptance probes. No transcript data. */
  setForeground(runId: string, active: boolean): Promise<void> | undefined {
    let release: Promise<void> | undefined;
    if (active) {
      // Track every admitted operation until its end. Dropping identities at a
      // threshold can resume reporting while overflow callbacks are still busy.
      this.activeRuns.add(runId);
    } else if (!active) {
      this.activeRuns.delete(runId);
    }
    this.quietAfter = this.now() + Math.max(...this.accounts.map((a) => a.config.idleMs), 1000);
    if (active && this.worker) {
      release = this.worker.terminate().then(() => undefined);
      void release.catch(() =>
        this.api.logger.warn("[DingTalk][FeedbackReport] worker termination failed"),
      );
    }
    if (active) {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = undefined;
      this.lag.disable();
      this.lagSampling = false;
    } else {
      this.wake();
    }
    return release;
  }
  status() {
    return {
      ...this.counters,
      queued: this.queue.size,
      delayed: this.retries.size,
      nextRetryAt: this.retries.nextDue(),
      recoveryScheduled: this.needsScan,
      nextRecoveryAt: this.needsScan ? this.scanAt : undefined,
      scanning: this.scanning,
      workerActive: this.processing && Boolean(this.worker),
      workerResident: Boolean(this.worker),
      foregroundRuns: this.activeRuns.size,
      timerScheduled: Boolean(this.timer),
    };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.scanAbort.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribeAgent?.();
    this.unsubscribeActivity?.();
    this.lag.disable();
    this.lagSampling = false;
    if (this.worker) {
      await this.worker.terminate();
    }
    if (this.workerIdleTimer) {
      clearTimeout(this.workerIdleTimer);
    }
    await Promise.all([this.processingTask, this.scanTask]);
    this.tokens.clear();
    this.queue.clear();
    this.retries.clear();
    this.activeRuns.clear();
  }
  private wake(): void {
    const tick = this.options.tickMs ?? 1000;
    if (this.timer && this.timerAt > this.now() + tick) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped || this.timer || this.ticking || this.activeRuns.size) {
      return;
    }
    if (!this.queue.size && !this.retries.size && !this.needsScan && !this.scanning) {
      this.lag.disable();
      this.lagSampling = false;
      return;
    }
    const tick = this.options.tickMs ?? 1000;
    let delay = tick;
    if (!this.processing) {
      const earliest = this.scanning
        ? this.now()
        : Math.min(
            this.needsScan ? this.scanAt : Infinity,
            this.retries.nextDue() ?? Infinity,
            ...[...this.queue.values()].map((p) => p.due),
          );
      delay = Math.max(tick, Math.min(60000, Math.max(earliest, this.quietAfter) - this.now()));
    }
    if (delay > tick) {
      this.lag.disable();
      this.lagSampling = false;
    } else {
      this.lag.enable();
      this.lagSampling = true;
    }
    this.timerAt = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ticking = true;
      void this.tick()
        .catch(() =>
          this.api.logger.warn("[DingTalk][FeedbackReport] scheduler deferred after local failure"),
        )
        .finally(() => {
          this.ticking = false;
          this.schedule();
        });
    }, delay);
    this.timer.unref();
  }
  private busy(): boolean {
    return this.stopped || this.activeRuns.size > 0 || this.now() < this.quietAfter;
  }
  private requestScan(at: number): void {
    if (this.stopped) {
      return;
    }
    this.scanAt = this.needsScan ? Math.min(this.scanAt, at) : at;
    this.needsScan = true;
    this.wake();
  }
  private enqueue(
    account: Account,
    cardId: string,
    due: number,
    eventHint = true,
    failures = 0,
  ): void {
    const key = queueKey(account.scope, cardId);
    const old = this.queue.get(key);
    if (old) {
      if (eventHint) {
        old.generation++;
        old.eventHint = true;
        old.failures = 0;
        old.due = Math.min(old.due, due);
        this.wake();
      }
      return;
    }
    if (this.queue.size >= MAX_QUEUE) {
      const retry = this.retries.get(key);
      if (eventHint && retry) {
        // A new vote must override the old receipt's backoff even if admission is full.
        this.retries.set(key, {
          ...retry,
          due: Math.min(retry.due, due),
          eventHint: true,
          failures: 0,
        });
        this.wake();
        return;
      }
      this.requestScan(this.now());
      return;
    }
    this.retries.delete(key);
    this.queue.set(key, { account, cardId, due, failures, generation: 0, eventHint });
    this.wake();
  }
  private rememberRetry(retry: Retry): void {
    if (this.stopped) {
      return;
    }
    const key = queueKey(retry.account.scope, retry.cardId);
    // A scan may finish reading an older receipt after a newer vote has arrived.
    if (this.queue.has(key) || this.retries.get(key)?.eventHint) {
      return;
    }
    const overflow = this.retries.set(key, retry);
    if (overflow) {
      this.requestScan(overflow.due);
    }
    this.wake();
  }
  /** Receipts persist retries; bounded hints avoid rescanning history for known deadlines. */
  private releaseForRecovery(key: string, pending: Pending, generation: number, due: number): void {
    if (this.queue.get(key) !== pending) {
      return;
    }
    if (pending.generation !== generation) {
      pending.due = this.now() + pending.account.config.idleMs;
      this.wake();
      return;
    }
    this.queue.delete(key);
    this.rememberRetry({
      account: pending.account,
      cardId: pending.cardId,
      due,
      failures: pending.failures,
      eventHint: false,
    });
  }
  private async deferFailure(
    key: string,
    pending: Pending,
    generation: number,
    record: FeedbackRecord,
    delay: number,
    error: string,
  ): Promise<void> {
    const paths = reportPaths(
      pending.account.scope,
      pending.cardId,
      pending.account.config.destinationKey,
    );
    const previous = await readSmallJson<ReportReceipt>(paths.receipt, 4096).catch(() => undefined);
    const sameSource = previous?.sourceRevision === record.reporting?.revision;
    const receipt: ReportReceipt = {
      sourceRevision: record.reporting!.revision,
      wireRevision: previous?.wireRevision ?? 0,
      terminal: false,
      nextAttemptAt: this.now() + delay,
      expiresAt: Math.max(record.expiresAt, record.reporting!.retainUntil),
      attempts: sameSource ? (previous?.attempts ?? 0) : 0,
      workerFailures: pending.failures,
      maintenanceVersion: sameSource ? previous?.maintenanceVersion : undefined,
      error,
    };
    // runWorker has settled (and terminated failed workers) before this write;
    // it is safe to publish a small retry receipt without touching its outbox.
    await writeReportJson(paths.receipt, receipt);
    this.releaseForRecovery(key, pending, generation, receipt.nextAttemptAt);
  }
  private async systemPressure(): Promise<boolean> {
    if (this.now() < this.pressureAt) {
      return this.cachedPressure;
    }
    this.pressureAt = this.now() + 5000;
    // Modern hosts can legitimately exceed 1 GiB RSS while the machine still
    // has ample reclaimable memory. Reserve headroom for the configured worker
    // instead of permanently starving reports because the host itself is large.
    const available =
      typeof process.availableMemory === "function" ? process.availableMemory() : freemem();
    const reserve =
      Math.max(256, ...this.accounts.map((a) => a.config.workerMemoryMb * 2)) * 1048576;
    const headroomLow = available < reserve;
    if (process.platform !== "linux") {
      return (this.cachedPressure = headroomLow);
    }
    try {
      // Sequential tiny reads leave the shared libuv pool available to foreground I/O.
      const current = await readFile("/sys/fs/cgroup/memory.current", "utf8");
      const maximum = await readFile("/sys/fs/cgroup/memory.max", "utf8");
      const cpu = await readFile("/sys/fs/cgroup/cpu.stat", "utf8");
      const pressure = await readFile("/sys/fs/cgroup/cpu.pressure", "utf8").catch(() => "");
      const capped = maximum.trim() !== "max" && Number(current) > Number(maximum) * 0.8;
      const throttled = Number(/nr_throttled\s+(\d+)/.exec(cpu)?.[1] ?? 0);
      const changed = this.pressureInitialized && throttled > this.throttled;
      this.pressureInitialized = true;
      this.throttled = throttled;
      const waiting = Number(/some avg10=([0-9.]+)/.exec(pressure)?.[1] ?? 0) > 10;
      return (this.cachedPressure = headroomLow || capped || changed || waiting);
    } catch {
      return (this.cachedPressure = headroomLow);
    }
  }
  private accountStillEnabled(account: Account): boolean {
    try {
      const current = (this.api.runtime.config?.current?.() ?? this.api.config) as OpenClawConfig;
      const channel = getConfig(current, account.scope.accountId);
      const reporting = resolveFeedbackReporting(channel.feedbackReporting);
      return (
        channel.enabled !== false &&
        Boolean(channel.feedbackEnabled) &&
        reporting?.destinationKey === account.config.destinationKey
      );
    } catch {
      return false;
    }
  }
  private async tick(): Promise<void> {
    if (
      this.stopped ||
      this.activeRuns.size ||
      (!this.processing && this.now() < this.quietAfter)
    ) {
      this.lag.reset();
      return;
    }
    if (!this.accounts.some((account) => this.accountStillEnabled(account))) {
      await this.stop();
      return;
    }
    if (!this.lagSampling) {
      // A sleeping histogram has no evidence of recovery. Observe a full tick
      // before restarting I/O, otherwise sustained pressure can slip through
      // every cooldown and repeatedly start/kill workers.
      this.lag.reset();
      this.lag.enable();
      this.lagSampling = true;
      return;
    }
    const stalled = this.lag.max / 1e6 > 50;
    this.lag.reset();
    const memoryHigh = await this.systemPressure();
    if (stalled || memoryHigh) {
      if (!this.resourcePaused) {
        this.api.logger.info("[DingTalk][FeedbackReport] paused for local resource pressure");
        this.resourcePaused = true;
      }
      this.quietAfter = this.now() + 5000;
      if (this.worker) {
        void this.worker.terminate();
      }
    }
    if (this.busy()) {
      return;
    }
    if (this.resourcePaused) {
      this.api.logger.info("[DingTalk][FeedbackReport] resuming after resource pressure");
      this.resourcePaused = false;
    }
    if (!this.processing && this.queue.size < MAX_QUEUE) {
      // Admit one due retry per dispatch, leaving room for fresh evaluation hints.
      const retry = this.retries.takeDue(this.now());
      if (retry) {
        this.enqueue(retry.account, retry.cardId, retry.due, retry.eventHint, retry.failures);
      }
    }
    if (this.needsScan && !this.scanning && this.now() >= this.scanAt) {
      this.needsScan = false;
      this.scanTask = this.scan()
        .catch(() => this.requestScan(this.now() + 60_000))
        .finally(() => {
          this.scanTask = undefined;
        });
    }
    if (this.processing) {
      return;
    }
    const candidate = [...this.queue.entries()].find(([, p]) => p.due <= this.now());
    if (!candidate) {
      return;
    }
    this.processing = true;
    const processingGeneration = candidate[1].generation;
    // Do not await the worker in the timer: pressure monitoring must continue
    // while it is reading or waiting for a receiver.
    this.processingTask = this.process(candidate[0], candidate[1])
      .catch(() => {
        this.releaseForRecovery(
          candidate[0],
          candidate[1],
          processingGeneration,
          this.now() + 300_000,
        );
        this.api.logger.warn("[DingTalk][FeedbackReport] job deferred after local failure");
      })
      .finally(() => {
        this.processing = false;
        this.processingTask = undefined;
        this.wake();
      });
  }
  private async scan(): Promise<void> {
    this.scanning = true;
    this.counters.scansStarted++;
    try {
      for (const account of this.accounts) {
        if (!this.accountStillEnabled(account)) {
          continue;
        }
        const base = resolveNamespacePath("feedback.ratings", {
          storePath: account.scope.storePath,
          scope: { accountId: account.scope.accountId },
        });
        const directory = path.dirname(base);
        const prefix = `${path.basename(base, ".json")}.target-`;
        let dir;
        try {
          dir = await opendir(directory);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw e;
        }
        for await (const entry of dir) {
          if (this.stopped) {
            break;
          }
          while (!this.stopped && (this.busy() || this.queue.size >= MAX_QUEUE)) {
            await pause(250, this.scanAbort.signal);
          }
          if (this.stopped) {
            break;
          }
          if (entry.name.startsWith(prefix) && entry.name.endsWith(".json")) {
            try {
              const record = await readSmallJson<FeedbackRecord>(path.join(directory, entry.name));
              if (
                record?.reporting?.destinationKey === account.config.destinationKey &&
                Math.max(record.expiresAt, record.reporting.retainUntil) > this.now()
              ) {
                const receipt = await readSmallJson<ReportReceipt>(
                  reportPaths(account.scope, record.outTrackId, account.config.destinationKey)
                    .receipt,
                  4096,
                );
                const current = receipt?.sourceRevision === record.reporting.revision;
                const complete =
                  current &&
                  receipt?.terminal &&
                  receipt.maintenanceVersion === REPORT_MAINTENANCE_VERSION;
                if (!complete) {
                  const due =
                    current && !receipt?.terminal
                      ? receipt?.nextAttemptAt || this.now()
                      : this.now();
                  if (due > this.now()) {
                    this.rememberRetry({
                      account,
                      cardId: record.outTrackId,
                      due,
                      failures: current ? (receipt?.workerFailures ?? 0) : 0,
                      eventHint: false,
                    });
                  } else {
                    this.enqueue(
                      account,
                      record.outTrackId,
                      due,
                      false,
                      current ? (receipt?.workerFailures ?? 0) : 0,
                    );
                  }
                }
              }
            } catch {
              this.requestScan(this.now() + 300_000);
              this.api.logger.warn(
                "[DingTalk][FeedbackReport] unreadable or oversized rating metadata skipped",
              );
            }
          } else if (entry.name.startsWith("feedback.report.") && entry.name.endsWith(".tmp")) {
            const file = path.join(directory, entry.name);
            const info = await stat(file).catch(() => undefined);
            if (info && info.mtimeMs < this.now() - 86400000) {
              await unlink(file).catch(() => undefined);
            }
          } else if (
            entry.name.startsWith("feedback.report.") &&
            entry.name.endsWith(".receipt.json")
          ) {
            const file = path.join(directory, entry.name);
            const receipt = await readSmallJson<ReportReceipt>(file, 4096).catch(() => undefined);
            if (receipt && receipt.expiresAt < this.now()) {
              await unlink(file.replace(/\.receipt\.json$/, ".json")).catch(() => undefined);
              await unlink(file).catch(() => undefined);
            }
          }
          await pause(this.options.scanPauseMs ?? 100, this.scanAbort.signal);
        }
      }
    } finally {
      this.scanning = false;
      this.wake();
      // No repeating whole-directory polling. New votes provide hints; overflow or
      // restart causes bounded recovery. A later restart also reclaims expired outboxes.
    }
  }
  private async process(key: string, pending: Pending): Promise<void> {
    const { account, cardId } = pending;
    const generation = pending.generation;
    if (!this.accountStillEnabled(account)) {
      this.queue.delete(key);
      return;
    }
    const { feedbackRecordPath } = await import("./feedback-store");
    let record: FeedbackRecord | undefined;
    try {
      record = await readSmallJson<FeedbackRecord>(feedbackRecordPath(account.scope, cardId));
    } catch {
      this.releaseForRecovery(key, pending, generation, this.now() + 300_000);
      return;
    }
    if (
      !record?.reporting ||
      record.accountId !== account.scope.accountId ||
      record.outTrackId !== cardId ||
      record.reporting.destinationKey !== account.config.destinationKey ||
      Math.max(record.expiresAt, record.reporting.retainUntil) <= this.now()
    ) {
      this.queue.delete(key);
      return;
    }
    if (this.busy()) {
      return;
    }
    if (!pending.eventHint) {
      const receipt = await readSmallJson<ReportReceipt>(
        reportPaths(account.scope, cardId, account.config.destinationKey).receipt,
        4096,
      );
      if (receipt?.sourceRevision === record.reporting.revision) {
        if (receipt.terminal && receipt.maintenanceVersion === REPORT_MAINTENANCE_VERSION) {
          this.queue.delete(key);
          return;
        }
        if (!receipt.terminal && receipt.nextAttemptAt > this.now()) {
          this.releaseForRecovery(key, pending, generation, receipt.nextAttemptAt);
          return;
        }
        pending.failures = receipt.workerFailures ?? 0;
      }
    }
    const tokenKey = `${account.scope.accountId}:${account.config.destinationKey}`;
    let token =
      this.tokens.get(tokenKey)?.until && this.tokens.get(tokenKey)!.until > this.now()
        ? this.tokens.get(tokenKey)!.value
        : undefined;
    if (!token) {
      token = await resolveSecretInputString(account.config.token, undefined, this.api.config);
      if (!token) {
        await this.deferFailure(
          key,
          pending,
          generation,
          record,
          300_000,
          "authentication_unavailable",
        );
        this.api.logger.warn("[DingTalk][FeedbackReport] authentication configuration unavailable");
        return;
      }
      this.tokens.set(tokenKey, { value: token, until: this.now() + 600_000 });
    }
    if (this.busy()) {
      return;
    }
    const { history: _history, seen: _seen, ...projection } = record;
    const { token: _token, ...config } = account.config;
    const job: ReportJob = {
      scope: account.scope,
      record: projection,
      config,
      token,
      transcriptStorePath: this.api.runtime.channel.session.resolveStorePath(
        this.api.config.session?.store,
        { agentId: record.agentId },
      ),
      metadataOnly: pending.failures >= 2,
    };
    let result: ReportResult;
    try {
      result = await this.runWorker(job);
    } catch {
      if (this.busy()) {
        this.counters.deferred++;
        pending.due = this.now() + config.idleMs;
        return;
      }
      pending.failures++;
      this.counters.failures++;
      await this.deferFailure(
        key,
        pending,
        generation,
        record,
        Math.min(300_000, 5000 * 2 ** Math.min(pending.failures, 6)),
        "worker_failed",
      );
      this.api.logger.warn(
        "[DingTalk][FeedbackReport] bounded worker failed; durable record retained for retry",
      );
      return;
    }
    if (result.kind === "error") {
      pending.failures++;
      await this.deferFailure(key, pending, generation, record, 300_000, result.code);
      this.counters.failures++;
      return;
    }
    pending.failures = 0;
    const latest = await readSmallJson<FeedbackRecord>(feedbackRecordPath(account.scope, cardId));
    if (
      pending.generation !== generation ||
      latest?.reporting?.revision !== result.receipt.sourceRevision
    ) {
      pending.due = this.now() + config.idleMs;
      return;
    }
    if (result.receipt.terminal) {
      this.queue.delete(key);
      if (result.receipt.superseded) {
        this.counters.superseded++;
      } else {
        this.counters.delivered++;
      }
      this.api.logger.info(
        `[DingTalk][FeedbackReport] ${result.receipt.superseded ? "superseded" : "saved"} card=${cardId} revision=${result.receipt.wireRevision}`,
      );
    } else {
      this.releaseForRecovery(
        key,
        pending,
        generation,
        result.receipt.nextAttemptAt || this.now() + 300_000,
      );
      if (result.receipt.error) {
        this.counters.failures++;
        this.tokens.delete(tokenKey);
      } else {
        this.counters.deferred++;
      }
      this.api.logger.info(
        `[DingTalk][FeedbackReport] pending card=${cardId} reason=${result.receipt.error ?? "content_deferred"}`,
      );
    }
  }
  private async runWorker(job: ReportJob): Promise<ReportResult> {
    if (this.workerIdleTimer) {
      clearTimeout(this.workerIdleTimer);
    }
    if (this.worker && this.workerBudgetMb !== job.config.workerMemoryMb) {
      const old = this.worker;
      await old.terminate();
      if (this.worker === old) {
        this.worker = undefined;
      }
    }
    // Foreground activity or shutdown may arrive while the previous isolate exits.
    if (this.busy()) {
      throw new Error("worker_deferred");
    }
    if (!this.worker) {
      this.counters.workersStarted++;
      const created = new Worker(
        this.options.workerUrl ?? new URL("./feedback-reporting-worker.js", import.meta.url),
        {
          workerData: { kind: "dingtalk-feedback-report" },
          execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: job.config.workerMemoryMb,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        },
      );
      created.on("error", () => {
        /* Each active job also observes failures. */
      });
      created.once("exit", () => {
        if (this.worker === created) {
          this.worker = undefined;
        }
      });
      this.worker = created;
      this.workerBudgetMb = job.config.workerMemoryMb;
    }
    const worker = this.worker;
    if ((worker.resourceLimits?.maxOldGenerationSizeMb ?? Infinity) > job.config.workerMemoryMb) {
      await worker.terminate();
      if (this.worker === worker) {
        this.worker = undefined;
      }
      throw new Error("worker_heap_budget_overridden");
    }
    let settled = false;
    try {
      const result = await new Promise<ReportResult>((resolve, reject) => {
        const deadline = setTimeout(() => {
          void worker.terminate();
          reject(new Error("worker_budget"));
        }, this.options.taskTimeoutMs ?? 20_000);
        const finish = () => {
          clearTimeout(deadline);
          worker.off("message", message);
          worker.off("error", error);
          worker.off("exit", exit);
        };
        const message = (result: ReportResult) => {
          finish();
          resolve(result);
        };
        const error = (failure: Error) => {
          finish();
          reject(failure);
        };
        const exit = () => {
          finish();
          reject(new Error("worker_stopped"));
        };
        worker.once("message", message);
        worker.once("error", error);
        worker.once("exit", exit);
        worker.postMessage({ kind: "job", job });
      });
      settled = true;
      return result;
    } finally {
      if (!settled || this.stopped || this.busy()) {
        await worker.terminate();
        if (this.worker === worker) {
          this.worker = undefined;
        }
      } else if (this.worker === worker) {
        // Reuse one isolate for a short burst; never keep a worker permanently idle.
        this.workerIdleTimer = setTimeout(() => {
          if (this.worker === worker && !this.processing) {
            void worker.terminate();
          }
        }, 5000);
        this.workerIdleTimer.unref();
      }
    }
  }
}

export function registerFeedbackReporting(api: OpenClawPluginApi): void {
  if (typeof api.registerService !== "function") {
    return;
  }
  let service: FeedbackReportingService | undefined;
  api.registerService({
    id: "dingtalk-feedback-reporting",
    start: () => {
      service = new FeedbackReportingService(api);
      service.start();
    },
    stop: async () => {
      await service?.stop();
      await stopFeedbackDetailReads();
      service = undefined;
    },
  });
}
