// AI 上游协议层（服务端与浏览器共用，纯函数、无平台依赖）
// 同一个「OpenAI 兼容」地址背后可能是三种协议之一：
//   Chat Completions（/chat/completions）｜Responses（/responses）｜Anthropic Messages（/messages）
// 不同中转支持的组合不同，这里按顺序都试一遍，哪条给出回复走哪条。

export type ChatTurn = { role: "user" | "assistant"; content: string };

export interface ChatAttempt {
	via: "chat" | "responses" | "messages";
	path: string;
	/** 协议自己的鉴权头（Authorization 由调用方统一加） */
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** 三种协议的请求形状（顺序即尝试顺序） */
export function buildChatAttempts(
	model: string,
	systemPrompt: string,
	history: ChatTurn[]
): ChatAttempt[] {
	return [
		{
			via: "chat",
			path: "/chat/completions",
			headers: {},
			body: {
				model,
				messages: [{ role: "system", content: systemPrompt }, ...history],
				max_tokens: 480,
				temperature: 0.8,
			},
		},
		{
			via: "responses",
			path: "/responses",
			headers: {},
			body: {
				model,
				instructions: systemPrompt,
				input: history,
				max_output_tokens: 480,
			},
		},
		{
			via: "messages",
			path: "/messages",
			headers: { "anthropic-version": "2023-06-01" },
			body: {
				model,
				system: systemPrompt,
				messages: history,
				max_tokens: 480,
			},
		},
	];
}

/**
 * 一个地址该尝试的 URL：先原样，Base URL 没带版本段再补 /v1。
 * 顺序不能反——Azure 这类 Base URL 本身就是完整路径，先补 /v1 会打坏。
 */
export function candidateUrls(baseUrl: string, path: string): string[] {
	const base = baseUrl.replace(/\/+$/, "");
	const urls = [`${base}${path}`];
	if (!/\/v\d+[a-z]*$/i.test(base)) urls.push(`${base}/v1${path}`);
	return urls;
}

/** 这个状态码意味着「这个地址不对/不让进，换带 /v1 的地址再试」 */
export function shouldTryVersioned(status: number): boolean {
	return status === 403 || status === 404 || status === 405;
}

/** 从各家协议的应答里把回复文本抠出来（Chat / Responses / Messages / 旧 Completions 全兼容） */
export function extractReply(d: unknown): string {
	if (!d || typeof d !== "object") return "";
	const data = d as Record<string, any>;
	const pick = (v: unknown): string => {
		if (typeof v === "string") return v;
		if (Array.isArray(v)) {
			return v
				.map((p) => (p && typeof p === "object" ? String((p as any).text ?? "") : ""))
				.join("");
		}
		return "";
	};
	const choice = Array.isArray(data.choices) ? data.choices[0] : null;
	if (choice) {
		const c =
			pick(choice.message?.content) || pick(choice.text) || pick(choice.delta?.content);
		if (c.trim()) return c.trim();
	}
	if (typeof data.output_text === "string" && data.output_text.trim()) {
		return data.output_text.trim();
	}
	if (Array.isArray(data.output)) {
		const c = data.output.map((item: any) => pick(item?.content)).join("");
		if (c.trim()) return c.trim();
	}
	if (Array.isArray(data.content)) {
		const c = pick(data.content);
		if (c.trim()) return c.trim();
	}
	if (typeof data.completion === "string" && data.completion.trim()) {
		return data.completion.trim();
	}
	return "";
}

/** 模型清单应答 → id 列表（兼容 {data:[...]} 与顶层数组） */
export function extractModelIds(d: unknown): string[] {
	if (!d) return [];
	const list = Array.isArray(d)
		? d
		: Array.isArray((d as { data?: unknown }).data)
			? ((d as { data: unknown[] }).data)
			: [];
	return list
		.map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
		.filter((id): id is string => typeof id === "string");
}

export interface AttemptFailure {
	via: string;
	/** 0 = 连不上（超时/被重置/CORS 被拦） */
	status: number;
	text?: string;
}

/** 把逐条尝试结果翻译成使用者看得懂的一句话 */
export function describeFailures(
	tries: AttemptFailure[],
	context: "server" | "browser" = "server"
): string {
	if (tries.length === 0) return "没有可用的接口地址";
	const statuses = tries.map((t) => t.status);
	if (statuses.every((s) => s === 0)) {
		return context === "browser"
			? "连不上这个接口（地址不通，或它不允许浏览器直接访问）——检查 API 地址；也可以点下面的「改走本站转发」"
			: "连不上上游（超时或被重置）：检查 API 地址是否写对";
	}
	if (statuses.every((s) => s >= 520)) {
		return context === "browser"
			? "上游源站返回异常（52x）：它自己出了问题，稍后再试"
			: "上游拒收了来自本站服务器的请求（520）。这个接口只接受客户端从你自己的电脑直连，不接受网站服务器转发——换一个标准的 OpenAI 兼容接口即可";
	}
	if (tries.some((t) => t.status === 401)) {
		return "API Key 无效或已过期";
	}
	const notAllowed = tries.find(
		(t) => t.status === 403 && /not.?allowed|client|whitelist|编程客户端|仅支持/i.test(t.text || "")
	);
	if (notAllowed) {
		return `这个接口仅允许特定客户端使用（${(notAllowed.text || "").slice(0, 60)}）`;
	}
	if (tries.some((t) => t.status === 403)) {
		return "没有权限（403）：这个 Key 不能访问该模型或接口";
	}
	if (tries.every((t) => t.status === 404)) {
		return "接口不存在：确认 API 地址（一般以 /v1 结尾）";
	}
	if (tries.some((t) => t.status === 429)) {
		return "上游限流 / 额度用完（429）：" + (tries.find((t) => t.status === 429)?.text || "").slice(0, 80);
	}
	if (tries.some((t) => t.status === 400 || t.status === 404 && t.text)) {
		const t = tries.find((x) => x.status === 400 || x.status === 404);
		return `上游拒绝了请求（${t?.status}）：${(t?.text || "").slice(0, 120)}`;
	}
	return (
		"上游没给出回复：" +
		tries
			.map(
				(t) =>
					`${t.via} ${t.status === 0 ? "连不上" : t.status}${t.text ? `（${t.text.slice(0, 60)}）` : ""}`
			)
			.join("；")
	);
}

/** 未自定义时的默认猫设——保持人设与站点角色，避免被当成通用问答机滥用 */
export const DEFAULT_PET_SYSTEM_PROMPT =
	"你是 WList 网盘站的守盘助手，右下角的粉色小猫式吉祥物。性格：温柔、爱撒娇、有点迷糊但很尽职。" +
	"规则：1) 全程用中文、口语化、句尾偶尔带\"喵\"；2) 回答尽量简短（一般不超过 100 字）；" +
	"3) 你熟悉本站功能（多桶聚合存储、传输盘 7 天保留、分片上传、直链下载、在线预览），可以答疑；" +
	"4) 你只是吉祥物，不是管理员：不受理删文件、开权限类请求，引导用户找管理员；" +
	"5) 除站点功能外的问题也可以聊，但保持人设，不扮演别的 AI 助手。";

/**
 * API Key 形状检查（服务端保存与浏览器直连共用）。
 * 只看「是不是一串干净的字符」，不认前缀——各家 key 长相天差地别：
 *   sk-…（OpenAI 系）｜ah-…｜key-…｜AKIA…（AWS）｜AIza…（Google）｜裸 uuid/token，
 * 自建中转更是随便起，所以绝不能按开头去猜。
 * 真实事故：用户粘贴 key 时剪贴板里是终端装饰线（"────…… ❯"，223 个字符），
 * 存进库后所有上游调用全部异常。因此只拦「不可能是 key」的形状：
 * 含非 ASCII / 控制符 / 空白、过短。
 */
export function invalidApiKeyReason(key: string): string | null {
	if (key.length === 0) return null; // 「必填」由调用方自己判
	if (/[\u0000-\u001f\u007f-\uffff]/.test(key) || /\s/.test(key)) {
		return "这个 Key 里有中文符号、横线装饰（───）、❯ 或空白——多半是复制时把终端界面一起带上了。先粘到记事本看一眼，确认是一整串不带空格的字符，再整段复制过来";
	}
	if (key.length < 8) {
		return "这个 Key 太短了，不像真的 API Key——请重新复制一遍";
	}
	return null;
}

