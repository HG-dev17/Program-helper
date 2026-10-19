/**
 * 扣子（Coze）聊天代理 —— Node.js 版本（Node 18+，零依赖）
 * ------------------------------------------------------------
 * 同时提供：静态文件服务 + /api/chat 代理（流式 SSE 透传）
 *
 * 本地/服务器运行：
 *   Windows PowerShell:
 *     $env:COZE_PAT="pat_xxx"; $env:COZE_BOT_ID="7694242160769908799"; node server.js
 *   Linux / macOS:
 *     COZE_PAT=pat_xxx COZE_BOT_ID=7694242160769908799 node server.js
 *
 * 可选环境变量：
 *   PORT          端口，默认 3000
 *   ALLOW_ORIGIN  允许跨域的来源，默认 *（同域部署可忽略）
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const dns = require("node:dns");

// 部分校园网/企业网的 IPv6 链路会返回错误证书，强制优先 IPv4
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (e) {
  /* 旧版本 Node 忽略即可 */
}

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const COZE_PAT = (process.env.COZE_PAT || "").trim();
const COZE_BOT_ID = (process.env.COZE_BOT_ID || "").trim();
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || "*").trim();
const COZE_API = "https://api.coze.cn/v3/chat";
const MAX_BODY = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

if (!COZE_PAT) {
  console.error("[错误] 未设置环境变量 COZE_PAT（扣子个人访问令牌）。");
  console.error('  PowerShell:  $env:COZE_PAT="pat_xxx"; node server.js');
  process.exit(1);
}

function cors(res, req) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN === "*" ? "*" : ALLOW_ORIGIN || origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Vary", "Origin");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleChat(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { code: 405, msg: "Method Not Allowed" });
    return;
  }

  let raw = "";
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        sendJson(res, 413, { code: 413, msg: "请求体过大" });
        return;
      }
    }
  } catch (e) {
    sendJson(res, 400, { code: 400, msg: "读取请求体失败" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch (e) {
    sendJson(res, 400, { code: 400, msg: "无效的 JSON" });
    return;
  }

  if (!payload.bot_id) {
    sendJson(res, 400, { code: 400, msg: "缺少 bot_id" });
    return;
  }
  if (COZE_BOT_ID && payload.bot_id !== COZE_BOT_ID) {
    sendJson(res, 403, { code: 403, msg: "bot_id 不被允许" });
    return;
  }

  payload.stream = true;
  if (payload.auto_save_history === undefined) payload.auto_save_history = true;

  let upstream;
  try {
    upstream = await fetch(COZE_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COZE_PAT}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    sendJson(res, 502, { code: 502, msg: "无法连接扣子接口：" + String((e && e.message) || e) });
    return;
  }

  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  let closed = false;
  res.on("close", function () {
    closed = true;
    reader.cancel().catch(function () {});
  });

  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    /* 客户端中断或上游异常 */
  } finally {
    res.end();
  }
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      return serveStatic(req, res, path.join(rel, "index.html"));
    }
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch (e) {
    // 根路径没有 index.html 时回退到 chat.html，方便直接部署本项目
    if (pathname === "/") {
      try {
        const data = await fsp.readFile(path.join(ROOT, "chat.html"));
        res.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": data.length, "Cache-Control": "no-cache" });
        res.end(data);
        return;
      } catch (e2) {
        /* ignore */
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  }
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  cors(res, req);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, bot: COZE_BOT_ID || null });
    return;
  }

  if (url.pathname === "/api/chat") {
    handleChat(req, res).catch(function (e) {
      if (!res.headersSent) sendJson(res, 500, { code: 500, msg: String((e && e.message) || e) });
      else res.end();
    });
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, function () {
  console.log("==========================================");
  console.log("  扣子聊天代理已启动");
  console.log("  页面:  http://localhost:" + PORT + "/chat.html");
  console.log("  接口:  POST http://localhost:" + PORT + "/api/chat");
  console.log("  智能体: " + (COZE_BOT_ID || "(未限制)"));
  console.log("==========================================");
});
