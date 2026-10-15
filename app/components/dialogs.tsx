import { useEffect, useMemo, useRef, useState } from "react";
import {
	CheckIcon,
	CloseIcon,
	DownloadIcon,
	ShareIcon,
	SpinnerIcon,
} from "~/components/icons";

// ---------- 通用遮罩 ----------

function ModalShell({
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
					<button
						type="button"
						className="btn-ghost !px-1.5"
						onClick={onClose}
					>
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

// ---------- 登录 ----------

function GithubIcon({ className }: { className?: string }) {
	return (
		<svg className={className ?? "h-4 w-4"} viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.67.41.36.77 1.05.77 2.13 0 1.54-.01 2.78-.01 3.16 0 .3.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
		</svg>
	);
}

export function LoginDialog({
	onSuccess,
	onClose,
}: {
	onSuccess: () => void;
	onClose: () => void;
}) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setLoading(true);
		setError(null);
		try {
			const response = await fetch("/api/storages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "login", username, password }),
			});
			const data = (await response.json()) as { error?: string };
			if (!response.ok) {
				throw new Error(data.error || "登录失败");
			}
			onSuccess();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "登录失败");
		} finally {
			setLoading(false);
		}
	};

	return (
		<ModalShell
			title="登录"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						form="wlist-login-form"
						className="btn-primary"
						disabled={loading || !username || !password}
					>
						{loading && <SpinnerIcon className="h-4 w-4 animate-spin" />}
						登录
					</button>
				</>
			}
		>
			<form
				id="wlist-login-form"
				className="space-y-3"
				onSubmit={handleSubmit}
			>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						用户名
					</label>
					<input
						className="input"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						autoComplete="username"
						autoFocus
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						密码
					</label>
					<input
						className="input"
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="current-password"
					/>
				</div>
				{error && (
					<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
						{error}
					</p>
				)}
				<div className="flex items-center gap-2 pt-1 text-xs text-zinc-400">
					<span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
					或
					<span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
				</div>
				<a
					href="/api/auth/github"
					className="btn-outline w-full justify-center !py-2"
				>
					<GithubIcon className="h-4 w-4" />
					使用 GitHub 登录
				</a>
			</form>
		</ModalShell>
	);
}

// ---------- 个人资料 ----------

export interface CurrentUser {
	id: number;
	username: string;
	displayName: string;
	bio: string;
	avatarUrl: string;
	role: "admin" | "user";
	githubLogin: string | null;
}

