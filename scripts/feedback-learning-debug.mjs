#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

function parseArgs(argv) {
  const args = { port: 18895, accountId: "default", storePath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--port" && next) {
      args.port = Number(next);
      index += 1;
    } else if (value === "--accountId" && next) {
      args.accountId = next;
      index += 1;
    } else if (value === "--storePath" && next) {
      args.storePath = next;
      index += 1;
    }
  }
  if (!args.storePath) {
    console.error("Usage: node scripts/feedback-learning-debug.mjs --storePath /path/to/store.json [--accountId main] [--port 18895]");
    process.exit(1);
  }
  return args;
}

function encodeScopeValue(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeScopeValue(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildScopeSuffix(scope = {}) {
  const ordered = [
    ["accountId", scope.accountId],
    ["agentId", scope.agentId],
    ["conversationId", scope.conversationId],
    ["groupId", scope.groupId],
    ["targetId", scope.targetId],
  ];
  const parts = ordered
    .filter(([, current]) => current && String(current).trim())
    .map(([key, current]) => `${key.replace(/Id$/, "")}-${encodeScopeValue(String(current).trim())}`);
  return parts.length > 0 ? `.${parts.join(".")}` : "";
}

function resolveNamespacePath(storePath, namespace, scope = {}) {
  const baseDir = path.join(path.dirname(storePath), "dingtalk-state");
  return path.join(baseDir, `${sanitizeSegment(namespace)}${buildScopeSuffix(scope)}.json`);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function listTargets(storePath, accountId) {
  const baseDir = path.join(path.dirname(storePath), "dingtalk-state");
  if (!fs.existsSync(baseDir)) {
    return [];
  }
  const targets = new Set();
  for (const fileName of fs.readdirSync(baseDir)) {
    if (!fileName.startsWith("feedback.")) {
      continue;
    }
    const accountMatch = fileName.match(/\.account-([^.]+)\./);
    const targetMatch = fileName.match(/\.target-([^.]+)\.json$/);
    if (!accountMatch || !targetMatch) {
      continue;
    }
    if (decodeScopeValue(accountMatch[1]) !== accountId) {
      continue;
    }
    targets.add(decodeScopeValue(targetMatch[1]));
  }
  return [...targets].sort();
}

function readOverview(storePath, accountId, targetId) {
  const scope = { accountId, targetId };
  return {
    events: readJson(resolveNamespacePath(storePath, "feedback.events", scope), { entries: [] }).entries || [],
    snapshots:
      readJson(resolveNamespacePath(storePath, "feedback.snapshots", scope), { entries: [] }).entries || [],
    reflections:
      readJson(resolveNamespacePath(storePath, "feedback.reflections", scope), { entries: [] }).entries || [],
    notes:
      readJson(resolveNamespacePath(storePath, "feedback.session-notes", scope), { entries: [] }).entries || [],
    rules:
      Object.values(
        readJson(resolveNamespacePath(storePath, "feedback.learned-rules", { accountId }), { rules: {} }).rules || {},
      ).sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function appendManualReflection(storePath, accountId, targetId, payload) {
  const reflectionPath = resolveNamespacePath(storePath, "feedback.reflections", { accountId, targetId });
  const notePath = resolveNamespacePath(storePath, "feedback.session-notes", { accountId, targetId });
  const rulePath = resolveNamespacePath(storePath, "feedback.learned-rules", { accountId });
  const reflectionBucket = readJson(reflectionPath, { updatedAt: 0, entries: [] });
  const noteBucket = readJson(notePath, { updatedAt: 0, entries: [] });
  const ruleBucket = readJson(rulePath, { updatedAt: 0, rules: {} });
  const nowMs = Date.now();
  const reflection = {
    id: payload.id || `manual_${nowMs}`,
    targetId,
    sourceEventId: payload.sourceEventId || `manual_${nowMs}`,
    kind: payload.kind || "implicit_negative",
    category: payload.category || "generic_negative",
    diagnosis: payload.diagnosis || "",
    suggestedInstruction: payload.suggestedInstruction || "",
    question: payload.question || "",
    answer: payload.answer || "",
    createdAt: nowMs,
    manual: true,
  };
  reflectionBucket.entries = [reflection, ...(reflectionBucket.entries || [])].slice(0, 200);
  reflectionBucket.updatedAt = nowMs;
  writeJson(reflectionPath, reflectionBucket);

  if (payload.suggestedInstruction) {
    noteBucket.entries = [
      {
        id: `manual_note_${nowMs}`,
        targetId,
        instruction: payload.suggestedInstruction,
        source: "implicit_negative",
        category: payload.category || "generic_negative",
        createdAt: nowMs,
        expiresAt: nowMs + 6 * 60 * 60 * 1000,
      },
      ...(noteBucket.entries || []).filter((note) => (note.expiresAt || 0) > nowMs),
    ].slice(0, 20);
    noteBucket.updatedAt = nowMs;
    writeJson(notePath, noteBucket);
  }

  if (payload.promoteToGlobal && payload.suggestedInstruction) {
    const ruleId = payload.ruleId || `manual_rule_${payload.category || "generic_negative"}`;
    ruleBucket.rules[ruleId] = {
      ruleId,
      category: payload.category || "generic_negative",
      instruction: payload.suggestedInstruction,
      negativeCount: Number(payload.negativeCount || 1),
      positiveCount: Number(payload.positiveCount || 0),
      updatedAt: nowMs,
      enabled: payload.enabled !== false,
      manual: true,
    };
    ruleBucket.updatedAt = nowMs;
    writeJson(rulePath, ruleBucket);
  }
}

function upsertRule(storePath, accountId, payload) {
  const rulePath = resolveNamespacePath(storePath, "feedback.learned-rules", { accountId });
  const ruleBucket = readJson(rulePath, { updatedAt: 0, rules: {} });
  const nowMs = Date.now();
  const ruleId = payload.ruleId || `manual_rule_${payload.category || "generic_negative"}`;
  ruleBucket.rules[ruleId] = {
    ruleId,
    category: payload.category || "generic_negative",
    instruction: payload.instruction || "",
    negativeCount: Number(payload.negativeCount || 0),
    positiveCount: Number(payload.positiveCount || 0),
    updatedAt: nowMs,
    enabled: payload.enabled !== false,
    manual: true,
  };
  ruleBucket.updatedAt = nowMs;
  writeJson(rulePath, ruleBucket);
}

function renderHtml(args) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>DingTalk Feedback Learning Debug</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #111827; color: #e5e7eb; }
    header { padding: 16px 20px; background: #0f172a; border-bottom: 1px solid #334155; }
    main { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 64px); }
    aside { border-right: 1px solid #334155; padding: 16px; background: #111827; }
    section { padding: 16px; }
    h1,h2,h3 { margin: 0 0 12px; }
    .muted { color: #94a3b8; font-size: 12px; }
    .target { width: 100%; text-align: left; margin: 0 0 8px; padding: 10px 12px; border: 1px solid #334155; background: #1e293b; color: #e5e7eb; border-radius: 8px; cursor: pointer; }
    .target.active { border-color: #38bdf8; background: #082f49; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 16px; }
    .card { border: 1px solid #334155; border-radius: 10px; padding: 14px; background: #0f172a; }
    .item { padding: 10px; border-radius: 8px; background: #111827; border: 1px solid #1f2937; margin-bottom: 10px; white-space: pre-wrap; }
    textarea, input, select { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 8px; border: 1px solid #334155; background: #111827; color: #e5e7eb; }
    button { padding: 8px 12px; border: 0; border-radius: 8px; background: #0284c7; color: white; cursor: pointer; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>Feedback Learning Debug</h1>
    <div class="muted">storePath: ${args.storePath} · accountId: <span id="accountId">${args.accountId}</span></div>
  </header>
  <main>
    <aside>
      <h3>Targets</h3>
      <div id="targets"></div>
    </aside>
    <section>
      <div class="grid">
        <div class="card"><h3>Snapshots</h3><div id="snapshots"></div></div>
        <div class="card"><h3>Events</h3><div id="events"></div></div>
        <div class="card"><h3>Reflections</h3><div id="reflections"></div></div>
        <div class="card"><h3>Session Notes</h3><div id="notes"></div></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3>Global Rules（跨所有钉钉会话共享）</h3>
        <div class="muted">这里保存的是 account 级规则。保存后，新的钉钉消息会实时读取并作用到所有会话。</div>
        <div id="rules" style="margin-top:12px;"></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3>Manual Reflection</h3>
        <div class="muted">你可以直接修正“系统没理解对”的地方，并选择只注入当前会话、提升为全局规则，或仅保存为候选反思。</div>
        <div class="row" style="margin-top:12px;">
          <div><label>Category</label><select id="manualCategory">
            <option value="misunderstood_intent">misunderstood_intent</option>
            <option value="quoted_context_missing">quoted_context_missing</option>
            <option value="missing_image_context">missing_image_context</option>
            <option value="generic_negative">generic_negative</option>
          </select></div>
          <div><label>Promote To Global</label><select id="manualPromote"><option value="false">false</option><option value="true">true</option></select></div>
        </div>
        <div style="margin-top:12px;"><label>Diagnosis</label><textarea id="manualDiagnosis" rows="3"></textarea></div>
        <div style="margin-top:12px;"><label>Instruction</label><textarea id="manualInstruction" rows="3"></textarea></div>
        <div style="margin-top:12px;"><button id="manualSave">保存人工反思 / 注入</button></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3>Global Knowledge Injection</h3>
        <div class="muted">这里用于你手动发布一条跨所有钉钉会话共享的知识，不依赖点赞点踩。</div>
        <div class="row" style="margin-top:12px;">
          <div><label>Rule Id</label><input id="globalRuleId" placeholder="manual_rule_xxx" /></div>
          <div><label>Category</label><select id="globalRuleCategory">
            <option value="misunderstood_intent">misunderstood_intent</option>
            <option value="quoted_context_missing">quoted_context_missing</option>
            <option value="missing_image_context">missing_image_context</option>
            <option value="generic_negative">generic_negative</option>
          </select></div>
        </div>
        <div style="margin-top:12px;"><label>Instruction</label><textarea id="globalRuleInstruction" rows="3" placeholder="输入你要全局共享的知识"></textarea></div>
        <div style="margin-top:12px;"><button id="globalRuleSave">发布到全局</button></div>
      </div>
    </section>
  </main>
  <script>
    const state = { targetId: "" };
    async function api(path, options) {
      const res = await fetch(path, options);
      return res.json();
    }
    function renderList(nodeId, items, formatter) {
      const node = document.getElementById(nodeId);
      node.innerHTML = items.length ? items.map(formatter).join("") : '<div class="muted">暂无数据</div>';
    }
    function renderRules(rules) {
      const node = document.getElementById("rules");
      node.innerHTML = rules.length ? rules.map((rule) => \`
        <div class="item">
          <div><strong>\${rule.ruleId}</strong> · \${rule.category} · enabled=\${rule.enabled}</div>
          <textarea data-rule-id="\${rule.ruleId}" data-category="\${rule.category}" class="rule-instruction" rows="3">\${rule.instruction || ""}</textarea>
          <div style="margin-top:8px;"><button onclick="saveRule('\${rule.ruleId}','\${rule.category}')">保存规则</button></div>
        </div>\`).join("") : '<div class="muted">暂无全局规则</div>';
    }
    async function saveRule(ruleId, category) {
      const textarea = document.querySelector(\`.rule-instruction[data-rule-id="\${ruleId}"]\`);
      await api("/api/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: document.getElementById("accountId").textContent, ruleId, category, instruction: textarea.value, enabled: true }),
      });
      await loadOverview();
    }
    async function loadTargets() {
      const data = await api(\`/api/targets?accountId=\${encodeURIComponent(document.getElementById("accountId").textContent)}\`);
      const node = document.getElementById("targets");
      node.innerHTML = data.targets.map((targetId, index) => \`
        <button class="target \${state.targetId === targetId || (!state.targetId && index === 0) ? "active" : ""}" onclick="selectTarget('\${targetId.replace(/'/g, "\\\\'")}')">\${targetId}</button>\`).join("");
      if (!state.targetId && data.targets[0]) {
        state.targetId = data.targets[0];
      }
    }
    async function loadOverview() {
      if (!state.targetId) return;
      const accountId = document.getElementById("accountId").textContent;
      const data = await api(\`/api/overview?accountId=\${encodeURIComponent(accountId)}&targetId=\${encodeURIComponent(state.targetId)}\`);
      renderList("snapshots", data.snapshots, (item) => \`<div class="item"><div><strong>Q:</strong> \${item.question || ""}</div><div><strong>A:</strong> \${item.answer || ""}</div><div class="muted">processQueryKey=\${item.processQueryKey || ""}</div></div>\`);
      renderList("events", data.events, (item) => \`<div class="item"><div><strong>\${item.kind}</strong></div><div>\${item.signalText || ""}</div><div class="muted">\${new Date(item.createdAt).toLocaleString()}</div></div>\`);
      renderList("reflections", data.reflections, (item) => \`<div class="item"><div><strong>\${item.category}</strong></div><div>\${item.diagnosis || ""}</div><div class="muted">\${item.suggestedInstruction || ""}</div></div>\`);
      renderList("notes", data.notes, (item) => \`<div class="item"><div><strong>\${item.category}</strong></div><div>\${item.instruction || ""}</div><div class="muted">expiresAt=\${new Date(item.expiresAt).toLocaleString()}</div></div>\`);
      renderRules(data.rules || []);
    }
    async function selectTarget(targetId) {
      state.targetId = targetId;
      await loadTargets();
      await loadOverview();
    }
    document.getElementById("manualSave").addEventListener("click", async () => {
      if (!state.targetId) return;
      await api("/api/manual-reflection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: document.getElementById("accountId").textContent,
          targetId: state.targetId,
          category: document.getElementById("manualCategory").value,
          diagnosis: document.getElementById("manualDiagnosis").value,
          suggestedInstruction: document.getElementById("manualInstruction").value,
          promoteToGlobal: document.getElementById("manualPromote").value === "true",
        }),
      });
      document.getElementById("manualDiagnosis").value = "";
      document.getElementById("manualInstruction").value = "";
      await loadOverview();
    });
    document.getElementById("globalRuleSave").addEventListener("click", async () => {
      await api("/api/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: document.getElementById("accountId").textContent,
          ruleId: document.getElementById("globalRuleId").value,
          category: document.getElementById("globalRuleCategory").value,
          instruction: document.getElementById("globalRuleInstruction").value,
          enabled: true,
        }),
      });
      document.getElementById("globalRuleId").value = "";
      document.getElementById("globalRuleInstruction").value = "";
      await loadOverview();
    });
    loadTargets().then(loadOverview);
  </script>
</body>
</html>`;
}

const args = parseArgs(process.argv.slice(2));
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${args.port}`);
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderHtml(args));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/targets") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ targets: listTargets(args.storePath, url.searchParams.get("accountId") || args.accountId) }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/overview") {
    const accountId = url.searchParams.get("accountId") || args.accountId;
    const targetId = url.searchParams.get("targetId") || "";
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(readOverview(args.storePath, accountId, targetId)));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/rules") {
    const payload = await readRequestBody(request);
    upsertRule(args.storePath, payload.accountId || args.accountId, payload);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/manual-reflection") {
    const payload = await readRequestBody(request);
    appendManualReflection(args.storePath, payload.accountId || args.accountId, payload.targetId, payload);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(args.port, "127.0.0.1", () => {
  console.log(`Feedback learning debug panel: http://127.0.0.1:${args.port}`);
});
