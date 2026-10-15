import type { Route } from "./+types/api.files.$storageId.$";
import { getStorageById, initDatabase } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";
import { resolveFolderAccess } from "~/lib/folders";
import { getShareByToken, verifySharePassword } from "~/lib/shares";
import { createClient, withClientState } from "~/lib/client-factory";
import { getRequestMeta, logAudit } from "~/lib/audit";
import { getFileType, getMimeType } from "~/lib/file-utils";

export async function loader({ request, params, context }: Route.LoaderArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);

	const storageId = parseInt(params.storageId || "0", 10);
	const path = params["*"] || "";

	const storage = await getStorageById(db, storageId);
	if (!storage) {
		return Response.json({ error: "Storage not found" }, { status: 404 });
	}

	// 默认无权限，下方鉴权时按虚拟目录覆盖
	let effectiveAccess = { list: false, download: false, upload: false };
	const url = new URL(request.url);
	const action = url.searchParams.get("action");
	const shareToken = url.searchParams.get("token");
	const isInlineImageRequest =
		!action && path && getFileType(path) === "image";

	let isAdmin = false;
	let shareVerified = false;
	let userType: "admin" | "user" | "guest" | "share" = "guest";

	if (shareToken) {
		const share = await getShareByToken(db, shareToken);
		if (share && share.storageId === storageId) {
			// 规范化：去掉尾部斜杠，避免 "photos/" + "/" = "photos//" 导致子路径匹配失败
			const sharePath = (share.filePath || "").replace(/\/+$/, "");
			const sharePathPrefix = sharePath ? sharePath + "/" : "";
			if (
				path === sharePath ||
				path === sharePath + "/" ||
				path.startsWith(sharePathPrefix)
			) {
				shareVerified = true;
			}
			// 分享设了访问密码时必须校验通过
			if (shareVerified && share.passwordHash) {
				const password = url.searchParams.get("password") || undefined;
				const ok = await verifySharePassword(db, shareToken, password);
				if (!ok) {
					return Response.json(
						{ error: "需要访问密码或密码错误" },
						{ status: 403 }
					);
				}
			}
		}
		if (!shareVerified) {
			return Response.json({ error: "分享令牌无效或已过期" }, { status: 403 });
		}
		userType = "share";
	} else {
		const authResult = await requireAuth(request, db);
		isAdmin = authResult.isAdmin;
		// 虚拟目录权限（公开目录 / 用户被授权的目录）是访客与普通用户的唯一通路；
		// 桶级 guest 标志仅作后端配置展示，不再直接放行
		const folderAccess = await resolveFolderAccess(
			db,
			authResult.user ? { id: authResult.user.id, role: authResult.user.role } : null,
			storageId,
			path
		);
		effectiveAccess = {
			list: folderAccess.list,
			download: folderAccess.download,
			upload: folderAccess.upload,
		};
		userType = isAdmin ? "admin" : authResult.user ? "user" : "guest";
	}

	// 权限检查：管理员/分享令牌/用户分配/访客公开 的并集
	const canList = isAdmin || shareVerified || effectiveAccess.list;
	const canDownload = isAdmin || shareVerified || effectiveAccess.download;

	// 列目录需要浏览权限；下载/签名 URL/信息需要下载权限
	if (action === "list" || (!action && !isInlineImageRequest)) {
		if (!canList) {
			return Response.json({ error: "没有浏览权限" }, { status: 403 });
		}
	} else {
		if (!canDownload) {
			return Response.json({ error: "没有下载权限" }, { status: 403 });
		}
	}

	const client = createClient(storage);

	// 列目录
	if (action === "list" || (!action && !isInlineImageRequest)) {
		try {
			const result = await withClientState(client, db, storageId, () =>
				client.listObjects(path)
			);
			return Response.json({
				storage: { id: storage.id, name: storage.name },
				path,
				...result,
			});
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to list objects",
				},
				{ status: 500 }
			);
		}
	}

	// 图片内联预览：直接访问 /api/files/7/images/1.jpg
	if (isInlineImageRequest) {
		try {
			const response = await withClientState(client, db, storageId, () =>
				client.getObject(path)
			);
			const upstreamContentType =
				response.headers.get("content-type") || "";
			const contentType = upstreamContentType.startsWith("image/")
				? upstreamContentType
				: getMimeType(path);
			const contentLength = response.headers.get("content-length");
			const fileName = path.split("/").pop() || "image";

			await logAudit(db, {
				action: "file.preview",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
				detail: { fileName, contentLength, contentType },
			});

			return new Response(response.body, {
				headers: {
					"Content-Type": contentType,
					"Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
					...(contentLength ? { "Content-Length": contentLength } : {}),
				},
			});
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to preview image",
				},
				{ status: 500 }
			);
		}
	}

	// 下载文件（Workers 代理转发）
	if (action === "download") {
		try {
			const response = await withClientState(client, db, storageId, () =>
				client.getObject(path)
			);
			const contentType =
				response.headers.get("content-type") ||
				"application/octet-stream";
			const contentLength = response.headers.get("content-length");

			const fileName = path.split("/").pop() || "download";

			await logAudit(db, {
				action: "file.download",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
				detail: { fileName, contentLength },
			});

			const inline = url.searchParams.get("inline") === "1";
			return new Response(response.body, {
				headers: {
					"Content-Type": contentType,
					"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(fileName)}"`,
					...(contentLength ? { "Content-Length": contentLength } : {}),
				},
			});
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to download file",
				},
				{ status: 500 }
			);
		}
	}

	// 生成预签名下载 URL
	if (action === "signed-url") {
		try {
			const signedUrl = await withClientState(client, db, storageId, () =>
				client.getSignedUrl(path)
			);
			await logAudit(db, {
				action: "file.signed_url",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
			});
			return Response.json({ url: signedUrl });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to generate signed URL",
				},
				{ status: 500 }
			);
		}
	}

	// 文件信息（HEAD）
	if (action === "info") {
		try {
			const info = await withClientState(client, db, storageId, () =>
				client.headObject(path)
			);
			if (!info) {
				return Response.json({ error: "File not found" }, { status: 404 });
			}
			return Response.json(info);
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to get file info",
				},
				{ status: 500 }
			);
		}
	}

	return Response.json({ error: "Unknown action" }, { status: 400 });
}

export async function action({
	request,
	params,
	context,
}: Route.ActionArgs) {
	const db = context.cloudflare.env.DB;
	await initDatabase(db);
	const meta = getRequestMeta(request);

	const storageId = parseInt(params.storageId || "0", 10);
	const path = params["*"] || "";

	const storage = await getStorageById(db, storageId);
	if (!storage) {
		return Response.json({ error: "Storage not found" }, { status: 404 });
	}

	const { user, isAdmin } = await requireAuth(request, db);
	const userType: "admin" | "user" | "guest" = isAdmin
		? "admin"
		: user
			? "user"
			: "guest";

	const method = request.method;
	const url = new URL(request.url);
	const action = url.searchParams.get("action");

	// 上传类操作允许「目录被授权可上传」的登录用户；其余管理操作仅限管理员
	const folderAccess = await resolveFolderAccess(
		db,
		user ? { id: user.id, role: user.role } : null,
		storageId,
		path
	);
	const canUpload = isAdmin || folderAccess.upload;
	const uploadActions = [
		"multipart-init",
		"multipart-urls",
		"multipart-upload",
		"multipart-complete",
		"multipart-abort",
	];
	const isUploadAction =
		uploadActions.includes(action || "") ||
		(method === "PUT" && !action) ||
		(method === "POST" && !action);

	if (isUploadAction) {
		if (!canUpload) {
			return Response.json({ error: "没有上传权限" }, { status: 403 });
		}
	} else {
		if (!isAdmin) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}
	}

	const client = createClient(storage);

	// 初始化分块上传
	if (method === "POST" && action === "multipart-init") {
		try {
			const body = (await request.json()) as {
				contentType?: string;
				size?: number;
				chunkSize?: number;
			};
			const contentType = body.contentType || "application/octet-stream";
			const uploadId = await withClientState(
				client,
				db,
				storageId,
				() =>
					client.initiateMultipartUpload(path, contentType, {
						size: body.size,
						chunkSize: body.chunkSize,
					})
			);
			await logAudit(db, {
				action: "file.multipart_init",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
				detail: { uploadId, contentType },
			});
			return Response.json({ uploadId });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to initialize multipart upload",
				},
				{ status: 500 }
			);
		}
	}

	// 批量获取分块上传的预签名 URL
	if (method === "POST" && action === "multipart-urls") {
		try {
			const body = (await request.json()) as {
				uploadId?: string;
				partNumbers?: number[];
			};

			if (
				!body.uploadId ||
				!body.partNumbers ||
				body.partNumbers.length === 0
			) {
				return Response.json(
					{ error: "uploadId and partNumbers are required" },
					{ status: 400 }
				);
			}
			const uploadId = body.uploadId;
			const partNumbers = body.partNumbers;

			const urls = await withClientState(
				client,
				db,
				storageId,
				async () => {
					const result: Record<number, string> = {};
					for (const partNumber of partNumbers) {
						try {
							result[partNumber] = await client.getSignedUploadPartUrl(
								path,
								uploadId,
								partNumber
							);
						} catch {
							// 单个失败则回退到代理上传通道
						}
					}
					return result;
				}
			);

			return Response.json({ urls });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to generate signed URLs",
				},
				{ status: 500 }
			);
		}
	}

	// 代理上传单个分块（预签名 URL 不可用时的回退通道）
	if (method === "PUT" && action === "multipart-upload") {
		const uploadId = url.searchParams.get("uploadId");
		const partNumber = parseInt(
			url.searchParams.get("partNumber") || "0",
			10
		);

		if (!uploadId || partNumber < 1) {
			return Response.json(
				{ error: "uploadId and partNumber are required" },
				{ status: 400 }
			);
		}

		if (!request.body) {
			return Response.json({ error: "No part body provided" }, { status: 400 });
		}

		try {
			const contentLength = parseInt(
				request.headers.get("content-length") || "0",
				10
			);
			const etag = await withClientState(client, db, storageId, () =>
				client.uploadPart(
					path,
					uploadId,
					partNumber,
					request.body as ReadableStream,
					contentLength
				)
			);
			return Response.json({ etag, partNumber });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to upload part",
				},
				{ status: 500 }
			);
		}
	}

	// 完成分块上传
	if (method === "POST" && action === "multipart-complete") {
		try {
			const body = (await request.json()) as {
				uploadId?: string;
				parts?: { partNumber: number; etag: string }[];
			};

			if (!body.uploadId || !body.parts || body.parts.length === 0) {
				return Response.json(
					{ error: "uploadId and parts are required" },
					{ status: 400 }
				);
			}
			const uploadId = body.uploadId;
			const parts = body.parts;

			await withClientState(client, db, storageId, () =>
				client.completeMultipartUpload(path, uploadId, parts)
			);
			await logAudit(db, {
				action: "file.multipart_complete",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
				detail: { uploadId, parts: parts.length },
			});
			return Response.json({ success: true, path });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to complete multipart upload",
				},
				{ status: 500 }
			);
		}
	}

	// 中止分块上传
	if (method === "POST" && action === "multipart-abort") {
		try {
			const body = (await request.json()) as { uploadId?: string };

			if (!body.uploadId) {
				return Response.json({ error: "uploadId is required" }, { status: 400 });
			}
			const uploadId = body.uploadId;

			await withClientState(client, db, storageId, () =>
				client.abortMultipartUpload(path, uploadId)
			);
			await logAudit(db, {
				action: "file.multipart_abort",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
				detail: { uploadId },
			});
			return Response.json({ success: true });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to abort multipart upload",
				},
				{ status: 500 }
			);
		}
	}

	// 新建文件夹
	if (method === "POST" && action === "mkdir") {
		try {
			await withClientState(client, db, storageId, () =>
				client.createFolder(path)
			);
			await logAudit(db, {
				action: "file.mkdir",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
			});
			return Response.json({ success: true, path });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to create folder",
				},
				{ status: 500 }
			);
		}
	}

	// 重命名
	if (method === "POST" && action === "rename") {
		try {
			const body = (await request.json()) as { newName?: string };
			const { newName } = body;

			if (!newName || newName.includes("/")) {
				return Response.json({ error: "Invalid new name" }, { status: 400 });
			}

			const isDirectory = path.endsWith("/");
			const cleanPath = path.replace(/\/$/, "");
			const parentPath = cleanPath.includes("/")
				? cleanPath.substring(0, cleanPath.lastIndexOf("/") + 1)
				: "";
			const newPath = parentPath + newName + (isDirectory ? "/" : "");

			const audit = (moved?: number) => {
				void logAudit(db, {
					action: "file.rename",
					userType,
					ip: meta.ip,
					userAgent: meta.userAgent,
					storageId,
					path,
					detail: { newPath, isDirectory, moved },
				});
				void logAudit(db, {
					action: "file.move",
					userType,
					ip: meta.ip,
					userAgent: meta.userAgent,
					storageId,
					path,
					detail: { newPath, isDirectory, moved },
				});
			};

			// 客户端支持原生重命名时直接调用
			const directClient = client as unknown as {
				renameObject?: (path: string, name: string) => Promise<void>;
			};
			if (typeof directClient.renameObject === "function") {
				await withClientState(client, db, storageId, () =>
					directClient.renameObject!(path, newName)
				);
				audit();
				return Response.json({ success: true, newPath });
			}

			if (isDirectory) {
				// 文件夹重命名：按前缀列出全部对象，逐个复制到新前缀后删除旧对象
				const keysToMove = await listAllUnderPrefix(
					client,
					db,
					storageId,
					cleanPath
				);

				const oldPrefix = cleanPath + "/";
				const newPrefix = parentPath + newName + "/";
				for (const key of keysToMove) {
					const newKey = newPrefix + key.substring(oldPrefix.length);
					await withClientState(client, db, storageId, () =>
						client.copyObject(key, newKey)
					);
				}
				for (const key of keysToMove) {
					await withClientState(client, db, storageId, () =>
						client.deleteObject(key)
					);
				}
				// 尝试删除旧的目录占位对象
				try {
					await withClientState(client, db, storageId, () =>
						client.deleteObject(oldPrefix)
					);
				} catch {
					// 不存在则忽略
				}

				audit(keysToMove.length);
				return Response.json({
					success: true,
					newPath: newPrefix,
					moved: keysToMove.length,
				});
			} else {
				// 单文件重命名：复制 + 删除
				await withClientState(client, db, storageId, () =>
					client.copyObject(path, newPath)
				);
				await withClientState(client, db, storageId, () =>
					client.deleteObject(path)
				);
				audit();
				return Response.json({ success: true, newPath });
			}
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error ? error.message : "Failed to rename",
				},
				{ status: 500 }
			);
		}
	}

	// 移动
	if (method === "POST" && action === "move") {
		try {
			const body = (await request.json()) as { destPath?: string };
			const { destPath } = body;

			if (destPath === undefined) {
				return Response.json({ error: "destPath is required" }, { status: 400 });
			}

			const isDirectory = path.endsWith("/");
			const cleanPath = path.replace(/\/$/, "");
			const fileName = cleanPath.includes("/")
				? cleanPath.substring(cleanPath.lastIndexOf("/") + 1)
				: cleanPath;

			// destPath 是目标目录，文件名保持不变
			const targetDir = destPath.endsWith("/")
				? destPath
				: destPath
					? destPath + "/"
					: "";
			const newPath = targetDir + fileName + (isDirectory ? "/" : "");

			const directClient = client as unknown as {
				moveObject?: (
					path: string,
					destPath: string
				) => Promise<void>;
			};
			if (typeof directClient.moveObject === "function") {
				await withClientState(client, db, storageId, () =>
					directClient.moveObject!(path, newPath)
				);
				await logAudit(db, {
					action: "file.move",
					userType,
					ip: meta.ip,
					userAgent: meta.userAgent,
					storageId,
					path,
					detail: { newPath, isDirectory },
				});
				return Response.json({ success: true, newPath });
			}

			if (isDirectory) {
				const keysToMove = await listAllUnderPrefix(
					client,
					db,
					storageId,
					cleanPath
				);

				const oldPrefix = cleanPath + "/";
				const newPrefix = targetDir + fileName + "/";
				for (const key of keysToMove) {
					const newKey = newPrefix + key.substring(oldPrefix.length);
					await withClientState(client, db, storageId, () =>
						client.copyObject(key, newKey)
					);
				}
				for (const key of keysToMove) {
					await withClientState(client, db, storageId, () =>
						client.deleteObject(key)
					);
				}
				try {
					await withClientState(client, db, storageId, () =>
						client.deleteObject(oldPrefix)
					);
				} catch {
					// 忽略
				}

				await logAudit(db, {
					action: "file.move",
					userType,
					ip: meta.ip,
					userAgent: meta.userAgent,
					storageId,
					path,
					detail: {
						newPath: newPrefix,
						moved: keysToMove.length,
						isDirectory: true,
					},
				});
				return Response.json({
					success: true,
					newPath: newPrefix,
					moved: keysToMove.length,
				});
			} else {
				await withClientState(client, db, storageId, () =>
					client.copyObject(path, newPath)
				);
				await withClientState(client, db, storageId, () =>
					client.deleteObject(path)
				);
				await logAudit(db, {
					action: "file.move",
					userType,
					ip: meta.ip,
					userAgent: meta.userAgent,
					storageId,
					path,
					detail: { newPath, isDirectory: false },
				});
				return Response.json({ success: true, newPath });
			}
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : "Failed to move" },
				{ status: 500 }
			);
		}
	}

	// 离线下载：从 URL 抓取并转存到当前目录
	if (method === "POST" && action === "fetch") {
		try {
			const body = (await request.json()) as {
				url?: string;
				filename?: string;
			};
			const { url: remoteUrl, filename } = body;

			if (!remoteUrl) {
				return Response.json({ error: "URL is required" }, { status: 400 });
			}

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(remoteUrl);
			} catch {
				return Response.json({ error: "Invalid URL" }, { status: 400 });
			}

			const remoteResponse = await fetch(parsedUrl.href, {
				headers: {
					"User-Agent": "WList/1.0",
				},
			});

			if (!remoteResponse.ok) {
				return Response.json(
					{
						error: `Failed to fetch: ${remoteResponse.status} ${remoteResponse.statusText}`,
					},
					{ status: 400 }
				);
			}

			// 文件名：优先用户指定，其次 Content-Disposition，最后 URL 路径
			let finalFilename = filename;
			if (!finalFilename) {
				const contentDisposition =
					remoteResponse.headers.get("content-disposition");
				if (contentDisposition) {
					const match = contentDisposition.match(
						/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
					);
					if (match) {
						finalFilename = match[1].replace(/['"]/g, "");
					}
				}
				if (!finalFilename) {
					finalFilename = parsedUrl.pathname.split("/").pop() || "download";
				}
			}

			const contentType =
				remoteResponse.headers.get("content-type") ||
				"application/octet-stream";

			const bodyBuffer = await remoteResponse.arrayBuffer();

			const uploadPath = path
				? `${path}/${finalFilename}`
				: finalFilename;
			await withClientState(client, db, storageId, () =>
				client.putObject(uploadPath, bodyBuffer, contentType)
			);
			await logAudit(db, {
				action: "file.fetch",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path: uploadPath,
				detail: { sourceUrl: remoteUrl, size: bodyBuffer.byteLength },
			});

			return Response.json({
				success: true,
				path: uploadPath,
				filename: finalFilename,
				size: bodyBuffer.byteLength,
				contentType,
			});
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to fetch and upload file",
				},
				{ status: 500 }
			);
		}
	}

	// 直接上传（单文件 PUT/POST）
	if (method === "POST" || method === "PUT") {
		const contentType =
			request.headers.get("content-type") || "application/octet-stream";

		try {
			const bodyBuffer = await request.arrayBuffer();
			if (bodyBuffer.byteLength === 0) {
				return Response.json({ error: "No file body provided" }, { status: 400 });
			}
			await withClientState(client, db, storageId, () =>
				client.putObject(path, bodyBuffer, contentType)
			);
			await logAudit(db, {
				action: "file.upload",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
				detail: { size: bodyBuffer.byteLength, contentType },
			});
			return Response.json({ success: true, path });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to upload file",
				},
				{ status: 500 }
			);
		}
	}

	// 删除
	if (method === "DELETE") {
		// 递归删除文件夹
		if (action === "rmdir") {
			try {
				const keysToDelete = await listAllRecursive(
					client,
					db,
					storageId,
					path
				);

				for (const key of keysToDelete) {
					await withClientState(client, db, storageId, () =>
						client.deleteObject(key)
					);
				}

				// 尝试删除目录占位对象本身
				try {
					await withClientState(client, db, storageId, () =>
						client.deleteObject(path.endsWith("/") ? path : path + "/")
					);
				} catch {
					// 目录占位对象可能不存在，忽略
				}

				await logAudit(db, {
					action: "file.rmdir",
					userType,
					ip: meta.ip,
					userAgent: meta.userAgent,
					storageId,
					path,
					detail: { deleted: keysToDelete.length },
				});
				return Response.json({
					success: true,
					deleted: keysToDelete.length,
				});
			} catch (error) {
				return Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Failed to delete folder",
					},
					{ status: 500 }
				);
			}
		}

		// 单文件删除
		try {
			await withClientState(client, db, storageId, () =>
				client.deleteObject(path)
			);
			await logAudit(db, {
				action: "file.delete",
				userType,
				ip: meta.ip,
				userAgent: meta.userAgent,
				storageId,
				path,
			});
			return Response.json({ success: true });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Failed to delete file",
				},
				{ status: 500 }
			);
		}
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
}

/** 不带分隔符列出前缀下全部对象 key（用于文件夹复制/移动） */
async function listAllUnderPrefix(
	client: import("~/lib/client-factory").StorageClient,
	db: D1Database,
	storageId: number,
	prefix: string
): Promise<string[]> {
	const keys: string[] = [];
	let continuationToken: string | undefined;

	do {
		const result = await withClientState(client, db, storageId, () =>
			client.listObjects(prefix, "", 1000, continuationToken)
		);
		for (const obj of result.objects) {
			keys.push(obj.key);
		}
		continuationToken = result.nextContinuationToken;
	} while (continuationToken);

	return keys;
}

/** 递归列出目录下全部对象 key（含子目录占位对象，用于递归删除） */
async function listAllRecursive(
	client: import("~/lib/client-factory").StorageClient,
	db: D1Database,
	storageId: number,
	path: string
): Promise<string[]> {
	const keys: string[] = [];
	let continuationToken: string | undefined;

	do {
		const result = await withClientState(client, db, storageId, () =>
			client.listObjects(path, "/", 1000, continuationToken)
		);

		for (const obj of result.objects) {
			if (!obj.isDirectory) {
				keys.push(obj.key);
			}
		}

		for (const obj of result.objects) {
			if (obj.isDirectory) {
				const subKeys = await listAllRecursive(client, db, storageId, obj.key);
				keys.push(...subKeys);
				// 目录占位对象（空对象 + 尾斜杠）也要删
				keys.push(obj.key);
			}
		}

		continuationToken = result.nextContinuationToken;
	} while (continuationToken);

	return keys;
}
