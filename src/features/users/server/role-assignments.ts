import { bumpUserAccessRevisionStatement } from "#/features/access/server/access-revision";
import { DomainError } from "#/lib/domain-error";

export async function replaceUserRolesAtomically(
	db: D1Database,
	input: {
		userId: string;
		roleIds: string[];
		desiredHasRoot: boolean;
		currentUserId: string;
		currentUserIsRoot: boolean;
		audit?: D1PreparedStatement;
	},
) {
	if (input.userId === input.currentUserId && input.roleIds.length === 0)
		throw new DomainError(
			"own_roles_required",
			409,
			"You cannot remove all of your own roles",
		);
	const rootActorGuard = `(
		? = 1 OR (
		 ? = 0 AND NOT EXISTS (
		  SELECT 1 FROM user_roles actor_target_ur
		  JOIN roles actor_target_r ON actor_target_r.id = actor_target_ur.role_id
		  WHERE actor_target_ur.user_id = ? AND actor_target_r.name = 'root'
		 )
		)
	)`;
	const lastRootGuard = `(
		NOT EXISTS (
		 SELECT 1 FROM user_roles target_ur
		 JOIN roles target_r ON target_r.id = target_ur.role_id
		 JOIN users target_u ON target_u.id = target_ur.user_id
		 WHERE target_ur.user_id = ? AND target_r.name = 'root'
		 AND target_r.enabled = 1 AND target_u.enabled = 1
		) OR ? = 1 OR EXISTS (
		 SELECT 1 FROM user_roles other_ur
		 JOIN roles other_r ON other_r.id = other_ur.role_id
		 JOIN users other_u ON other_u.id = other_ur.user_id
		 WHERE other_r.name = 'root' AND other_r.enabled = 1
		 AND other_u.enabled = 1 AND other_u.id <> ?
		)
	)`;
	const now = Date.now();
	const expectedIds = [...new Set(input.roleIds)].sort();
	try {
		await db.batch([
			db
				.prepare(
					`DELETE FROM user_roles WHERE user_id = ?
					 AND ${rootActorGuard} AND ${lastRootGuard}`,
				)
				.bind(
					input.userId,
					input.currentUserIsRoot ? 1 : 0,
					input.desiredHasRoot ? 1 : 0,
					input.userId,
					input.userId,
					input.desiredHasRoot ? 1 : 0,
					input.userId,
				),
			...expectedIds.map((roleId) =>
				db
					.prepare(
						`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, created_at)
							 SELECT ?, ?, ?, ? WHERE EXISTS (
							  SELECT 1 FROM users WHERE id = ?
							 ) AND ${rootActorGuard} AND ${lastRootGuard}`,
					)
					.bind(
						crypto.randomUUID(),
						input.userId,
						roleId,
						now,
						input.userId,
						input.currentUserIsRoot ? 1 : 0,
						input.desiredHasRoot ? 1 : 0,
						input.userId,
						input.userId,
						input.desiredHasRoot ? 1 : 0,
						input.userId,
					),
			),
			bumpUserAccessRevisionStatement(db, input.userId, now),
			// Abort the batch, and with it the audit row, unless the membership now
			// equals the requested set; guarded writes that were skipped surface here.
			db
				.prepare(
					`SELECT CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = ?)
					 AND (SELECT COUNT(*) FROM user_roles WHERE user_id = ?) = ?
					 ${
							expectedIds.length
								? `AND (SELECT COUNT(*) FROM user_roles WHERE user_id = ?
					 AND role_id IN (${expectedIds.map(() => "?").join(",")})) = ?`
								: ""
						}
					 THEN 1 ELSE json_extract('role assignment conflict', '$') END`,
				)
				.bind(
					input.userId,
					input.userId,
					expectedIds.length,
					...(expectedIds.length
						? [input.userId, ...expectedIds, expectedIds.length]
						: []),
				),
			...(input.audit ? [input.audit] : []),
		]);
	} catch (error) {
		const conflict = await db
			.prepare(
				`SELECT
				 EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
				  WHERE ur.user_id = users.id AND r.name = 'root') AS target_root,
				 EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
				  WHERE ur.user_id = users.id AND r.name = 'root' AND r.enabled = 1
				  AND users.enabled = 1) AS target_enabled_root,
				 EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
				  JOIN users other ON other.id = ur.user_id
				  WHERE r.name = 'root' AND r.enabled = 1 AND other.enabled = 1
				  AND other.id <> users.id) AS other_root
				 FROM users WHERE id = ?`,
			)
			.bind(input.userId)
			.first<{
				target_root: number;
				target_enabled_root: number;
				other_root: number;
			}>();
		if (!conflict)
			throw new DomainError("user_not_found", 404, "User not found");
		if (
			!input.currentUserIsRoot &&
			(conflict.target_root || input.desiredHasRoot)
		)
			throw new DomainError(
				"root_role_required",
				403,
				"Only a root user can change root membership",
			);
		if (
			!input.desiredHasRoot &&
			conflict.target_enabled_root &&
			!conflict.other_root
		)
			throw new DomainError(
				"last_root_required",
				409,
				"The last enabled root user cannot lose the root role",
			);
		throw error;
	}
	return { userId: input.userId, roleIds: expectedIds };
}
