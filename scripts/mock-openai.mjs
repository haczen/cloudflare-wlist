// 本地假 OpenAI 接口：只实现带 /v1 的路径（故意不实现裸路径，验证客户端自动补 /v1）。
// CORS 全开 + 处理预检——模拟 hub.oaifree.com 这类允许浏览器直连的中转。
// 用法：node scripts/mock-openai.mjs [port]   （默认 8787）
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || 8787);
const KEY = "ah-arbitrary-prefix-9876"; // 故意不用 sk- 前缀：验证不按前缀做判断
const MODELS = ["mock-mini", "mock-pro", "mock-ultra"];

const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key, anthropic-version",
	"Access-Control-Max-Age": "86400",
};

const json = (res, status, body, extra = {}) => {
	res.writeHead(status, { "Content-Type": "application/json", ...cors, ...extra });
	res.end(JSON.stringify(body));
};

const readBody = (req) =>
	new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
		});
	});

createServer(async (req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

	if (req.method === "OPTIONS") return json(res, 204, {}, { "Content-Length": 0 });

	// 裸路径（不带 /v1）模拟两种真实中转的行为（环境变量 BARE=404|spa，默认 spa）：
	//   spa：回 200 + 网站首页 HTML（qingniaocoding 这类 SPA 的通配兜底，最阴险——状态码看着是对的）
	//   404 ：回 404 JSON
	// 两种情况下客户端都必须自己补 /v1 再试
	if (!url.pathname.startsWith("/v1/")) {
		if (process.env.BARE === "404") {
			return json(res, 404, { error: { message: `no such path: ${url.pathname} (try /v1)` } });
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...cors });
		return res.end(
			"<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\" /><title>Mock SPA</title></head><body><div id=\"root\"></div></body></html>"
		);
	}

	const auth = req.headers.authorization || req.headers["x-api-key"] || "";
	if (!auth.includes(KEY)) return json(res, 401, { error: { message: "invalid key" } });

	const rest = url.pathname.slice("/v1".length);

	if (req.method === "GET" && rest === "/models") {
		return json(res, 200, { data: MODELS.map((id) => ({ id })) });
	}

	if (req.method === "POST" && rest === "/chat/completions") {
		const body = await readBody(req);
		const userMsg = (body.messages || []).filter((m) => m.role === "user").pop();
		return json(res, 200, {
			id: "mock-chat-1",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: `喵~（mock-chat）收到：「${(userMsg && userMsg.content || "").slice(0, 40)}」，用的模型是 ${body.model}`,
					},
					finish_reason: "stop",
				},
			],
		});
	}

	if (req.method === "POST" && rest === "/responses") {
		const body = await readBody(req);
		const last = Array.isArray(body.input) ? body.input.filter((m) => m.role === "user").pop() : null;
		return json(res, 200, {
			id: "mock-resp-1",
			output: [
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: `喵~（mock-responses）收到：「${(last && last.content || "").slice(0, 40)}」` }] },
			],
		});
	}

	return json(res, 404, { error: { message: `no such endpoint: ${req.method} ${url.pathname}` } });
}).listen(PORT, "127.0.0.1", () => {
	console.log(`mock openai on http://127.0.0.1:${PORT}/v1  (key=${KEY})`);
});
