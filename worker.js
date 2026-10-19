/**
 * 扣子（Coze）聊天代理 —— Cloudflare Worker 版本
 * ------------------------------------------------------------
 * 作用：把浏览器的 /api/chat 请求转发到扣子 v3 Chat API，
 *       PAT 保存在 Worker 的「机密变量」里，前端永远看不到。
 *
 * 部署步骤（免费，无需服务器）：
 *   1. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. 把本文件内容整体粘贴进去，Deploy
 *   3. Settings → Variables and Secrets，添加：
 *        COZE_PAT      = pat_xxxxxxxx（类型选 Secret）
 *        COZE_BOT_ID   = 7694242160769908799
 *        ALLOW_ORIGIN  = https://你的用户名.github.io   （可选，限制来源）
 *   4. 记下 Worker 地址，例如 https://coze-proxy.xxx.workers.dev
 *   5. 在 chat.html 里把 CONFIG.proxyBase 设成这个地址（末尾不要加斜杠）
 */

const COZE_API = "https://api.coze.cn/v3/chat";
const MAX_BODY_BYTES = 64 * 1024;

function corsHeaders(env) {
  const allow = env.ALLOW_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status, body, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(env), "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === "/api/health") {
      return json(200, { ok: true, bot: env.COZE_BOT_ID || null }, env);
    }

    if (url.pathname !== "/api/chat") {
      return json(404, { code: 404, msg: "Not Found（请把请求发到 /api/chat）" }, env);
    }

    if (request.method !== "POST") {
      return json(405, { code: 405, msg: "Method Not Allowed" }, env);
    }

    if (!env.COZE_PAT) {
      return json(500, { code: 500, msg: "服务端未配置 COZE_PAT" }, env);
    }

    // 简单的来源校验（浏览器场景有效；服务端伪造仍可能绕过，需配合配额限制）
    const origin = request.headers.get("Origin") || "";
    if (env.ALLOW_ORIGIN && env.ALLOW_ORIGIN !== "*" && origin && origin !== env.ALLOW_ORIGIN) {
      return json(403, { code: 403, msg: "Origin 不被允许" }, env);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json(413, { code: 413, msg: "请求体过大" }, env);
    }

    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch (e) {
      return json(400, { code: 400, msg: "无效的 JSON" }, env);
    }

    // 只允许调用你配置的智能体，避免别人拿你的 Worker 消耗额度
    if (!payload.bot_id) {
      return json(400, { code: 400, msg: "缺少 bot_id" }, env);
    }
    if (env.COZE_BOT_ID && payload.bot_id !== env.COZE_BOT_ID) {
      return json(403, { code: 403, msg: "bot_id 不被允许" }, env);
    }

    payload.stream = true;
    if (payload.auto_save_history === undefined) payload.auto_save_history = true;

    let upstream;
    try {
      upstream = await fetch(COZE_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.COZE_PAT}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json(502, { code: 502, msg: "无法连接扣子接口：" + String(e && e.message ? e.message : e) }, env);
    }

    // 直接透传 SSE 流
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...corsHeaders(env),
        "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  },
};
