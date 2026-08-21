import { paraglideVitePlugin } from "@inlang/paraglide-js";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		paraglideVitePlugin({
			project: "./project.inlang",
			outdir: "./src/paraglide",
			strategy: ["cookie", "custom-system-default", "baseLocale"],
		}),
		tailwindcss(),
		tanstackStart({
			start: { entry: "start.ts" },
			server: { entry: "server-entry.node.ts" },
		}),
		nitro({ preset: "node-server" }),
		viteReact(),
		babel({ presets: [reactCompilerPreset()] }),
	],
});
