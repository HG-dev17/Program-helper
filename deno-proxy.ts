/**
 * 扣子（Coze）聊天代理 —— Deno Deploy 版本
 * ------------------------------------------------------------
 * 与 worker.js 功能完全一致，用于国内网络：
 *   *.workers.dev 在大陆会被 DNS 污染 + SNI 阻断，
 *   而 *.deno.dev 目前可以正常访问。
 *
 * 部署（浏览器操作即可，无需命令行）：
 *   1. 打开 https://dash.deno.com，用 GitHub 登录
 *   2. New Project / Playground，粘贴本文件全部内容
 *   3. Settings → Environment Variables 添加：
 *        COZE_PAT     = pat_xxxx（设为 Secret）
 *        COZE_BOT_ID  = 7694242160769908799
 *        ALLOW_ORIGIN = https://hg-dev17.github.io
 *   4. Deploy，得到 https://<项目名>.<用户名>.deno.dev
 *   5. 页面切换代理：
 *        https://hg-dev17.github.io/Program-helper/?proxy=https://<项目名>.<用户名>.deno.dev
 *      或直接把 index.html 里的 CONFIG.proxyBase 改成该地址
 */

const COZE_API = "https://api.coze.cn/v3/chat";
const MAX_BODY_BYTES = 64 * 1024;

function corsHeaders(): Record<string, string> {
  const allow = Deno.env.get("ALLOW_ORIGIN") || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (url.pathname === "/api/health") {
    return json(200, { ok: true, bot: Deno.env.get("COZE_BOT_ID") || null });
  }

  if (url.pathname !== "/api/chat") {
    return json(404, { code: 404, msg: "Not Found（请把请求发到 /api/chat）" });
  }

  if (request.method !== "POST") {
    return json(405, { code: 405, msg: "Method Not Allowed" });
  }

  const pat = Deno.env.get("COZE_PAT") || "";
  const botId = Deno.env.get("COZE_BOT_ID") || "";
  const allowOrigin = Deno.env.get("ALLOW_ORIGIN") || "*";

  if (!pat) {
    return json(500, { code: 500, msg: "服务端未配置 COZE_PAT" });
  }

  // 来源校验：浏览器场景有效，可降低他人网页盗用你额度的风险
  const origin = request.headers.get("Origin") || "";
  if (allowOrigin !== "*" && origin && origin !== allowOrigin) {
    return json(403, { code: 403, msg: "Origin 不被允许" });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { code: 413, msg: "请求体过大" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
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

  let upstream: Response;
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
    return json(502, {
      code: 502,
      msg: "无法连接扣子接口：" + String(e instanceof Error ? e.message : e),
    });
  }

  // 直接透传 SSE 流
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...corsHeaders(),
      "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
