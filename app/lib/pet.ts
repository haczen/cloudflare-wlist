// 守盘助手：公共配置层（路由与 home loader 共用）
// - pet_model：形象选择（全站生效，管理员切换）
// - pet_ai：AI 对话配置（OpenAI 兼容 + key，只存服务端）

export interface PetAiConfig {
	baseUrl: string;
	model: string;
	apiKey: string;
	systemPrompt?: string;
}

export { DEFAULT_PET_SYSTEM_PROMPT } from "./ai-protocols";

export const PET_MODEL_SETTING_KEY = "pet_model";
export const PET_AI_SETTING_KEY = "pet_ai";

/** 可选形象（与服务端校验、管理面板、前端目录保持一致；不含 Cubism5 模型——需 Core 5 运行时暂不引入） */
export const PET_MODELS = ["shizuku", "tororo", "hijiki", "rice", "hiyori"];
export const PET_MODEL_DEFAULT = "rice";

async function readSetting(db: D1Database, key: string): Promise<string | null> {
	const row = await db
		.prepare("SELECT value FROM app_settings WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

export async function getPetModel(db: D1Database): Promise<string> {
	const v = await readSetting(db, PET_MODEL_SETTING_KEY);
	return v && PET_MODELS.includes(v) ? v : PET_MODEL_DEFAULT;
}

export async function setPetModel(db: D1Database, key: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO app_settings (key, value) VALUES (?, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value"
		)
		.bind(PET_MODEL_SETTING_KEY, key)
		.run();
}

export async function readPetAiConfig(db: D1Database): Promise<PetAiConfig | null> {
	const raw = await readSetting(db, PET_AI_SETTING_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as PetAiConfig;
		if (parsed.baseUrl && parsed.apiKey) return parsed;
	} catch {
		/* 损坏按未配置处理 */
	}
	return null;
}

export async function writePetAiConfig(
	db: D1Database,
	config: PetAiConfig
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO app_settings (key, value) VALUES (?, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value"
		)
		.bind(PET_AI_SETTING_KEY, JSON.stringify(config))
		.run();
}

export async function deletePetAiConfig(db: D1Database): Promise<void> {
	await db
		.prepare("DELETE FROM app_settings WHERE key = ?")
		.bind(PET_AI_SETTING_KEY)
		.run();
}
