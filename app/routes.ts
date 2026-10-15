import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("api/storages", "routes/api.storages.ts"),
	route("api/files/:storageId/*", "routes/api.files.$storageId.$.ts"),
	route("api/storage-stats/:storageId", "routes/api.storage-stats.$storageId.ts"),
	route("api/audit", "routes/api.audit.ts"),
	route("api/shares", "routes/api.shares.ts"),
	route("api/me", "routes/api.me.ts"),
	route("api/users", "routes/api.users.ts"),
	route("api/folders", "routes/api.folders.ts"),
	route("api/auth/github", "routes/api.auth.github.ts"),
	route("api/auth/github/callback", "routes/api.auth.github.callback.ts"),
	route("share", "routes/share.tsx"),
	route("dav/:storageId/*", "routes/dav.$storageId.$.ts"),
] satisfies RouteConfig;
