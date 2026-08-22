import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute(
	"/api/admin/payment-reviews/$reviewId/evidence",
)({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				await requireAdmin(
					request,
					systemPermission("payment_reviews", "read"),
				);
				const env = getEnv();
				const reviewIdResult = z.uuid().safeParse(params.reviewId);
				if (!reviewIdResult.success)
					return new Response("Invalid review ID", { status: 400 });
				const reviewId = reviewIdResult.data;
				const review = await env.DB.prepare(
					"SELECT evidence_key, evidence_content_type, evidence_sha256 FROM payment_reviews WHERE id = ? LIMIT 1",
				)
					.bind(reviewId)
					.first<{
						evidence_key: string;
						evidence_content_type: string;
						evidence_sha256: string;
					}>();
				if (!review) return new Response("Not found", { status: 404 });
				const object = await env.FILES.get(review.evidence_key);
				if (!object) return new Response("Not found", { status: 404 });
				return new Response(object.body, {
					headers: {
						"Content-Type": review.evidence_content_type,
						"Content-Length": String(object.size),
						"Cache-Control": "private, no-store",
						"Content-Security-Policy": "default-src 'none'; sandbox",
						"X-Content-Type-Options": "nosniff",
						"X-Evidence-SHA256": review.evidence_sha256,
					},
				});
			},
		},
	},
});
