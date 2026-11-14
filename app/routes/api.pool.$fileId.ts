// 聚合盘文件级 API
// - GET    /api/pool/:fileId?download=1 → 顺序流式聚合下载（chunk 逐个回源拼接）
// - GET    /api/pool/:fileId?inline=1   → inline 预览流（在线预览用，非 attachment）
// - GET    /api/pool/:fileId            → 文件信息
// - POST   /api/pool/:fileId?action=rename  → 重命名（仅改 D1 清单，零数据搬移）
// - DELETE /api/pool/:fileId            → 删除（各桶批量删 chunk + 清单）

import type { Route } from "./+types/api.pool.$fileId";
import { requireAuth } from "~/lib/auth";
import { initDatabase, getStorageById } from "~/lib/storage";
import { getFolderById, getAllFolders, getUserFolders, computeFolderAccess } from "~/lib/folders";
import {
	getPoolFile,
	renamePoolFile,
	deletePoolFileRecord,
	groupChunksByStorage,
	type PoolFile,
} from "~/lib/pool";
import { createClient, withClientState } from "~/lib/client-factory";
import { getRequestMeta, logAudit } from "~/lib/audit";

async function resolveAccess(
	db: D1Database,
	request: Request,
	file: PoolFile
) {
	const { user, isAdmin } = await requireAuth(request, db);
	if (isAdmin) return { user, isAdmin, access: { list: true, download: true, upload: true } };
	const folder = await getFolderById(db, file.folderId);
	if (!folder) return { user, isAdmin, access: { list: false, download: false, upload: false } };
	const all = await getAllFolders(db);
	const assigned = user ? await getUserFolders(db, user.id) : [];
	return {
		user,
		isAdmin,
		access: computeFolderAccess(all, assigned, folder.storageId, folder.storagePath),
	};
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);

	const file = await getPoolFile(db, params.fileId || "");
	if (!file || file.status !== "ready") {
		return Response.json({ error: "文件不存在" }, { status: 404 });
	}

	const url = new URL(request.url);
	const { isAdmin, access } = await resolveAccess(db, request, file);
	const inline = url.searchParams.get("inline") === "1";

	// 文件信息
	if (url.searchParams.get("download") !== "1" && !inline) {
		if (!isAdmin && !access.list) {
			return Response.json({ error: "没有浏览权限" }, { status: 403 });
		}
		return Response.json({
			file: {
				id: file.id,
				name: file.name,
				size: file.size,
				chunks: file.chunks.length,
				buckets: groupChunksByStorage(file.chunks).size,
				createdAt: file.createdAt,
			},
		});
	}

	// 聚合下载 / 内联预览：逐 chunk 回源顺序拼接。
	// 支持 Range（单区间）：<video> 拖动进度、zip 预览只取尾部目录都靠它——
	// 区间按 chunk.start/size 映射到对应分片，能 Range 的存储只取片内窗口，
	// 不支持 Range 的存储（TG/WebDAV/Onedrive…）流式跳过前缀后截取。
	if (!isAdmin && !access.download) {
		return Response.json({ error: "没有下载权限" }, { status: 403 });
	}

	const rangeHeader = request.headers.get("Range");
	const rangeMatch =
		rangeHeader && !rangeHeader.includes(",")
			? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
			: null;
	let range: { start: number; end: number } | null = null;
	if (rangeMatch && file.size > 0) {
		let start: number;
		let end: number;
		if (rangeMatch[1] === "" && rangeMatch[2] !== "") {
			// 后缀区间 bytes=-N
			start = Math.max(0, file.size - Number(rangeMatch[2]));
			end = file.size - 1;
		} else {
			start = Number(rangeMatch[1]);
			end = rangeMatch[2] === "" ? file.size - 1 : Math.min(Number(rangeMatch[2]), file.size - 1);
		}
		if (Number.isNaN(start) || Number.isNaN(end) || start > end || end < 0) {
			return new Response("Range Not Satisfiable", {
				status: 416,
				headers: { "Content-Range": `bytes */${file.size}` },
			});
		}
		range = { start, end };
	}

	const meta = getRequestMeta(request);
	await logAudit(db, {
		action: "pool.download",
		userType: isAdmin ? "admin" : "guest",
		ip: meta.ip,
		userAgent: meta.userAgent,
		path: file.name,
		detail: { fileId: file.id, size: file.size, chunks: file.chunks.length },
	});

	const chunkStream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let readerClosedEarly = false;
			try {
				for (const chunk of file.chunks) {
					const chunkStart = chunk.start;
					const chunkEnd = chunk.start + chunk.size - 1; // 含端
					if (range && (chunkEnd < range.start || chunkStart > range.end)) {
						continue; // 与请求区间不相交的分片直接跳过（不回源）
					}
					const readStart = range ? Math.max(chunkStart, range.start) : chunkStart;
					const readEnd = range ? Math.min(chunkEnd, range.end) : chunkEnd;
					const storage = await getStorageById(db, chunk.storageId);
					if (!storage) {
						throw new Error(`分片 ${chunk.i} 所在桶不存在`);
					}
					const client = createClient(storage, db, storage.id);
					const need = readEnd - readStart + 1;
					const resp = await client.getObject(
						chunk.key,
						`bytes=${readStart - chunkStart}-${readEnd - chunkStart}`
					);
					if (!resp.ok || !resp.body) {
						throw new Error(`分片 ${chunk.i} 读取失败: ${resp.status}`);
					}
					if (resp.status === 206 && resp.body) {
						// 存储端已按区间返回，直接透传
						const reader = resp.body.getReader();
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							if (value) controller.enqueue(value);
						}
					} else {
						// 存储端忽略 Range（TG/WebDAV 等）：整片流回来，跳过前缀再截 need 字节
						const reader = resp.body.getReader();
						let toSkip = readStart - chunkStart;
						let taken = 0;
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							let buf = value;
							if (toSkip > 0 && buf) {
								const skip = Math.min(toSkip, buf.byteLength);
								buf = buf.subarray(skip);
								toSkip -= skip;
							}
							if (buf && taken < need) {
								const take = Math.min(need - taken, buf.byteLength);
								controller.enqueue(buf.subarray(0, take));
								taken += take;
							}
							if (taken >= need && range) {
								// 已取满请求区间，剩余分片也无需回源
								await reader.cancel();
								readerClosedEarly = true;
								break;
							}
						}
					}
					if (readerClosedEarly) break;
				}
				controller.close();
			} catch (err) {
				// 下载中断归因：tail 里能看出是哪片回源失败（vs 客户端主动断开）
				console.error(
					`pool.download aborted file=${file.id} chunk-exit err=${err instanceof Error ? err.message : String(err)}`
				);
				controller.error(err);
			}
		},
	});

	const asciiName = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	// SVG 是可含脚本的 XML：传输盘访客可匿名上传，inline 直接给等于把任意 JS 送进本站会话。
	// CSP sandbox 让直接导航时脚本不执行、沦为独立沙箱源；<img> 嵌入展示不受影响（与 api.files 一致）
	const isSvg =
		file.contentType.includes("svg") ||
		file.name.toLowerCase().endsWith(".svg");
	return new Response(chunkStream, {
		status: range ? 206 : 200,
		headers: {
			"Content-Type": file.contentType || "application/octet-stream",
			"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			"Accept-Ranges": "bytes",
			...(range
				? {
						"Content-Range": `bytes ${range.start}-${range.end}/${file.size}`,
						"Content-Length": String(range.end - range.start + 1),
					}
				: { "Content-Length": String(file.size) }),
			...(isSvg
				? {
						"Content-Security-Policy": "sandbox",
						"X-Content-Type-Options": "nosniff",
					}
				: {}),
		},
	});
}

