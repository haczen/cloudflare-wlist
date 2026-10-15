// 外呼超时包装：workerd 的 fetch 没有 Happy Eyeballs，
// 本地开发遇到 IPv6 不通的环境会无限挂起，超时让错误尽早暴露。
// 仅用于小响应的控制面请求；流式上传/下载不要用（会被整段掐断）。

export async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
	ms: number = 20_000
): Promise<Response> {
	try {
		return await fetch(url, {
			...init,
			signal: AbortSignal.timeout(ms),
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new Error(
				`请求超时（${Math.round(ms / 1000)}s）：${new URL(url).host} 未响应。` +
					`本地开发时常见原因是系统 IPv6 不通（可关闭 IPv6 或部署到线上验证）`
			);
		}
		throw err;
	}
}
