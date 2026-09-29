import { DomainError } from "#/lib/domain-error";

/**
 * Deletes a custom role only while it has no members. The membership check
 * runs inside the DELETE so a concurrent binding is never cascaded away, and
 * the audit row commits in the same batch or not at all.
 */
export async function deleteCustomRole(
	db: D1Database,
	id: string,
	audit: D1PreparedStatement,
) {
	try {
		await db.batch([
			db
				.prepare(
					`DELETE FROM roles WHERE id = ? AND built_in = 0
					 AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role_id = roles.id)`,
				)
				.bind(id),
			// Abort the batch, and with it the audit row, when nothing was deleted.
			db.prepare(
				"SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('role delete conflict', '$') END",
			),
			audit,
		]);
	} catch (error) {
		const role = await db
			.prepare(
				`SELECT r.built_in,
				 EXISTS (SELECT 1 FROM user_roles WHERE role_id = r.id) AS in_use
				 FROM roles r WHERE r.id = ? LIMIT 1`,
			)
			.bind(id)
			.first<{ built_in: number; in_use: number }>();
		if (!role) throw new DomainError("role_not_found", 404, "Role not found");
		if (role.built_in)
			throw new DomainError(
				"built_in_role",
				409,
				"Built-in roles cannot be deleted",
			);
		if (role.in_use)
			throw new DomainError(
				"role_in_use",
				409,
				"Remove this role from users first",
			);
		throw error;
	}
	return { id };
}
