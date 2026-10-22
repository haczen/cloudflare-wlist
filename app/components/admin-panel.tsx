import { useEffect, useMemo, useRef, useState } from "react";
import {
	CheckIcon,
	CloseIcon,
	GlobeIcon,
	HistoryIcon,
	LinkIcon,
	ShareIcon,
	ShieldIcon,
	SpinnerIcon,
	StatsIcon,
	StorageIcon,
	TrashIcon,
	UploadIcon,
} from "~/components/icons";

// ---------- 类型 ----------

export interface StorageInfo {
	id: number;
	name: string;
	type: string;
	endpoint?: string;
	region?: string;
	accessKeyId?: string;
	bucket?: string;
	basePath?: string;
	config?: Record<string, any>;
	isPublic: boolean;
	guestList: boolean;
	guestDownload: boolean;
	guestUpload: boolean;
	/** 当前访问者的实际权限（服务端计算） */
	access?: { list: boolean; download: boolean; upload: boolean };
}

interface ShareInfo {
	id: string;
	storageId: number;
	filePath: string;
	isDirectory: boolean;
	shareToken: string;
	expiresAt: string | null;
	createdAt: string;
	hasPassword?: boolean;
}

interface AuditLog {
	id: number;
	action: string;
	storageId: number | null;
	path: string | null;
	userType: string;
	ip: string | null;
	detail: string | null;
	createdAt: string;
}

export const STORAGE_TYPE_OPTIONS: Array<{
	value: string;
	label: string;
	hint: string;
}> = [
	{ value: "s3", label: "S3 兼容存储", hint: "AWS S3 / R2 / B2 / OSS / COS / MinIO" },
	{ value: "webdav", label: "WebDAV", hint: "任意 WebDAV 服务（坚果云、TeraCloud 等）" },
	{ value: "onedrive", label: "OneDrive", hint: "Microsoft Graph，支持世纪互联" },
	{ value: "gdrive", label: "Google Drive", hint: "Google Drive API v3" },
	{ value: "baiduyun", label: "百度网盘", hint: "百度开放平台" },
	{ value: "alicloud", label: "阿里云盘", hint: "阿里云盘 OpenAPI" },
];

const DRIVE_CONFIG_TEMPLATES: Record<string, Record<string, string>> = {
	onedrive: {
		refresh_token: "必填：refresh_token",
		region: "global（世纪互联填 cn）",
		root_folder_path: "/（可选，限定根目录）",
	},
	gdrive: {
		refresh_token: "必填：refresh_token",
		root_folder_id: "root（可选）",
	},
	baiduyun: {
		refresh_token: "必填：refresh_token",
		root_path: "/（可选）",
	},
	alicloud: {
		refresh_token: "必填：refresh_token",
		drive_type: "resource（备份盘填 backup）",
	},
};

// ---------- 存储编辑表单 ----------