export function ProfileDialog({
	user,
	onSaved,
	onClose,
}: {
	user: CurrentUser;
	onSaved: () => void;
	onClose: () => void;
}) {
	const [displayName, setDisplayName] = useState(user.displayName);
	const [bio, setBio] = useState(user.bio);
	const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
	const [oldPassword, setOldPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [saving, setSaving] = useState(false);
	const [changingPwd, setChangingPwd] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pwdError, setPwdError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const handleSaveProfile = async (event: React.FormEvent) => {
		event.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/me", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ displayName, bio, avatarUrl }),
			});
			const data = (await response.json()) as { error?: string };
			if (!response.ok) {
				throw new Error(data.error || "保存失败");
			}
			setNotice("资料已保存");
			onSaved();
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存失败");
		} finally {
			setSaving(false);
		}
	};

	const handleChangePassword = async (event: React.FormEvent) => {
		event.preventDefault();
		setChangingPwd(true);
		setPwdError(null);
		try {
			const response = await fetch("/api/me", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "change-password",
					oldPassword,
					newPassword,
				}),
			});
			const data = (await response.json()) as { error?: string };
			if (!response.ok) {
				throw new Error(data.error || "修改失败");
			}
			setOldPassword("");
			setNewPassword("");
			setNotice("密码已修改");
		} catch (err) {
			setPwdError(err instanceof Error ? err.message : "修改失败");
		} finally {
			setChangingPwd(false);
		}
	};

	const avatar = avatarUrl.trim() || `https://github.com/${user.username}.png`;

	return (
		<ModalShell title="个人资料" onClose={onClose} width="max-w-md">
			{notice && (
				<p className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700 dark:bg-green-950/40 dark:text-green-400">
					{notice}
				</p>
			)}
			<form className="space-y-3" onSubmit={handleSaveProfile}>
				<div className="flex items-center gap-4">
					<img
						src={avatar}
						alt="头像"
						className="h-16 w-16 rounded-full border border-zinc-200 object-cover dark:border-zinc-700"
						onError={(event) => {
							event.currentTarget.src =
								"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='8' r='4' fill='%23a1a1aa'/%3E%3Ccircle cx='12' cy='20' r='8' fill='%23d4d4d8'/%3E%3C/svg%3E";
						}}
					/>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
							{user.username}
							{user.role === "admin" && (
								<span className="badge ml-1.5 bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400">
									管理员
								</span>
							)}
						</div>
						{user.githubLogin && (
							<div className="text-xs text-zinc-500">
								GitHub: @{user.githubLogin}
							</div>
						)}
					</div>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						头像链接（留空用 GitHub 默认头像）
					</label>
					<input
						className="input"
						value={avatarUrl}
						onChange={(event) => setAvatarUrl(event.target.value)}
						placeholder="https://..."
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						昵称
					</label>
					<input
						className="input"
						value={displayName}
						onChange={(event) => setDisplayName(event.target.value)}
						placeholder={user.username}
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						个性签名
					</label>
					<input
						className="input"
						value={bio}
						onChange={(event) => setBio(event.target.value)}
						placeholder="一句话介绍自己"
					/>
				</div>
				{error && (
					<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
						{error}
					</p>
				)}
				<div className="flex justify-end">
					<button
						type="submit"
						className="btn-primary"
						disabled={saving}
					>
						{saving && <SpinnerIcon className="h-4 w-4 animate-spin" />}
						保存资料
					</button>
				</div>
			</form>

			<div className="mt-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
				<form className="space-y-3" onSubmit={handleChangePassword}>
					<h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
						修改密码
					</h4>
					<input
						className="input"
						type="password"
						value={oldPassword}
						onChange={(event) => setOldPassword(event.target.value)}
						placeholder="旧密码（未设过密码的可留空）"
						autoComplete="current-password"
					/>
					<input
						className="input"
						type="password"
						value={newPassword}
						onChange={(event) => setNewPassword(event.target.value)}
						placeholder="新密码（至少 6 位）"
						autoComplete="new-password"
					/>
					{pwdError && (
						<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
							{pwdError}
						</p>
					)}
					<div className="flex justify-end">
						<button
							type="submit"
							className="btn-outline"
							disabled={changingPwd || newPassword.length < 6}
						>
							{changingPwd && <SpinnerIcon className="h-4 w-4 animate-spin" />}
							修改密码
						</button>
					</div>
				</form>
			</div>
		</ModalShell>
	);
}

// ---------- 确认 ----------

export function ConfirmDialog({
	title,
	message,
	confirmText = "确认",
	danger,
	onConfirm,
	onClose,
}: {
	title: string;
	message: React.ReactNode;
	confirmText?: string;
	danger?: boolean;
	onConfirm: () => void | Promise<void>;
	onClose: () => void;
}) {
	const [loading, setLoading] = useState(false);

	const handleConfirm = async () => {
		setLoading(true);
		try {
			await onConfirm();
			onClose();
		} finally {
			setLoading(false);
		}
	};

	return (
		<ModalShell
			title={title}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="button"
						className={danger ? "btn-danger" : "btn-primary"}
						onClick={handleConfirm}
						disabled={loading}
					>
						{loading && <SpinnerIcon className="h-4 w-4 animate-spin" />}
						{confirmText}
					</button>
				</>
			}
		>
			<div className="text-sm text-zinc-600 dark:text-zinc-300">{message}</div>
		</ModalShell>
	);
}

// ---------- 文本输入 ----------

export function PromptDialog({
	title,
	label,
	initialValue = "",
	placeholder,
	confirmText = "确认",
	onSubmit,
	onClose,
}: {
	title: string;
	label?: string;
	initialValue?: string;
	placeholder?: string;
	confirmText?: string;
	onSubmit: (value: string) => void | Promise<void>;
	onClose: () => void;
}) {
	const [value, setValue] = useState(initialValue);
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		const trimmed = value.trim();
		if (!trimmed) return;
		setLoading(true);
		try {
			await onSubmit(trimmed);
			onClose();
		} finally {
			setLoading(false);
		}
	};

	return (
		<ModalShell
			title={title}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						form="wlist-prompt-form"
						className="btn-primary"
						disabled={loading || !value.trim()}
					>
						{loading && <SpinnerIcon className="h-4 w-4 animate-spin" />}
						{confirmText}
					</button>
				</>
			}
		>
			<form id="wlist-prompt-form" className="space-y-3" onSubmit={handleSubmit}>
				{label && (
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						{label}
					</label>
				)}
				<input
					ref={inputRef}
					className="input"
					value={value}
					placeholder={placeholder}
					onChange={(event) => setValue(event.target.value)}
				/>
			</form>
		</ModalShell>
	);
}

