export function encodeUploadState(state: Record<string, unknown>): string {
	const json = JSON.stringify(state);
	const base64 = btoa(json);
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeUploadState(token: string): Record<string, any> {
	const padded = token.replace(/-/g, "+").replace(/_/g, "/");
	const padLength = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
	const base64 = padded + "=".repeat(padLength);
	const json = atob(base64);
	return JSON.parse(json) as Record<string, any>;
}

export function normalizeRootPath(rootPath: string): string {
	if (!rootPath) {
		return "/";
	}
	let normalized = rootPath.trim();
	if (!normalized.startsWith("/")) {
		normalized = "/" + normalized;
	}
	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

export function joinRootPath(rootPath: string, path: string): string {
	const root = normalizeRootPath(rootPath);
	const cleanPath = path ? (path.startsWith("/") ? path : "/" + path) : "";
	if (!path || cleanPath === "/") {
		return root;
	}
	if (root === "/") {
		return cleanPath;
	}
	return `${root}${cleanPath}`;
}

export function stripTrailingSlash(path: string): string {
	if (path.length <= 1) {
		return path;
	}
	return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function stripLeadingSlash(path: string): string {
	return path.startsWith("/") ? path.slice(1) : path;
}

export function getConfigString(
	config: Record<string, any>,
	keys: string | string[],
	fallback: string = ""
): string {
	const keyList = Array.isArray(keys) ? keys : [keys];
	for (const key of keyList) {
		const value = config[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return fallback;
}

export function getRefreshToken(
	config: Record<string, any>,
	saving: Record<string, any>
): string {
	return (
		getConfigString(config, "refresh_token") ||
		getConfigString(saving, "refresh_token")
	);
}

/**
 * 是否使用在线 API 代理刷新 token。
 * 未配置本地 client_id/secret 时必须走代理；显式配置 use_online_api 时按其值。
 */
export function shouldUseOnlineApi(config: Record<string, any>): boolean {
	const hasLocalClient =
		typeof config.client_id === "string" &&
		config.client_id.trim() &&
		typeof config.client_secret === "string" &&
		config.client_secret.trim();
	if (!hasLocalClient) {
		return true;
	}
	if (config.use_online_api === undefined || config.use_online_api === null) {
		return true;
	}
	return (
		config.use_online_api === true ||
		config.use_online_api === "true" ||
		config.use_online_api === 1
	);
}
