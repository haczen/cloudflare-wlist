import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import {
	CloseIcon,
	DownloadIcon,
	SpinnerIcon,
} from "~/components/icons";
import {
	formatDuration,
	getCodeLanguage,
	getFileType,
} from "~/lib/file-utils";

marked.setOptions({
	gfm: true,
	breaks: true,
});

export interface FilePreviewProps {
	storageId: number;
	path: string;
	fileName: string;
	size?: number;
	token?: string;
	password?: string;
	/** 聚合盘文件 ID：传入时数据源改走 /api/pool/:id（storageId/path 仅作展示兜底） */
	poolFileId?: string;
	onClose: () => void;
}

function encodeFilePath(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function buildUrl(
	storageId: number,
	path: string,
	params: Record<string, string> = {},
	token?: string,
	password?: string
): string {
	const url = new URL(
		`/api/files/${storageId}/${encodeFilePath(path)}`,
		window.location.origin
	);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	if (token) {
		url.searchParams.set("token", token);
	}
	if (password) {
		url.searchParams.set("password", password);
	}
	return url.toString();
}

function formatSize(bytes: number): string {
	if (!bytes && bytes !== 0) return "";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = bytes;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------- 媒体源：签名直链优先，失败回退代理 ----------
// 视频/音频直连存储端后 <video> 可用 Range 拖动进度；大文件不占 Workers 流量。
// <img>/<video>/<audio>/<iframe> 不受存储端 CORS 限制，直链可用；
// 文本/Office/ZIP 预览用 fetch 拉取，仍走代理。

function useMediaSrc(
	storageId: number,
	path: string,
	proxyUrl: string,
	enabled: boolean,
	token?: string,
	password?: string,
	/** 直接使用该 URL 作媒体源（聚合盘：无签名直链，直接用 inline 流） */
	directSrc?: string | null
): { src: string | null; handleError: () => void } {
	const [signed, setSigned] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!enabled || directSrc) return;
		let alive = true;
		const params: Record<string, string> = {
			action: "signed-url",
			disposition: "inline",
		};
		if (token) params.token = token;
		if (password) params.password = password;
		fetch(buildUrl(storageId, path, params, token, password))
			.then((res) => (res.ok ? (res.json() as Promise<{ url?: string } | null>) : null))
			.then((data: { url?: string } | null) => {
				if (alive && data?.url) setSigned(data.url);
			})
			.catch(() => {
				/* 保持代理 */
			});
		return () => {
			alive = false;
		};
	}, [storageId, path, enabled, token, password, directSrc]);

	// 直链还没回来时返回 null（外层显示加载中）；明确失败则回退代理
	if (directSrc) {
		return { src: directSrc, handleError: () => {} };
	}
	if (failed) {
		return { src: proxyUrl, handleError: () => {} };
	}
	if (!signed) {
		return { src: enabled ? null : proxyUrl, handleError: () => setFailed(true) };
	}
	return { src: signed, handleError: () => setFailed(true) };
}

function MediaLoading() {
	return (
		<div className="flex h-48 items-center justify-center">
			<SpinnerIcon className="h-8 w-8 animate-spin text-zinc-400" />
		</div>
	);
}

// ---------- 文本 / 代码 ----------

