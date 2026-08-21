import { ConfiguredMailSender } from "#/server/runtime/email-mail";
import type {
	RuntimeEmailMessage,
	RuntimeEnv,
	RuntimeMailSender,
} from "#/server/runtime/types";

export type CloudflareBindings = {
	DB?: D1Database;
	FILES?: R2Bucket;
	CACHE?: KVNamespace;
	WEBHOOK_QUEUE?: Queue;
	PAYMENT_QUEUE?: Queue;
	EMAIL?: SendEmail;
};

export function adaptCloudflareEnv(
	bindings: CloudflareBindings,
	waitUntil?: (promise: Promise<unknown>) => void,
): RuntimeEnv {
	const database = bindings.DB as RuntimeEnv["DB"];
	const email = bindings.EMAIL
		? adaptCloudflareEmail(bindings.EMAIL)
		: undefined;
	return {
		runtime: "cloudflare",
		DB: database,
		FILES: bindings.FILES as RuntimeEnv["FILES"],
		CACHE: bindings.CACHE as RuntimeEnv["CACHE"],
		WEBHOOK_QUEUE: bindings.WEBHOOK_QUEUE as RuntimeEnv["WEBHOOK_QUEUE"],
		PAYMENT_QUEUE: bindings.PAYMENT_QUEUE as RuntimeEnv["PAYMENT_QUEUE"],
		EMAIL: email,
		MAIL: database ? new ConfiguredMailSender(database, email) : undefined,
		waitUntil,
	};
}

function adaptCloudflareEmail(binding: SendEmail): RuntimeMailSender {
	return {
		send(message: RuntimeEmailMessage) {
			if (!message.from) throw new Error("Email sender is unavailable");
			return binding.send({ ...message, from: message.from });
		},
	};
}
