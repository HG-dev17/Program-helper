/**
 * 扣子（Coze）聊天代理 —— Vercel Edge Function 版本
 * ------------------------------------------------------------
 * 部署方式：把仓库连接到 Vercel 即可，本文件会自动成为 /api/chat。
 * PAT 保存在 Vercel 项目的 Environment Variables 里，前端拿不到。
 *
 * Vercel 环境变量（Production / Preview 都要加）：
 *   COZE_PAT      = pat_xxxxxxxx（类型选 Secret）
 *   COZE_BOT_ID   = 7694242160769908799
 *   ALLOW_ORIGIN  = https://cookiesky.cn
 *
 * 自定义域名：
 *   Project → Settings → Domains → Add `coze-api.cookiesky.cn`
 *   然后把 Vercel 给出的 CNAME 目标填到阿里云 DNS：
 *       CNAME  coze-api  cname.vercel-dns.com
 */

export const config = { runtime: "edge" };

const COZE_API = "https://api.coze.cn/v3/chat";
const MAX_BODY_BYTES = 64 * 1024;

function allowedOrigins() {
  return String(process.env.ALLOW_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickOrigin(request) {
  const list = allowedOrigins();
  const origin = request.headers.get("Origin") || "";
  if (list.includes("*")) return "*";
  if (origin && list.includes(origin)) return origin;
  if (!origin) return list[0] || "*";
  return "";
}

function corsHeaders(allow) {
  return {
    "Access-Control-Allow-Origin": allow || "null",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(status, body, allow) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(allow), "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async function handler(request) {
  const url = new URL(request.url);
  const allow = pickOrigin(request);

  // 浏览器带了 Origin 但不在白名单，直接拒绝
  if (!allow) {
    return new Response("Forbidden", { status: 403 });
  }

  const json = (status, body) => jsonResponse(status, body, allow);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allow) });
  }

  if (url.pathname === "/api/health") {
    return json(200, { ok: true, bot: process.env.COZE_BOT_ID || null });
  }

  if (url.pathname !== "/api/chat") {
    return json(404, { code: 404, msg: "Not Found（请把请求发到 /api/chat）" });
  }

  if (request.method !== "POST") {
    return json(405, { code: 405, msg: "Method Not Allowed" });
  }

  const pat = process.env.COZE_PAT || "";
  const botId = process.env.COZE_BOT_ID || "";

  if (!pat) {
    return json(500, { code: 500, msg: "服务端未配置 COZE_PAT" });
  }

  // 来源校验已由 pickOrigin 完成（ALLOW_ORIGIN 支持逗号分隔多个来源）

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { code: 413, msg: "请求体过大" });
  }

  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch (e) {
    return json(400, { code: 400, msg: "无效的 JSON" });
  }

  // 只允许调用你配置的智能体，避免别人拿你的代理消耗额度
  if (!payload.bot_id) {
    return json(400, { code: 400, msg: "缺少 bot_id" });
  }
  if (botId && payload.bot_id !== botId) {
    return json(403, { code: 403, msg: "bot_id 不被允许" });
  }

  payload.stream = true;
  if (payload.auto_save_history === undefined) payload.auto_save_history = true;

  let upstream;
  try {
    upstream = await fetch(COZE_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json(502, { code: 502, msg: "无法连接扣子接口：" + String(e && e.message ? e.message : e) });
  }

  // 直接透传 SSE 流
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...corsHeaders(allow),
      "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