// ---------- 创建分享 ----------

export interface ShareDialogProps {
	storageId: number;
	storageName: string;
	path: string;
	fileName: string;
	isDirectory: boolean;
	onClose: () => void;
}

interface CreatedShare {
	shareUrl: string;
	token: string;
}

export function ShareDialog({
	storageId,
	storageName,
	path,
	fileName,
	isDirectory,
	onClose,
}: ShareDialogProps) {
	const [expiresDays, setExpiresDays] = useState<string>("");
	const [customToken, setCustomToken] = useState("");
	const [password, setPassword] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<CreatedShare | null>(null);
	const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (created) {
			// 浏览器端按需加载，避免 qrcode 的 Node fs 依赖进 SSR 包
			import("qrcode")
				.then((QRCode) =>
					QRCode.toDataURL(created.shareUrl, {
						width: 160,
						margin: 1,
						color: { dark: "#18181b", light: "#ffffff" },
					})
				)
				.then(setQrDataUrl)
				.catch(() => setQrDataUrl(null));
		}
	}, [created]);

	const handleCreate = async (event: React.FormEvent) => {
		event.preventDefault();
		setCreating(true);
		setError(null);
		try {
			let expiresAt: string | undefined;
			const days = parseInt(expiresDays, 10);
			if (expiresDays.trim() && !Number.isNaN(days) && days > 0) {
				expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
			}
			const response = await fetch("/api/shares", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					storageId,
					filePath: path,
					isDirectory,
					expiresAt,
					shareToken: customToken.trim() || undefined,
					password: password.trim() || undefined,
				}),
			});
			const data = (await response.json()) as {
				error?: string;
				shareUrl: string;
				share: { shareToken: string };
			};
			if (!response.ok) {
				throw new Error(data.error || "创建分享失败");
			}
			setCreated({ shareUrl: data.shareUrl, token: data.share.shareToken });
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建分享失败");
		} finally {
			setCreating(false);
		}
	};

	const copyLink = async () => {
		if (!created) return;
		try {
			await navigator.clipboard.writeText(created.shareUrl);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// 剪贴板不可用时忽略
		}
	};

	if (created) {
		return (
			<ModalShell title="分享链接已创建" onClose={onClose} width="max-w-sm">
				<div className="flex flex-col items-center gap-4">
					{qrDataUrl && (
						<img
							src={qrDataUrl}
							alt="分享二维码"
							className="h-40 w-40 rounded-lg border border-zinc-200 dark:border-zinc-700"
						/>
					)}
					<div className="w-full break-all rounded-lg bg-zinc-100 px-3 py-2 text-center text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
						{created.shareUrl}
					</div>
					<div className="flex gap-2">
						<button type="button" className="btn-primary" onClick={copyLink}>
							{copied ? (
								<CheckIcon className="h-4 w-4" />
							) : (
								<ShareIcon className="h-4 w-4" />
							)}
							{copied ? "已复制" : "复制链接"}
						</button>
						<a
							href={created.shareUrl}
							target="_blank"
							rel="noreferrer"
							className="btn-outline"
						>
							打开
						</a>
					</div>
				</div>
			</ModalShell>
		);
	}

	return (
		<ModalShell
			title="创建分享链接"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						form="wlist-share-form"
						className="btn-primary"
						disabled={creating}
					>
						{creating && <SpinnerIcon className="h-4 w-4 animate-spin" />}
						创建分享
					</button>
				</>
			}
		>
			<form
				id="wlist-share-form"
				className="space-y-3"
				onSubmit={handleCreate}
			>
				<div className="rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
					{storageName} / {fileName}
					{isDirectory ? "/" : ""}
				</div>
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
							有效期（天，留空永久）
						</label>
						<input
							className="input"
							type="number"
							min={1}
							value={expiresDays}
							onChange={(event) => setExpiresDays(event.target.value)}
							placeholder="永久"
						/>
					</div>
					<div>
						<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
							访问密码（可选）
						</label>
						<input
							className="input"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							placeholder="留空不设密码"
						/>
					</div>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						自定义令牌（可选，留空随机）
					</label>
					<input
						className="input"
						value={customToken}
						onChange={(event) => setCustomToken(event.target.value)}
						placeholder="如 my-share，仅限字母数字下划线短横线"
					/>
				</div>
				{error && (
					<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
						{error}
					</p>
				)}
			</form>
		</ModalShell>
	);
}

