import type { Route } from "./+types/home";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { marked } from "marked";
import { requireAuth } from "~/lib/auth";
import { getAllStorages, initDatabase } from "~/lib/storage";
import {
	getVisibleFolders,
	buildFolderTree,
	resolveFolderAccess,
	type Folder,
} from "~/lib/folders";

// ---------- 带权限的目录树节点 ----------

export interface FolderNode extends Folder {
	children: FolderNode[];
	access: { list: boolean; download: boolean; upload: boolean };
}

function enrichFolderTree(
	nodes: ReturnType<typeof buildFolderTree>,
	accessMap: Map<number, { list: boolean; download: boolean; upload: boolean }>
): FolderNode[] {
	return nodes.map((node) => ({
		...node,
		access:
			accessMap.get(node.id) || { list: false, download: false, upload: false },
		children: enrichFolderTree(node.children, accessMap),
	}));
}
import { getFileType, isPreviewable } from "~/lib/file-utils";
import { apiFileUrl } from "~/lib/api-path";
import { FilePreview } from "~/components/FilePreview";
import {
	AdminPanel,
	StorageFormDialog,
	type StorageInfo,
} from "~/components/admin-panel";
import {
	ConfirmDialog,
	LoginDialog,
	NewFolderDialog,
	OfflineDownloadDialog,
	ProfileDialog,
	PromptDialog,
	ShareDialog,
	StatsDialog,
	TextEditorDialog,
	type CurrentUser,
	type StorageOption,
} from "~/components/dialogs";
import {
	CheckIcon,
	ChevronRightIcon,
	CloseIcon,
	CloudIcon,
	DownloadIcon,
	EyeIcon,
	FileTypeIcon,
	FolderIcon,
	FolderPlusIcon,
	GlobeIcon,
	HomeIcon,
	LinkIcon,
	LoginIcon,
	LogoutIcon,
	MoonIcon,
	MoveIcon,
	MoreIcon,
	RefreshIcon,
	RenameIcon,
	SearchIcon,
	ShareIcon,
	ShieldIcon,
	SpinnerIcon,
	StatsIcon,
	SunIcon,
	StorageIcon,
	TrashIcon,
	UploadIcon,
} from "~/components/icons";

marked.setOptions({ gfm: true, breaks: true });

// ---------- 路由：元信息 + 数据加载 ----------

export function meta({ data }: Route.MetaArgs) {
	const title = data?.siteTitle || "WList";
	return [
		{ title: `${title} - 存储中心` },
		{ name: "description", content: "多网盘聚合的私有存储中心" },
	];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	const siteTitle = context.cloudflare.env.SITE_TITLE || "WList";
	const siteAnnouncement = context.cloudflare.env.SITE_ANNOUNCEMENT || "";
	const chunkSizeMB = parseInt(context.cloudflare.env.CHUNK_SIZE_MB || "10", 10);
	const webdavEnabled =
		(context.cloudflare.env.WEBDAV_ENABLED as string | undefined) === "true";

	if (!db) {
		return {
			isAdmin: false,
			user: null,
			githubEnabled: false,
			folders: [],
			storages: [],
			siteTitle,
			siteAnnouncement,
			chunkSizeMB,
			webdavEnabled: false,
		};
	}

	await initDatabase(db);

	const { user, isAdmin } = await requireAuth(request, db);
	const githubEnabled = !!context.cloudflare.env.GITHUB_CLIENT_ID;
	const identity = user ? { id: user.id, role: user.role } : null;

	// 虚拟目录树：管理员全部；用户/访客 = 公开 ∪ 被授权（含子树与祖先链）
	const folders = await getVisibleFolders(db, identity);

	// 每个目录对当前身份的实际权限
	const accessMap = new Map<
		number,
		{ list: boolean; download: boolean; upload: boolean }
	>();
	for (const folder of folders) {
		if (isAdmin) {
			accessMap.set(folder.id, { list: true, download: true, upload: true });
		} else {
			const access = await resolveFolderAccess(
				db,
				identity,
				folder.storageId,
				folder.storagePath
			);
			accessMap.set(folder.id, {
				list: access.list,
				download: access.download,
				upload: access.upload,
			});
		}
	}

	// 桶列表：管理员可见（存储后端原始入口）；普通身份用于权限计算
	const storages = isAdmin
		? await getAllStorages(db)
		: await getAllStorages(db);

	return {
		isAdmin,
		user: user
			? {
					id: user.id,
					username: user.username,
					displayName: user.displayName,
					bio: user.bio,
					avatarUrl: user.avatarUrl,
					role: user.role,
					githubLogin: user.githubLogin,
				}
			: null,
		githubEnabled,
		siteTitle,
		siteAnnouncement,
		chunkSizeMB,
		webdavEnabled,
		folders: enrichFolderTree(buildFolderTree(folders), accessMap),
		storages: storages.map((s) => ({
			id: s.id,
			name: s.name,
			type: s.type,
			endpoint: s.endpoint,
			region: s.region,
			accessKeyId: s.accessKeyId,
			bucket: s.bucket,
			basePath: s.basePath,
			// 扩展配置（refresh_token 等）只给管理员
			config: isAdmin ? s.config : undefined,
			isPublic: s.isPublic,
			guestList: s.guestList,
			guestDownload: s.guestDownload,
			guestUpload: s.guestUpload,
			// 桶级权限（管理员全通）
			access: isAdmin
				? { list: true, download: true, upload: true }
				: { list: false, download: false, upload: false },
		})),
	};
}

// ---------- 类型与工具 ----------

interface S3Object {
	key: string;
	name: string;
	size: number;
	lastModified: string;
	isDirectory: boolean;
}

/** 除百度网盘（不支持分块）外全部支持 */
function supportsMultipart(type?: string): boolean {
	return type !== "baiduyun";
}

function formatBytes(bytes: number): string {
	if (!bytes || bytes <= 0) return "-";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = bytes;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSecond: number): string {
	if (!bytesPerSecond || bytesPerSecond <= 0) return "-";
	return `${formatBytes(bytesPerSecond)}/s`;
}

function formatDate(dateStr: string): string {
	if (!dateStr) return "-";
	const date = new Date(dateStr);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toLocaleString("zh-CN", { hour12: false });
}

/** 目录 key 去掉尾部斜杠用于导航；文件 key 原样 */
function normalizeDirPath(key: string): string {
	return key.replace(/\/+$/, "");
}

// ---------- 本地弹窗外壳（与 dialogs.tsx 的 ModalShell 同款式） ----------

function Modal({
	title,
	onClose,
	children,
	footer,
	width = "max-w-md",
}: {
	title: string;
	onClose: () => void;
	children: React.ReactNode;
	footer?: React.ReactNode;
	width?: string;
}) {
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onClose]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className={`w-full ${width} overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900`}
			>
				<div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
					<h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
						{title}
					</h3>
					<button type="button" className="btn-ghost !px-1.5" onClick={onClose}>
						<CloseIcon className="h-4 w-4" />
					</button>
				</div>
				<div className="max-h-[70vh] overflow-auto px-5 py-4">{children}</div>
				{footer && (
					<div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
						{footer}
					</div>
				)}
			</div>
		</div>
	);
}

// ---------- 移动到指定文件夹 ----------

function MoveDialog({
	storage,
	obj,
	onMoved,
	onClose,
}: {
	storage: StorageInfo;
	obj: S3Object;
	onMoved: () => void;
	onClose: () => void;
}) {
	const [folders, setFolders] = useState<string[] | null>(null);
	const [dest, setDest] = useState("");
	const [moving, setMoving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 递归枚举全部文件夹作为目标选项
	useEffect(() => {
		let cancelled = false;
		const collected: string[] = [];
		const walk = async (prefix: string) => {
			if (cancelled) return;
			try {
				const res = await fetch(
					apiFileUrl(storage.id, prefix, { action: "list" })
				);
				if (!res.ok) return;
				const data = (await res.json()) as { objects?: S3Object[] };
				for (const item of data.objects || []) {
					if (item.isDirectory) {
						const clean = normalizeDirPath(item.key);
						collected.push(clean);
						if (collected.length < 500) {
							await walk(clean);
						}
					}
				}
			} catch {
				// 单个目录失败忽略
			}
		};
		(async () => {
			await walk("");
			if (!cancelled) setFolders(collected);
		})();
		return () => {
			cancelled = true;
		};
	}, [storage.id]);

	const currentDir = normalizeDirPath(obj.key).split("/").slice(0, -1).join("/");

	const handleMove = async (event: React.FormEvent) => {
		event.preventDefault();
		setMoving(true);
		setError(null);
		try {
			const res = await fetch(
				apiFileUrl(storage.id, obj.key, { action: "move" }),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ destPath: dest }),
				}
			);
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error || "移动失败");
			}
			onMoved();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "移动失败");
		} finally {
			setMoving(false);
		}
	};

	return (
		<Modal
			title={`移动「${obj.name}」`}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						form="wlist-move-form"
						className="btn-primary"
						disabled={moving || folders === null}
					>
						{moving && <SpinnerIcon className="h-4 w-4 animate-spin" />}
						移动
					</button>
				</>
			}
		>
			<form id="wlist-move-form" className="space-y-3" onSubmit={handleMove}>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						目标文件夹
					</label>
					{folders === null ? (
						<div className="flex items-center gap-2 py-2 text-sm text-zinc-500">
							<SpinnerIcon className="h-4 w-4 animate-spin" />
							正在枚举文件夹…
						</div>
					) : (
						<select
							className="input"
							value={dest}
							onChange={(event) => setDest(event.target.value)}
						>
							<option value="/">/（根目录）</option>
							{folders.map((folder) => (
								<option key={folder} value={folder}>
									/{folder}
								</option>
							))}
						</select>
					)}
				</div>
				{currentDir && (
					<p className="text-xs text-zinc-500">当前位于 /{currentDir}</p>
				)}
				{error && (
					<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
						{error}
					</p>
				)}
			</form>
		</Modal>
	);
}

