import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const webhookUrl = process.env.AUTOMATION_WEBHOOK_URL;
const webhookSecret = process.env.AUTOMATION_WEBHOOK_SECRET;
const repo = process.env.GITHUB_REPOSITORY || "GMWalletApp/gmpay-edge";

if (!(webhookUrl && webhookSecret)) {
	throw new Error(
		"AUTOMATION_WEBHOOK_URL and AUTOMATION_WEBHOOK_SECRET are required",
	);
}

const context = JSON.parse(readFileSync(".automation/context.json", "utf8"));
const triggerKind = process.env.GITHUB_EVENT_NAME || "unknown";
const isPullRequest =
	triggerKind === "pull_request_target" ||
	Boolean(context.trigger?.pullRequest) ||
	Boolean(context.trigger?.issue?.pullRequest);
const eventType = ["schedule", "workflow_dispatch"].includes(triggerKind)
	? "triage.repository"
	: isPullRequest
		? "triage.pull_request"
		: "triage.issue";
const dryRun = process.env.AUTOMATION_DRY_RUN === "true";
const webhookBodyLimitBytes = 32 * 1024;
const triggerBodyLimit = 8 * 1024;
const truncationSuffix = "\n[truncated]";

type GitHubItem = {
	number?: unknown;
	title?: unknown;
	url?: unknown;
	html_url?: unknown;
	labels?: unknown;
	user?: unknown;
	createdAt?: unknown;
	updatedAt?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	[key: string]: unknown;
};

function truncateText(text: string, limit = triggerBodyLimit) {
	if (Buffer.byteLength(text) <= limit) return text;
	let truncated = text.slice(0, Math.max(0, limit - truncationSuffix.length));
	while (Buffer.byteLength(`${truncated}${truncationSuffix}`) > limit) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}${truncationSuffix}`;
}

function summarizeItem(item: GitHubItem) {
	return {
		number: item.number,
		title: item.title,
		url: item.url ?? item.html_url,
		labels: item.labels,
		user: item.user,
		createdAt: item.createdAt ?? item.created_at,
		updatedAt: item.updatedAt ?? item.updated_at,
	};
}

function boundContext(value: Record<string, unknown>) {
	const trigger = (value.trigger ?? {}) as Record<string, unknown>;
	const triggerIssue = trigger.issue as GitHubItem | null | undefined;
	const triggerPullRequest = trigger.pullRequest as
		| GitHubItem
		| null
		| undefined;
	const triggerComment = trigger.comment as GitHubItem | null | undefined;

	return {
		...value,
		trigger: {
			...trigger,
			issue: triggerIssue && {
				...triggerIssue,
				body:
					typeof triggerIssue.body === "string"
						? truncateText(triggerIssue.body)
						: triggerIssue.body,
			},
			pullRequest: triggerPullRequest && {
				...triggerPullRequest,
				body:
					typeof triggerPullRequest.body === "string"
						? truncateText(triggerPullRequest.body)
						: triggerPullRequest.body,
			},
			comment: triggerComment && {
				...triggerComment,
				body:
					typeof triggerComment.body === "string"
						? truncateText(triggerComment.body)
						: triggerComment.body,
			},
		},
		openIssues: Array.isArray(value.openIssues)
			? value.openIssues.map((item) => summarizeItem(item as GitHubItem))
			: value.openIssues,
		openPullRequests: Array.isArray(value.openPullRequests)
			? value.openPullRequests.map((item) => summarizeItem(item as GitHubItem))
			: value.openPullRequests,
	};
}

function createPayload(contextValue: Record<string, unknown>) {
	return {
		routeId: "gmwalletapp-gmpay-edge-triage",
		eventType,
		repo,
		dryRun,
		source: "github-actions",
		trigger: {
			kind: triggerKind,
			eventName: triggerKind,
			eventAction: process.env.GITHUB_EVENT_ACTION || "",
		},
		context: dryRun ? { ...contextValue, test: true } : contextValue,
	};
}

let boundedContext = boundContext(context);
let rawBody = JSON.stringify(createPayload(boundedContext));

if (Buffer.byteLength(rawBody) > webhookBodyLimitBytes) {
	boundedContext = {
		...boundedContext,
		openIssues: Array.isArray(boundedContext.openIssues)
			? boundedContext.openIssues.slice(0, 25)
			: boundedContext.openIssues,
		openPullRequests: Array.isArray(boundedContext.openPullRequests)
			? boundedContext.openPullRequests.slice(0, 25)
			: boundedContext.openPullRequests,
	};
	rawBody = JSON.stringify(createPayload(boundedContext));
}

if (Buffer.byteLength(rawBody) > webhookBodyLimitBytes) {
	throw new Error(
		`Automation webhook payload exceeds ${webhookBodyLimitBytes} bytes after bounding`,
	);
}
const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;

for (let attempt = 1; attempt <= 3; attempt++) {
	try {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-signature-256": signature,
			},
			body: rawBody,
			signal: AbortSignal.timeout(30_000),
		});

		if (response.ok) {
			console.log(await response.text());
			process.exit(0);
		}

		const text = await response.text();
		if (response.status < 500 || attempt === 3) {
			throw new Error(`Webhook request failed: ${response.status} ${text}`);
		}
	} catch (error) {
		if (attempt === 3) throw error;
	}

	await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
}