// ---------- 存储统计 ----------

export interface StorageStats {
	totalSize: number;
	fileCount: number;
	folderCount: number;
	typeDistribution: Record<string, { count: number; size: number }>;
}

function formatSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = bytes;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function StatsDialog({
	storageId,
	storageName,
	onClose,
}: {
	storageId: number;
	storageName: string;
	onClose: () => void;
}) {
	const [stats, setStats] = useState<StorageStats | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch(
					`/api/storage-stats/${encodeURIComponent(String(storageId))}`
				);
				const data = (await response.json()) as {
					error?: string;
					stats: StorageStats;
				};
				if (!response.ok) {
					throw new Error(data.error || "统计失败");
				}
				if (!cancelled) {
					setStats(data.stats);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "统计失败");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [storageName]);

	const topTypes = useMemo(() => {
		if (!stats) return [];
		return Object.entries(stats.typeDistribution)
			.sort((a, b) => b[1].size - a[1].size)
			.slice(0, 10);
	}, [stats]);

	return (
		<ModalShell title={`存储统计 · ${storageName}`} onClose={onClose} width="max-w-lg">
			{error && (
				<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
					{error}
				</p>
			)}
			{!stats && !error && (
				<div className="flex items-center justify-center gap-2 p-8 text-sm text-zinc-500">
					<SpinnerIcon className="h-5 w-5 animate-spin" />
					正在遍历统计（大存储可能较慢）…
				</div>
			)}
			{stats && (
				<div className="space-y-4">
					<div className="grid grid-cols-3 gap-3">
						<div className="card p-3 text-center">
							<div className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
								{formatSize(stats.totalSize)}
							</div>
							<div className="text-xs text-zinc-500">总大小</div>
						</div>
						<div className="card p-3 text-center">
							<div className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
								{stats.fileCount.toLocaleString()}
							</div>
							<div className="text-xs text-zinc-500">文件数</div>
						</div>
						<div className="card p-3 text-center">
							<div className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
								{stats.folderCount.toLocaleString()}
							</div>
							<div className="text-xs text-zinc-500">文件夹数</div>
						</div>
					</div>
					{topTypes.length > 0 && (
						<div>
							<h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
								文件类型分布（按大小）
							</h4>
							<div className="space-y-1.5">
								{topTypes.map(([ext, info]) => {
									const percent = stats.totalSize
										? Math.max((info.size / stats.totalSize) * 100, 1)
										: 0;
									return (
										<div key={ext} className="flex items-center gap-2 text-xs">
											<span className="w-24 shrink-0 truncate font-mono text-zinc-600 dark:text-zinc-400">
												.{ext}
											</span>
											<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
												<div
													className="h-full rounded-full bg-blue-500"
													style={{ width: `${percent}%` }}
												/>
											</div>
											<span className="w-16 shrink-0 text-right text-zinc-500">
												{formatSize(info.size)}
											</span>
											<span className="w-14 shrink-0 text-right text-zinc-500">
												{info.count} 个
											</span>
										</div>
									);
								})}
							</div>
						</div>
					)}
				</div>
			)}
		</ModalShell>
	);
}

// ---------- 新建 / 编辑文本文件 ----------

export interface StorageOption {
	id: number;
	name: string;
}