// ---------- 文件浏览器 ----------

interface UploadProgressState {
	name: string;
	progress: number;
	currentPart?: number;
	totalParts?: number;
	speed?: number;
	loaded?: number;
	total?: number;
	/** 队列剩余（含当前） */
	queueIndex?: number;
	queueTotal?: number;
}

function FileBrowser({
	storage,
	isAdmin,
	chunkSizeMB,
	initialPath,
	rootLabel,
	currentFolderId,
	folderAccess,
	storageOptions,
	onFoldersChanged,
}: {
	storage: StorageInfo;
	isAdmin: boolean;
	chunkSizeMB: number;
	/** 侧边栏进入时的起始路径 */
	initialPath: string;
	/** 面包屑根名称（目录名或桶名） */
	rootLabel: string;
	/** 当前所在虚拟目录 ID（用于在其下建子目录），浏览桶根时为 null */
	currentFolderId: number | null;
	/** 当前虚拟目录的访问权限（管理员忽略） */
	folderAccess: { list: boolean; download: boolean; upload: boolean };
	/** 当前用户可上传的桶（供"新建文件"对话框选择目标） */
	storageOptions: StorageOption[];
	/** 目录树变更后刷新侧边栏 */
	onFoldersChanged: () => void;
}) {
	// 权限：管理员全通；否则来自所在虚拟目录
	const canList = isAdmin || folderAccess.list;
	const canDownload = isAdmin || folderAccess.download;
	const canUpload = isAdmin || folderAccess.upload;
	// 重命名 / 移动 / 删除 / 离线下载仅管理员
	const canManage = isAdmin;

	// 浏览状态
	const [path, setPath] = useState(
		(initialPath || "").replace(/^\/+|\/+$/g, "")
	);
	const [objects, setObjects] = useState<S3Object[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	// 界面状态
	const [searchQuery, setSearchQuery] = useState("");
	const [deepSearch, setDeepSearch] = useState(false);
	const [deepResults, setDeepResults] = useState<S3Object[] | null>(null);
	const [deepLoading, setDeepLoading] = useState(false);
	const [viewMode, setViewMode] = useState<"list" | "grid">("list");
	const [sortKey, setSortKey] = useState<"name" | "size" | "lastModified">("name");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const [cursor, setCursor] = useState(-1);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		obj: S3Object;
	} | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const [readme, setReadme] = useState<string | null>(null);

	// 上传
	const [uploadProgress, setUploadProgress] =
		useState<UploadProgressState | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// 弹窗
	const [previewFile, setPreviewFile] = useState<S3Object | null>(null);
	const [confirmState, setConfirmState] = useState<{
		title: string;
		message: React.ReactNode;
		confirmText?: string;
		onConfirm: () => void | Promise<void>;
	} | null>(null);
	const [promptState, setPromptState] = useState<{
		title: string;
		label?: string;
		initialValue?: string;
		placeholder?: string;
		confirmText?: string;
		onSubmit: (value: string) => void | Promise<void>;
	} | null>(null);
	const [moveTarget, setMoveTarget] = useState<S3Object | null>(null);
	const [shareTarget, setShareTarget] = useState<S3Object | null>(null);
	const [showStats, setShowStats] = useState(false);
	const [showOffline, setShowOffline] = useState(false);
	/** null=关闭；{existing}=编辑已有文件；{}=新建 */
	const [editorState, setEditorState] = useState<{
		existing?: S3Object;
	} | null>(null);
	const [showNewFolder, setShowNewFolder] = useState(false);

	// 切换存储时重置（组件本身按 storageId+path 重挂载，这里兜底）
	useEffect(() => {
		setSearchQuery("");
		setDeepResults(null);
		setDeepSearch(false);
		setReadme(null);
	}, [storage.id, initialPath]);

	const loadFiles = useCallback(async () => {
		if (!canList) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError("");
		try {
			const res = await fetch(apiFileUrl(storage.id, path, { action: "list" }));
			if (res.ok) {
				const data = (await res.json()) as { objects?: S3Object[] };
				setObjects(data.objects || []);
			} else {
				const data = (await res.json()) as { error?: string };
				setObjects([]);
				setError(data.error || "加载失败");
			}
		} catch {
			setObjects([]);
			setError("网络错误");
		} finally {
			setLoading(false);
		}
	}, [storage.id, path, canList]);

	useEffect(() => {
		loadFiles();
		setSelectedKeys(new Set());
		setCursor(-1);
	}, [loadFiles]);

	// 目录 README.md 自动渲染
	useEffect(() => {
		setReadme(null);
		if (!objects.length) return;
		const readmeFile = objects.find(
			(obj) => !obj.isDirectory && /^readme\.md$/i.test(obj.name)
		);
		if (!readmeFile || !canDownload) return;
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(
					apiFileUrl(storage.id, readmeFile.key, {
						action: "download",
						inline: "1",
					})
				);
				if (!res.ok) return;
				const text = await res.text();
				const html = await marked.parse(text);
				if (!cancelled) {
					setReadme(typeof html === "string" ? html : null);
				}
			} catch {
				// README 拉取失败静默忽略
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [objects, storage.id, canDownload]);

	// ---------- 导航 ----------

	const navigateTo = (newPath: string) => {
		setPath(newPath.replace(/^\/+/, "").replace(/\/+$/, ""));
	};

	const goUp = useCallback(() => {
		setPath((prev) => {
			const parts = prev.split("/").filter(Boolean);
			parts.pop();
			return parts.join("/");
		});
	}, []);

	// ---------- 过滤 / 排序 ----------

	const visibleObjects = useMemo(() => {
		const list = deepSearch && deepResults !== null ? deepResults : objects;
		const filtered = searchQuery.trim()
			? list.filter((obj) =>
					obj.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
				)
			: list;
		const dir = sortDir === "asc" ? 1 : -1;
		return [...filtered].sort((a, b) => {
			// 文件夹永远排在文件前面
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			let cmp = 0;
			if (sortKey === "name") {
				cmp = a.name.localeCompare(b.name, "zh-CN");
			} else if (sortKey === "size") {
				cmp = a.size - b.size;
			} else {
				cmp = (a.lastModified || "").localeCompare(b.lastModified || "");
			}
			return cmp * dir;
		});
	}, [objects, deepSearch, deepResults, searchQuery, sortKey, sortDir]);

	const allVisibleSelected =
		visibleObjects.length > 0 &&
		visibleObjects.every((obj) => selectedKeys.has(obj.key));

	// ---------- 深度搜索（递归遍历子目录） ----------

	const runDeepSearch = useCallback(
		async (query: string) => {
			if (!query.trim()) {
				setDeepResults(null);
				return;
			}
			setDeepLoading(true);
			const results: S3Object[] = [];
			let visitedDirs = 0;
			const walk = async (prefix: string) => {
				if (visitedDirs >= 300 || results.length >= 500) return;
				visitedDirs++;
				try {
					const res = await fetch(
						apiFileUrl(storage.id, prefix, { action: "list" })
					);
					if (!res.ok) return;
					const data = (await res.json()) as { objects?: S3Object[] };
					for (const obj of data.objects || []) {
						if (obj.isDirectory) {
							await walk(obj.key);
						} else if (
							obj.name.toLowerCase().includes(query.trim().toLowerCase())
						) {
							results.push(obj);
						}
					}
				} catch {
					// 单个目录失败忽略
				}
			};
			await walk(path);
			setDeepResults(results);
			setDeepLoading(false);
		},
		[storage.id, path]
	);

	// ---------- 上传 ----------

	/** 单文件直传（PUT 走 Workers 代理，带进度） */
	const uploadSingle = (file: File, uploadPath: string) => {
		return new Promise<void>((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) {
					setUploadProgress((prev) => ({
						name: file.name,
						progress: Math.round((event.loaded / event.total) * 100),
						loaded: event.loaded,
						total: event.total,
						...prev,
					}));
				}
			};
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					try {
						const data = JSON.parse(xhr.responseText);
						reject(new Error(data.error || "上传失败"));
					} catch {
						reject(new Error("上传失败"));
					}
				}
			};
			xhr.onerror = () => reject(new Error("网络错误"));
			xhr.open("PUT", apiFileUrl(storage.id, uploadPath));
			xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
			xhr.send(file);
		});
	};

	/** 分块上传：优先直传预签名 URL，失败回退 Workers 代理；localStorage 记录进度支持续传 */
	const uploadMultipart = async (
		file: File,
		uploadPath: string,
		chunkSize: number
	) => {
		const totalParts = Math.ceil(file.size / chunkSize);
		const contentType = file.type || "application/octet-stream";
		const storageKey = `wlist_multipart_${storage.id}_${uploadPath}_${file.size}`;
		const savedState = localStorage.getItem(storageKey);

		let uploadId: string | undefined;
		let completedParts: { partNumber: number; etag: string }[] = [];
		let startPart = 0;
		let useDirectUpload = true;

		// 断点续传
		if (savedState) {
			try {
				const parsed = JSON.parse(savedState) as {
					uploadId?: string;
					parts?: { partNumber: number; etag: string }[];
					fileName?: string;
					useDirectUpload?: boolean;
				};
				if (parsed.uploadId && parsed.parts && parsed.fileName === file.name) {
					const shouldResume = window.confirm(
						`检测到未完成的上传「${file.name}」，是否继续？\n已完成 ${parsed.parts.length}/${totalParts} 分块`
					);
					if (shouldResume) {
						uploadId = parsed.uploadId;
						completedParts = parsed.parts;
						startPart = completedParts.length;
						useDirectUpload = parsed.useDirectUpload ?? true;
					} else {
						try {
							await fetch(
								apiFileUrl(storage.id, uploadPath, {
									action: "multipart-abort",
								}),
								{
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ uploadId: parsed.uploadId }),
								}
							);
						} catch {
							// 中止失败忽略
						}
						localStorage.removeItem(storageKey);
					}
				}
			} catch {
				// 无效状态忽略
			}
		}

		// 初始化新的分块上传
		if (!uploadId) {
			setUploadProgress({
				name: file.name,
				progress: 0,
				currentPart: 0,
				totalParts,
				loaded: 0,
				total: file.size,
			});
			const initRes = await fetch(
				apiFileUrl(storage.id, uploadPath, { action: "multipart-init" }),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ contentType, size: file.size, chunkSize }),
				}
			);
			if (!initRes.ok) {
				const data = (await initRes.json()) as { error?: string };
				throw new Error(data.error || "初始化分块上传失败");
			}
			const initData = (await initRes.json()) as { uploadId: string };
			uploadId = initData.uploadId;
			localStorage.setItem(
				storageKey,
				JSON.stringify({
					uploadId,
					fileName: file.name,
					parts: [],
					useDirectUpload: true,
				})
			);
		}

		// 进度统计
		let totalBytesUploaded = startPart * chunkSize;
		const startTime = Date.now();
		const partProgress: Record<number, number> = {};
		const currentUploadId = uploadId;
		// 直传预签名 URL（惰性获取；客户端不支持时为空，走代理）
		let signedUrls: Record<number, string> = {};

		const persistState = () => {
			localStorage.setItem(
				storageKey,
				JSON.stringify({
					uploadId: currentUploadId,
					fileName: file.name,
					parts: completedParts,
					useDirectUpload,
				})
			);
		};

		const updateProgress = () => {
			const currentBytes =
				totalBytesUploaded +
				Object.values(partProgress).reduce((sum, v) => sum + v, 0);
			const elapsed = (Date.now() - startTime) / 1000;
			setUploadProgress({
				name: file.name,
				progress: Math.min(Math.round((currentBytes / file.size) * 100), 100),
				currentPart: completedParts.length,
				totalParts,
				speed: elapsed > 0 ? currentBytes / elapsed : 0,
				loaded: currentBytes,
				total: file.size,
			});
		};

		const uploadPartDirect = (
			chunk: Blob,
			url: string,
			partNumber: number
		): Promise<{ partNumber: number; etag: string }> =>
			new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable) {
						partProgress[partNumber] = event.loaded;
						updateProgress();
					}
				};
				xhr.onload = () => {
					delete partProgress[partNumber];
					if (xhr.status >= 200 && xhr.status < 300) {
						const etag = xhr.getResponseHeader("ETag")?.replace(/"/g, "") || "";
						totalBytesUploaded += chunk.size;
						resolve({ partNumber, etag });
					} else {
						reject(new Error(`直传失败: ${xhr.status}`));
					}
				};
				xhr.onerror = () => {
					delete partProgress[partNumber];
					reject(new Error("直传网络错误"));
				};
				xhr.open("PUT", url);
				xhr.send(chunk);
			});

		const uploadPartProxy = (
			chunk: Blob,
			partNumber: number
		): Promise<{ partNumber: number; etag: string }> =>
			new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable) {
						partProgress[partNumber] = event.loaded;
						updateProgress();
					}
				};
				xhr.onload = () => {
					delete partProgress[partNumber];
					if (xhr.status >= 200 && xhr.status < 300) {
						try {
							const data = JSON.parse(xhr.responseText);
							totalBytesUploaded += chunk.size;
							resolve({ partNumber, etag: data.etag || "" });
						} catch {
							reject(new Error("上传分块响应异常"));
						}
					} else {
						try {
							const data = JSON.parse(xhr.responseText);
							reject(new Error(data.error || "上传分块失败"));
						} catch {
							reject(new Error("上传分块失败"));
						}
					}
				};
				xhr.onerror = () => {
					delete partProgress[partNumber];
					reject(new Error("网络错误"));
				};
				xhr.open(
					"PUT",
					apiFileUrl(storage.id, uploadPath, {
						action: "multipart-upload",
						uploadId: currentUploadId,
						partNumber: String(partNumber),
					})
				);
				xhr.send(chunk);
			});

		const uploadPart = async (item: {
			partNumber: number;
			start: number;
			end: number;
		}) => {
			const chunk = file.slice(item.start, item.end);
			if (useDirectUpload && signedUrls[item.partNumber]) {
				try {
					return await uploadPartDirect(chunk, signedUrls[item.partNumber], item.partNumber);
				} catch {
					// CORS / 网络问题 → 切换代理模式并记入断点状态
					useDirectUpload = false;
					persistState();
				}
			}
			return uploadPartProxy(chunk, item.partNumber);
		};

		try {
			const remainingParts = Array.from(
				{ length: totalParts - startPart },
				(_, i) => startPart + i + 1
			);

			// 批量获取直传 URL（客户端不支持签名时返回空，自动走代理）
			if (useDirectUpload && remainingParts.length > 0) {
				try {
					const urlsRes = await fetch(
						apiFileUrl(storage.id, uploadPath, { action: "multipart-urls" }),
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								uploadId: currentUploadId,
								partNumbers: remainingParts,
							}),
						}
					);
					if (urlsRes.ok) {
						const data = (await urlsRes.json()) as {
							urls: Record<number, string>;
						};
						signedUrls = data.urls || {};
					}
				} catch {
					// 回退代理
				}
			}

			const queue = remainingParts.map((partNumber) => ({
				partNumber,
				start: (partNumber - 1) * chunkSize,
				end: Math.min(partNumber * chunkSize, file.size),
			}));

			// 并发池：同时最多 4 个分块
			const CONCURRENT = 4;
			let nextIndex = 0;
			const worker = async () => {
				while (nextIndex < queue.length) {
					const item = queue[nextIndex++];
					const result = await uploadPart(item);
					completedParts.push(result);
					persistState();
					updateProgress();
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(CONCURRENT, queue.length) }, worker)
			);

			// 完成合并（S3 要求按分块号升序）
			completedParts.sort((a, b) => a.partNumber - b.partNumber);
			const completeRes = await fetch(
				apiFileUrl(storage.id, uploadPath, { action: "multipart-complete" }),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						uploadId: currentUploadId,
						parts: completedParts,
					}),
				}
			);
			if (!completeRes.ok) {
				const data = (await completeRes.json()) as { error?: string };
				throw new Error(data.error || "完成上传失败");
			}
			localStorage.removeItem(storageKey);
		} catch (err) {
			persistState();
			throw err;
		}
	};

	const uploadFiles = async (fileList: File[]) => {
		if (fileList.length === 0 || !canUpload) return;
		// R2/S3 分块最小 5MB，最大 5GB，夹紧到安全区间
		const chunkSize =
			Math.min(Math.max(chunkSizeMB, 5), 5120) * 1024 * 1024;
		for (let i = 0; i < fileList.length; i++) {
			const file = fileList[i];
			const uploadPath = path ? `${path}/${file.name}` : file.name;
			setUploadProgress({
				name: file.name,
				progress: 0,
				queueIndex: i + 1,
				queueTotal: fileList.length,
			});
			try {
				if (file.size >= chunkSize && supportsMultipart(storage.type)) {
					await uploadMultipart(file, uploadPath, chunkSize);
				} else {
					await uploadSingle(file, uploadPath);
				}
			} catch (err) {
				window.alert(
					`上传 ${file.name} 失败: ${err instanceof Error ? err.message : "未知错误"}`
				);
			}
		}
		setUploadProgress(null);
		loadFiles();
	};

	const handleUploadInput = async (
		event: React.ChangeEvent<HTMLInputElement>
	) => {
		const files = event.target.files;
		if (!files || files.length === 0) return;
		await uploadFiles(Array.from(files));
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	// Ctrl+V 粘贴文件直接上传到当前目录
	useEffect(() => {
		if (!canUpload) return;
		const onPaste = (event: ClipboardEvent) => {
			const files = event.clipboardData?.files;
			if (files && files.length > 0) {
				event.preventDefault();
				uploadFiles(Array.from(files));
			}
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [canUpload, path, storage.id, chunkSizeMB]);

	// 拖拽上传
	const handleDrop = async (event: React.DragEvent) => {
		event.preventDefault();
		setDragOver(false);
		if (!canUpload) return;
		const files = Array.from(event.dataTransfer.files);
		if (files.length > 0) {
			await uploadFiles(files);
		}
	};

	// ---------- 文件操作 ----------

	const openObject = (obj: S3Object) => {
		if (obj.isDirectory) {
			navigateTo(normalizeDirPath(obj.key));
		} else if (isPreviewable(obj.name)) {
			setPreviewFile(obj);
		} else if (canDownload) {
			downloadObject(obj);
		}
	};

	const downloadObject = (obj: S3Object) => {
		if (obj.isDirectory || !canDownload) return;
		const link = document.createElement("a");
		link.href = apiFileUrl(storage.id, obj.key, { action: "download" });
		link.download = obj.name;
		document.body.appendChild(link);
		link.click();
		link.remove();
	};

	/** 复制预签名直链（仅文件） */
	const copySignedLink = async (obj: S3Object) => {
		if (obj.isDirectory) return;
		try {
			const res = await fetch(
				apiFileUrl(storage.id, obj.key, { action: "signed-url" })
			);
			const data = (await res.json()) as { url?: string; error?: string };
			if (!res.ok || !data.url) {
				throw new Error(data.error || "生成直链失败");
			}
			await navigator.clipboard.writeText(data.url);
			window.alert("直链已复制到剪贴板");
		} catch (err) {
			window.alert(err instanceof Error ? err.message : "复制失败");
		}
	};

	const deleteObject = (obj: S3Object) => {
		const isDir = obj.isDirectory;
		setConfirmState({
			title: isDir ? "删除文件夹" : "删除文件",
			confirmText: "删除",
			message: isDir
				? `确定删除文件夹「${obj.name}」及其全部内容？此操作不可恢复。`
				: `确定删除「${obj.name}」？此操作不可恢复。`,
			onConfirm: async () => {
				const res = await fetch(
					apiFileUrl(storage.id, obj.key, isDir ? { action: "rmdir" } : {}),
					{ method: "DELETE" }
				);
				if (!res.ok) {
					const data = (await res.json()) as { error?: string };
					window.alert(data.error || "删除失败");
					return;
				}
				loadFiles();
			},
		});
	};

	const renameObject = (obj: S3Object) => {
		setPromptState({
			title: "重命名",
			label: "新名称（不能包含 /）",
			initialValue: obj.name,
			confirmText: "重命名",
			onSubmit: async (newName) => {
				if (newName === obj.name) return;
				const res = await fetch(
					apiFileUrl(storage.id, obj.key, { action: "rename" }),
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ newName }),
					}
				);
				if (!res.ok) {
					const data = (await res.json()) as { error?: string };
					window.alert(data.error || "重命名失败");
					return;
				}
				loadFiles();
			},
		});
	};

	const createFolder = () => {
		setShowNewFolder(true);
	};

	// ---------- 选择与批量操作 ----------

	const toggleSelect = (key: string) => {
		setSelectedKeys((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	const toggleSelectAll = () => {
		setSelectedKeys((prev) => {
			const next = new Set(prev);
			if (allVisibleSelected) {
				for (const obj of visibleObjects) {
					next.delete(obj.key);
				}
			} else {
				for (const obj of visibleObjects) {
					next.add(obj.key);
				}
			}
			return next;
		});
	};

	const batchDelete = () => {
		const folders = objects.filter(
			(obj) => obj.isDirectory && selectedKeys.has(obj.key)
		);
		const files = objects.filter(
			(obj) => !obj.isDirectory && selectedKeys.has(obj.key)
		);
		if (folders.length + files.length === 0) return;
		setConfirmState({
			title: "批量删除",
			confirmText: "全部删除",
			message: `确定删除 ${files.length} 个文件和 ${folders.length} 个文件夹（含其中所有内容）？此操作不可恢复。`,
			onConfirm: async () => {
				let failed = 0;
				for (const folder of folders) {
					try {
						const res = await fetch(
							apiFileUrl(storage.id, folder.key, { action: "rmdir" }),
							{ method: "DELETE" }
						);
						if (!res.ok) failed++;
					} catch {
						failed++;
					}
				}
				for (const file of files) {
					try {
						const res = await fetch(apiFileUrl(storage.id, file.key), {
							method: "DELETE",
						});
						if (!res.ok) failed++;
					} catch {
						failed++;
					}
				}
				if (failed > 0) {
					window.alert(`删除完成，${failed} 个项目失败`);
				}
				setSelectedKeys(new Set());
				loadFiles();
			},
		});
	};

	const batchDownload = () => {
		const files = objects.filter(
			(obj) => !obj.isDirectory && selectedKeys.has(obj.key)
		);
		files.forEach((file, index) => {
			setTimeout(() => downloadObject(file), index * 400);
		});
	};

	// ---------- 键盘流（列表无输入焦点时生效） ----------

	const anyModalOpen =
		!!previewFile ||
		!!confirmState ||
		!!promptState ||
		!!moveTarget ||
		!!shareTarget ||
		!!editorState ||
		showStats ||
		showOffline ||
		!!contextMenu;

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (anyModalOpen || !canList) return;
			const target = event.target as HTMLElement;
			if (
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT" ||
				target.isContentEditable
			) {
				return;
			}
			if (visibleObjects.length === 0) return;

			const move = (delta: number) => {
				event.preventDefault();
				setCursor((prev) => {
					if (prev === -1) return delta > 0 ? 0 : visibleObjects.length - 1;
					return Math.min(Math.max(prev + delta, 0), visibleObjects.length - 1);
				});
			};

			switch (event.key) {
				case "j":
				case "ArrowDown":
					move(1);
					break;
				case "k":
				case "ArrowUp":
					move(-1);
					break;
				case "Enter": {
					if (cursor >= 0 && cursor < visibleObjects.length) {
						event.preventDefault();
						openObject(visibleObjects[cursor]);
					}
					break;
				}
				case " ": {
					if (cursor >= 0 && cursor < visibleObjects.length) {
						event.preventDefault();
						toggleSelect(visibleObjects[cursor].key);
					}
					break;
				}
				case "Backspace":
					event.preventDefault();
					if (!deepSearch) goUp();
					break;
				case "Escape":
					setSelectedKeys(new Set());
					setCursor(-1);
					break;
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		anyModalOpen,
		canList,
		visibleObjects,
		cursor,
		deepSearch,
		goUp,
	]);

	// 点击任意处关闭右键菜单
	useEffect(() => {
		if (!contextMenu) return;
		const close = () => setContextMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [contextMenu]);

	// ---------- 渲染 ----------

	if (!canList && !canUpload) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
				<ShieldIcon className="h-10 w-10 text-zinc-400" />
				<p className="text-sm text-zinc-500">该存储未开放访客访问</p>
			</div>
		);
	}

	const pathSegments = path ? path.split("/") : [];

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 工具栏 */}
			<div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white/80 px-4 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
				{/* 返回上级 */}
				{(path !== "" || deepSearch) && (
					<button
						type="button"
						className="btn-ghost !px-2"
						title="返回上级 (Backspace)"
						onClick={() => {
							if (deepSearch) {
								setDeepSearch(false);
								setDeepResults(null);
								setSearchQuery("");
							} else {
								goUp();
							}
						}}
					>
						<ChevronRightIcon className="h-4 w-4 rotate-180" />
					</button>
				)}

				{/* 面包屑 */}
				<nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
					<button
						type="button"
						className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-medium text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800/70"
						onClick={() => {
							setDeepSearch(false);
							setDeepResults(null);
							navigateTo("");
						}}
					>
						<HomeIcon className="h-4 w-4" />
						{rootLabel}
					</button>
					{pathSegments.map((segment, index) => {
						const target = pathSegments.slice(0, index + 1).join("/");
						return (
							<span key={target} className="flex shrink-0 items-center gap-1">
								<ChevronRightIcon className="h-3.5 w-3.5 text-zinc-400" />
								<button
									type="button"
									className="rounded px-1.5 py-1 text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800/70"
									onClick={() => navigateTo(target)}
								>
									{segment}
								</button>
							</span>
						);
					})}
				</nav>

				{/* 搜索 */}
				<div className="relative">
					<SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
					<input
						className="input !w-44 !py-1 pl-8"
						placeholder={deepSearch ? "深度搜索本目录…" : "过滤当前目录…"}
						value={searchQuery}
						onChange={(event) => {
							setSearchQuery(event.target.value);
							if (deepSearch) setDeepResults(null);
						}}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								deepSearch &&
								searchQuery.trim()
							) {
								runDeepSearch(searchQuery);
							}
						}}
					/>
				</div>
				<button
					type="button"
					className={`btn-ghost !px-2 !text-xs ${deepSearch ? "!text-blue-600 dark:!text-blue-400" : ""}`}
					title="深度搜索：递归遍历子目录查找（最多 300 个目录）"
					onClick={() => {
						setDeepSearch((prev) => !prev);
						setDeepResults(null);
					}}
				>
					{deepSearch ? "深度" : "过滤"}
				</button>
				{deepSearch && deepResults === null && searchQuery.trim() && (
					<button
						type="button"
						className="btn-outline !px-2 !py-1 !text-xs"
						onClick={() => runDeepSearch(searchQuery)}
					>
						{deepLoading ? (
							<SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
						) : (
							"搜索"
						)}
					</button>
				)}

				{/* 视图切换 */}
				<div className="flex overflow-hidden rounded-lg border border-zinc-300 text-xs dark:border-zinc-700">
					{(["list", "grid"] as const).map((mode) => (
						<button
							key={mode}
							type="button"
							className={`px-2.5 py-1.5 transition-colors ${
								viewMode === mode
									? "bg-blue-600 text-white"
									: "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
							}`}
							onClick={() => setViewMode(mode)}
						>
							{mode === "list" ? "列表" : "网格"}
						</button>
					))}
				</div>

				<button
					type="button"
					className="btn-ghost !px-2"
					title="刷新"
					onClick={() => {
						setDeepResults(null);
						loadFiles();
					}}
				>
					<RefreshIcon className="h-4 w-4" />
				</button>

				{canManage && (
					<>
						<button
							type="button"
							className="btn-ghost !px-2"
							title="存储统计"
							onClick={() => setShowStats(true)}
						>
							<StatsIcon className="h-4 w-4" />
						</button>
						<button
							type="button"
							className="btn-ghost !px-2"
							title="离线下载（从 URL 转存）"
							onClick={() => setShowOffline(true)}
						>
							<LinkIcon className="h-4 w-4" />
						</button>
						<button
							type="button"
							className="btn-ghost !px-2"
							title="新建文件夹"
							onClick={createFolder}
						>
							<FolderPlusIcon className="h-4 w-4" />
						</button>
					</>
				)}
				{canUpload && (
					<button
						type="button"
						className="btn-outline !px-2 !text-xs"
						title="在线新建文本文件（.txt / .md / 代码…）"
						onClick={() => setEditorState({})}
					>
						+ 文件
					</button>
				)}
				{canUpload && (
					<button
						type="button"
						className="btn-primary"
						onClick={() => fileInputRef.current?.click()}
					>
						<UploadIcon className="h-4 w-4" />
						上传
					</button>
				)}
				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="hidden"
					onChange={handleUploadInput}
				/>
			</div>

			{/* 批量操作条 */}
			{selectedKeys.size > 0 && (
				<div className="flex flex-wrap items-center gap-2 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">
					<span className="text-blue-700 dark:text-blue-300">
						已选 {selectedKeys.size} 项
					</span>
					{canDownload && (
						<button
							type="button"
							className="btn-outline !py-1 !text-xs"
							onClick={batchDownload}
						>
							<DownloadIcon className="h-3.5 w-3.5" />
							批量下载
						</button>
					)}
					{canManage && (
						<button
							type="button"
							className="btn-danger !py-1 !text-xs"
							onClick={batchDelete}
						>
							<TrashIcon className="h-3.5 w-3.5" />
							批量删除
						</button>
					)}
					<button
						type="button"
						className="btn-ghost !py-1 !text-xs"
						onClick={() => setSelectedKeys(new Set())}
					>
						取消选择
					</button>
				</div>
			)}

			{/* 上传进度条 */}
			{uploadProgress && (
				<div className="border-b border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
					<div className="mb-1 flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400">
						<span className="truncate">
							{uploadProgress.queueTotal &&
								`[${uploadProgress.queueIndex}/${uploadProgress.queueTotal}] `}
							正在上传 {uploadProgress.name}
							{uploadProgress.totalParts
								? `（分块 ${uploadProgress.currentPart}/${uploadProgress.totalParts}）`
								: ""}
						</span>
						<span className="shrink-0">
							{uploadProgress.progress}%
							{uploadProgress.speed ? ` · ${formatSpeed(uploadProgress.speed)}` : ""}
							{uploadProgress.loaded !== undefined && uploadProgress.total
								? ` · ${formatBytes(uploadProgress.loaded)}/${formatBytes(uploadProgress.total)}`
								: ""}
						</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
						<div
							className="h-full rounded-full bg-blue-600 transition-all"
							style={{ width: `${uploadProgress.progress}%` }}
						/>
					</div>
				</div>
			)}

			{/* 文件区 */}
			<div
				className="relative min-h-0 flex-1 overflow-auto"
				onDragOver={(event) => {
					if (!canUpload) return;
					event.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={(event) => {
					if (event.currentTarget === event.target) setDragOver(false);
				}}
				onDrop={handleDrop}
			>
				{/* 拖拽遮罩 */}
				{dragOver && canUpload && (
					<div className="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-500 bg-blue-500/10 backdrop-blur-sm">
						<UploadIcon className="h-10 w-10 text-blue-600" />
						<p className="text-sm font-medium text-blue-700 dark:text-blue-300">
							松开鼠标上传到{path ? ` /${path}` : "根目录"}
						</p>
					</div>
				)}

				{/* 错误提示 */}
				{error && (
					<div className="m-4 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
						<span className="flex-1">{error}</span>
						<button
							type="button"
							className="shrink-0"
							onClick={() => setError("")}
						>
							<CloseIcon className="h-4 w-4" />
						</button>
					</div>
				)}

				{!canList ? (
					<div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
						<ShieldIcon className="h-10 w-10 text-zinc-400" />
						<p className="text-sm text-zinc-500">没有浏览权限，仅可上传</p>
					</div>
				) : loading ? (
					<div className="flex items-center justify-center gap-2 p-14 text-sm text-zinc-500">
						<SpinnerIcon className="h-5 w-5 animate-spin" />
						正在加载…
					</div>
				) : deepSearch && deepResults === null ? (
					<div className="flex flex-col items-center justify-center gap-2 p-14 text-center text-sm text-zinc-500">
						<SearchIcon className="h-8 w-8 text-zinc-400" />
						输入关键词后点击「搜索」，将递归查找子目录</div>
				) : visibleObjects.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 p-14 text-center text-sm text-zinc-500">
						<CloudIcon className="h-8 w-8 text-zinc-400" />
						{searchQuery.trim()
							? "没有匹配的文件"
							: deepSearch
								? "深度搜索无结果"
								: "此目录为空"}
					</div>
				) : viewMode === "list" ? (
					<table className="w-full border-collapse text-sm">
						<thead className="sticky top-0 z-[5] bg-white/95 backdrop-blur dark:bg-zinc-900/95">
							<tr className="border-b border-zinc-200 dark:border-zinc-800">
								<th className="table-head w-10">
									<input
										type="checkbox"
										className="h-3.5 w-3.5 accent-blue-600"
										checked={allVisibleSelected}
										onChange={toggleSelectAll}
									/>
								</th>
								<th className="table-head">
									<button
										type="button"
										className="flex items-center gap-1 uppercase tracking-wider hover:text-zinc-800 dark:hover:text-zinc-200"
										onClick={() => {
											setSortKey("name");
											setSortDir((prev) =>
												sortKey === "name" && prev === "asc" ? "desc" : "asc"
											);
										}}
									>
										名称
										{sortKey === "name" && (
											<span>{sortDir === "asc" ? "↑" : "↓"}</span>
										)}
									</button>
								</th>
								<th className="table-head w-24">
									<button
										type="button"
										className="flex items-center gap-1 uppercase tracking-wider hover:text-zinc-800 dark:hover:text-zinc-200"
										onClick={() => {
											setSortKey("size");
											setSortDir((prev) =>
												sortKey === "size" && prev === "asc" ? "desc" : "asc"
											);
										}}
									>
										大小
										{sortKey === "size" && (
											<span>{sortDir === "asc" ? "↑" : "↓"}</span>
										)}
									</button>
								</th>
								<th className="table-head w-40">
									<button
										type="button"
										className="flex items-center gap-1 uppercase tracking-wider hover:text-zinc-800 dark:hover:text-zinc-200"
										onClick={() => {
											setSortKey("lastModified");
											setSortDir((prev) =>
												sortKey === "lastModified" && prev === "asc"
													? "desc"
													: "asc"
											);
										}}
									>
										修改时间
										{sortKey === "lastModified" && (
											<span>{sortDir === "asc" ? "↑" : "↓"}</span>
										)}
									</button>
								</th>
								<th className="table-head w-28"></th>
							</tr>
						</thead>
						<tbody>
							{visibleObjects.map((obj, index) => (
								<tr
									key={obj.key}
									className={`group border-b border-zinc-100 transition-colors dark:border-zinc-800/60 ${
										cursor === index
											? "bg-blue-50 ring-1 ring-inset ring-blue-300 dark:bg-blue-950/40 dark:ring-blue-800"
											: "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
									}`}
									onContextMenu={(event) => {
										event.preventDefault();
										setContextMenu({ x: event.clientX, y: event.clientY, obj });
									}}
								>
									<td className="px-3 py-1.5">
										<input
											type="checkbox"
											className="h-3.5 w-3.5 accent-blue-600"
											checked={selectedKeys.has(obj.key)}
											onChange={() => toggleSelect(obj.key)}
										/>
									</td>
									<td className="max-w-0 px-3 py-1.5">
										<button
											type="button"
											className="flex w-full items-center gap-2 text-left"
											onClick={() => openObject(obj)}
											title={obj.name}
										>
											<FileTypeIcon
												name={obj.name}
												isDirectory={obj.isDirectory}
												className="h-4.5 w-4.5 shrink-0"
											/>
											<span className="truncate text-zinc-800 dark:text-zinc-200">
												{obj.isDirectory ? `${obj.name}/` : obj.name}
											</span>
										</button>
									</td>
									<td className="px-3 py-1.5 text-xs text-zinc-500">
										{obj.isDirectory ? "-" : formatBytes(obj.size)}
									</td>
									<td className="px-3 py-1.5 text-xs text-zinc-500">
										{obj.isDirectory ? "-" : formatDate(obj.lastModified)}
									</td>
									<td className="px-3 py-1.5">
										<div className="flex items-center justify-end gap-0.5">
											<div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
												{!obj.isDirectory && isPreviewable(obj.name) && (
													<button
														type="button"
														className="btn-ghost !px-1.5"
														title="预览"
														onClick={() => setPreviewFile(obj)}
													>
														<EyeIcon className="h-4 w-4" />
													</button>
												)}
												{!obj.isDirectory && canDownload && (
													<button
														type="button"
														className="btn-ghost !px-1.5"
														title="下载"
														onClick={() => downloadObject(obj)}
													>
														<DownloadIcon className="h-4 w-4" />
													</button>
												)}
											</div>
											{/* 三个点常驻显示，不跟随行悬停 */}
											<button
												type="button"
												className="btn-ghost !px-1.5"
												title="更多操作（重命名 / 移动 / 删除 / 分享）"
												onClick={(event) => {
													event.stopPropagation();
													const rect =
														event.currentTarget.getBoundingClientRect();
													setContextMenu({
														x: rect.left,
														y: rect.bottom + 4,
														obj,
													});
												}}
											>
												<MoreIcon className="h-4 w-4" />
											</button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
						{visibleObjects.map((obj, index) => (
							// div 而非 button：卡片内要嵌套勾选框和三个点按钮，button 嵌套 button 不合法
							<div
								key={obj.key}
								role="button"
								tabIndex={0}
								className={`card group relative flex cursor-pointer flex-col items-center gap-2 p-3 text-center transition-shadow hover:shadow-md ${
									cursor === index ? "ring-2 ring-blue-500" : ""
								}`}
								onClick={() => openObject(obj)}
								onKeyDown={(event) => {
									if (event.key === "Enter") openObject(obj);
								}}
								onContextMenu={(event) => {
									event.preventDefault();
									setContextMenu({ x: event.clientX, y: event.clientY, obj });
								}}
							>
								<span
									className={`absolute left-2 top-2 h-3.5 w-3.5 rounded border accent-blue-600 ${
										selectedKeys.has(obj.key)
											? "border-blue-600 bg-blue-600"
											: "border-zinc-300 bg-white/80 opacity-0 group-hover:opacity-100 dark:border-zinc-600 dark:bg-zinc-800"
									}`}
									onClick={(event) => {
										event.stopPropagation();
										toggleSelect(obj.key);
									}}
								>
									{selectedKeys.has(obj.key) && (
										<CheckIcon className="h-3 w-3 text-white" />
									)}
								</span>
								{/* 三个点常驻，菜单向左展开避免出屏 */}
								<button
									type="button"
									className="btn-ghost absolute right-1.5 top-1.5 !px-1"
									title="更多操作（重命名 / 移动 / 删除 / 分享）"
									onClick={(event) => {
										event.stopPropagation();
										const rect =
											event.currentTarget.getBoundingClientRect();
										setContextMenu({
											x: Math.max(rect.right - 176, 8),
											y: rect.bottom + 4,
											obj,
										});
									}}
								>
									<MoreIcon className="h-4 w-4" />
								</button>
								{!obj.isDirectory &&
								getFileType(obj.name) === "image" &&
								canDownload ? (
									<img
										className="h-20 w-20 rounded-lg object-cover"
										src={apiFileUrl(storage.id, obj.key)}
										alt={obj.name}
										loading="lazy"
									/>
								) : (
									<FileTypeIcon
										name={obj.name}
										isDirectory={obj.isDirectory}
										className="h-14 w-14"
									/>
								)}
								<span
									className="w-full truncate text-xs text-zinc-700 dark:text-zinc-300"
									title={obj.name}
								>
									{obj.name}
								</span>
								<span className="text-[11px] text-zinc-400">
									{obj.isDirectory ? "文件夹" : formatBytes(obj.size)}
								</span>
							</div>
						))}
					</div>
				)}

				{/* README.md */}
				{readme && visibleObjects.length > 0 && (
					<details
						className="m-4 rounded-xl border border-zinc-200 bg-white p-4 open:pb-2 dark:border-zinc-800 dark:bg-zinc-900"
						open
					>
						<summary className="cursor-pointer select-none text-sm font-medium text-zinc-700 dark:text-zinc-300">
							README.md
						</summary>
						<div
							className="markdown-body mt-3"
							dangerouslySetInnerHTML={{ __html: readme }}
						/>
					</details>
				)}
			</div>

			{/* 右键菜单 */}
			{contextMenu && (
				<div
					className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
					style={{
						left: Math.min(contextMenu.x, window.innerWidth - 200),
						top: Math.min(contextMenu.y, window.innerHeight - 320),
					}}
					onClick={(event) => event.stopPropagation()}
				>
					<button
						type="button"
						className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
						onClick={() => {
							openObject(contextMenu.obj);
							setContextMenu(null);
						}}
					>
						{contextMenu.obj.isDirectory ? (
							<HomeIcon className="h-4 w-4" />
						) : (
							<EyeIcon className="h-4 w-4" />
						)}
						{contextMenu.obj.isDirectory
							? "打开"
							: isPreviewable(contextMenu.obj.name)
								? "预览"
								: "下载"}
					</button>
					{!contextMenu.obj.isDirectory && canDownload && (
						<button
							type="button"
							className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
							onClick={() => {
								downloadObject(contextMenu.obj);
								setContextMenu(null);
							}}
						>
							<DownloadIcon className="h-4 w-4" />
							下载
						</button>
					)}
					{!contextMenu.obj.isDirectory && canDownload && (
						<button
							type="button"
							className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
							onClick={() => {
								copySignedLink(contextMenu.obj);
								setContextMenu(null);
							}}
						>
							<LinkIcon className="h-4 w-4" />
							复制直链
						</button>
					)}
					{canManage && (
						<>
							{!contextMenu.obj.isDirectory &&
								["text", "code", "markdown"].includes(
									getFileType(contextMenu.obj.name)
								) && (
									<button
										type="button"
										className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
										onClick={() => {
											setEditorState({ existing: contextMenu.obj });
											setContextMenu(null);
										}}
									>
										<RenameIcon className="h-4 w-4" />
										编辑
									</button>
								)}
							<button
								type="button"
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
								onClick={() => {
									renameObject(contextMenu.obj);
									setContextMenu(null);
								}}
							>
								<RenameIcon className="h-4 w-4" />
								重命名
							</button>
							<button
								type="button"
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
								onClick={() => {
									setMoveTarget(contextMenu.obj);
									setContextMenu(null);
								}}
							>
								<MoveIcon className="h-4 w-4" />
								移动
							</button>
							<div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
							<button
								type="button"
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
								onClick={() => {
									deleteObject(contextMenu.obj);
									setContextMenu(null);
								}}
							>
								<TrashIcon className="h-4 w-4" />
								删除
							</button>
						</>
					)}
					{canManage && (
						<>
							<div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
							<button
								type="button"
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
								onClick={() => {
									setShareTarget(contextMenu.obj);
									setContextMenu(null);
								}}
							>
								<ShareIcon className="h-4 w-4" />
								创建分享
							</button>
						</>
					)}
				</div>
			)}

			{/* 弹窗们 */}
			{previewFile && (
				<FilePreview
					storageId={storage.id}
					path={previewFile.key}
					fileName={previewFile.name}
					size={previewFile.size}
					onClose={() => setPreviewFile(null)}
				/>
			)}
			{confirmState && (
				<ConfirmDialog
					title={confirmState.title}
					message={confirmState.message}
					confirmText={confirmState.confirmText}
					danger
					onConfirm={confirmState.onConfirm}
					onClose={() => setConfirmState(null)}
				/>
			)}
			{promptState && (
				<PromptDialog
					title={promptState.title}
					label={promptState.label}
					initialValue={promptState.initialValue}
					placeholder={promptState.placeholder}
					confirmText={promptState.confirmText}
					onSubmit={promptState.onSubmit}
					onClose={() => setPromptState(null)}
				/>
			)}
			{moveTarget && (
				<MoveDialog
					storage={storage}
					obj={moveTarget}
					onMoved={loadFiles}
					onClose={() => setMoveTarget(null)}
				/>
			)}
			{editorState && (
				<TextEditorDialog
					storageId={storage.id}
					storageName={rootLabel}
					currentDir={path}
					storageOptions={
						isAdmin && storageOptions.length > 0
							? storageOptions
							: [{ id: storage.id, name: storage.name }]
					}
					existingPath={editorState.existing?.key}
					existingName={editorState.existing?.name}
					onSaved={() => loadFiles()}
					onClose={() => setEditorState(null)}
				/>
			)}
			{showNewFolder && (
				<NewFolderDialog
					isAdmin={isAdmin}
					currentFolderId={currentFolderId}
					currentFolderName={rootLabel}
					storageOptions={storageOptions}
					onCreated={() => {
						loadFiles();
						onFoldersChanged();
					}}
					onClose={() => setShowNewFolder(false)}
				/>
			)}
			{shareTarget && (
				<ShareDialog
					storageId={storage.id}
					storageName={storage.name}
					path={shareTarget.key}
					fileName={shareTarget.name}
					isDirectory={shareTarget.isDirectory}
					onClose={() => setShareTarget(null)}
				/>
			)}
			{showStats && (
				<StatsDialog
					storageId={storage.id}
					storageName={storage.name}
					onClose={() => setShowStats(false)}
				/>
			)}
			{showOffline && (
				<OfflineDownloadDialog
					currentDir={path}
					onSubmit={async (url, filename) => {
						const res = await fetch(
							apiFileUrl(storage.id, path, { action: "fetch" }),
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ url, filename: filename || undefined }),
							}
						);
						if (!res.ok) {
							const data = (await res.json()) as { error?: string };
							throw new Error(data.error || "离线下载失败");
						}
						loadFiles();
					}}
					onClose={() => setShowOffline(false)}
				/>
			)}
		</div>
	);
}

