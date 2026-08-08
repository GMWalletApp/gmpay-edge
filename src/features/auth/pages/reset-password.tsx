import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Password } from "#/components/pro/base/fields/input";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { useSiteBrand } from "#/context/site-brand-provider";
import { authClient } from "#/features/auth/auth-client";
import { m } from "#/paraglide/messages";

export function ResetPasswordPage({ token }: { token?: string }) {
	const brand = useSiteBrand();
	const [isLoading, setIsLoading] = useState(false);
	const [completed, setCompleted] = useState(false);
	const [failed, setFailed] = useState(!token);
	const form = useForm({
		defaultValues: { password: "", confirmation: "" },
		validators: {
			onSubmit: z
				.object({
					password: z.string().min(12, m.auth_password_min()),
					confirmation: z.string(),
				})
				.refine((value) => value.password === value.confirmation, {
					path: ["confirmation"],
					message: m.auth_passwords_do_not_match(),
				}),
		},
		onSubmit: async ({ value }) => {
			if (!token) return;
			setIsLoading(true);
			const result = await authClient.resetPassword({
				newPassword: value.password,
				token,
			});
			setIsLoading(false);
			if (result.error) setFailed(true);
			else setCompleted(true);
		},
	});
	const description = completed
		? m.auth_reset_password_complete()
		: failed
			? m.auth_reset_password_invalid()
			: m.auth_reset_password_description();
	return (
		<div className="w-full space-y-6">
			<div className="space-y-2">
				<p className="font-medium text-primary text-sm">{brand.name}</p>
				<h1 className="font-semibold text-3xl tracking-tight">
					{m.auth_reset_password_title()}
				</h1>
				<p className="text-muted-foreground leading-6">{description}</p>
			</div>
			{completed || failed ? (
				<Button asChild className="w-full" variant="outline">
					<Link
						search={completed ? {} : undefined}
						to={completed ? "/sign-in" : "/forgot-password"}
					>
						{completed ? m.auth_back_to_sign_in() : m.auth_request_new_link()}
					</Link>
				</Button>
			) : (
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void form.handleSubmit();
					}}
				>
					{(["password", "confirmation"] as const).map((name) => (
						<form.Field key={name} name={name}>
							{(field) => {
								const error = field.state.meta.errors[0]?.message;
								return (
									<div className="grid gap-2">
										<Label htmlFor={`reset-${name}`}>
											{name === "password"
												? m.auth_new_password()
												: m.auth_confirm_password()}
										</Label>
										<Password
											id={`reset-${name}`}
											name={field.name}
											autoComplete="new-password"
											aria-describedby={
												error ? `reset-${name}-error` : undefined
											}
											aria-invalid={Boolean(error)}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(event) =>
												field.handleChange(event.currentTarget.value)
											}
										/>
										{error ? (
											<p
												className="text-destructive text-sm"
												id={`reset-${name}-error`}
											>
												{error}
											</p>
										) : null}
									</div>
								);
							}}
						</form.Field>
					))}
					<Button disabled={isLoading}>
						{isLoading ? <Loader2 className="animate-spin" /> : <KeyRound />}
						{m.auth_reset_password_submit()}
					</Button>
				</form>
			)}
		</div>
	);
}