function TextPreview({
	url,
	fileName,
	language,
	content,
}: {
	url?: string;
	fileName: string;
	language?: string;
	/** 已有内容（内容嗅探通道传入，可跳过再取） */
	content?: string;
}) {
	const [text, setText] = useState<string | null>(content ?? null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (content !== undefined) return;
		let cancelled = false;
		(async () => {
			try {
				// 只取前 2MB+1：展示本身就是 2MB 截断的，别为预览下载整份大日志
				const CAP = 2 * 1024 * 1024;
				if (!url) throw new Error("no url");
				const { bytes } = await fetchByteRange(url, 0, CAP + 1);
				const decoded = new TextDecoder().decode(bytes);
				if (!cancelled) {
					setText(
						bytes.byteLength > CAP
							? decoded.slice(0, CAP) + "\n\n… (内容已截断)"
							: decoded
					);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "加载失败");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url, content]);

	if (error) {
		return <div className="p-8 text-center text-red-500">{error}</div>;
	}
	if (text === null) {
		return (
			<div className="flex items-center justify-center gap-2 p-8 text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" /> 正在加载…
			</div>
		);
	}
	const content2 = text;

	const lang = language ?? getCodeLanguage(fileName);
	const isPlainText = lang === "plaintext";
	let html = "";
	if (!isPlainText && hljs.getLanguage(lang)) {
		try {
			html = hljs.highlight(content2, { language: lang }).value;
		} catch {
			html = "";
		}
	}
	if (!html) {
		const div = document.createElement("div");
		div.textContent = content2;
		html = div.innerHTML;
	}

	return (
		<div className="code-block max-h-[70vh]">
			<pre>
				<code dangerouslySetInnerHTML={{ __html: html }} />
			</pre>
		</div>
	);
}

// ---------- 未知类型：头部内容嗅探 ----------

/** 未知扩展名：取头 64KB 试着按文本解码——srt/eml/ini/log 等一切文本都能就地预览 */
function SniffPreview({
	url,
	fileName,
	downloadUrl,
}: {
	url: string;
	fileName: string;
	downloadUrl: string;
}) {
	const [state, setState] = useState<"sniffing" | "text" | "binary">(
		"sniffing"
	);
	const [content, setContent] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const { bytes } = await fetchByteRange(url, 0, 64 * 1024);
				let text: string | null = null;
				try {
					const decoded = new TextDecoder("utf-8", {
						fatal: true,
					}).decode(bytes);
					// 控制字符（除 \t \n \r）占比 >5% 视为二进制
					let bad = 0;
					for (let i = 0; i < decoded.length; i++) {
						const c = decoded.charCodeAt(i);
						if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
					}
					if (bad / Math.max(1, decoded.length) > 0.05) {
						throw new Error("binary");
					}
					text = decoded;
				} catch {
					/* 非 UTF-8 或二进制 */
				}
				if (cancelled) return;
				if (text && text.length > 0) {
					setContent(text);
					setState("text");
				} else {
					setState("binary");
				}
			} catch {
				if (!cancelled) setState("binary");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url]);

	if (state === "sniffing") {
		return (
			<div className="flex items-center justify-center gap-2 p-8 text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" /> 正在识别文件…
			</div>
		);
	}
	if (state === "text" && content !== null) {
		return <TextPreview content={content} fileName={fileName} language="plaintext" />;
	}
	return (
		<div className="flex flex-col items-center gap-4 p-10 text-center">
			<div className="text-5xl opacity-40">📄</div>
			<div>
				<p className="text-sm text-zinc-500">二进制文件，暂不支持在线预览</p>
				<p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
					文本 / 图片 / 音视频 / PDF / Office / zip 均可在线预览
				</p>
			</div>
			<a href={downloadUrl} download={fileName} className="btn-primary !py-1.5 !text-xs">
				<DownloadIcon className="h-4 w-4" />
				下载查看
			</a>
		</div>
	);
}

// ---------- Markdown ----------

