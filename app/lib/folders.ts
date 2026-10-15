// 虚拟目录：用户看到的文件夹树，映射到后端桶的真实路径
// 公开性（is_public）与用户授权（user_folders）都挂在目录上

export interface Folder {
	id: number;
	name: string;
	parentId: number | null;
	storageId: number;
	/** 桶内完整路径（不含首尾斜杠，"" = 桶根） */
	storagePath: string;
	isPublic: boolean;
	createdAt: string;
}

interface FolderRow {
	id: number;
	name: string;
	parent_id: number | null;
	storage_id: number;
	storage_path: string | null;
	is_public: number;
	created_at: string;
}

function rowToFolder(row: FolderRow): Folder {
	return {
		id: row.id,
		name: row.name,
		parentId: row.parent_id,
		storageId: row.storage_id,
		storagePath: (row.storage_path || "").replace(/^\/+|\/+$/g, ""),
		isPublic: row.is_public === 1,
		createdAt: row.created_at,
	};
}

export async function getFolderById(
	db: D1Database,
	id: number
): Promise<Folder | null> {
	const row = await db
		.prepare("SELECT * FROM folders WHERE id = ?")
		.bind(id)
		.first<FolderRow>();
	return row ? rowToFolder(row) : null;
}

export async function getAllFolders(db: D1Database): Promise<Folder[]> {
	const result = await db
		.prepare("SELECT * FROM folders ORDER BY name")
		.all<FolderRow>();
	return (result.results || []).map(rowToFolder);
}

export interface CreateFolderInput {
	name: string;
	parentId: number | null;
	storageId: number;
	storagePath: string;
	isPublic: boolean;
}

export async function createFolderRecord(
	db: D1Database,
	input: CreateFolderInput
): Promise<Folder> {
	const name = input.name.trim();
	if (!name || name.includes("/")) {
		throw new Error("目录名不合法（不能包含 /）");
	}
	const parent = input.parentId !== null ? await getFolderById(db, input.parentId) : null;
	if (input.parentId !== null && !parent) {
		throw new Error("父目录不存在");
	}
	// 同一父目录下不允许重名
	const dup = await db
		.prepare("SELECT id FROM folders WHERE parent_id IS ? AND name = ?")
		.bind(input.parentId, name)
		.first();
	if (dup) {
		throw new Error("同级已存在同名目录");
	}
	const storagePath = (input.storagePath || "").replace(/^\/+|\/+$/g, "");
	const row = await db
		.prepare(
			`INSERT INTO folders (name, parent_id, storage_id, storage_path, is_public)
			 VALUES (?, ?, ?, ?, ?) RETURNING *`
		)
		.bind(
			name,
			input.parentId,
			input.storageId,
			storagePath,
			input.isPublic ? 1 : 0
		)
		.first<FolderRow>();
	if (!row) throw new Error("创建目录记录失败");
	return rowToFolder(row);
}

export async function updateFolderRecord(
	db: D1Database,
	id: number,
	input: Partial<Pick<Folder, "name" | "isPublic">>
): Promise<Folder | null> {
	const updates: string[] = [];
	const values: (string | number)[] = [];
	if (input.name !== undefined) {
		updates.push("name = ?");
		values.push(input.name.trim());
	}
	if (input.isPublic !== undefined) {
		updates.push("is_public = ?");
		values.push(input.isPublic ? 1 : 0);
	}
	if (updates.length === 0) return getFolderById(db, id);
	values.push(id);
	const row = await db
		.prepare(`UPDATE folders SET ${updates.join(", ")} WHERE id = ? RETURNING *`)
		.bind(...values)
		.first<FolderRow>();
	return row ? rowToFolder(row) : null;
}

export async function deleteFolderRecord(db: D1Database, id: number): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM folders WHERE id = ?")
		.bind(id)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

// ---------- 用户授权 ----------

export interface UserFolderPerm {
	folderId: number;
	canList: boolean;
	canDownload: boolean;
	canUpload: boolean;
}

export async function getUserFolders(
	db: D1Database,
	userId: number
): Promise<UserFolderPerm[]> {
	const result = await db
		.prepare("SELECT * FROM user_folders WHERE user_id = ?")
		.bind(userId)
		.all<{
			folder_id: number;
			can_list: number;
			can_download: number;
			can_upload: number;
		}>();
	return (result.results || []).map((r) => ({
		folderId: r.folder_id,
		canList: r.can_list === 1,
		canDownload: r.can_download === 1,
		canUpload: r.can_upload === 1,
	}));
}

