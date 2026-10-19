/**
 * 健康检查 —— Vercel Edge Function，对应 /api/health
 * 只返回服务状态与智能体 ID，不含任何密钥。
 */

export const config = { runtime: "edge" };

export default async function handler() {
  return new Response(
    JSON.stringify({ ok: true, bot: process.env.COZE_BOT_ID || null }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