function MarkdownPreview({ url }: { url: string }) {
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`加载失败 (${response.status})`);
				}
				const text = await response.text();
				const rendered = await marked.parse(text);
				if (!cancelled) {
					// marked 不净化原始 HTML：桶里任何来源的文件内容都可能携带脚本
					setHtml(
						typeof rendered === "string"
							? DOMPurify.sanitize(rendered)
							: ""
					);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "加载失败");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url]);

	// 渲染后对代码块做高亮
	useEffect(() => {
		if (!html || !containerRef.current) return;
		containerRef.current
			.querySelectorAll("pre code")
			.forEach((block) => {
				try {
					hljs.highlightElement(block as HTMLElement);
				} catch {
					// 忽略不支持的语言
				}
			});
	}, [html]);

	if (error) {
		return <div className="p-8 text-center text-red-500">{error}</div>;
	}
	if (html === null) {
		return (
			<div className="flex items-center justify-center gap-2 p-8 text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" /> 正在加载…
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="markdown-body max-h-[70vh] overflow-auto rounded-lg bg-white p-6 shadow-inner dark:bg-zinc-900"
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

// ---------- Office 文档 ----------

function DocxPreview({ url }: { url: string }) {
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`加载失败 (${response.status})`);
				}
				const buffer = await response.arrayBuffer();
				const mammoth = await import("mammoth");
				const result = await mammoth.convertToHtml(
					{ arrayBuffer: buffer },
					{ convertImage: undefined }
				);
				if (!cancelled) {
					setHtml(result.value);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "文档解析失败");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url]);

	if (error) {
		return <div className="p-8 text-center text-red-500">{error}</div>;
	}
	if (html === null) {
		return (
			<div className="flex items-center justify-center gap-2 p-8 text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" /> 正在解析文档…
			</div>
		);
	}

	return (
		<div
			className="markdown-body max-h-[70vh] overflow-auto rounded-lg bg-white p-6 shadow-inner dark:bg-zinc-900"
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

function SheetPreview({ url, fileName }: { url: string; fileName: string }) {
	const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
	const [active, setActive] = useState(0);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`加载失败 (${response.status})`);
				}
				const buffer = await response.arrayBuffer();
				// 浏览器端按需加载，避免 xlsx 的 Node stream 依赖进 SSR 包
				const XLSX = await import("xlsx");
				const workbook = XLSX.read(buffer, { type: "array" });
				const result = workbook.SheetNames.map((name) => ({
					name,
					html: XLSX.utils.sheet_to_html(workbook.Sheets[name], {
						editable: false,
					}),
				}));
				if (!cancelled) {
					setSheets(result);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "表格解析失败");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url]);

	if (error) {
		return <div className="p-8 text-center text-red-500">{error}</div>;
	}
	if (sheets.length === 0) {
		return (
			<div className="flex items-center justify-center gap-2 p-8 text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" /> 正在解析表格…
			</div>
		);
	}

	return (
		<div className="w-full">
			{sheets.length > 1 && (
				<div className="mb-3 flex flex-wrap gap-1.5">
					{sheets.map((sheet, index) => (
						<button
							key={sheet.name}
							type="button"
							onClick={() => setActive(index)}
							className={`rounded-md px-2.5 py-1 text-xs font-medium ${
								index === active
									? "bg-blue-600 text-white"
									: "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
							}`}
						>
							{sheet.name}
						</button>
					))}
				</div>
			)}
			<div
				className="preview-sheet max-h-[65vh] overflow-auto rounded-lg [&_table]:w-full [&_td]:border [&_td]:border-zinc-300 [&_td]:px-2 [&_td]:py-1 [&_td]:text-sm [&_th]:border [&_th]:border-zinc-300 [&_th]:bg-zinc-100 [&_th]:px-2 [&_th]:py-1 [&_th]:text-sm dark:[&_td]:border-zinc-700 dark:[&_td]:text-zinc-200 dark:[&_th]:border-zinc-700 dark:[&_th]:bg-zinc-800 dark:[&_th]:text-zinc-200"
				dangerouslySetInnerHTML={{ __html: sheets[active].html }}
			/>
			<p className="mt-2 text-center text-xs text-zinc-500">
				{fileName} · {sheets.length} 个工作表
			</p>
		</div>
	);
}

// ---------- ZIP 压缩包 ----------

interface ZipEntry {
	path: string;
	isDirectory: boolean;
	size: number;
}

/** 按字节窗口读取：源支持 Range 时直接取窗口；不支持时读满即断流（仅 start=0 时内容正确） */
async function fetchByteRange(
	url: string,
	start: number,
	length?: number
): Promise<{ bytes: Uint8Array; absStart: number; honored: boolean }> {
	const rangeValue =
		length !== undefined
			? `bytes=${start}-${start + length - 1}`
			: `bytes=${start}-`;
	const res = await fetch(url, { headers: { Range: rangeValue } });
	if (!res.ok) {
		throw new Error(`加载失败 (${res.status})`);
	}
	if (res.status === 206) {
		const contentRange = res.headers.get("Content-Range");
		const matched = contentRange ? /bytes (\d+)-/.exec(contentRange) : null;
		return {
			bytes: new Uint8Array(await res.arrayBuffer()),
			absStart: matched ? Number(matched[1]) : start,
			honored: true,
		};
	}
	// 200：源忽略了 Range。start=0 时读满 length 即断流（内容正确）；其他 start 无效
	if (start !== 0 || !res.body) {
		return { bytes: new Uint8Array(0), absStart: start, honored: false };
	}
	const capped =
		length !== undefined
			? length
			: Number(res.headers.get("Content-Length") || 0) || Number.MAX_SAFE_INTEGER;
	const reader = res.body.getReader();
	const parts: Uint8Array[] = [];
	let got = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		parts.push(value);
		got += value.byteLength;
		if (got >= capped) {
			await reader.cancel();
			break;
		}
	}
	const out = new Uint8Array(Math.min(got, capped));
	let offset = 0;
	for (const part of parts) {
		const take = Math.min(part.byteLength, out.byteLength - offset);
		out.set(part.subarray(0, take), offset);
		offset += take;
		if (offset >= out.byteLength) break;
	}
	return { bytes: out, absStart: 0, honored: false };
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
/** EOCD 固定 22 字节、后最多跟 64KB 注释——从尾部倒着扫 */
function findEocdOffset(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const min = Math.max(0, bytes.byteLength - 22 - 65535);
	for (let i = bytes.byteLength - 22; i >= min; i--) {
		if (view.getUint32(i, true) === EOCD_SIG) return i;
	}
	return -1;
}

