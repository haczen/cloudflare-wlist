import type { Route } from "./+types/share";
import { useCallback, useEffect, useState } from "react";
import { FilePreview } from "~/components/FilePreview";
import { apiFileUrl } from "~/lib/api-path";
import { isPreviewable } from "~/lib/file-utils";
import {
	ChevronRightIcon,
	CloudIcon,
	DownloadIcon,
	EyeIcon,
	FileTypeIcon,
	HomeIcon,
	SpinnerIcon,
} from "~/components/icons";

// ---------- 路由：仅透传令牌 ----------

export function meta({ data }: Route.MetaArgs) {
	return [{ title: "分享 - WList" }];
}

export async function loader({ request }: Route.LoaderArgs) {
	const url = new URL(request.url);
	const token = url.searchParams.get("token");
	return { token };
}

// ---------- 类型与工具 ----------

interface S3Object {
	key: string;
	name: string;
	size: number;
	lastModified: string;
	isDirectory: boolean;
}

interface ShareInfo {
	id: string;
	storageId: number;
	filePath: string;
	isDirectory: boolean;
	shareToken: string;
	expiresAt: string | null;
	createdAt: string;
	hasPassword: boolean;
}

interface StorageBrief {
	id: number;
	name: string;
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

function formatDate(dateStr: string | null): string {
	if (!dateStr) return "永久有效";
	const date = new Date(dateStr);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toLocaleString("zh-CN", { hour12: false });
}

/** 分享根路径（去尾部斜杠），子路径以其为前缀 */
function shareRoot(share: ShareInfo): string {
	return (share.filePath || "").replace(/\/+$/, "");
}

// ---------- 密码验证卡片 ----------

function PasswordGate({
	onVerified,
	busy,
	error,
	password,
	setPassword,
}: {
	onVerified: () => void;
	busy: boolean;
	error: string;
	password: string;
	setPassword: (value: string) => void;
}) {
	return (
		<div className="flex flex-1 items-center justify-center p-6">
			<form
				className="card w-full max-w-sm space-y-4 p-6"
				onSubmit={(event) => {
					event.preventDefault();
					if (password.trim()) onVerified();
				}}
			>
				<div className="text-center">
					<div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-2xl dark:bg-blue-950">
						🔒
					</div>
					<h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
						此分享已加密
					</h1>
					<p className="mt-1 text-xs text-zinc-500">请输入访问密码继续</p>
				</div>
				<input
					className="input"
					type="password"
					placeholder="访问密码"
					value={password}
					autoFocus
					onChange={(event) => setPassword(event.target.value)}
				/>
				{error && (
					<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
						{error}
					</p>
				)}
				<button
					type="submit"
					className="btn-primary w-full"
					disabled={busy || !password.trim()}
				>
					{busy && <SpinnerIcon className="h-4 w-4 animate-spin" />}
					验证并继续
				</button>
			</form>
		</div>
	);
}

// ---------- 分享页 ----------

export default function Share({ loaderData }: Route.ComponentProps) {
	const token = loaderData.token;
	const [share, setShare] = useState<ShareInfo | null>(null);
	const [storage, setStorage] = useState<StorageBrief | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	// 密码状态
	const [password, setPassword] = useState("");
	const [passwordVerified, setPasswordVerified] = useState(false);
	const [verifying, setVerifying] = useState(false);
	const [passwordError, setPasswordError] = useState("");

	// 浏览状态（relPath 相对分享根目录）
	const [relPath, setRelPath] = useState("");
	const [objects, setObjects] = useState<S3Object[]>([]);
	const [listLoading, setListLoading] = useState(false);
	const [listError, setListError] = useState("");
	const [previewFile, setPreviewFile] = useState<S3Object | null>(null);

	// 拉取分享元信息
	useEffect(() => {
		if (!token) {
			setError("分享令牌缺失");
			setLoading(false);
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(
					`/api/shares?token=${encodeURIComponent(token)}`
				);
				const data = (await res.json()) as {
					share?: ShareInfo;
					storage?: StorageBrief;
					error?: string;
				};
				if (!res.ok || !data.share || !data.storage) {
					throw new Error(data.error || "分享链接不存在或已过期");
				}
				if (!cancelled) {
					setShare(data.share);
					setStorage(data.storage);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "加载分享失败");
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [token]);

	const root = share ? shareRoot(share) : "";

	/** 相对路径 → 实际完整路径 */
	const fullPath = useCallback(
		(rel: string) => (root ? (rel ? `${root}/${rel}` : root) : rel),
		[root]
	);

	const fileParams = useCallback((): Record<string, string> => {
		const params: Record<string, string> = {};
		if (token) params.token = token;
		if (passwordVerified && password) params.password = password;
		return params;
	}, [token, passwordVerified, password]);

	// 目录分享：加载列表（单文件分享无需列表）
	useEffect(() => {
		if (!share || !share.isDirectory) return;
		if (share.hasPassword && !passwordVerified) return;
		let cancelled = false;
		(async () => {
			setListLoading(true);
			setListError("");
			try {
				const url = apiFileUrl(share.storageId, fullPath(relPath), {
					action: "list",
					...fileParams(),
				});
				const res = await fetch(url);
				const data = (await res.json()) as {
					objects?: S3Object[];
					error?: string;
				};
				if (!res.ok) {
					throw new Error(data.error || "加载失败");
				}
				if (!cancelled) setObjects(data.objects || []);
			} catch (err) {
				if (!cancelled) {
					setObjects([]);
					setListError(err instanceof Error ? err.message : "网络错误");
				}
			} finally {
				if (!cancelled) setListLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [share, relPath, fullPath, fileParams, passwordVerified]);

	const verifyPassword = async () => {
		if (!token) return;
		setVerifying(true);
		setPasswordError("");
		try {
			const res = await fetch("/api/shares", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "verify",
					token,
					password: password.trim(),
				}),
			});
			const data = (await res.json()) as { success?: boolean; error?: string };
			if (!res.ok) {
				throw new Error(data.error || "验证失败");
			}
			if (data.success) {
				setPasswordVerified(true);
			} else {
				setPasswordError("密码错误");
			}
		} catch (err) {
			setPasswordError(err instanceof Error ? err.message : "验证失败");
		} finally {
			setVerifying(false);
		}
	};

	const downloadObject = (obj: S3Object) => {
		if (!share || obj.isDirectory) return;
		const link = document.createElement("a");
		link.href = apiFileUrl(share.storageId, obj.key, {
			action: "download",
			...fileParams(),
		});
		link.download = obj.name;
		document.body.appendChild(link);
		link.click();
		link.remove();
	};

	const openObject = (obj: S3Object) => {
		if (!share) return;
		if (obj.isDirectory) {
			// 目录 key 相对存储根，换算回相对分享根的路径
			const dirKey = obj.key.replace(/\/+$/, "");
			const prefix = root ? root + "/" : "";
			setRelPath(dirKey.startsWith(prefix) ? dirKey.slice(prefix.length) : dirKey);
		} else if (isPreviewable(obj.name)) {
			setPreviewFile(obj);
		} else {
			downloadObject(obj);
		}
	};

	// ---------- 渲染 ----------

	// 元信息加载中（有令牌且尚未拿到结果）→ 加载态，避免闪现"链接不存在"
	if (token && loading) {
		return (
			<main className="flex min-h-dvh items-center justify-center gap-2 text-sm text-zinc-500">
				<SpinnerIcon className="h-5 w-5 animate-spin" />
				正在加载分享…
			</main>
		);
	}

	if (!token || error || !share || !storage) {
		return (
			<main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
				<CloudIcon className="h-12 w-12 text-zinc-300 dark:text-zinc-700" />
				<h1 className="text-base font-semibold text-zinc-800 dark:text-zinc-200">
					{error || "分享链接不存在"}
				</h1>
				<p className="text-sm text-zinc-500">
					{error || "请向分享者确认链接是否正确"}
				</p>
			</main>
		);
	}

	// 加密分享且未通过验证
	if (share.hasPassword && !passwordVerified) {
		return (
			<main className="flex min-h-dvh flex-col">
				<header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
					<CloudIcon className="h-5 w-5 text-blue-600" />
					<span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
						{storage.name} 的分享
					</span>
				</header>
				<PasswordGate
					onVerified={verifyPassword}
					busy={verifying}
					error={passwordError}
					password={password}
					setPassword={setPassword}
				/>
			</main>
		);
	}

	const rootName = root ? root.split("/").filter(Boolean).pop() || storage.name : storage.name;
	const relSegments = relPath ? relPath.split("/") : [];

	return (
		<main className="flex min-h-dvh flex-col">
			{/* 头部 */}
			<header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
				<CloudIcon className="h-5 w-5 text-blue-600" />
				<span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
					{storage.name}
				</span>
				<span className="badge bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
					{share.isDirectory ? "目录分享" : "文件分享"}
				</span>
				<span className="badge bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
					{share.expiresAt ? `有效期至 ${formatDate(share.expiresAt)}` : "永久有效"}
				</span>
			</header>

			{/* 单文件分享 */}
			{!share.isDirectory ? (
				<div className="flex flex-1 items-center justify-center p-6">
					<div className="card w-full max-w-md p-6 text-center">
						<FileTypeIcon
							name={rootName}
							className="mx-auto h-14 w-14"
						/>
						<h2 className="mt-3 break-all text-base font-semibold text-zinc-900 dark:text-zinc-100">
							{rootName}
						</h2>
						<p className="mt-1 text-xs text-zinc-500">
							分享于 {formatDate(share.createdAt)}
						</p>
						<div className="mt-5 flex justify-center gap-2">
							{isPreviewable(rootName) && (
								<button
									type="button"
									className="btn-outline"
									onClick={() =>
										setPreviewFile({
											key: root,
											name: rootName,
											size: 0,
											lastModified: "",
											isDirectory: false,
										})
									}
								>
									<EyeIcon className="h-4 w-4" />
									预览
								</button>
							)}
							<button
								type="button"
								className="btn-primary"
								onClick={() =>
									downloadObject({
										key: root,
										name: rootName,
										size: 0,
										lastModified: "",
										isDirectory: false,
									})
								}
							>
								<DownloadIcon className="h-4 w-4" />
								下载
							</button>
						</div>
					</div>
				</div>
			) : (
				<>
					{/* 面包屑 */}
					<nav className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-white/80 px-4 py-2.5 text-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
						<button
							type="button"
							className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-medium text-zinc-700 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800/70"
							onClick={() => setRelPath("")}
						>
							<HomeIcon className="h-4 w-4" />
							{rootName}
						</button>
						{relSegments.map((segment, index) => {
							const target = relSegments.slice(0, index + 1).join("/");
							return (
								<span key={target} className="flex shrink-0 items-center gap-1">
									<ChevronRightIcon className="h-3.5 w-3.5 text-zinc-400" />
									<button
										type="button"
										className="rounded px-1.5 py-1 text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800/70"
										onClick={() => setRelPath(target)}
									>
										{segment}
									</button>
								</span>
							);
						})}
					</nav>

					{/* 文件列表 */}
					<div className="min-h-0 flex-1 overflow-auto">
						{listLoading ? (
							<div className="flex items-center justify-center gap-2 p-14 text-sm text-zinc-500">
								<SpinnerIcon className="h-5 w-5 animate-spin" />
								正在加载…
							</div>
						) : listError ? (
							<div className="m-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
								{listError}
							</div>
						) : objects.length === 0 ? (
							<div className="flex flex-col items-center justify-center gap-2 p-14 text-center text-sm text-zinc-500">
								<CloudIcon className="h-8 w-8 text-zinc-400" />
								此目录为空
							</div>
						) : (
							<table className="w-full border-collapse text-sm">
								<thead className="sticky top-0 bg-white/95 backdrop-blur dark:bg-zinc-900/95">
									<tr className="border-b border-zinc-200 dark:border-zinc-800">
										<th className="table-head">名称</th>
										<th className="table-head w-24">大小</th>
										<th className="table-head w-40">修改时间</th>
										<th className="table-head w-24"></th>
									</tr>
								</thead>
								<tbody>
									{objects.map((obj) => (
										<tr
											key={obj.key}
											className="group border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/50"
										>
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
												{obj.isDirectory ? "-" : obj.lastModified
													? new Date(obj.lastModified).toLocaleString("zh-CN", {
															hour12: false,
														})
													: "-"}
											</td>
											<td className="px-3 py-1.5">
												<div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
													{!obj.isDirectory && (
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
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</div>
				</>
			)}

			{/* 预览 */}
			{previewFile && share && (
				<FilePreview
					storageId={share.storageId}
					path={previewFile.key}
					fileName={previewFile.name}
					size={previewFile.size || undefined}
					token={token || undefined}
					password={passwordVerified && password ? password : undefined}
					onClose={() => setPreviewFile(null)}
				/>
			)}
		</main>
	);
}

