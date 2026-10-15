// 用户表数据层：用户 CRUD、存储分配、访问权限解析

export type UserRole = "admin" | "user";

export interface User {
	id: number;
	username: string;
	passwordHash: string | null;
	displayName: string;
	bio: string;
	avatarUrl: string;
	role: UserRole;
	githubId: string | null;
	githubLogin: string | null;
	isDisabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface UserStoragePerm {
	storageId: number;
	canList: boolean;
	canDownload: boolean;
	canUpload: boolean;
}

/** 对某个存储的最终访问权限 */
export interface StorageAccess {
	list: boolean;
	download: boolean;
	upload: boolean;
}

interface UserRow {
	id: number;
	username: string;
	password_hash: string | null;
	display_name: string | null;
	bio: string | null;
	avatar_url: string | null;
	role: string;
	github_id: string | null;
	github_login: string | null;
	is_disabled: number;
	created_at: string;
	updated_at: string;
}

function rowToUser(row: UserRow): User {
	return {
		id: row.id,
		username: row.username,
		passwordHash: row.password_hash,
		displayName: row.display_name || "",
		bio: row.bio || "",
		avatarUrl: row.avatar_url || "",
		role: row.role === "admin" ? "admin" : "user",
		githubId: row.github_id,
		githubLogin: row.github_login,
		isDisabled: row.is_disabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function getUserById(
	db: D1Database,
	id: number
): Promise<User | null> {
	const row = await db
		.prepare("SELECT * FROM users WHERE id = ?")
		.bind(id)
		.first<UserRow>();
	return row ? rowToUser(row) : null;
}

export async function getUserByUsername(
	db: D1Database,
	username: string
): Promise<User | null> {
	const row = await db
		.prepare("SELECT * FROM users WHERE username = ?")
		.bind(username)
		.first<UserRow>();
	return row ? rowToUser(row) : null;
}

export async function getUserByGithubId(
	db: D1Database,
	githubId: string
): Promise<User | null> {
	const row = await db
		.prepare("SELECT * FROM users WHERE github_id = ?")
		.bind(githubId)
		.first<UserRow>();
	return row ? rowToUser(row) : null;
}

export async function getAllUsers(db: D1Database): Promise<User[]> {
	const result = await db
		.prepare("SELECT * FROM users ORDER BY id")
		.all<UserRow>();
	return (result.results || []).map(rowToUser);
}

export interface CreateUserInput {
	username: string;
	passwordHash?: string;
	displayName?: string;
	bio?: string;
	avatarUrl?: string;
	role?: UserRole;
	githubId?: string;
	githubLogin?: string;
}

export async function createUser(
	db: D1Database,
	input: CreateUserInput
): Promise<User> {
	const username = input.username.trim();
	if (!username || username.includes("/") || username.length > 64) {
		throw new Error("用户名不合法（1-64 位，不能包含 /）");
	}
	if (await getUserByUsername(db, username)) {
		throw new Error("用户名已存在");
	}
	const result = await db
		.prepare(
			`INSERT INTO users (username, password_hash, display_name, bio, avatar_url, role, github_id, github_login)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
		)
		.bind(
			username,
			input.passwordHash || null,
			input.displayName || "",
			input.bio || "",
			input.avatarUrl || "",
			input.role || "user",
			input.githubId || null,
			input.githubLogin || null
		)
		.first<UserRow>();
	if (!result) throw new Error("创建用户失败");
	return rowToUser(result);
}

export interface UpdateUserInput {
	passwordHash?: string | null;
	displayName?: string;
	bio?: string;
	avatarUrl?: string;
	role?: UserRole;
	isDisabled?: boolean;
	githubId?: string | null;
	githubLogin?: string | null;
}

export async function updateUser(
	db: D1Database,
	id: number,
	input: UpdateUserInput
): Promise<User | null> {
	const updates: string[] = [];
	const values: (string | number | null)[] = [];

	if (input.passwordHash !== undefined) {
		updates.push("password_hash = ?");
		values.push(input.passwordHash);
	}
	if (input.displayName !== undefined) {
		updates.push("display_name = ?");
		values.push(input.displayName);
	}
	if (input.bio !== undefined) {
		updates.push("bio = ?");
		values.push(input.bio);
	}
	if (input.avatarUrl !== undefined) {
		updates.push("avatar_url = ?");
		values.push(input.avatarUrl);
	}
	if (input.role !== undefined) {
		updates.push("role = ?");
		values.push(input.role);
	}
	if (input.isDisabled !== undefined) {
		updates.push("is_disabled = ?");
		values.push(input.isDisabled ? 1 : 0);
	}
	if (input.githubId !== undefined) {
		updates.push("github_id = ?");
		values.push(input.githubId);
	}
	if (input.githubLogin !== undefined) {
		updates.push("github_login = ?");
		values.push(input.githubLogin);
	}
	if (updates.length === 0) return getUserById(db, id);

	updates.push("updated_at = datetime('now')");
	values.push(id);
	const row = await db
		.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ? RETURNING *`)
		.bind(...values)
		.first<UserRow>();
	return row ? rowToUser(row) : null;
}

export async function deleteUser(db: D1Database, id: number): Promise<boolean> {
	// 不允许删除自己（由调用方保证）；删除用户时级联清理 user_storages
	await db.prepare("DELETE FROM user_storages WHERE user_id = ?").bind(id).run();
	const result = await db
		.prepare("DELETE FROM users WHERE id = ?")
		.bind(id)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

// ---------- 存储分配 ----------

export async function getUserStorages(
	db: D1Database,
	userId: number
): Promise<UserStoragePerm[]> {
	const result = await db
		.prepare("SELECT * FROM user_storages WHERE user_id = ?")
		.bind(userId)
		.all<{
			storage_id: number;
			can_list: number;
			can_download: number;
			can_upload: number;
		}>();
	return (result.results || []).map((r) => ({
		storageId: r.storage_id,
		canList: r.can_list === 1,
		canDownload: r.can_download === 1,
		canUpload: r.can_upload === 1,
	}));
}

export async function setUserStorages(
	db: D1Database,
	userId: number,
	perms: UserStoragePerm[]
): Promise<void> {
	await db.prepare("DELETE FROM user_storages WHERE user_id = ?").bind(userId).run();
	for (const p of perms) {
		await db
			.prepare(
				`INSERT INTO user_storages (user_id, storage_id, can_list, can_download, can_upload)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.bind(
				userId,
				p.storageId,
				p.canList ? 1 : 0,
				p.canDownload ? 1 : 0,
				p.canUpload ? 1 : 0
			)
			.run();
	}
}

/**
 * 解析某用户对某存储的访问权限：
 * 管理员全通；登录用户 = 分配权限 ∪ 访客公开权限；访客 = 公开权限。
 */
export function resolveStorageAccess(
	user: Pick<User, "role"> | null,
	storage: { guestList: boolean; guestDownload: boolean; guestUpload: boolean },
	assigned?: UserStoragePerm | null
): StorageAccess {
	if (user?.role === "admin") {
		return { list: true, download: true, upload: true };
	}
	const guest = {
		list: storage.guestList,
		download: storage.guestDownload,
		upload: storage.guestUpload,
	};
	const mine = assigned
		? {
				list: assigned.canList,
				download: assigned.canDownload,
				upload: assigned.canUpload,
			}
		: { list: false, download: false, upload: false };
	return {
		list: guest.list || mine.list,
		download: guest.download || mine.download,
		upload: guest.upload || mine.upload,
	};
}

/** 对外暴露的安全用户信息（不含哈希） */
export interface PublicUser {
	id: number;
	username: string;
	displayName: string;
	bio: string;
	avatarUrl: string;
	role: UserRole;
	githubLogin: string | null;
	isDisabled: boolean;
}

export function toPublicUser(user: User): PublicUser {
	return {
		id: user.id,
		username: user.username,
		displayName: user.displayName,
		bio: user.bio,
		avatarUrl: user.avatarUrl,
		role: user.role,
		githubLogin: user.githubLogin,
		isDisabled: user.isDisabled,
	};
}