// ---------- 深色模式 ----------

function useDarkMode() {
	const [isDark, setIsDark] = useState(false);
	useEffect(() => {
		const saved = localStorage.getItem("wlist-theme");
		const dark =
			saved === "dark"
				? true
				: saved === "light"
					? false
					: window.matchMedia("(prefers-color-scheme: dark)").matches;
		setIsDark(dark);
	}, []);
	const toggle = useCallback(() => {
		setIsDark((prev) => {
			const next = !prev;
			localStorage.setItem("wlist-theme", next ? "dark" : "light");
			return next;
		});
	}, []);
	useEffect(() => {
		document.documentElement.classList.toggle("dark", isDark);
	}, [isDark]);
	return { isDark, toggle };
}

// ---------- 侧边栏目录树 ----------

function FolderTreeItem({
	node,
	depth,
	selectedFolderId,
	onSelect,
	isAdmin,
	onChanged,
}: {
	node: FolderNode;
	depth: number;
	selectedFolderId: number | null;
	onSelect: (node: FolderNode) => void;
	isAdmin: boolean;
	onChanged: () => void;
}) {
	const [open, setOpen] = useState(false);
	const selected = selectedFolderId === node.id;

	const togglePublic = async () => {
		await fetch("/api/folders", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: node.id, isPublic: !node.isPublic }),
		});
		onChanged();
	};

	const removeFolder = async () => {
		if (
			!window.confirm(
				`确定删除目录「${node.name}」吗？桶内该目录下的所有文件都会被删除，且不可恢复。`
			)
		) {
			return;
		}
		const response = await fetch(`/api/folders?id=${node.id}`, {
			method: "DELETE",
		});
		if (!response.ok) {
			const data = (await response.json().catch(() => ({}))) as {
				error?: string;
			};
			window.alert(data.error || "删除失败");
			return;
		}
		onChanged();
	};

	return (
		<div>
			<div
				className={`group flex items-center gap-0.5 rounded-lg pr-1 transition-colors ${
					selected
						? "bg-blue-50 text-blue-700 ring-1 ring-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:ring-blue-900"
						: "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
				}`}
				style={{ paddingLeft: `${depth * 14 + 6}px` }}
			>
				{node.children.length > 0 ? (
					<button
						type="button"
						className="shrink-0 rounded p-0.5 text-[10px] text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700"
						onClick={() => setOpen((v) => !v)}
						title={open ? "收起" : "展开"}
					>
						{open ? "▾" : "▸"}
					</button>
				) : (
					<span className="w-4 shrink-0" />
				)}
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm"
					onClick={() => onSelect(node)}
					title={node.name}
				>
					<FolderIcon className="h-4 w-4 shrink-0 text-blue-500" />
					<span className="min-w-0 flex-1 truncate">{node.name}</span>
					{node.isPublic && (
						<GlobeIcon className="h-3 w-3 shrink-0 text-emerald-500" />
					)}
				</button>
				{isAdmin && (
					<span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
						<button
							type="button"
							className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
							title={node.isPublic ? "取消公开（仅自己和授权用户可见）" : "公开给所有人"}
							onClick={togglePublic}
						>
							<GlobeIcon className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
							title="删除目录（含桶内文件）"
							onClick={removeFolder}
						>
							<TrashIcon className="h-3.5 w-3.5" />
						</button>
					</span>
				)}
			</div>
			{open &&
				node.children.map((child) => (
					<FolderTreeItem
						key={child.id}
						node={child}
						depth={depth + 1}
						selectedFolderId={selectedFolderId}
						onSelect={onSelect}
						isAdmin={isAdmin}
						onChanged={onChanged}
					/>
				))}
		</div>
	);
}