/** 解析 central directory：ZIP 目录索引（文件名/大小/是否目录），字段布局固定 */
function parseCentralDirectory(cd: Uint8Array): ZipEntry[] {
	const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
	const entries: ZipEntry[] = [];
	let p = 0;
	while (p + 46 <= cd.byteLength) {
		if (view.getUint32(p, true) !== CEN_SIG) break;
		const flags = view.getUint16(p + 8, true);
		const uncompSize = view.getUint32(p + 24, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		if (p + 46 + nameLen > cd.byteLength) break;
		const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
		// bit11 = UTF-8 文件名；未置位时按 ZIP 规范是 cp437，windows-1252 近似解码即可读
		let path: string;
		try {
			path = new TextDecoder((flags & 0x800) !== 0 ? "utf-8" : "windows-1252").decode(
				nameBytes
			);
		} catch {
			path = String.fromCharCode(...nameBytes);
		}
		entries.push({ path, isDirectory: path.endsWith("/"), size: uncompSize });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

function ZipPreview({ url, size }: { url: string; size?: number }) {
	const [entries, setEntries] = useState<ZipEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notZip, setNotZip] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));

	useEffect(() => {
		let cancelled = false;
		setEntries(null);
		setError(null);
		setNotZip(false);
		(async () => {
			// 快路径：ZIP 的目录索引在文件尾部，Range 只取末尾 66KB 即可列出内容
			if (size !== undefined && size > 0) {
				try {
					const tailStart = Math.max(0, size - 66000);
					const tail = await fetchByteRange(url, tailStart);
					if (tail.honored && !cancelled) {
						const eocd = findEocdOffset(tail.bytes);
						if (eocd === -1) {
							// 尾部没有 EOCD：rar/7z/tar 等非 zip 压缩格式
							setNotZip(true);
							return;
						}
						const view = new DataView(
							tail.bytes.buffer,
							tail.bytes.byteOffset,
							tail.bytes.byteLength
						);
						const totalEntries = view.getUint16(eocd + 10, true);
						const cdSize = view.getUint32(eocd + 12, true);
						const cdOffset = view.getUint32(eocd + 16, true);
						if (totalEntries !== 0xffff && cdOffset !== 0xffffffff) {
							let cdBytes: Uint8Array;
							if (cdOffset >= tail.absStart) {
								// 目录索引已在取回的尾部窗口里
								cdBytes = tail.bytes.subarray(
									cdOffset - tail.absStart,
									cdOffset - tail.absStart + cdSize
								);
							} else {
								const cd = await fetchByteRange(url, cdOffset, cdSize);
								if (!cd.honored) {
									throw new Error("range-miss");
								}
								cdBytes = cd.bytes;
							}
							if (cancelled) return;
							const list = parseCentralDirectory(cdBytes);
							if (list.length > 0 || totalEntries === 0) {
								list.sort((a, b) => a.path.localeCompare(b.path));
								setEntries(list);
								return;
							}
						}
						// zip64 / 解析异常：落到慢路径
					}
				} catch {
					/* 快路径失败 → 慢路径兜底 */
				}
			}
			if (cancelled) return;
			// 慢路径：整包下载 + jszip（源不支持 Range，或 zip64 等异常结构）
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`加载失败 (${response.status})`);
				}
				const buffer = await response.arrayBuffer();
				// 浏览器端按需加载，避免 jszip 进 SSR 包
				const JSZip = (await import("jszip")).default;
				const zip = await JSZip.loadAsync(buffer);
				const list: ZipEntry[] = [];
				zip.forEach((path, file) => {
					list.push({
						path,
						isDirectory: file.dir,
						size: (file as unknown as { _data?: { uncompressedSize?: number } })._data
							?.uncompressedSize || 0,
					});
				});
				list.sort((a, b) => a.path.localeCompare(b.path));
				if (!cancelled) {
					setEntries(list);
				}
			} catch (err) {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "压缩包解析失败"
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url, size]);

	if (error) {
		return (
			<div className="flex flex-col items-center gap-3 p-8 text-center">
				<p className="text-sm text-red-500">{error}</p>
				<p className="text-xs text-zinc-500">
					仅支持 zip 格式在线列出；rar / 7z / tar 请下载后查看
				</p>
			</div>
		);
	}
	if (notZip) {
		return (
			<div className="flex flex-col items-center gap-3 p-10 text-center">
				<div className="text-5xl opacity-40">🗜️</div>
				<p className="text-sm text-zinc-500">
					该压缩格式暂不支持在线列出（目前支持 zip），请下载后查看
				</p>
			</div>
		);
	}
	if (entries === null) {
		return (
			<div className="flex items-center justify-center gap-2 p-8 text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" /> 正在解析压缩包…
			</div>
		);
	}

	// 按目录树展示。zip 可以没有显式目录条目（常见：直接打包文件），
	// 因此目录节点由更深的路径前缀合成虚拟目录，而不是只认显式条目
	const renderDir = (dirPath: string, depth: number) => {
		const prefix = dirPath; // "" 或 "dir1/"（含尾斜杠）
		const files: typeof entries = [];
		const dirs = new Set<string>();
		for (const entry of entries) {
			if (!entry.path.startsWith(prefix)) continue;
			const rest = entry.path.slice(prefix.length);
			if (!rest) continue; // 目录自身
			const slash = rest.indexOf("/");
			if (slash === -1) {
				if (!entry.isDirectory) files.push(entry);
			} else {
				dirs.add(rest.slice(0, slash + 1));
			}
		}
		const dirNames = [...dirs].sort((a, b) => a.localeCompare(b));
		files.sort((a, b) => a.path.localeCompare(b.path));

		return (
			<>
				{dirNames.map((dirName) => {
					const fullPath = prefix + dirName;
					const isOpen = expanded.has(fullPath);
					return (
						<div key={fullPath}>
							<button
								type="button"
								className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
								style={{ paddingLeft: `${depth * 16 + 6}px` }}
								onClick={() => {
									setExpanded((prev) => {
										const next = new Set(prev);
										if (next.has(fullPath)) {
											next.delete(fullPath);
										} else {
											next.add(fullPath);
										}
										return next;
									});
								}}
							>
								<span className="text-xs text-zinc-500">
									{isOpen ? "▾" : "▸"}
								</span>
								<span className="font-medium text-blue-600 dark:text-blue-400">
									{dirName}
								</span>
							</button>
							{isOpen && renderDir(fullPath, depth + 1)}
						</div>
					);
				})}
				{files.map((entry) => (
					<div
						key={entry.path}
						className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
						style={{ paddingLeft: `${depth * 16 + 22}px` }}
					>
						<span className="truncate text-zinc-700 dark:text-zinc-300">
							{entry.path.slice(prefix.length)}
						</span>
						<span className="shrink-0 text-xs text-zinc-500">
							{formatSize(entry.size)}
						</span>
					</div>
				))}
			</>
		);
	};

	return (
		<div className="max-h-[70vh] w-full overflow-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
			{entries.length === 0 ? (
				<p className="p-4 text-center text-sm text-zinc-500">压缩包为空</p>
			) : (
				renderDir("", 0)
			)}
		</div>
	);
}

