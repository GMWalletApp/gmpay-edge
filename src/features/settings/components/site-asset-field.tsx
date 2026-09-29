import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Upload, UploadTrigger } from "#/components/pro/base/fields/upload";
import { FormItem } from "#/components/pro/form";
import { Button } from "#/components/ui/button";
import { settingsErrorMessage } from "#/features/settings/error-message";
import {
	removeSiteBackgroundFn,
	removeSiteLogoFn,
	uploadSiteBackgroundFn,
	uploadSiteLogoFn,
} from "#/features/settings/server/admin";
import {
	isSiteAssetContentType,
	type SiteAssetContentType,
	siteAssetMaxBytes,
} from "#/features/settings/site-assets";
import { m } from "#/paraglide/messages";

type SiteAssetFieldProps = {
	url: string;
	onChanged: () => Promise<unknown>;
};

export function SiteLogoField({ url, onChanged }: SiteAssetFieldProps) {
	return (
		<SiteAssetField
			url={url}
			label={m.settings_site_logo_title()}
			description={m.settings_site_logo_description()}
			alt={m.settings_site_logo_alt()}
			previewClassName="size-[180px]"
			imageClassName="object-contain p-1"
			maxBytes={siteAssetMaxBytes.logo}
			validate={validateSquareImage}
			upload={uploadSiteLogoFn}
			remove={removeSiteLogoFn}
			onChanged={onChanged}
		/>
	);
}

export function SiteBackgroundField({ url, onChanged }: SiteAssetFieldProps) {
	return (
		<SiteAssetField
			url={url}
			label={m.settings_base_background_image_url_label()}
			description={m.settings_background_image_description()}
			alt={m.settings_base_background_image_url_label()}
			previewClassName="aspect-video w-full max-w-2xl"
			imageClassName="object-cover"
			maxBytes={siteAssetMaxBytes.background}
			upload={uploadSiteBackgroundFn}
			remove={removeSiteBackgroundFn}
			onChanged={onChanged}
		/>
	);
}

function SiteAssetField({
	url,
	label,
	description,
	alt,
	previewClassName,
	imageClassName,
	maxBytes,
	validate,
	upload,
	remove,
	onChanged,
}: SiteAssetFieldProps & {
	label: string;
	description: string;
	alt: string;
	previewClassName: string;
	imageClassName: string;
	maxBytes: number;
	validate?: (dataUrl: string) => Promise<string | null>;
	upload: (input: {
		data: {
			contentType: SiteAssetContentType;
			base64: string;
		};
	}) => Promise<{ url: string }>;
	remove: () => Promise<unknown>;
}) {
	const [busy, setBusy] = useState(false);

	async function uploadFile(file?: File) {
		if (!file) return false;
		if (!isSiteAssetContentType(file.type)) {
			toast.error(m.settings_error_asset_invalid());
			return false;
		}
		if (file.size > maxBytes) {
			toast.error(m.settings_error_asset_too_large());
			return false;
		}
		setBusy(true);
		try {
			const dataUrl = await fileDataUrl(file);
			const validationMessage = await validate?.(dataUrl);
			if (validationMessage) {
				toast.error(validationMessage);
				return false;
			}
			const result = await upload({
				data: {
					contentType: file.type,
					base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
				},
			});
			await onChanged();
			toast.success(m.settings_saved());
			return result.url;
		} catch (error) {
			toast.error(settingsErrorMessage(error));
			return false;
		} finally {
			setBusy(false);
		}
	}

	return (
		<FormItem label={label} description={description}>
			<div
				className={`relative overflow-hidden rounded-md bg-muted ${previewClassName}`}
			>
				<Upload
					value={[]}
					multiple={false}
					maxCount={1}
					disabled={busy}
					accept="image/png,image/jpeg,image/webp"
					className="size-full"
					upload={async (files) => uploadFile(files[0])}
				>
					{url ? (
						<img
							src={url}
							alt={alt}
							className={`size-full ${imageClassName}`}
						/>
					) : null}
					<UploadTrigger
						className={
							url
								? "absolute inset-0 z-10 size-full border-2 bg-background/10 text-transparent opacity-0 backdrop-blur-[1px] transition-opacity hover:bg-background/55 hover:text-foreground hover:opacity-100 focus-visible:bg-background/55 focus-visible:text-foreground focus-visible:opacity-100"
								: "absolute inset-0 size-full p-4"
						}
					/>
				</Upload>
				{url ? (
					<Button
						type="button"
						variant="secondary"
						size="icon-sm"
						className="absolute top-2 end-2 z-20"
						disabled={busy}
						aria-label={m.common_delete()}
						onClick={async () => {
							setBusy(true);
							try {
								await remove();
								await onChanged();
								toast.success(m.settings_saved());
							} catch (error) {
								toast.error(settingsErrorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<Trash2 />
					</Button>
				) : null}
			</div>
		</FormItem>
	);
}

function fileDataUrl(file: File) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function validateSquareImage(dataUrl: string) {
	return new Promise<string | null>((resolve) => {
		const image = new Image();
		image.onload = () =>
			resolve(
				image.naturalWidth === image.naturalHeight
					? null
					: m.settings_site_logo_square(),
			);
		image.onerror = () => resolve(m.settings_site_logo_invalid());
		image.src = dataUrl;
	});
}
