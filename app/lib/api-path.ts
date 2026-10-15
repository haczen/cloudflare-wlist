// 文件 API 路径构造：逐段 encodeURIComponent，避免整段编码把 / 也编掉

export function encodeFilePath(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/** /api/files/<storageId>/<path>，可附加查询参数 */
export function apiFileUrl(
	storageId: number,
	path: string,
	params: Record<string, string> = {}
): string {
	let url = `/api/files/${storageId}/${encodeFilePath(path)}`;
	const query = new URLSearchParams(params).toString();
	if (query) {
		url += `?${query}`;
	}
	return url;
}
