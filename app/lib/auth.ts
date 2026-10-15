import { getUserById, type User } from "./users";

export type UserRole = "guest" | "user" | "admin";

export interface Session {
	id: string;
	userId: number | null;
	user: User | null;
	isAdmin: boolean;
	expiresAt: Date;
}

/** 生成 32 字节随机 hex 会话 ID */
export function generateSessionId(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return Array.from(array)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function createSession(
	db: D1Database,
	user: { id: number; role: string },
	expiresInHours: number = 24 * 7
): Promise<string> {
	const sessionId = generateSessionId();
	const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

	await db
		.prepare(
			"INSERT INTO sessions (id, user_type, user_id, expires_at) VALUES (?, ?, ?, ?)"
		)
		.bind(sessionId, user.role, user.id, expiresAt.toISOString())
		.run();

	return sessionId;
}

export async function getSession(
	db: D1Database,
	sessionId: string
): Promise<Session | null> {
	const row = await db
		.prepare(
			"SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')"
		)
		.bind(sessionId)
		.first<{ id: string; user_id: number | null; expires_at: string }>();

	if (!row) {
		return null;
	}

	// 会话对应的用户可能被删除或禁用，此时按访客处理
	let user: User | null = null;
	if (row.user_id !== null && row.user_id !== undefined) {
		user = await getUserById(db, row.user_id);
		if (user?.isDisabled) {
			user = null;
		}
	}

	return {
		id: row.id,
		userId: row.user_id ?? null,
		user,
		isAdmin: user?.role === "admin",
		expiresAt: new Date(row.expires_at),
	};
}

export async function deleteSession(
	db: D1Database,
	sessionId: string
): Promise<void> {
	await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export async function cleanExpiredSessions(db: D1Database): Promise<void> {
	await db
		.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
		.run();
}

export function getSessionIdFromCookie(
	cookieHeader: string | null
): string | null {
	if (!cookieHeader) return null;

	const cookies = cookieHeader.split(";").map((c) => c.trim());
	for (const cookie of cookies) {
		const [name, value] = cookie.split("=");
		if (name === "session") {
			return value;
		}
	}
	return null;
}

export function createSessionCookie(
	sessionId: string,
	maxAge: number = 7 * 86400
): string {
	return `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function deleteSessionCookie(): string {
	return "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

/** 定长时间比较，避免时序侧信道 */
export function safeEqualStrings(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

export async function validateAdmin(
	username: string,
	password: string,
	env: { ADMIN_USERNAME: string; ADMIN_PASSWORD: string }
): Promise<boolean> {
	return (
		safeEqualStrings(username, env.ADMIN_USERNAME) &&
		safeEqualStrings(password, env.ADMIN_PASSWORD)
	);
}

/**
 * 鉴权：解析会话并返回当前用户。
 * 兼容旧调用方 —— 返回值始终带 isAdmin。
 */
export async function requireAuth(request: Request, db: D1Database): Promise<{
	session: Session | null;
	user: User | null;
	isAdmin: boolean;
}> {
	const cookieHeader = request.headers.get("Cookie");
	const sessionId = getSessionIdFromCookie(cookieHeader);

	if (!sessionId) {
		return { session: null, user: null, isAdmin: false };
	}

	const session = await getSession(db, sessionId);
	if (!session) {
		return { session: null, user: null, isAdmin: false };
	}

	return {
		session,
		user: session.user,
		isAdmin: session.isAdmin,
	};
}
