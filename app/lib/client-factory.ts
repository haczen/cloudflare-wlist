import { S3Client } from "./s3-client";
import { WebDavClient } from "./webdav-client";
import { OneDriveClient } from "./onedrive-client";
import { GoogleDriveClient } from "./gdrive-client";
import { AliyunDriveClient } from "./alicloud-client";
import { BaiduYunClient } from "./baiduyun-client";

export type StorageClient =
	| S3Client
	| WebDavClient
	| OneDriveClient
	| GoogleDriveClient
	| AliyunDriveClient
	| BaiduYunClient;

type StatefulClient = {
	getStateUpdates: () => {
		config?: Record<string, any>;
		saving?: Record<string, any>;
	} | null;
};

export interface ClientStorageConfig {
	type: string;
	endpoint: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
	basePath: string;
	config?: Record<string, any>;
	saving?: Record<string, any>;
}

/**
 * 根据存储类型创建对应客户端。
 * "webdev" 是旧版（CList）的类型拼写，与 "webdav" 等价，保证旧备份可直接导入。
 */
export function createClient(storage: ClientStorageConfig): StorageClient {
	const type = storage.type?.trim().toLowerCase() || "s3";

	if (type === "webdav" || type === "webdev") {
		return new WebDavClient({
			endpoint: storage.endpoint,
			username: storage.accessKeyId,
			password: storage.secretAccessKey,
			basePath: storage.basePath,
		});
	}
	if (type === "onedrive") {
		return new OneDriveClient({
			config: storage.config,
			saving: storage.saving,
		});
	}
	if (type === "gdrive") {
		return new GoogleDriveClient({
			config: storage.config,
			saving: storage.saving,
		});
	}
	if (type === "alicloud") {
		return new AliyunDriveClient({
			config: storage.config,
			saving: storage.saving,
		});
	}
	if (type === "baiduyun") {
		return new BaiduYunClient({
			config: storage.config,
			saving: storage.saving,
		});
	}
	return new S3Client({
		endpoint: storage.endpoint,
		region: storage.region,
		accessKeyId: storage.accessKeyId,
		secretAccessKey: storage.secretAccessKey,
		bucket: storage.bucket,
		basePath: storage.basePath,
	});
}

/** 有状态客户端（OAuth token 刷新等）操作结束后，把状态变化持久化回 D1 */
async function persistClientState(
	client: StorageClient,
	db: D1Database,
	storageId: number
): Promise<void> {
	const stateful = client as unknown as StatefulClient;
	if (typeof stateful.getStateUpdates !== "function") {
		return;
	}
	const updates = stateful.getStateUpdates();
	if (!updates) {
		return;
	}
	const input: {
		config?: Record<string, any>;
		saving?: Record<string, any>;
	} = {};
	if (updates.config) {
		input.config = updates.config;
	}
	if (updates.saving) {
		input.saving = updates.saving;
	}
	if (Object.keys(input).length === 0) {
		return;
	}
	const { updateStorage } = await import("./storage");
	await updateStorage(db, storageId, input);
}

/** 执行客户端操作并保证状态回写（即使操作抛错也尝试保存刷新的 token） */
export async function withClientState<T>(
	client: StorageClient,
	db: D1Database,
	storageId: number,
	action: () => Promise<T>
): Promise<T> {
	try {
		return await action();
	} finally {
		try {
			await persistClientState(client, db, storageId);
		} catch (error) {
			console.error("Failed to persist storage state:", error);
		}
	}
}
