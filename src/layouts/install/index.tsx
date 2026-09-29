import { CheckCircle2, Cloud, Database, LockKeyhole } from "lucide-react";
import { AppTitle } from "#/layouts/components/app-title";
import { LocaleSwitch } from "#/layouts/components/locale-switch";
import { ThemeSwitch } from "#/layouts/components/theme-switch";
import { m } from "#/paraglide/messages";

export function InstallLayout({ children }: { children: React.ReactNode }) {
	return (
		<main className="relative min-h-svh overflow-hidden px-4 py-10">
			<div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_32rem),linear-gradient(color-mix(in_oklab,var(--foreground)_4%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_oklab,var(--foreground)_4%,transparent)_1px,transparent_1px)] bg-[size:auto,48px_48px,48px_48px]" />
			<div className="relative mx-auto max-w-3xl">
				<header className="mb-7 flex items-center justify-between">
					<AppTitle description />
					<div className="flex items-center gap-1">
						<LocaleSwitch />
						<ThemeSwitch />
					</div>
				</header>
				<section className="overflow-hidden rounded-3xl border bg-card/80 shadow-2xl backdrop-blur-xl">
					<div className="border-b p-7 md:p-9">
						<div className="flex items-center gap-2 text-primary text-xs uppercase tracking-[.2em]">
							<LockKeyhole className="size-4" />
							{m.install_setup_eyebrow()}
						</div>
						<h1 className="mt-4 font-semibold text-3xl tracking-tight">
							{m.install_title()}
						</h1>
						<p className="mt-3 max-w-2xl text-muted-foreground text-sm leading-6">
							{m.install_description()}
						</p>
						<div className="mt-7 grid gap-3 sm:grid-cols-3">
							{(
								[
									[
										"database",
										Database,
										m.install_setup_database(),
										m.install_setup_database_ready(),
									],
									[
										"resources",
										Cloud,
										m.install_setup_resources(),
										m.install_setup_resources_ready(),
									],
									[
										"root",
										CheckCircle2,
										m.install_setup_root(),
										m.install_setup_root_ready(),
									],
								] as const
							).map(([id, Icon, title, status]) => (
								<div
									key={id}
									className="flex items-center gap-3 rounded-xl border bg-background/70 p-3"
								>
									<span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
										<Icon className="size-4" />
									</span>
									<span>
										<strong className="block text-sm">{String(title)}</strong>
										<small className="text-muted-foreground">
											{String(status)}
										</small>
									</span>
								</div>
							))}
						</div>
					</div>
					<div className="p-7 md:p-9">{children}</div>
				</section>
			</div>
		</main>
	);
}