export function StorageFormDialog({
	initial,
	onSaved,
	onClose,
}: {
	initial: StorageInfo | null;
	onSaved: () => void;
	onClose: () => void;
}) {
	const isEdit = !!initial;
	const [type, setType] = useState(initial?.type || "s3");
	const [form, setForm] = useState({
		name: initial?.name || "",
		endpoint: initial?.endpoint || "",
		region: initial?.region || "auto",
		// 编辑时回填 accessKeyId（API 明文返回）；密钥服务端不回传，留空表示不变
		accessKeyId: initial?.accessKeyId || "",
		secretAccessKey: "",
		bucket: initial?.bucket || "",
		basePath: initial?.basePath || "",
		configJson: initial?.config
			? JSON.stringify(initial.config, null, 2)
			: "",
		forcePathStyle: initial?.config?.forcePathStyle === true,
		isPublic: initial?.isPublic ?? false,
		guestList: initial?.guestList ?? true,
		guestDownload: initial?.guestDownload ?? true,
		guestUpload: initial?.guestUpload ?? false,
	});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const set = (key: keyof typeof form, value: any) => {
		setForm((prev) => ({ ...prev, [key]: value }));
	};

	const isS3 = type === "s3";
	const isWebdav = type === "webdav" || type === "webdev";
	const isDrive = !isS3 && !isWebdav;

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setLoading(true);
		setError(null);
		try {
			let config: Record<string, any> | undefined;
			if (isDrive) {
				if (form.configJson.trim()) {
					try {
						config = JSON.parse(form.configJson);
					} catch {
						throw new Error("扩展配置 JSON 格式错误");
					}
				}
			}

			const body: Record<string, any> = {
				name: form.name,
				type,
				endpoint: isDrive ? "" : form.endpoint,
				region: isS3 ? form.region || "auto" : "",
				// 编辑时凭证留空 = 保持原值（updateStorage 只更新传入的字段）
				accessKeyId:
					isS3 || isWebdav
						? form.accessKeyId || (isEdit ? undefined : "")
						: "",
				secretAccessKey:
					isS3 || isWebdav
						? form.secretAccessKey || (isEdit ? undefined : "")
						: "",
				bucket: isS3 ? form.bucket : "",
				basePath: form.basePath,
				config: config || (isS3 ? { forcePathStyle: form.forcePathStyle } : {}),
				isPublic: form.isPublic,
				guestList: form.guestList,
				guestDownload: form.guestDownload,
				guestUpload: form.guestUpload,
			};
			// JSON.stringify 会丢弃 undefined 字段，服务端即跳过更新对应列

			const response = await fetch("/api/storages", {
				method: isEdit ? "PUT" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(isEdit ? { id: initial!.id, ...body } : body),
			});
			const data = (await response.json()) as { error?: string };
			if (!response.ok) {
				throw new Error(data.error || "保存失败");
			}
			onSaved();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存失败");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="max-h-[88vh] w-full max-w-xl overflow-auto rounded-2xl bg-white shadow-2xl dark:bg-zinc-900">
				<div className="sticky top-0 flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900">
					<h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
						{isEdit ? `编辑存储 · ${initial!.name}` : "添加存储"}
					</h3>
					<button type="button" className="btn-ghost !px-1.5" onClick={onClose}>
						<CloseIcon className="h-4 w-4" />
					</button>
				</div>

				<form className="space-y-4 px-5 py-4" onSubmit={handleSubmit}>
					{/* 类型 */}
					<div>
						<label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
							存储类型
						</label>
						<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
							{STORAGE_TYPE_OPTIONS.map((option) => (
								<button
									key={option.value}
									type="button"
									disabled={isEdit}
									onClick={() => setType(option.value)}
									className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
										type === option.value
											? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
											: "border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400"
									} ${isEdit ? "cursor-not-allowed opacity-60" : ""}`}
									title={option.hint}
								>
									<StorageIcon type={option.value} className="h-4 w-4 shrink-0" />
									<span className="font-medium">{option.label}</span>
								</button>
							))}
						</div>
					</div>

					{/* 名称 */}
					<div>
						<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
							名称
						</label>
						<input
							className="input"
							value={form.name}
							onChange={(event) => set("name", event.target.value)}
							placeholder="我的存储"
							required
						/>
					</div>

					{/* S3 / WebDAV 连接字段 */}
					{(isS3 || isWebdav) && (
						<>
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<div className={isS3 ? "" : "sm:col-span-2"}>
									<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
										{isS3 ? "Endpoint" : "WebDAV 地址"}
									</label>
									<input
										className="input"
										value={form.endpoint}
										onChange={(event) => set("endpoint", event.target.value)}
										placeholder={
											isS3
												? "https://s3.us-east-005.backblazeb2.com"
												: "https://dav.teracloud.jp/dav/"
										}
										required
									/>
								</div>
								{isS3 && (
									<div>
										<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
											Region
										</label>
										<input
											className="input"
											value={form.region}
											onChange={(event) => set("region", event.target.value)}
											placeholder="auto"
										/>
									</div>
								)}
							</div>
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<div>
									<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
										{isS3 ? "Access Key ID" : "用户名"}
									</label>
									<input
										className="input"
										value={form.accessKeyId}
										onChange={(event) => set("accessKeyId", event.target.value)}
										required={!isEdit}
										placeholder={isEdit ? "留空保持不变" : ""}
										autoComplete="off"
									/>
								</div>
								<div>
									<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
										{isS3 ? "Secret Access Key" : "密码"}
									</label>
									<input
										className="input"
										type="password"
										value={form.secretAccessKey}
										onChange={(event) =>
											set("secretAccessKey", event.target.value)
										}
										placeholder={isEdit ? "留空保持不变" : ""}
										autoComplete="new-password"
									/>
								</div>
							</div>
							{isS3 && (
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<div>
										<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
											Bucket
										</label>
										<input
											className="input"
											value={form.bucket}
											onChange={(event) => set("bucket", event.target.value)}
											required
										/>
									</div>
									<div>
										<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
											Base Path（可选）
										</label>
										<input
											className="input"
											value={form.basePath}
											onChange={(event) => set("basePath", event.target.value)}
											placeholder="留空为整个 bucket"
										/>
									</div>
								</div>
							)}
							{isS3 && (
								<label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
									<input
										type="checkbox"
										checked={form.forcePathStyle}
										onChange={(event) => set("forcePathStyle", event.target.checked)}
										className="h-4 w-4"
									/>
									强制 Path-Style 访问（MinIO 等无泛域名解析的私有存储开启；阿里云 OSS / AWS S3 / R2 保持关闭）
								</label>
							)}
							{isWebdav && (
								<div>
									<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
										Base Path（可选）
									</label>
									<input
										className="input"
										value={form.basePath}
										onChange={(event) => set("basePath", event.target.value)}
										placeholder="留空为根目录"
									/>
								</div>
							)}
						</>
					)}

					{/* 网盘扩展配置 */}
					{isDrive && (
						<div>
							<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
								扩展配置（JSON）
							</label>
							<textarea
								className="input min-h-[120px] font-mono text-xs"
								value={form.configJson}
								onChange={(event) => set("configJson", event.target.value)}
								placeholder={JSON.stringify(
									DRIVE_CONFIG_TEMPLATES[type] || { refresh_token: "必填" },
									null,
									2
								)}
							/>
							<p className="mt-1 text-[11px] text-zinc-500">
								至少包含 refresh_token；可选 client_id / client_secret（本地刷新）、
								{Object.values(DRIVE_CONFIG_TEMPLATES[type] || {})
									.filter((v) => !v.startsWith("必填"))
									.join(" / ")}
							</p>
						</div>
					)}

					{/* 权限 */}
					<div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
						<div className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
							访问控制
						</div>
						<div className="grid grid-cols-2 gap-2">
							{(
								[
									["isPublic", "公开存储"],
									["guestList", "访客浏览"],
									["guestDownload", "访客下载"],
									["guestUpload", "访客上传"],
								] as const
							).map(([key, label]) => (
								<label
									key={key}
									className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300"
								>
									<input
										type="checkbox"
										className="h-4 w-4 rounded border-zinc-300 accent-blue-600"
										checked={form[key]}
										onChange={(event) => set(key, event.target.checked)}
									/>
									{label}
								</label>
							))}
						</div>
					</div>

					{error && (
						<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
							{error}
						</p>
					)}

					<div className="flex justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
						<button type="button" className="btn-ghost" onClick={onClose}>
							取消
						</button>
						<button
							type="submit"
							className="btn-primary"
							disabled={loading || !form.name}
						>
							{loading && <SpinnerIcon className="h-4 w-4 animate-spin" />}
							{isEdit ? "保存修改" : "添加"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

// ---------- 用户管理 ----------

export interface AdminUserRow {
	id: number;
	username: string;
	displayName: string;
	bio: string;
	avatarUrl: string;
	role: "admin" | "user";
	githubLogin: string | null;
	isDisabled: boolean;
	hasPassword?: boolean;
	folders?: Array<{
		folderId: number;
		canList: boolean;
		canDownload: boolean;
		canUpload: boolean;
	}>;
}

/** 目录树节点（分配用） */
export interface AdminFolderNode {
	id: number;
	name: string;
	isPublic?: boolean;
	children: AdminFolderNode[];
}

function FolderAssignItem({
	node,
	depth,
	perms,
	toggleFolder,
	setPerm,
}: {
	node: AdminFolderNode;
	depth: number;
	perms: Map<number, { list: boolean; download: boolean; upload: boolean }>;
	toggleFolder: (folderId: number, on: boolean) => void;
	setPerm: (
		folderId: number,
		key: "list" | "download" | "upload",
		value: boolean
	) => void;
}) {
	const p = perms.get(node.id);
	return (
		<div>
			<div
				className="card flex flex-wrap items-center gap-3 px-3 py-2"
				style={{ marginLeft: `${depth * 12}px` }}
			>
				<label className="flex min-w-36 items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
					<input
						type="checkbox"
						className="h-4 w-4 accent-blue-600"
						checked={!!p}
						onChange={(event) => toggleFolder(node.id, event.target.checked)}
					/>
					{node.children.length > 0 ? "📂" : "📄"}
					<span className="truncate">{node.name}</span>
					{node.isPublic && (
						<span className="badge bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">
							公开
						</span>
					)}
				</label>
				{p && (
					<div className="flex items-center gap-3 text-xs text-zinc-600 dark:text-zinc-400">
						{(
							[
								["list", "浏览", p.list],
								["download", "下载", p.download],
								["upload", "上传", p.upload],
							] as const
						).map(([key, label, checked]) => (
							<label key={key} className="flex items-center gap-1">
								<input
									type="checkbox"
									className="h-3.5 w-3.5 accent-blue-600"
									checked={checked}
									onChange={(event) =>
										setPerm(node.id, key, event.target.checked)
									}
								/>
								{label}
							</label>
						))}
					</div>
				)}
			</div>
			{node.children.map((child) => (
				<FolderAssignItem
					key={child.id}
					node={child}
					depth={depth + 1}
					perms={perms}
					toggleFolder={toggleFolder}
					setPerm={setPerm}
				/>
			))}
		</div>
	);
}

export function UserFormDialog({
	initial,
	folderTree,
	currentUserId,
	onSaved,
	onClose,
}: {
	initial: AdminUserRow | null;
	folderTree: AdminFolderNode[];
	currentUserId: number;
	onSaved: () => void;
	onClose: () => void;
}) {
	const isEdit = !!initial;
	const [username, setUsername] = useState(initial?.username || "");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<"admin" | "user">(initial?.role || "user");
	const [isDisabled, setIsDisabled] = useState(initial?.isDisabled || false);
	// folderId → 权限
	const [perms, setPerms] = useState<
		Map<number, { list: boolean; download: boolean; upload: boolean }>
	>(() => {
		const map = new Map<
			number,
			{ list: boolean; download: boolean; upload: boolean }
		>();
		for (const p of initial?.folders || []) {
			map.set(p.folderId, {
				list: p.canList,
				download: p.canDownload,
				upload: p.canUpload,
			});
		}
		return map;
	});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggleFolder = (folderId: number, on: boolean) => {
		setPerms((prev) => {
			const next = new Map(prev);
			if (on) {
				next.set(folderId, { list: true, download: true, upload: false });
			} else {
				next.delete(folderId);
			}
			return next;
		});
	};

	const setPerm = (
		folderId: number,
		key: "list" | "download" | "upload",
		value: boolean
	) => {
		setPerms((prev) => {
			const next = new Map(prev);
			const current = next.get(folderId) || {
				list: true,
				download: true,
				upload: false,
			};
			next.set(folderId, { ...current, [key]: value });
			return next;
		});
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const folderAssignments = Array.from(perms.entries()).map(
				([folderId, p]) => ({
					folderId,
					canList: p.list,
					canDownload: p.download,
					canUpload: p.upload,
				})
			);
			let response: Response;
			if (isEdit) {
				response = await fetch("/api/users", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: initial!.id,
						role,
						isDisabled,
						...(password ? { password } : {}),
						folders: folderAssignments,
					}),
				});
			} else {
				response = await fetch("/api/users", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						username,
						password,
						role,
						folders: folderAssignments,
					}),
				});
			}
			const data = (await response.json()) as { error?: string };
			if (!response.ok) {
				throw new Error(data.error || "保存失败");
			}
			onSaved();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存失败");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="max-h-[88vh] w-full max-w-xl overflow-auto rounded-2xl bg-white shadow-2xl dark:bg-zinc-900">
				<div className="sticky top-0 flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900">
					<h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
						{isEdit ? `编辑用户 · ${initial!.username}` : "添加用户"}
					</h3>
					<button type="button" className="btn-ghost !px-1.5" onClick={onClose}>
						<CloseIcon className="h-4 w-4" />
					</button>
				</div>
				<form className="space-y-4 px-5 py-4" onSubmit={handleSubmit}>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div>
							<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
								用户名
							</label>
							<input
								className="input"
								value={username}
								onChange={(event) => setUsername(event.target.value)}
								disabled={isEdit}
								required={!isEdit}
								autoComplete="off"
							/>
						</div>
						<div>
							<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
								{isEdit ? "重置密码（留空不改）" : "密码（至少 6 位）"}
							</label>
							<input
								className="input"
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								required={!isEdit}
								minLength={6}
								autoComplete="new-password"
							/>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-4">
						<div>
							<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
								角色
							</label>
							<select
								className="input !w-36"
								value={role}
								onChange={(event) =>
									setRole(event.target.value as "admin" | "user")
								}
							>
								<option value="user">普通用户</option>
								<option value="admin">管理员</option>
							</select>
						</div>
						{isEdit && (
							<label className="flex items-center gap-2 pt-4 text-sm text-zinc-700 dark:text-zinc-300">
								<input
									type="checkbox"
									className="h-4 w-4 accent-blue-600"
									checked={isDisabled}
									onChange={(event) => setIsDisabled(event.target.checked)}
								/>
								禁用账号
							</label>
						)}
					</div>

					<div>
						<label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
							分配目录（勾选父目录即包含子目录；公开目录无需分配）
						</label>
						{folderTree.length === 0 ? (
							<p className="text-xs text-zinc-500">还没有目录。先到首页创建主目录再分配。</p>
						) : (
							<div className="space-y-2">
								{folderTree.map((node) => (
									<FolderAssignItem
										key={node.id}
										node={node}
										depth={0}
										perms={perms}
										toggleFolder={toggleFolder}
										setPerm={setPerm}
									/>
								))}
							</div>
						)}
					</div>

					{error && (
						<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
							{error}
						</p>
					)}
					<div className="flex justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
						<button type="button" className="btn-ghost" onClick={onClose}>
							取消
						</button>
						<button type="submit" className="btn-primary" disabled={saving}>
							{saving && <SpinnerIcon className="h-4 w-4 animate-spin" />}
							{isEdit ? "保存修改" : "创建用户"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

// ---------- 管理面板主组件 ----------

type AdminTab = "storages" | "users" | "shares" | "backup" | "audit" | "webdav";

export function AdminPanel({
	storages,
	webdavEnabled,
	currentUserId,
	onStoragesChanged,
	onClose,
	onShowStats,
	onEditStorage,
	onAddStorage,
}: {
	storages: StorageInfo[];
	webdavEnabled: boolean;
	/** 当前登录管理员（用于防止误操作自己） */
	currentUserId: number;
	onStoragesChanged: () => void;
	onClose: () => void;
	onShowStats: (storage: StorageInfo) => void;
	onEditStorage: (storage: StorageInfo) => void;
	onAddStorage: () => void;
}) {
	const [tab, setTab] = useState<AdminTab>("storages");
	const [shares, setShares] = useState<ShareInfo[]>([]);
	const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
	const [auditAction, setAuditAction] = useState("");
	const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
	const [importResult, setImportResult] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// 用户管理
	const [users, setUsers] = useState<AdminUserRow[]>([]);
	const [editingUser, setEditingUser] = useState<AdminUserRow | null>(null);
	const [showAddUser, setShowAddUser] = useState(false);
	const [folderTree, setFolderTree] = useState<AdminFolderNode[]>([]);

	// 拉取分享 / 审计 / 用户数据 + 目录树
	useEffect(() => {
		if (tab === "users") {
			fetch("/api/users")
				.then((response) => response.json() as Promise<{ users?: AdminUserRow[] }>)
				.then((data) => setUsers(data.users || []))
				.catch(() => setUsers([]));
			fetch("/api/folders")
				.then((response) => response.json() as Promise<{ folders?: AdminFolderNode[] }>)
				.then((data) => setFolderTree(data.folders || []))
				.catch(() => setFolderTree([]));
		}
		if (tab === "shares") {
			fetch("/api/shares")
				.then((response) => response.json() as Promise<{ shares?: ShareInfo[] }>)
				.then((data) => setShares(data.shares || []))
				.catch(() => setShares([]));
		}
		if (tab === "audit") {
			const params = new URLSearchParams({ limit: "200" });
			if (auditAction.trim()) {
				params.set("action", auditAction.trim());
			}
			fetch(`/api/audit?${params}`)
				.then((response) => response.json() as Promise<{ logs?: AuditLog[] }>)
				.then((data) => setAuditLogs(data.logs || []))
				.catch(() => setAuditLogs([]));
		}
	}, [tab, auditAction]);

	const handleDeleteStorage = async (storage: StorageInfo) => {
		if (
			!window.confirm(
				`确定删除存储「${storage.name}」吗？相关的分享链接也会一并删除。`
			)
		) {
			return;
		}
		setBusy(true);
		try {
			const response = await fetch(
				`/api/storages?id=${storage.id}`,
				{ method: "DELETE" }
			);
			if (!response.ok) {
				const data = (await response.json()) as { error?: string };
				throw new Error(data.error || "删除失败");
			}
			onStoragesChanged();
		} catch (err) {
			window.alert(err instanceof Error ? err.message : "删除失败");
		} finally {
			setBusy(false);
		}
	};

	const handleDeleteShare = async (share: ShareInfo) => {
		if (!window.confirm(`确定删除分享「${share.shareToken}」吗？`)) return;
		await fetch(`/api/shares?id=${share.id}`, { method: "DELETE" });
		setShares((prev) => prev.filter((s) => s.id !== share.id));
	};

	const refreshUsers = () => {
		fetch("/api/users")
			.then((response) => response.json() as Promise<{ users?: AdminUserRow[] }>)
			.then((data) => setUsers(data.users || []))
			.catch(() => setUsers([]));
	};

	const handleDeleteUser = async (user: AdminUserRow) => {
		if (
			!window.confirm(
				`确定删除用户「${user.username}」吗？其会话与存储分配将一并清除。`
			)
		) {
			return;
		}
		const response = await fetch(`/api/users?id=${user.id}`, {
			method: "DELETE",
		});
		if (!response.ok) {
			const data = (await response.json()) as { error?: string };
			window.alert(data.error || "删除失败");
			return;
		}
		refreshUsers();
	};

	const handleExportBackup = async () => {
		setBusy(true);
		try {
			const response = await fetch("/api/storages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "export-backup" }),
			});
			const data = (await response.json()) as {
				error?: string;
				backup: unknown;
			};
			if (!response.ok) {
				throw new Error(data.error || "导出失败");
			}
			const blob = new Blob([JSON.stringify(data.backup, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `wlist-backup-${new Date().toISOString().slice(0, 10)}.json`;
			link.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			window.alert(err instanceof Error ? err.message : "导出失败");
		} finally {
			setBusy(false);
		}
	};

	const handleImportBackup = async (
		event: React.ChangeEvent<HTMLInputElement>
	) => {
		const file = event.target.files?.[0];
		if (!file) return;
		setBusy(true);
		setImportResult(null);
		try {
			const backup = JSON.parse(await file.text());
			const response = await fetch("/api/storages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "import-backup", backup, mode: importMode }),
			});
			const data = (await response.json()) as {
				error?: string;
				imported: number;
				skipped: number;
				errors?: string[];
			};
			if (!response.ok) {
				throw new Error(data.error || "导入失败");
			}
			setImportResult(
				`导入成功：新增 ${data.imported} 个，跳过同名 ${data.skipped} 个${
					data.errors?.length ? `；错误：${data.errors.join("; ")}` : ""
				}`
			);
			onStoragesChanged();
		} catch (err) {
			setImportResult(`导入失败：${err instanceof Error ? err.message : "未知错误"}`);
		} finally {
			setBusy(false);
			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
		}
	};

	const storageNameById = useMemo(() => {
		const map = new Map<number, string>();
		for (const storage of storages) {
			map.set(storage.id, storage.name);
		}
		return map;
	}, [storages]);

	const tabs: Array<{ key: AdminTab; label: string }> = [
		{ key: "storages", label: `存储 (${storages.length})` },
		{ key: "users", label: "用户" },
		{ key: "shares", label: "分享" },
		{ key: "backup", label: "备份" },
		{ key: "audit", label: "审计" },
		{ key: "webdav", label: "WebDAV" },
	];

	return (
		<div
			className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="flex h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900">
				{/* 头部 */}
				<div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
					<div className="flex items-center gap-2">
						<ShieldIcon className="h-4 w-4 text-blue-600" />
						<h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
							管理面板
						</h3>
					</div>
					<button type="button" className="btn-ghost !px-1.5" onClick={onClose}>
						<CloseIcon className="h-4 w-4" />
					</button>
				</div>

				{/* 标签页 */}
				<div className="flex gap-1 border-b border-zinc-200 px-4 pt-2 dark:border-zinc-800">
					{tabs.map((item) => (
						<button
							key={item.key}
							type="button"
							onClick={() => setTab(item.key)}
							className={`rounded-t-lg px-3.5 py-2 text-sm font-medium transition-colors ${
								tab === item.key
									? "border-b-2 border-blue-600 text-blue-600 dark:text-blue-400"
									: "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
							}`}
						>
							{item.label}
						</button>
					))}
				</div>

				<div className="min-h-0 flex-1 overflow-auto p-4">
					{/* 存储管理 */}
					{tab === "storages" && (
						<div className="space-y-2">
							<div className="flex justify-end">
								<button type="button" className="btn-primary" onClick={onAddStorage}>
									添加存储
								</button>
							</div>
							{storages.length === 0 && (
								<p className="py-10 text-center text-sm text-zinc-500">
									还没有存储，点击「添加存储」开始
								</p>
							)}
							{storages.map((storage) => (
								<div
									key={storage.id}
									className="card flex items-center gap-3 px-4 py-3"
								>
									<StorageIcon type={storage.type} className="h-5 w-5 shrink-0" />
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
												{storage.name}
											</span>
											<span className="badge bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
												{storage.type}
											</span>
											{storage.isPublic && (
												<span className="badge bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">
													公开
												</span>
											)}
											{storage.guestUpload && (
												<span className="badge bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400">
													访客可传
												</span>
											)}
										</div>
										<div className="truncate text-xs text-zinc-500">
											{storage.type === "s3"
												? `${storage.endpoint} / ${storage.bucket}`
												: storage.endpoint || "云盘驱动"}
											{storage.basePath ? ` · /${storage.basePath}` : ""}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<button
											type="button"
											className="btn-ghost !px-2"
											title="统计"
											onClick={() => onShowStats(storage)}
										>
											<StatsIcon className="h-4 w-4" />
										</button>
										<button
											type="button"
											className="btn-ghost !px-2"
											title="编辑"
											onClick={() => onEditStorage(storage)}
										>
											<RenameIcon />
										</button>
										<button
											type="button"
											className="btn-ghost !px-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
											title="删除"
											disabled={busy}
											onClick={() => handleDeleteStorage(storage)}
										>
											<TrashIcon className="h-4 w-4" />
										</button>
									</div>
								</div>
							))}
						</div>
					)}

					{/* 用户管理 */}
					{tab === "users" && (
						<div className="space-y-2">
							<div className="flex justify-end">
								<button
									type="button"
									className="btn-primary"
									onClick={() => setShowAddUser(true)}
								>
									添加用户
								</button>
							</div>
							{users.length === 0 && (
								<p className="py-10 text-center text-sm text-zinc-500">
									还没有用户，点击「添加用户」创建
								</p>
							)}
							{users.map((user) => (
								<div
									key={user.id}
									className="card flex items-center gap-3 px-4 py-3"
								>
									<img
										src={
											user.avatarUrl ||
											`https://github.com/${user.username}.png`
										}
										alt=""
										className="h-9 w-9 shrink-0 rounded-full border border-zinc-200 object-cover dark:border-zinc-700"
										onError={(event) => {
											event.currentTarget.style.visibility = "hidden";
										}}
									/>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
												{user.displayName || user.username}
											</span>
											<span className="text-xs text-zinc-400">
												@{user.username}
											</span>
											{user.role === "admin" && (
												<span className="badge bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400">
													管理员
												</span>
											)}
											{user.isDisabled && (
												<span className="badge bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400">
													已禁用
												</span>
											)}
											{user.githubLogin && (
												<span className="badge bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
													GitHub
												</span>
											)}
										</div>
										<div className="truncate text-xs text-zinc-500">
											{user.folders && user.folders.length > 0
												? `已分配 ${user.folders.length} 个目录`
												: "未分配目录（仅公开目录可见）"}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<button
											type="button"
											className="btn-ghost !px-2"
											title="编辑 / 分配存储"
											onClick={() => setEditingUser(user)}
										>
											<RenameIcon />
										</button>
										<button
											type="button"
											className="btn-ghost !px-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
											title="删除"
											onClick={() => handleDeleteUser(user)}
										>
											<TrashIcon className="h-4 w-4" />
										</button>
									</div>
								</div>
							))}
						</div>
					)}

					{/* 分享管理 */}
					{tab === "shares" && (
						<div className="space-y-2">
							{shares.length === 0 && (
								<p className="py-10 text-center text-sm text-zinc-500">
									暂无分享链接
								</p>
							)}
							{shares.map((share) => (
								<div
									key={share.id}
									className="card flex items-center gap-3 px-4 py-3"
								>
									<ShareIcon className="h-4 w-4 shrink-0 text-zinc-400" />
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-1.5 text-sm">
											<span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
												{storageNameById.get(share.storageId) ||
													`存储 ${share.storageId}`}
												: /{share.filePath}
												{share.isDirectory ? "/" : ""}
											</span>
											{share.hasPassword && (
												<span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
													加密
												</span>
											)}
										</div>
										<div className="text-xs text-zinc-500">
											令牌 {share.shareToken} · 创建于{" "}
											{new Date(share.createdAt).toLocaleString("zh-CN")}
											{share.expiresAt
												? ` · 过期于 ${new Date(share.expiresAt).toLocaleString("zh-CN")}`
												: " · 永久"}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<button
											type="button"
											className="btn-ghost !px-2"
											title="复制链接"
											onClick={() => {
												navigator.clipboard
													.writeText(
														`${window.location.origin}/share?token=${share.shareToken}`
													)
													.catch(() => {});
											}}
										>
											<LinkIcon className="h-4 w-4" />
										</button>
										<button
											type="button"
											className="btn-ghost !px-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
											title="删除"
											onClick={() => handleDeleteShare(share)}
										>
											<TrashIcon className="h-4 w-4" />
										</button>
									</div>
								</div>
							))}
						</div>
					)}

					{/* 备份 */}
					{tab === "backup" && (
						<div className="mx-auto max-w-lg space-y-4 py-4">
							<div className="card space-y-3 p-4">
								<h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
									导出备份
								</h4>
								<p className="text-xs text-zinc-500">
									导出全部存储配置（包含访问密钥），请妥善保管备份文件。
								</p>
								<button
									type="button"
									className="btn-primary"
									disabled={busy}
									onClick={handleExportBackup}
								>
									{busy ? (
										<SpinnerIcon className="h-4 w-4 animate-spin" />
									) : (
										<CheckIcon className="h-4 w-4" />
									)}
									导出 JSON
								</button>
							</div>

							<div className="card space-y-3 p-4">
								<h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
									导入备份
								</h4>
								<p className="text-xs text-zinc-500">
									支持 WList 备份格式，兼容 CList 导出的备份文件。
								</p>
								<div className="flex gap-3 text-sm">
									<label className="flex cursor-pointer items-center gap-1.5">
										<input
											type="radio"
											name="import-mode"
											checked={importMode === "merge"}
											onChange={() => setImportMode("merge")}
											className="accent-blue-600"
										/>
										合并（跳过同名）
									</label>
									<label className="flex cursor-pointer items-center gap-1.5">
										<input
											type="radio"
											name="import-mode"
											checked={importMode === "replace"}
											onChange={() => setImportMode("replace")}
											className="accent-blue-600"
										/>
										替换（清空现有）
									</label>
								</div>
								<input
									ref={fileInputRef}
									type="file"
									accept=".json,application/json"
									className="hidden"
									onChange={handleImportBackup}
								/>
								<button
									type="button"
									className="btn-outline"
									disabled={busy}
									onClick={() => fileInputRef.current?.click()}
								>
									<UploadIcon className="h-4 w-4" />
									选择备份文件
								</button>
								{importResult && (
									<p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
										{importResult}
									</p>
								)}
							</div>
						</div>
					)}

					{/* 审计日志 */}
					{tab === "audit" && (
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								<HistoryIcon className="h-4 w-4 text-zinc-400" />
								<input
									className="input max-w-xs"
									placeholder="按 action 过滤，如 file.download"
									value={auditAction}
									onChange={(event) => setAuditAction(event.target.value)}
								/>
								<span className="text-xs text-zinc-500">
									{auditLogs.length} 条记录
								</span>
							</div>
							<div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
								<table className="w-full text-left text-xs">
									<thead className="bg-zinc-50 dark:bg-zinc-800/50">
										<tr>
											<th className="table-head">时间</th>
											<th className="table-head">操作</th>
											<th className="table-head">用户</th>
											<th className="table-head">路径</th>
											<th className="table-head">IP</th>
											<th className="table-head">详情</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
										{auditLogs.map((log) => (
											<tr key={log.id} className="text-zinc-600 dark:text-zinc-400">
												<td className="whitespace-nowrap px-3 py-1.5">
													{new Date(log.createdAt + "Z").toLocaleString("zh-CN")}
												</td>
												<td className="whitespace-nowrap px-3 py-1.5 font-mono">
													{log.action}
												</td>
												<td className="px-3 py-1.5">
													<span
														className={`badge ${
															log.userType === "admin"
																? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
																: log.userType === "share"
																	? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400"
																	: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
														}`}
													>
														{log.userType}
													</span>
												</td>
												<td className="max-w-[220px] truncate px-3 py-1.5">
													{log.path || "-"}
												</td>
												<td className="whitespace-nowrap px-3 py-1.5">
													{log.ip || "-"}
												</td>
												<td className="max-w-[260px] truncate px-3 py-1.5 text-zinc-500">
													{log.detail || "-"}
												</td>
											</tr>
										))}
									</tbody>
								</table>
								{auditLogs.length === 0 && (
									<p className="py-8 text-center text-sm text-zinc-500">
										暂无日志
									</p>
								)}
							</div>
						</div>
					)}

					{/* WebDAV */}
					{tab === "webdav" && (
						<div className="mx-auto max-w-lg py-4">
							<div className="card space-y-3 p-4 text-sm">
								<div className="flex items-center gap-2">
									<GlobeIcon className="h-4 w-4 text-sky-500" />
									<h4 className="font-semibold text-zinc-900 dark:text-zinc-100">
										WebDAV 服务
									</h4>
									<span
										className={`badge ${
											webdavEnabled
												? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
												: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
										}`}
									>
										{webdavEnabled ? "已启用" : "未启用"}
									</span>
								</div>
								<p className="text-xs text-zinc-500">
									在 wrangler.jsonc 中设置{" "}
									<code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">
										WEBDAV_ENABLED="true"
									</code>{" "}
									并配置独立 WebDAV 账号后重新部署即可开启。
								</p>
								<div className="space-y-1.5 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400">
									<div>
										全部存储根：
										<code className="font-mono">https://你的域名/dav/0/</code>
									</div>
									<div>
										指定存储：
										<code className="font-mono">https://你的域名/dav/&lt;存储ID&gt;/</code>
									</div>
									<div>
										Windows：资源管理器 → 映射网络驱动器；macOS：Finder →
										连接服务器
									</div>
								</div>
							</div>
						</div>
					)}
				</div>
			</div>

				{/* 用户编辑 / 新建弹窗 */}
				{editingUser && (
					<UserFormDialog
						initial={editingUser}
						folderTree={folderTree}
						currentUserId={currentUserId}
						onSaved={refreshUsers}
						onClose={() => setEditingUser(null)}
					/>
				)}
				{showAddUser && (
					<UserFormDialog
						initial={null}
						folderTree={folderTree}
						currentUserId={currentUserId}
						onSaved={refreshUsers}
						onClose={() => setShowAddUser(false)}
					/>
				)}
		</div>
	);
}

// RenameIcon 在本文件内使用，简单内联一份避免循环依赖
function RenameIcon() {
	return (
		<svg
			className="h-4 w-4"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
		</svg>
	);
}
