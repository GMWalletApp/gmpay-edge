import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";

import { account, session } from "#/db/schema";
import { DomainError } from "#/lib/domain-error";
import type { AppDb } from "#/server/db.server";

export type AdminUserRecord = {
	id: string;
	name: string;
	email: string;
	enabled: boolean;
	emailVerified: boolean;
	createdAt: string;
	updatedAt: string;
	roles: string[];
};

export type ListUsersInput = {
	pageIndex?: number;
	pageSize?: number;
	search?: string;
};

export type UserFormInput = {
	id?: string;
	name: string;
	email: string;
	enabled: boolean;
	password?: string;
};

type UserListRow = {
	id: string;
	name: string;
	email: string;
	enabled: number;
	email_verified: number;
	created_at: number;
	updated_at: number;
	role_names: string;
};

// Root users are managed only by an enabled root actor. The predicate runs
// inside every mutation so a concurrent root assignment cannot bypass it.
const rootActorGuard = `(
 NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
  WHERE ur.user_id = users.id AND r.name = 'root')
 OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
  JOIN users actor ON actor.id = ur.user_id
  WHERE actor.id = ? AND actor.enabled = 1 AND r.name = 'root' AND r.enabled = 1)
)`;

// Disabling or deleting a root user must leave another enabled root behind.
const otherEnabledRootGuard = `EXISTS (
 SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
 JOIN users other ON other.id = ur.user_id
 WHERE r.name = 'root' AND r.enabled = 1 AND other.enabled = 1 AND other.id <> users.id
)`;

export async function listUsers(db: AppDb, input: ListUsersInput = {}) {
	const pageIndex = Math.max(0, input.pageIndex ?? 0);
	const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 10));
	const keyword = input.search?.trim() ?? "";
	const where = keyword ? "WHERE u.name LIKE ? OR u.email LIKE ?" : "";
	const pattern = `%${keyword}%`;
	const bindings = keyword ? [pattern, pattern] : [];
	const [countResult, rowsResult] = await db.$client.batch([
		db.$client
			.prepare(`SELECT COUNT(*) AS total FROM users u ${where}`)
			.bind(...bindings),
		db.$client
			.prepare(`WITH page AS (
		 SELECT u.id, u.name, u.email, u.enabled, u.email_verified,
		  u.created_at, u.updated_at
		 FROM users u ${where}
		 ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?
		)
		SELECT page.*,
		 COALESCE((
		  SELECT json_group_array(role_name) FROM (
		   SELECT r.name AS role_name FROM user_roles ur
		   JOIN roles r ON r.id = ur.role_id
		   WHERE ur.user_id = page.id ORDER BY r.name
		  )
			 ), '[]') AS role_names
		FROM page ORDER BY page.created_at DESC, page.id DESC`)
			.bind(...bindings, pageSize, pageIndex * pageSize),
	]);
	const count = countResult?.results?.[0] as { total: number } | undefined;
	const rows = rowsResult as D1Result<UserListRow>;
	return {
		data: rows.results.map((row) => ({
			id: row.id,
			name: row.name,
			email: row.email,
			enabled: Boolean(row.enabled),
			emailVerified: Boolean(row.email_verified),
			createdAt: new Date(row.created_at).toISOString(),
			updatedAt: new Date(row.updated_at).toISOString(),
			roles: parseRoleNames(row.role_names),
		})),
		total: count?.total ?? 0,
	};
}

function parseRoleNames(value: string) {
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		!parsed.every((role) => typeof role === "string")
	)
		throw new Error("Invalid user role data");
	return parsed;
}