export function TextEditorDialog({
	storageId,
	storageName,
	currentDir,
	storageOptions,
	existingPath,
	existingName,
	existingContent,
	onSaved,
	onClose,
}: {
	storageId: number;
	storageName: string;
	currentDir: string;
	/** 可保存到的桶列表（当前桶默认选中） */
	storageOptions: StorageOption[];
	/** 编辑已有文件时的完整 key；新建时为空 */
	existingPath?: string;
	existingName?: string;
	existingContent?: string;
	/** 保存成功后回调，参数为实际保存到的桶 ID */
	onSaved: (storageId: number) => void;
	onClose: () => void;
}) {
	const isEdit = !!existingPath;
	const [fileName, setFileName] = useState(existingName || "");
	const [content, setContent] = useState(existingContent ?? "");
	const [targetStorageId, setTargetStorageId] = useState(storageId);
	const [targetDir, setTargetDir] = useState(currentDir);
	const [loading, setLoading] = useState(isEdit && existingContent === undefined);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 编辑模式且未预取内容时拉取现有内容
	useEffect(() => {
		if (!isEdit || existingContent !== undefined) return;
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch(
					`/api/files/${storageId}/${existingPath
						.split("/")
						.map(encodeURIComponent)
						.join("/")}?action=download&inline=1`
				);
				if (!response.ok) {
					throw new Error(`加载失败 (${response.status})`);
				}
				const text = await response.text();
				if (!cancelled && text.length <= 2 * 1024 * 1024) {
					setContent(text);
				} else if (!cancelled) {
					setContent(text.slice(0, 2 * 1024 * 1024));
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "加载失败");
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isEdit, existingPath, existingContent, storageId]);

	const handleSave = async (event: React.FormEvent) => {
		event.preventDefault();
		const name = fileName.trim();
		if (!name || name.includes("/")) {
			setError("文件名不能为空且不能包含 /");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			// 新建时按用户选择的桶/目录保存；编辑时覆盖原路径
			const cleanDir = targetDir.replace(/^\/+|\/+$/g, "");
			const saveTo = isEdit ? existingPath! : cleanDir ? `${cleanDir}/${name}` : name;
			const extension = name.toLowerCase().split(".").pop() || "";
			const contentType =
				extension === "md" || extension === "markdown"
					? "text/markdown; charset=utf-8"
					: "text/plain; charset=utf-8";
			const response = await fetch(
				`/api/files/${targetStorageId}/${saveTo
					.split("/")
					.map(encodeURIComponent)
					.join("/")}`,
				{
					method: "PUT",
					headers: { "Content-Type": contentType },
					body: content,
				}
			);
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(data.error || "保存失败");
			}
			onSaved(targetStorageId);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存失败");
		} finally {
			setSaving(false);
		}
	};

	return (
		<ModalShell
			title={isEdit ? `编辑 · ${existingName}` : "新建文本文件"}
			onClose={onClose}
			width="max-w-2xl"
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						form="wlist-text-editor-form"
						className="btn-primary"
						disabled={saving || loading || (!isEdit && !fileName.trim())}
					>
						{saving && <SpinnerIcon className="h-4 w-4 animate-spin" />}
						{isEdit ? "保存覆盖" : "创建"}
					</button>
				</>
			}
		>
			<form
				id="wlist-text-editor-form"
				className="space-y-3"
				onSubmit={handleSave}
			>
				{isEdit ? (
					<p className="text-xs text-zinc-500">
						{storageName} / {existingPath}
						（保存将覆盖原文件）
					</p>
				) : (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div>
							<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
								保存到哪个桶
							</label>
							<select
								className="input"
								value={targetStorageId}
								onChange={(event) => setTargetStorageId(Number(event.target.value))}
							>
								{storageOptions.map((option) => (
									<option key={option.id} value={option.id}>
										{option.name}
									</option>
								))}
							</select>
						</div>
						<div>
							<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
								目标目录（留空 = 根目录）
							</label>
							<input
								className="input font-mono"
								value={targetDir}
								onChange={(event) => setTargetDir(event.target.value)}
								placeholder="根目录"
							/>
						</div>
					</div>
				)}
				{!isEdit && (
					<div>
						<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
							文件名（.txt / .md / .json / 代码文件…）
						</label>
						<input
							className="input font-mono"
							value={fileName}
							onChange={(event) => setFileName(event.target.value)}
							placeholder="笔记.md"
							autoFocus
						/>
					</div>
				)}
				{loading ? (
					<div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
						<SpinnerIcon className="h-5 w-5 animate-spin" />
						正在加载原内容…
					</div>
				) : (
					<textarea
						className="input h-[46vh] resize-none font-mono !text-[13px] leading-relaxed"
						value={content}
						onChange={(event) => setContent(event.target.value)}
						placeholder="输入内容…"
						spellCheck={false}
					/>
				)}
				<div className="flex items-center justify-between text-[11px] text-zinc-400">
					<span>{content.length.toLocaleString()} 字符</span>
					{isEdit && <span>覆盖前建议先下载备份</span>}
				</div>
				{error && (
					<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
						{error}
					</p>
				)}
			</form>
		</ModalShell>
	);
}

// ---------- 新建目录（虚拟目录树，可选桶 / 是否公开） ----------