// ---------- 页面外壳 ----------

export default function Home({ loaderData }: Route.ComponentProps) {
	const {
		isAdmin,
		user,
		githubEnabled,
		folders,
		storages,
		siteTitle,
		siteAnnouncement,
		chunkSizeMB,
		webdavEnabled,
	} = loaderData;
	const revalidator = useRevalidator();
	const { isDark, toggle: toggleDark } = useDarkMode();

	const [target, setTarget] = useState<{
		storageId: number;
		path: string;
		folderId: number | null;
	} | null>(null);
	const [showLogin, setShowLogin] = useState(false);
	const [showAdmin, setShowAdmin] = useState(false);
	const [showProfile, setShowProfile] = useState(false);
	const [userMenuOpen, setUserMenuOpen] = useState(false);
	const [editingStorage, setEditingStorage] = useState<StorageInfo | null>(null);
	const [showAddStorage, setShowAddStorage] = useState(false);
	const [statsStorage, setStatsStorage] = useState<StorageInfo | null>(null);

	// GitHub 登录失败提示（回调带回的 ?github_error=）
	const [githubError, setGithubError] = useState("");
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const err = params.get("github_error");
		if (err) {
			setGithubError(err);
			params.delete("github_error");
			const clean = params.toString();
			window.history.replaceState(
				{},
				"",
				window.location.pathname + (clean ? `?${clean}` : "")
			);
		}
	}, []);

	// 展平目录树（查当前目录 / 校验 target 有效性）
	const allFolderNodes = useMemo(() => {
		const list: FolderNode[] = [];
		const walk = (nodes: FolderNode[]) => {
			for (const node of nodes) {
				list.push(node);
				walk(node.children);
			}
		};
		walk(folders);
		return list;
	}, [folders]);

	// 默认/回退选中：第一个目录；管理员无目录时选第一个桶
	useEffect(() => {
		const targetValid =
			target !== null &&
			(target.folderId === null
				? storages.some((s) => s.id === target.storageId)
				: allFolderNodes.some((f) => f.id === target.folderId));
		if (targetValid) return;
		if (allFolderNodes.length > 0) {
			const first = allFolderNodes[0];
			setTarget({
				storageId: first.storageId,
				path: first.storagePath,
				folderId: first.id,
			});
		} else if (isAdmin && storages.length > 0) {
			setTarget({ storageId: storages[0].id, path: "", folderId: null });
		} else {
			setTarget(null);
		}
	}, [allFolderNodes, storages, isAdmin, target]);

	const activeStorage =
		storages.find((s) => s.id === target?.storageId) || null;
	const currentFolder =
		target?.folderId !== null && target?.folderId !== undefined
			? allFolderNodes.find((f) => f.id === target.folderId) || null
			: null;

	// 新建文件可选的桶（管理员；普通用户在当前目录内创建）
	const uploadableStorages: StorageOption[] = isAdmin
		? storages.map((s) => ({ id: s.id, name: s.name }))
		: [];

	// 公告关闭状态（记录已读文本，公告变更后重新显示）
	const [announcementDismissed, setAnnouncementDismissed] = useState("");
	useEffect(() => {
		setAnnouncementDismissed(
			localStorage.getItem("wlist-announcement-dismissed") || ""
		);
	}, []);
	const showAnnouncement =
		!!siteAnnouncement && announcementDismissed !== siteAnnouncement;

	const handleLogout = async () => {
		await fetch("/api/storages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "logout" }),
		});
		revalidator.revalidate();
	};

	const refreshStorages = useCallback(() => {
		revalidator.revalidate();
	}, [revalidator]);

	return (
		<div className="flex h-dvh flex-col overflow-hidden md:flex-row">
			{/* 侧边栏 */}
			<aside className="flex shrink-0 flex-col border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 md:w-60 md:border-b-0 md:border-r">
				{/* 品牌区 */}
				<div className="flex items-center gap-2 px-4 py-3.5">
					<CloudIcon className="h-5 w-5 text-blue-600" />
					<h1 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
						{siteTitle}
					</h1>
					{isAdmin && (
						<span className="badge bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400">
							管理员
						</span>
					)}
				</div>

				{/* 目录树（主内容）+ 管理员的存储后端 */}
				<nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-2">
					{folders.length === 0 && (
						<p className="px-2 py-6 text-center text-xs leading-relaxed text-zinc-500">
							{isAdmin
								? storages.length > 0
									? "还没有目录。右侧点 📁 新建第一个主目录"
									: "还没有桶。点击下方「管理面板」添加存储桶"
								: "管理员还没有创建任何目录"}
						</p>
					)}
					{folders.map((node) => (
						<FolderTreeItem
							key={node.id}
							node={node}
							depth={0}
							selectedFolderId={target?.folderId ?? null}
							onSelect={(n) =>
								setTarget({
									storageId: n.storageId,
									path: n.storagePath,
									folderId: n.id,
								})
							}
							isAdmin={isAdmin}
							onChanged={refreshStorages}
						/>
					))}

					{/* 存储后端（仅管理员）：直接浏览桶的原始内容 */}
					{isAdmin && storages.length > 0 && (
						<details className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
							<summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
								存储后端（{storages.length}）
							</summary>
							<div className="mt-1 space-y-0.5">
								{storages.map((storage) => (
									<button
										key={storage.id}
										type="button"
										className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
											target?.folderId === null &&
											target?.storageId === storage.id
												? "bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
												: "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
										}`}
										onClick={() =>
											setTarget({
												storageId: storage.id,
												path: "",
												folderId: null,
											})
										}
									>
										<StorageIcon
											type={storage.type}
											className="h-4 w-4 shrink-0"
										/>
										<span className="min-w-0 flex-1 truncate">
											{storage.name}
										</span>
									</button>
								))}
							</div>
						</details>
					)}
				</nav>

				{/* 底部操作区：主题 + 用户 */}
				<div className="relative flex items-center gap-1 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
					<button
						type="button"
						className="btn-ghost !px-2"
						title={isDark ? "切换到浅色" : "切换到深色"}
						onClick={toggleDark}
					>
						{isDark ? (
							<SunIcon className="h-4 w-4" />
						) : (
							<MoonIcon className="h-4 w-4" />
						)}
					</button>

					{user ? (
						<>
							<button
								type="button"
								className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
								onClick={() => setUserMenuOpen((v) => !v)}
							>
								<img
									src={
										user.avatarUrl || `https://github.com/${user.username}.png`
									}
									alt=""
									className="h-6 w-6 shrink-0 rounded-full border border-zinc-200 object-cover dark:border-zinc-700"
									onError={(event) => {
										event.currentTarget.style.visibility = "hidden";
									}}
								/>
								<span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
									{user.displayName || user.username}
								</span>
								{user.role === "admin" && (
									<ShieldIcon className="h-3.5 w-3.5 shrink-0 text-blue-600" />
								)}
							</button>

							{userMenuOpen && (
								<>
									<div
										className="fixed inset-0 z-40"
										onClick={() => setUserMenuOpen(false)}
									/>
									<div className="absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
										<div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
											<div className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
												{user.displayName || user.username}
											</div>
											{user.bio && (
												<div className="truncate text-[11px] text-zinc-500">
													{user.bio}
												</div>
											)}
										</div>
										{isAdmin && (
											<button
												type="button"
												className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
												onClick={() => {
													setShowAdmin(true);
													setUserMenuOpen(false);
												}}
											>
												<ShieldIcon className="h-4 w-4" />
												管理面板
											</button>
										)}
										<button
											type="button"
											className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
											onClick={() => {
												setShowProfile(true);
												setUserMenuOpen(false);
											}}
										>
											<LoginIcon className="h-4 w-4" />
											个人资料
										</button>
										<button
											type="button"
											className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
											onClick={() => {
												setUserMenuOpen(false);
												handleLogout();
											}}
										>
											<LogoutIcon className="h-4 w-4" />
											退出登录
										</button>
									</div>
								</>
							)}
						</>
					) : (
						<button
							type="button"
							className="btn-outline flex-1 !py-1.5 !text-xs"
							onClick={() => setShowLogin(true)}
						>
							<LoginIcon className="h-4 w-4" />
							登录
						</button>
					)}
				</div>
			</aside>

			{/* 主内容区 */}
			<main className="flex min-h-0 min-w-0 flex-1 flex-col">
				{/* GitHub 登录错误提示 */}
				{githubError && (
					<div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
						<p className="min-w-0 flex-1">{githubError}</p>
						<button
							type="button"
							className="shrink-0 rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900/50"
							onClick={() => setGithubError("")}
						>
							<CloseIcon className="h-4 w-4" />
						</button>
					</div>
				)}
				{/* 公告 */}
				{showAnnouncement && (
					<div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
						<p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
							{siteAnnouncement}
						</p>
						<button
							type="button"
							className="shrink-0 rounded p-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/50"
							title="关闭公告"
							onClick={() => {
								localStorage.setItem(
									"wlist-announcement-dismissed",
									siteAnnouncement
								);
								setAnnouncementDismissed(siteAnnouncement);
							}}
						>
							<CloseIcon className="h-4 w-4" />
						</button>
					</div>
				)}

				{activeStorage && target ? (
					<FileBrowser
						key={`${target.storageId}:${target.path}`}
						storage={activeStorage}
						isAdmin={isAdmin}
						chunkSizeMB={chunkSizeMB}
						initialPath={target.path}
						rootLabel={currentFolder ? currentFolder.name : activeStorage.name}
						currentFolderId={target.folderId}
						folderAccess={
							currentFolder?.access || {
								list: false,
								download: false,
								upload: false,
							}
						}
						storageOptions={uploadableStorages}
						onFoldersChanged={refreshStorages}
					/>
				) : (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
						<FolderIcon className="h-14 w-14 text-zinc-300 dark:text-zinc-700" />
						<h2 className="text-lg font-semibold text-zinc-700 dark:text-zinc-300">
							{isAdmin ? "开始搭建你的目录" : "还没有可浏览的目录"}
						</h2>
						<p className="max-w-sm text-sm leading-relaxed text-zinc-500">
							{isAdmin
								? storages.length > 0
									? "桶已就绪。先添加一个存储桶，再创建主目录组织你的文件。"
									: "先在管理面板添加存储桶（R2 / B2 / OneDrive…），然后创建主目录组织你的文件。"
								: "等管理员创建并公开目录后，这里就会显示内容。"}
						</p>
						{isAdmin && storages.length === 0 && (
							<button
								type="button"
								className="btn-primary"
								onClick={() => setShowAddStorage(true)}
							>
								<UploadIcon className="h-4 w-4" />
								添加存储桶
							</button>
						)}
					</div>
				)}
			</main>

			{/* 登录弹窗 */}
			{showLogin && (
				<LoginDialog
					onSuccess={refreshStorages}
					onClose={() => setShowLogin(false)}
				/>
			)}

			{/* 管理面板 */}
			{showAdmin && isAdmin && user && (
				<AdminPanel
					storages={storages}
					webdavEnabled={webdavEnabled}
					currentUserId={user.id}
					onStoragesChanged={refreshStorages}
					onClose={() => setShowAdmin(false)}
					onShowStats={(storage) => setStatsStorage(storage)}
					onEditStorage={(storage) => setEditingStorage(storage)}
					onAddStorage={() => setShowAddStorage(true)}
				/>
			)}

			{/* 个人资料 */}
			{showProfile && user && (
				<ProfileDialog
					user={user as CurrentUser}
					onSaved={refreshStorages}
					onClose={() => setShowProfile(false)}
				/>
			)}

			{/* 编辑 / 新建存储表单 */}
			{editingStorage && (
				<StorageFormDialog
					initial={editingStorage}
					onSaved={refreshStorages}
					onClose={() => setEditingStorage(null)}
				/>
			)}
			{showAddStorage && (
				<StorageFormDialog
					initial={null}
					onSaved={refreshStorages}
					onClose={() => setShowAddStorage(false)}
				/>
			)}

			{/* 存储统计（管理面板入口） */}
			{statsStorage && (
				<StatsDialog
					storageId={statsStorage.id}
					storageName={statsStorage.name}
					onClose={() => setStatsStorage(null)}
				/>
			)}
		</div>
	);
}







