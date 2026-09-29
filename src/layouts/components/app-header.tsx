import { Header } from "#/layouts/components/header";
import { LocaleSwitch } from "#/layouts/components/locale-switch";
import { ProfileDropdown } from "#/layouts/components/profile-dropdown";
import { Search } from "#/layouts/components/search";
import { ThemeSwitch } from "#/layouts/components/theme-switch";

export function AppHeader() {
	return (
		<Header>
			<Search />
			<div className="ms-auto flex items-center space-x-4">
				<LocaleSwitch />
				<ThemeSwitch />
				<ProfileDropdown />
			</div>
		</Header>
	);
}