export function NewFolderDialog({
	isAdmin,
	currentFolderId,
	currentFolderName,
	storageOptions,
	onCreated,
	onClose,
}: {
	isAdmin: boolean;
	/** 在某目录下建子目录时传其 ID；顶层传 null */
	currentFolderId: number | null;
	currentFolderName: string;
	storageOptions: StorageOption[];
	onCreated: () => void;
	onClose: () => void;
}) {
	const isSub = currentFolderId !== null;
	const [folderName, setFolderName] = useState("");
	const [targetStorageId, setTargetStorageId] = useState(
		storageOptions[0]?.id || 0
	);
	const [isPublic, setIsPublic] = useState(false);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		const name = folderName.trim();
		if (!name || name.includes("/")) {
			setError("目录名不能为空且不能包含 /");
			return;
		}
		if (!isSub && !isAdmin) {
			setError("只有管理员可以创建顶层目录");
			return;
		}
		setCreating(true);
		setError(null);
		try {
			const response = await fetch("/api/folders", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					parentId: currentFolderId,
					storageId: isSub ? undefined : targetStorageId,
					isPublic,
				}),
			});
			const data = (await response.json().catch(() => ({}))) as {
				error?: string;
			};
			if (!response.ok) {
				throw new Error(data.error || "创建失败");
			}
			onCreated();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建失败");
		} finally {
			setCreating(false);
		}
	};

	return (
		<ModalShell
			title={isSub ? `在「${currentFolderName}」下新建子目录` : "新建主目录"}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						form="wlist-newfolder-form"
						className="btn-primary"
						disabled={creating || !folderName.trim()}
					>
						{creating && <SpinnerIcon className="h-4 w-4 animate-spin" />}
						创建
					</button>
				</>
			}
		>
			<form
				id="wlist-newfolder-form"
				className="space-y-3"
				onSubmit={handleSubmit}
			>
				{!isSub && (
					<div>
						<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
							存放在哪个桶（用户看不到桶，只看到目录）
						</label>
						<select
							className="input"
							value={targetStorageId}
							onChange={(event) =>
								setTargetStorageId(Number(event.target.value))
							}
						>
							{storageOptions.map((option) => (
								<option key={option.id} value={option.id}>
									{option.name}
								</option>
							))}
						</select>
					</div>
				)}
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						目录名称
					</label>
					<input
						className="input"
						value={folderName}
						onChange={(event) => setFolderName(event.target.value)}
						placeholder={isSub ? "子目录" : "主目录"}
						autoFocus
					/>
				</div>
				{isAdmin && (
					<label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
						<input
							type="checkbox"
							className="h-4 w-4 accent-blue-600"
							checked={isPublic}
							onChange={(event) => setIsPublic(event.target.checked)}
						/>
						公开给所有人（访客无需登录即可浏览）
					</label>
				)}
				{error && (
					<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
						{error}
					</p>
				)}
			</form>
		</ModalShell>
	);
}

// ---------- 离线下载 ----------

export function OfflineDownloadDialog({
	currentDir,
	onSubmit,
	onClose,
}: {
	currentDir: string;
	onSubmit: (url: string, filename: string) => Promise<void>;
	onClose: () => void;
}) {
	const [url, setUrl] = useState("");
	const [filename, setFilename] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!url.trim()) return;
		setLoading(true);
		setError(null);
		try {
			await onSubmit(url.trim(), filename.trim());
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "离线下载失败");
		} finally {
			setLoading(false);
		}
	};

	return (
		<ModalShell
			title="离线下载"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						form="wlist-offline-form"
						className="btn-primary"
						disabled={loading || !url.trim()}
					>
						{loading ? (
							<SpinnerIcon className="h-4 w-4 animate-spin" />
						) : (
							<DownloadIcon className="h-4 w-4" />
						)}
						下载并转存
					</button>
				</>
			}
		>
			<form
				id="wlist-offline-form"
				className="space-y-3"
				onSubmit={handleSubmit}
			>
				<p className="text-xs text-zinc-500">
					从 URL 抓取文件并保存到当前目录
					{currentDir ? ` /${currentDir}` : "（根目录）"}
				</p>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						文件 URL
					</label>
					<input
						className="input"
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="https://example.com/file.zip"
						autoFocus
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
						保存文件名（可选，默认取 URL / Content-Disposition）
					</label>
					<input
						className="input"
						value={filename}
						onChange={(event) => setFilename(event.target.value)}
						placeholder="file.zip"
					/>
				</div>
				{error && (
					<p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
						{error}
					</p>
				)}
			</form>
		</ModalShell>
	);
}
