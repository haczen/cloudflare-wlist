// 本地假 OpenAI 接口：只实现带 /v1 的路径（故意不实现裸路径，验证客户端自动补 /v1）。
// CORS 全开 + 处理预检——模拟 hub.oaifree.com 这类允许浏览器直连的中转。
// 用法：node scripts/mock-openai.mjs [port]   （默认 8787）
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || 8787);
const KEY = "sk-mock-123";
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

	// 故意：裸路径（不带 /v1）一概 404，看客户端会不会自动补 /v1
	if (!url.pathname.startsWith("/v1/")) {
		return json(res, 404, { error: { message: `no such path: ${url.pathname} (try /v1)` } });
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
