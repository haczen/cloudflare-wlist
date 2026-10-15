-- WList 数据库结构（与 app/lib/storage.ts initDatabase 保持一致）
-- 注意：应用启动时会自动建表/补列，此文件供参考与手动初始化

-- 存储后端（桶）连接信息
CREATE TABLE IF NOT EXISTS storages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 's3',
    endpoint TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'us-east-1',
    access_key_id TEXT NOT NULL,
    secret_access_key TEXT NOT NULL,
    bucket TEXT NOT NULL,
    base_path TEXT DEFAULT '',
    config_json TEXT DEFAULT '{}',
    saving_json TEXT DEFAULT '{}',
    is_public INTEGER DEFAULT 0,
    guest_list INTEGER DEFAULT 1,
    guest_download INTEGER DEFAULT 1,
    guest_upload INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 用户
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    display_name TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    github_id TEXT,
    github_login TEXT,
    is_disabled INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 会话
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_type TEXT NOT NULL DEFAULT 'guest',
    user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

-- 虚拟目录（用户看到的目录树，映射到桶内真实路径）
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    storage_id INTEGER NOT NULL,
    storage_path TEXT DEFAULT '',
    is_public INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
    FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
);

-- 用户 ↔ 目录授权（浏览/下载/上传）
CREATE TABLE IF NOT EXISTS user_folders (
    user_id INTEGER NOT NULL,
    folder_id INTEGER NOT NULL,
    can_list INTEGER DEFAULT 1,
    can_download INTEGER DEFAULT 1,
    can_upload INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, folder_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- 用户 ↔ 存储授权（旧版桶粒度，已被 user_folders 取代，保留兼容）
CREATE TABLE IF NOT EXISTS user_storages (
    user_id INTEGER NOT NULL,
    storage_id INTEGER NOT NULL,
    can_list INTEGER DEFAULT 1,
    can_download INTEGER DEFAULT 1,
    can_upload INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, storage_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
);

-- 分享链接
CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    storage_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    is_directory INTEGER DEFAULT 0,
    share_token TEXT NOT NULL UNIQUE,
    expires_at TEXT,
    password_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    storage_id INTEGER,
    path TEXT,
    user_type TEXT NOT NULL DEFAULT 'guest',
    ip TEXT,
    user_agent TEXT,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_storages_is_public ON storages(is_public);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(share_token);
CREATE INDEX IF NOT EXISTS idx_shares_storage_id ON shares(storage_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_storage_id ON audit_logs(storage_id);
