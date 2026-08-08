import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { Loader2, Mail } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Input } from "#/components/pro/base/fields/input";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { useSiteBrand } from "#/context/site-brand-provider";
import { authClient } from "#/features/auth/auth-client";
import { m } from "#/paraglide/messages";

export function ForgotPasswordPage() {
	const brand = useSiteBrand();
	const [isLoading, setIsLoading] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const form = useForm({
		defaultValues: { email: "" },
		validators: {
			onSubmit: z.object({ email: z.email(m.auth_email_invalid()) }),
		},
		onSubmit: async ({ value }) => {
			setIsLoading(true);
			try {
				await authClient.requestPasswordReset({
					email: value.email,
					redirectTo: "/reset-password",
				});
			} finally {
				setIsLoading(false);
				setSubmitted(true);
			}
		},
	});
	return (
		<div className="w-full space-y-6">
			<div className="space-y-2">
				<p className="font-medium text-primary text-sm">{brand.name}</p>
				<h1 className="font-semibold text-3xl tracking-tight">
					{m.auth_forgot_password_title()}
				</h1>
				<p className="text-muted-foreground leading-6">
					{submitted
						? m.auth_forgot_password_submitted()
						: m.auth_forgot_password_description()}
				</p>
			</div>
			{submitted ? (
				<Button asChild className="w-full" variant="outline">
					<Link search={{ redirect: undefined }} to="/sign-in">
						{m.auth_back_to_sign_in()}
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
					<form.Field name="email">
						{(field) => {
							const error = field.state.meta.errors[0]?.message;
							return (
								<div className="grid gap-2">
									<Label htmlFor="forgot-password-email">
										{m.common_email()}
									</Label>
									<Input
										id="forgot-password-email"
										name={field.name}
										type="email"
										autoComplete="email"
										aria-describedby={
											error ? "forgot-password-email-error" : undefined
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
											id="forgot-password-email-error"
										>
											{error}
										</p>
									) : null}
								</div>
							);
						}}
					</form.Field>
					<Button disabled={isLoading}>
						{isLoading ? <Loader2 className="animate-spin" /> : <Mail />}
						{m.auth_send_reset_link()}
					</Button>
					<Link
						className="text-center text-muted-foreground text-sm hover:text-foreground"
						search={{ redirect: undefined }}
						to="/sign-in"
					>
						{m.auth_back_to_sign_in()}
					</Link>
				</form>
			)}
		</div>
	);
}