export async function createUser(
	db: AppDb,
	input: UserFormInput & { audit?: D1PreparedStatement },
) {
	const email = normalizeEmail(input.email);
	const password = assertValidPassword(input.password);
	const userId = input.id ?? randomUUID();
	const passwordHash = await hashPassword(password);
	const createdAt = Date.now();
	const client = db.$client;
	try {
		await client.batch([
			client
				.prepare(
					`INSERT INTO users
					 (id, name, email, email_verified, image, enabled, created_at, updated_at)
					 VALUES (?, ?, ?, 1, NULL, ?, ?, ?)
					 ON CONFLICT(email) DO NOTHING`,
				)
				.bind(
					userId,
					input.name.trim(),
					email,
					input.enabled ? 1 : 0,
					createdAt,
					createdAt,
				),
			conflictGuard(client),
			client
				.prepare(
					`INSERT INTO accounts
					 (id, account_id, provider_id, user_id, password, created_at, updated_at)
					 VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
				)
				.bind(randomUUID(), userId, userId, passwordHash, createdAt, createdAt),
			...(input.audit ? [input.audit] : []),
		]);
	} catch (error) {
		const existing = await client
			.prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
			.bind(email)
			.first<{ id: string }>();
		if (existing)
			throw new DomainError("email_in_use", 409, "Email is already used");
		throw error;
	}

	return { id: userId };
}

export async function updateUser(
	db: AppDb,
	input: UserFormInput & { currentUserId: string; audit?: D1PreparedStatement },
) {
	if (!input.id)
		throw new DomainError("user_id_required", 400, "Missing user id");
	if (!input.enabled && input.id === input.currentUserId)
		throw new DomainError(
			"cannot_disable_self",
			409,
			"Cannot disable your own account",
		);

	const email = normalizeEmail(input.email);
	const passwordHash = input.password
		? await hashPassword(assertValidPassword(input.password))
		: undefined;
	const now = Date.now();
	const client = db.$client;
	try {
		await client.batch([
			client
				.prepare(`UPDATE users SET name = ?, email = ?, enabled = ?, disabled_at = ?,
			updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
			WHERE id = ? AND NOT EXISTS (
			 SELECT 1 FROM users other WHERE other.email = ? AND other.id <> ?
			) AND ${rootActorGuard} AND (? = 1 OR NOT EXISTS (
			 SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id = users.id AND r.name = 'root'
			) OR ${otherEnabledRootGuard})`)
				.bind(
					input.name.trim(),
					email,
					input.enabled ? 1 : 0,
					input.enabled ? null : now,
					now,
					now,
					input.id,
					email,
					input.id,
					input.currentUserId,
					input.enabled ? 1 : 0,
				),
			conflictGuard(client),
			...(passwordHash
				? [
						client
							.prepare(
								"UPDATE accounts SET password = ?, updated_at = ? WHERE user_id = ? AND provider_id = 'credential'",
							)
							.bind(passwordHash, now, input.id),
						client
							.prepare(`INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
			 SELECT ?, ?, 'credential', ?, ?, ?, ? WHERE NOT EXISTS (
			  SELECT 1 FROM accounts WHERE user_id = ? AND provider_id = 'credential')`)
							.bind(
								randomUUID(),
								input.id,
								input.id,
								passwordHash,
								now,
								now,
								input.id,
							),
					]
				: []),
			...(!input.enabled || passwordHash
				? [
						client
							.prepare("DELETE FROM sessions WHERE user_id = ?")
							.bind(input.id),
					]
				: []),
			...(input.audit ? [input.audit] : []),
		]);
	} catch (error) {
		const conflict = await loadMutationConflict(client, {
			id: input.id,
			currentUserId: input.currentUserId,
			email,
		});
		if (!conflict)
			throw new DomainError("user_not_found", 404, "User not found");
		if (conflict.target_root && !conflict.actor_root) throw rootRoleRequired();
		if (conflict.email_used)
			throw new DomainError("email_in_use", 409, "Email is already used");
		if (!input.enabled && conflict.target_root && !conflict.other_root)
			throw lastRootRequired("Cannot disable the last enabled root user");
		throw error;
	}

	return { id: input.id };
}

export async function setUserEnabled(
	db: AppDb,
	input: {
		id: string;
		enabled: boolean;
		currentUserId: string;
		audit?: D1PreparedStatement;
	},
) {
	if (!input.enabled) {
		await disableUserAtomically(db, input);
		return { id: input.id };
	}
	const now = Date.now();
	const client = db.$client;
	try {
		await client.batch([
			client
				.prepare(`UPDATE users SET enabled = 1, disabled_at = NULL,
				updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
				WHERE id = ? AND ${rootActorGuard}`)
				.bind(now, now, input.id, input.currentUserId),
			conflictGuard(client),
			...(input.audit ? [input.audit] : []),
		]);
	} catch (error) {
		const conflict = await loadMutationConflict(client, input);
		if (!conflict)
			throw new DomainError("user_not_found", 404, "User not found");
		if (conflict.target_root && !conflict.actor_root) throw rootRoleRequired();
		throw error;
	}
	return { id: input.id };
}

export async function resetUserPassword(
	db: AppDb,
	input: { id: string; password: string },
) {
	const now = new Date();
	const password = assertValidPassword(input.password);
	const passwordHash = await hashPassword(password);
	const [credentialAccount] = await db
		.select()
		.from(account)
		.where(
			and(eq(account.userId, input.id), eq(account.providerId, "credential")),
		)
		.limit(1);

	if (credentialAccount) {
		await db.batch([
			db
				.update(account)
				.set({ password: passwordHash, updatedAt: now })
				.where(eq(account.id, credentialAccount.id)),
			db.delete(session).where(eq(session.userId, input.id)),
		]);
	} else {
		await db.batch([
			db.insert(account).values({
				id: randomUUID(),
				accountId: input.id,
				providerId: "credential",
				userId: input.id,
				password: passwordHash,
				createdAt: now,
				updatedAt: now,
			}),
			db.delete(session).where(eq(session.userId, input.id)),
		]);
	}
	return { id: input.id };
}

export async function deleteUser(
	db: AppDb,
	input: { id: string; currentUserId: string; audit?: D1PreparedStatement },
) {
	if (input.id === input.currentUserId) {
		throw new DomainError(
			"cannot_delete_self",
			409,
			"Cannot delete your own account",
		);
	}
	const client = db.$client;
	try {
		await client.batch([
			client
				.prepare(
					`DELETE FROM users WHERE id = ? AND ${rootActorGuard} AND (
					 NOT EXISTS (
					  SELECT 1 FROM user_roles target_ur
					  JOIN roles target_r ON target_r.id = target_ur.role_id
					  WHERE target_ur.user_id = users.id AND target_r.name = 'root'
					  AND target_r.enabled = 1 AND users.enabled = 1
					 ) OR ${otherEnabledRootGuard}
					)`,
				)
				.bind(input.id, input.currentUserId),
			conflictGuard(client),
			...(input.audit ? [input.audit] : []),
		]);
	} catch (error) {
		const conflict = await loadMutationConflict(client, input);
		if (!conflict) return { id: input.id };
		if (conflict.target_root && !conflict.actor_root) throw rootRoleRequired();
		if (conflict.target_root && !conflict.other_root)
			throw lastRootRequired("Cannot delete the last enabled root user");
		throw error;
	}
	return { id: input.id };
}

async function disableUserAtomically(
	db: AppDb,
	input: { id: string; currentUserId: string; audit?: D1PreparedStatement },
) {
	if (input.id === input.currentUserId)
		throw new DomainError(
			"cannot_disable_self",
			409,
			"Cannot disable your own account",
		);
	const now = Date.now();
	const client = db.$client;
	try {
		await client.batch([
			client
				.prepare(
					`UPDATE users SET enabled = 0, disabled_at = ?, updated_at =
					 CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
				 WHERE id = ? AND enabled = 1 AND ${rootActorGuard} AND (
				  NOT EXISTS (
				   SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
				   WHERE ur.user_id = users.id AND r.name = 'root'
				  ) OR ${otherEnabledRootGuard}
				 )`,
				)
				.bind(now, now, now, input.id, input.currentUserId),
			conflictGuard(client),
			client.prepare("DELETE FROM sessions WHERE user_id = ?").bind(input.id),
			...(input.audit ? [input.audit] : []),
		]);
	} catch (error) {
		const conflict = await loadMutationConflict(client, input);
		if (!conflict)
			throw new DomainError("user_not_found", 404, "User not found");
		if (conflict.target_root && !conflict.actor_root) throw rootRoleRequired();
		if (!conflict.enabled) return;
		if (conflict.target_root && !conflict.other_root)
			throw lastRootRequired("Cannot disable the last enabled root user");
		throw error;
	}
}

// Aborts the batch, and every later statement including the audit row, unless
// the preceding guarded write changed exactly one row.
function conflictGuard(client: D1Database) {
	return client.prepare(
		"SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('user mutation conflict', '$') END",
	);
}

type MutationConflict = {
	enabled: number;
	target_root: number;
	actor_root: number;
	email_used: number;
	other_root: number;
};

function loadMutationConflict(
	client: D1Database,
	input: { id: string; currentUserId: string; email?: string },
) {
	return client
		.prepare(`SELECT users.enabled,
		 EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
		  WHERE ur.user_id = users.id AND r.name = 'root') AS target_root,
		 EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
		  JOIN users actor ON actor.id = ur.user_id
		  WHERE actor.id = ? AND actor.enabled = 1 AND r.name = 'root' AND r.enabled = 1) AS actor_root,
		 EXISTS (SELECT 1 FROM users other WHERE other.email = ? AND other.id <> users.id) AS email_used,
		 ${otherEnabledRootGuard} AS other_root
		 FROM users WHERE id = ?`)
		.bind(input.currentUserId, input.email ?? null, input.id)
		.first<MutationConflict>();
}

function rootRoleRequired() {
	return new DomainError(
		"root_role_required",
		403,
		"Only a root user can manage root users",
	);
}

function lastRootRequired(message: string) {
	return new DomainError("last_root_required", 409, message);
}

function normalizeEmail(email: string) {
	return email.trim().toLowerCase();
}

function assertValidPassword(password: string | undefined) {
	if (!password || password.length < 12 || password.trim().length === 0) {
		throw new DomainError(
			"password_too_short",
			400,
			"Password must be at least 12 characters long",
		);
	}

	return password;
}
