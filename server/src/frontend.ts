import type { Manifest } from "vite";
import { paths, serve } from "facilmap-frontend/build.js";
import { readFile } from "node:fs/promises";
import type { ID, PadData, Type } from "facilmap-types";
import * as ejs from "ejs";
import { Router, type RequestHandler } from "express";
import { static as expressStatic } from "express";
import { normalizePadName, type InjectedConfig, quoteHtml } from "facilmap-utils";
import config from "./config";
import { asyncIteratorToArray, jsonStream, streamPromiseToStream, streamReplace } from "./utils/streams";
import { ReadableStream } from "stream/web";
import { generateRandomId } from "./utils/utils";
import type { TableParams } from "./export/table";

export const isDevMode = !!process.env.FM_DEV;

async function getViteManifest(): Promise<Manifest> {
	const manifest = await readFile(paths.viteManifest);
	return JSON.parse(manifest.toString());
}

interface Scripts {
	scripts: string[];
	preloadScripts: string[];
	styles: string[];
}

async function getScripts(entry: "mapEntry" | "tableEntry"): Promise<Scripts> {
	if (isDevMode) {
		return {
			scripts: ["@vite/client", paths[entry]],
			preloadScripts: [],
			styles: []
		};
	} else {
		const manifest = await getViteManifest();

		let referencedChunks = [paths[entry]];
		for (let i = 0; i < referencedChunks.length; i++) {
			const chunk = manifest[referencedChunks[i]];
			for (const reference of [
				...chunk.imports ?? [],
				...chunk.dynamicImports ?? []
			]) {
				if (!referencedChunks.includes(reference)) {
					referencedChunks.push(reference);
				}
			}
		}

		const scripts = referencedChunks.map((c) => manifest[c].file);
		const styles = referencedChunks.map((c) => manifest[c].css ?? []);

		return {
			scripts: scripts.slice(0, 1),
			preloadScripts: scripts.slice(1),
			styles: styles.flat()
		};
	}
}

function getInjectedConfig(): InjectedConfig {
	return {
		appName: config.appName,
		limaLabsToken: config.limaLabsToken,
		hideCommercialMapLinks: config.hideCommercialMapLinks,
	};
}

export interface RenderMapParams {
	padData: Pick<PadData, "name" | "description" | "searchEngines"> | undefined;
	isReadOnly: boolean;
}

export async function renderMap(params: RenderMapParams): Promise<string> {
	const [template, injections] = await Promise.all([
		readFile(paths.mapEjs).then((t) => t.toString()),
		getScripts("mapEntry")
	]);

	return ejs.render(template, {
		appName: config.appName,
		config: getInjectedConfig(),
		hasCustomCssFile: !!config.customCssFile,
		...injections,
		paths,
		...params
	});
}

export function renderTable({ padData, types, renderSingleTable }: {
	padData: PadData | undefined;
	types: Type[];
	renderSingleTable: (typeId: ID, params: TableParams) => ReadableStream<string>;
}): ReadableStream<string> {
	return streamPromiseToStream((async () => {
		const [template, injections] = await Promise.all([
			readFile(paths.tableEjs).then((t) => t.toString()),
			getScripts("tableEntry")
		]);

		const replace: Record<string, ReadableStream<string>> = {};
		const rendered = ejs.render(template, {
			...injections,
			appName: config.appName,
			hasCustomCssFile: !!config.customCssFile,
			paths,
			normalizePadName,
			quoteHtml,
			renderSingleTable: (typeId: ID, params: TableParams) => {
				const placeholder = `%${generateRandomId(32)}%`;
				replace[placeholder] = renderSingleTable(typeId, params);
				return placeholder;
			},
			padData,
			types,
		});

		return streamReplace(rendered, replace);
	})());
}

export async function getStaticFrontendMiddleware(): Promise<RequestHandler> {
	if (isDevMode) {
		const devServer = await serve({
			server: {
				middlewareMode: true
			},
			appType: "custom"
		});

		return devServer.middlewares;
	} else {
		const router = Router();
		router.use(`${paths.base}assets/`, (req, res, next) => {
			res.setHeader('Cache-Control', 'public, max-age=315576000, immutable'); // 10 years
			next();
		});
		router.use(paths.base, expressStatic(paths.dist));
		return router;
	}
}

export async function getPwaManifest(): Promise<string> {
	const template = await readFile(paths.pwaManifest).then((t) => t.toString());
	const chunks = await asyncIteratorToArray(jsonStream(JSON.parse(template), {
		APP_NAME: config.appName
	}));
	return chunks.join("");
}

export async function getOpensearchXml(baseUrl: string): Promise<string> {
	const template = await readFile(paths.opensearchXmlEjs).then((t) => t.toString());

	return ejs.render(template, {
		appName: config.appName,
		baseUrl
	});
}