// ---------- 视频带时长显示 ----------

function VideoPreview({
	url,
	onError,
}: {
	url: string;
	onError?: () => void;
}) {
	const [duration, setDuration] = useState<number | null>(null);
	const onLoadedMetadata = useCallback(
		(event: React.SyntheticEvent<HTMLVideoElement>) => {
			const value = event.currentTarget.duration;
			if (Number.isFinite(value)) {
				setDuration(value);
			}
		},
		[]
	);

	return (
		<div className="flex w-full flex-col items-center gap-2">
			<video
				className="max-h-[65vh] w-auto max-w-full rounded-lg bg-black"
				src={url}
				controls
				autoPlay
				onLoadedMetadata={onLoadedMetadata}
				onError={onError}
			/>
			{duration !== null && (
				<p className="text-xs text-zinc-500">
					时长 {formatDuration(duration)}
				</p>
			)}
		</div>
	);
}

// ---------- 主组件 ----------

export function FilePreview({
	storageId,
	path,
	fileName,
	size,
	token,
	password,
	poolFileId,
	onClose,
}: FilePreviewProps) {
	const fileType = useMemo(() => getFileType(fileName), [fileName]);
	const [currentType, setCurrentType] = useState(fileType);

	// ESC 关闭
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", handler);
		return () => {
			window.removeEventListener("keydown", handler);
		};
	}, [onClose]);

	// 聚合盘文件：数据源只有 /api/pool/:id（无签名直链，Worker 流式拼接）
	const poolDownloadUrl = poolFileId
		? `/api/pool/${poolFileId}?download=1`
		: null;
	const poolInlineUrl = poolFileId ? `/api/pool/${poolFileId}?inline=1` : null;
	const downloadUrl =
		poolDownloadUrl ??
		buildUrl(
			storageId,
			path,
			{ action: "download" },
			token,
			password
		);
	const inlineUrl =
		poolInlineUrl ??
		buildUrl(
			storageId,
			path,
			{ action: "download", inline: "1" },
			token,
			password
		);
	// 媒体类（图/视频/音频/PDF）优先签名直链：视频可用 Range 拖进度、不占 Workers 流量；
	// 聚合盘无直链可用，直接用 inline 流（视频不能拖进度，但能顺序播放）
	const isMediaType = ["image", "video", "audio", "pdf"].includes(currentType);
	const media = useMediaSrc(
		storageId,
		path,
		inlineUrl,
		isMediaType && !poolInlineUrl,
		token,
		password,
		poolInlineUrl
	);

	const renderContent = () => {
		switch (currentType) {
			case "image":
				return media.src ? (
					<img
						className="max-h-[70vh] w-auto max-w-full rounded-lg object-contain"
						src={media.src}
						alt={fileName}
						onError={media.handleError}
					/>
				) : (
					<MediaLoading />
				);
			case "video":
				return media.src ? (
					<VideoPreview url={media.src} onError={media.handleError} />
				) : (
					<MediaLoading />
				);
			case "audio":
				return (
					<div className="flex w-full max-w-lg flex-col items-center gap-4 p-8">
						<div className="flex h-32 w-32 items-center justify-center rounded-2xl bg-gradient-to-br from-pink-500/20 to-purple-500/20 text-5xl">
							🎵
						</div>
						{media.src ? (
							<audio
								className="w-full"
								src={media.src}
								controls
								autoPlay
								onError={media.handleError}
							/>
						) : (
							<SpinnerIcon className="h-6 w-6 animate-spin text-zinc-400" />
						)}
					</div>
				);
			case "markdown":
				return <MarkdownPreview url={inlineUrl} />;
			case "code":
				return <TextPreview url={inlineUrl} fileName={fileName} />;
			case "text":
				return <TextPreview url={inlineUrl} fileName={fileName} language="plaintext" />;
			case "pdf":
				return media.src ? (
					<iframe
						className="h-[70vh] w-full rounded-lg bg-white lg:w-[60vw]"
						src={media.src}
						title={fileName}
					/>
				) : (
					<MediaLoading />
				);
			case "docx":
				return <DocxPreview url={inlineUrl} />;
			case "xlsx":
				return <SheetPreview url={inlineUrl} fileName={fileName} />;
			case "archive":
				return <ZipPreview url={inlineUrl} size={size} />;
			default:
				return (
					<SniffPreview
						url={inlineUrl}
						fileName={fileName}
						downloadUrl={downloadUrl}
					/>
				);
		}
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
			onClick={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-zinc-50 shadow-2xl dark:bg-zinc-900">
				{/* 顶栏 */}
				<div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
					<div className="min-w-0 flex-1">
						<h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
							{fileName}
						</h3>
						{size !== undefined && (
							<p className="text-xs text-zinc-500">{formatSize(size)}</p>
						)}
					</div>
					<a
						href={downloadUrl}
						download={fileName}
						className="btn-outline !py-1"
						title="下载"
					>
						<DownloadIcon className="h-4 w-4" />
						<span className="hidden sm:inline">下载</span>
					</a>
					<button
						type="button"
						className="btn-ghost !px-2"
						onClick={onClose}
						title="关闭 (Esc)"
					>
						<CloseIcon className="h-4 w-4" />
					</button>
				</div>

				{/* 内容区 */}
				<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
					{renderContent()}
				</div>
			</div>
		</div>
	);
}