export async function action({ request, params, context }: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);

	const file = await getPoolFile(db, params.fileId || "");
	if (!file) {
		return Response.json({ error: "文件不存在" }, { status: 404 });
	}
	const url = new URL(request.url);
	const action = url.searchParams.get("action");
	const { user, isAdmin, access } = await resolveAccess(db, request, file);

	if (request.method === "DELETE") {
		// 删除权限（所有权制）：管理员全通；登录用户只能删自己上传的文件
		// （且仍需保有目录上传权限，防止被移出目录后继续删旧文件）；
		// 访客不能删任何人的文件 —— 传输盘/聚合盘从「有上传权就能删」收紧。
		// 访客上传与迁移前旧数据 uploader_id 为 NULL，同样只有管理员能删。
		if (!isAdmin) {
			if (!user) {
				return Response.json({ error: "游客不能删除文件，请登录后删除自己上传的文件" }, { status: 403 });
			}
			if (file.uploaderId !== user.id) {
				return Response.json({ error: "只能删除自己上传的文件" }, { status: 403 });
			}
			if (!access.upload) {
				return Response.json({ error: "没有删除权限" }, { status: 403 });
			}
		}

		// 各桶批量删 chunk
		const grouped = groupChunksByStorage(file.chunks);
		let deleted = 0;
		for (const [storageId, keys] of grouped) {
			const storage = await getStorageById(db, storageId);
			if (!storage) continue;
			const client = createClient(storage, db, storage.id);
			const batch = client as unknown as {
				deleteObjects?: (keys: string[]) => Promise<number>;
			};
			try {
				if (typeof batch.deleteObjects === "function") {
					deleted += await withClientState(client, db, storageId, () =>
						batch.deleteObjects!(keys)
					);
				} else {
					for (const key of keys) {
						await withClientState(client, db, storageId, () => client.deleteObject(key));
						deleted++;
					}
				}
			} catch {
				// 单桶失败不阻断：尽力删，记录仍会清理
			}
		}
		await deletePoolFileRecord(db, file.id);
		await logAudit(db, {
			action: "pool.delete",
			userType: isAdmin ? "admin" : "user",
			ip: meta.ip,
			userAgent: meta.userAgent,
			path: file.name,
			detail: { fileId: file.id, deleted },
		});
		return Response.json({ success: true, deleted });
	}

	if (request.method === "POST" && action === "rename") {
		// 重命名：仅改 D1 清单，零数据搬移。权限与删除同一套所有权制 ——
		// 改别人文件的名字同样是破坏行为，不能比删除更宽松
		if (!isAdmin) {
			if (!user) {
				return Response.json({ error: "游客不能重命名文件，请登录后操作自己上传的文件" }, { status: 403 });
			}
			if (file.uploaderId !== user.id) {
				return Response.json({ error: "只能重命名自己上传的文件" }, { status: 403 });
			}
			if (!access.upload) {
				return Response.json({ error: "没有权限" }, { status: 403 });
			}
		}
		const body = (await request.json().catch(() => ({}))) as { name?: string };
		const name = String(body.name || "").trim();
		if (!name || name.includes("/")) {
			return Response.json({ error: "名称不合法" }, { status: 400 });
		}
		await renamePoolFile(db, file.id, name);
		await logAudit(db, {
			action: "pool.rename",
			userType: isAdmin ? "admin" : "user",
			ip: meta.ip,
			userAgent: meta.userAgent,
			path: file.name,
			detail: { fileId: file.id, newName: name },
		});
		return Response.json({ success: true, name });
	}

	return Response.json({ error: "Unknown action" }, { status: 400 });
}
