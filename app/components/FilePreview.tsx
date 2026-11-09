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
	password?: string
): { src: string | null; handleError: () => void } {
	const [signed, setSigned] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!enabled) return;
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
	}, [storageId, path, enabled, token, password]);

	// 直链还没回来时返回 null（外层显示加载中）；明确失败则回退代理
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
}: {
	url: string;
	fileName: string;
	language?: string;
}) {
	const [content, setContent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`加载失败 (${response.status})`);
				}
				const text = await response.text();
				if (!cancelled) {
					// 超大文本截断，避免浏览器卡死
					setContent(text.length > 2 * 1024 * 1024 ? text.slice(0, 2 * 1024 * 1024) + "\n\n… (内容已截断)" : text);
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

	if (error) {
		return <div className="p-8 text-center text-red-500">{error}</div>;
	}
	if (content === null) {
		return (
			<div className="flex items-center justify-center gap-2 p-8 text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" /> 正在加载…
			</div>
		);
	}

	const lang = language ?? getCodeLanguage(fileName);
	const isPlainText = lang === "plaintext";
	let html = "";
	if (!isPlainText && hljs.getLanguage(lang)) {
		try {
			html = hljs.highlight(content, { language: lang }).value;
		} catch {
			html = "";
		}
	}
	if (!html) {
		const div = document.createElement("div");
		div.textContent = content;
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

function ZipPreview({ url }: { url: string }) {
	const [entries, setEntries] = useState<ZipEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));

	useEffect(() => {
		let cancelled = false;
		(async () => {
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
						size: (file as any)._data?.uncompressedSize || 0,
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
	}, [url]);

	if (error) {
		return <div className="p-8 text-center text-red-500">{error}</div>;
	}
	if (entries === null) {
		return (
			<div className="flex items-center justify-center gap-2 p-8 text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" /> 正在解析压缩包…
			</div>
		);
	}

	// 按目录树展示
	const renderDir = (dirPath: string, depth: number) => {
		const children = entries.filter((entry) => {
			if (dirPath) {
				return (
					entry.path.startsWith(dirPath) &&
					entry.path !== dirPath &&
					!entry.path
						.slice(dirPath.length)
						.includes("/")
				);
			}
			return !entry.path.includes("/");
		});

		return children.map((entry) => {
			const isDir = entry.isDirectory || entry.path.endsWith("/");
			const displayName = entry.path.split("/").filter(Boolean).pop() || "";
			const fullPath = dirPath ? entry.path : entry.path;
			if (isDir) {
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
							<span className="text-xs text-zinc-500">{isOpen ? "▾" : "▸"}</span>
							<span className="font-medium text-blue-600 dark:text-blue-400">
								{displayName}/
							</span>
						</button>
						{isOpen && renderDir(fullPath, depth + 1)}
					</div>
				);
			}
			return (
				<div
					key={fullPath}
					className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
					style={{ paddingLeft: `${depth * 16 + 22}px` }}
				>
					<span className="truncate text-zinc-700 dark:text-zinc-300">
						{displayName}
					</span>
					<span className="shrink-0 text-xs text-zinc-500">
						{formatSize(entry.size)}
					</span>
				</div>
			);
		});
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

	const downloadUrl = buildUrl(
		storageId,
		path,
		{ action: "download" },
		token,
		password
	);
	const inlineUrl = buildUrl(
		storageId,
		path,
		{ action: "download", inline: "1" },
		token,
		password
	);
	// 媒体类（图/视频/音频/PDF）优先签名直链：视频可用 Range 拖进度、不占 Workers 流量
	const isMediaType = ["image", "video", "audio", "pdf"].includes(currentType);
	const media = useMediaSrc(
		storageId,
		path,
		inlineUrl,
		isMediaType,
		token,
		password
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
				return <ZipPreview url={inlineUrl} />;
			default:
				return (
					<div className="flex flex-col items-center gap-3 p-10 text-center">
						<div className="text-5xl opacity-40">📄</div>
						<p className="text-sm text-zinc-500">
							该文件类型暂不支持在线预览，请下载后查看
						</p>
					</div>
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