export async function setUserFolders(
	db: D1Database,
	userId: number,
	perms: UserFolderPerm[]
): Promise<void> {
	await db.prepare("DELETE FROM user_folders WHERE user_id = ?").bind(userId).run();
	for (const p of perms) {
		await db
			.prepare(
				`INSERT INTO user_folders (user_id, folder_id, can_list, can_download, can_upload)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.bind(
				userId,
				p.folderId,
				p.canList ? 1 : 0,
				p.canDownload ? 1 : 0,
				p.canUpload ? 1 : 0
			)
			.run();
	}
}

// ---------- 可见性与权限解析 ----------

/**
 * 某身份可见的目录树：
 * 管理员 = 全部；否则 = is_public 的目录 ∪ 被授权的目录（及其子树）。
 */
export async function getVisibleFolders(
	db: D1Database,
	user: { id: number; role: string } | null
): Promise<Folder[]> {
	const all = await getAllFolders(db);
	if (user?.role === "admin") return all;
	// 访客无授权集合；登录用户带上授权集合，统一走「公开 ∪ 授权 + 子树展开 + 祖先补链」
	const assigned = user ? await getUserFolders(db, user.id) : [];
	const assignedIds = new Set(assigned.map((p) => p.folderId));
	// 公开目录或被授权目录（子目录跟随父目录可见）
	const visible = new Set<number>();
	const byId = new Map(all.map((f) => [f.id, f]));
	const markWithAncestors = (folder: Folder) => {
		let current: Folder | undefined = folder;
		while (current && !visible.has(current.id)) {
			visible.add(current.id);
			current = current.parentId !== null ? byId.get(current.parentId) : undefined;
		}
	};
	const markSubtree = (folderId: number) => {
		for (const f of all) {
			if (f.parentId === folderId) {
				visible.add(f.id);
				markSubtree(f.id);
			}
		}
	};
	for (const f of all) {
		if (f.isPublic || assignedIds.has(f.id)) {
			visible.add(f.id);
			markSubtree(f.id);
		}
	}
	// 祖先链也可见（否则树断开）—— 祖先本身不公开内容，仅作导航
	// 简化：祖先也加入可见（其内容访问由 access 检查控制）
	for (const f of all) {
		if (visible.has(f.id)) markWithAncestors(f);
	}
	return all.filter((f) => visible.has(f.id));
}

/**
 * 解析（storageId, path）的访问权限：
 * 管理员全通；分享令牌由调用方处理；
 * 访客/用户 = 沿祖先链找到任一「公开或被授权」的目录根即放行。
 */
export async function resolveFolderAccess(
	db: D1Database,
	user: { id: number; role: string } | null,
	storageId: number,
	path: string
): Promise<{ list: boolean; download: boolean; upload: boolean; via: "public" | "assigned" | "none" }> {
	if (user?.role === "admin") {
		return { list: true, download: true, upload: true, via: "assigned" };
	}
	const cleanPath = (path || "").replace(/^\/+|\/+$/g, "");
	const all = await getAllFolders(db);
	const assigned = user
		? await getUserFolders(db, user.id)
		: [];
	const assignedMap = new Map(assigned.map((p) => [p.folderId, p]));

	// 候选：同桶下，路径等于目录路径或在其之下
	let best: { folder: Folder; perm: UserFolderPerm | null } | null = null;
	for (const f of all) {
		if (f.storageId !== storageId) continue;
		const fp = f.storagePath;
		const covers =
			fp === "" ? true : cleanPath === fp || cleanPath.startsWith(fp + "/");
		if (!covers) continue;
		const perm = assignedMap.get(f.id) || null;
		if (f.isPublic || perm) {
			if (!best || fp.length > best.folder.storagePath.length) {
				best = { folder: f, perm };
			}
		}
	}
	if (!best) {
		return { list: false, download: false, upload: false, via: "none" };
	}
	return {
		list: best.folder.isPublic || !!best.perm?.canList,
		download: best.folder.isPublic || !!best.perm?.canDownload,
		upload: !!best.perm?.canUpload,
		via: best.perm ? "assigned" : "public",
	};
}

/** 目录树节点（含子节点嵌套） */
export interface FolderTreeNode extends Folder {
	children: FolderTreeNode[];
}

export function buildFolderTree(folders: Folder[]): FolderTreeNode[] {
	const nodes = new Map<number, FolderTreeNode>(
		folders.map((f) => [f.id, { ...f, children: [] }])
	);
	const roots: FolderTreeNode[] = [];
	for (const node of nodes.values()) {
		if (node.parentId !== null && nodes.has(node.parentId)) {
			nodes.get(node.parentId)!.children.push(node);
		} else {
			roots.push(node);
		}
	}
	const sortRec = (list: FolderTreeNode[]) => {
		list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
		list.forEach((n) => sortRec(n.children));
	};
	sortRec(roots);
	return roots;
}
