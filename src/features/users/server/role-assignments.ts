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
		...input.roleIds.map((roleId) =>
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
	]);
	const actual = await db
		.prepare(
			`SELECT users.id AS user_id, user_roles.role_id
			 FROM users LEFT JOIN user_roles ON user_roles.user_id = users.id
			 WHERE users.id = ? ORDER BY user_roles.role_id`,
		)
		.bind(input.userId)
		.all<{ user_id: string; role_id: string | null }>();
	if (!actual.results.length)
		throw new DomainError("user_not_found", 404, "User not found");
	const expectedIds = [...input.roleIds].sort();
	const actualIds = actual.results.flatMap((row) =>
		row.role_id === null ? [] : [row.role_id],
	);
	if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
		if (!input.currentUserIsRoot)
			throw new DomainError(
				"root_role_required",
				403,
				"Only a root user can change root membership",
			);
		throw new DomainError(
			"last_root_required",
			409,
			"The last enabled root user cannot lose the root role",
		);
	}
	return { userId: input.userId, roleIds: expectedIds };
}
