import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATUS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = dirname(STATUS_DIRECTORY);
const ARTICLES_DIRECTORY = join(REPOSITORY_DIRECTORY, "articles");
const OUTPUT_PATH = join(STATUS_DIRECTORY, "articles.json");
const SITEMAP_INDEX_URL = "https://newrpg.seesaa.net/sitemap.xml";
const BROWSER_HEADERS = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    "referer": "https://newrpg.seesaa.net/"
};

function decodeHtml(value) {
    return String(value)
        .replace(/&amp;/giu, "&")
        .replace(/&lt;/giu, "<")
        .replace(/&gt;/giu, ">")
        .replace(/&#x([0-9a-f]+);/giu, (_, hexadecimal) =>
            String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
        .replace(/&#([0-9]+);/gu, (_, decimal) =>
            String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function stripBom(value) {
    return value.replace(/^\uFEFF/u, "");
}

async function fetchText(url) {
    const response = await fetch(url, { headers: BROWSER_HEADERS });
    if (!response.ok) {
        throw new Error(`取得に失敗しました (${response.status}): ${url}`);
    }
    return response.text();
}

async function getSitemapEntries() {
    const sitemapIndex = await fetchText(SITEMAP_INDEX_URL);
    const sitemapUrls = [...sitemapIndex.matchAll(
        /<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/giu
    )]
        .map(match => decodeHtml(match[1].trim()))
        .filter(url => url.startsWith("https://newrpg.seesaa.net/sitemap.xml"));

    if (sitemapUrls.length === 0) {
        throw new Error("サイトマップ一覧を取得できませんでした。");
    }

    const entries = new Map();
    for (const sitemapUrl of sitemapUrls) {
        const sitemap = await fetchText(sitemapUrl);
        for (const match of sitemap.matchAll(
            /<url>\s*<loc>\s*(https?:\/\/[^<]+\/article\/(\d+)\.html)\s*<\/loc>\s*<lastmod>\s*([^<]+)\s*<\/lastmod>\s*<\/url>/giu
        )) {
            const entry = {
                id: match[2],
                url: decodeHtml(match[1].trim()),
                updatedAt: match[3].trim()
            };
            const previous = entries.get(entry.id);
            if (!previous || new Date(entry.updatedAt) > new Date(previous.updatedAt)) {
                entries.set(entry.id, entry);
            }
        }
    }
    return [...entries.values()];
}

async function getTranslatedArticles() {
    const translated = new Map();
    let files = [];
    try {
        files = await readdir(ARTICLES_DIRECTORY, { withFileTypes: true });
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }

    for (const file of files) {
        if (!file.isFile() || !/^\d+\.json$/u.test(file.name)) continue;
        const id = file.name.slice(0, -5);
        let title = "";
        try {
            const article = JSON.parse(stripBom(await readFile(
                join(ARTICLES_DIRECTORY, file.name),
                "utf8"
            )));
            title = article.blocks
                ?.find(block => block.type === "title")?.source
                || "";
        } catch {
            // The existence of the JSON is enough to mark an article as
            // translated. A malformed file simply has no title in the list.
        }
        translated.set(id, title);
    }
    return translated;
}

async function main() {
    const [entries, translated] = await Promise.all([
        getSitemapEntries(),
        getTranslatedArticles()
    ]);
    const articles = entries
        .map(entry => ({
            ...entry,
            translated: translated.has(entry.id),
            title: translated.get(entry.id) || ""
        }))
        .sort((left, right) =>
            new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf()
        );

    await mkdir(STATUS_DIRECTORY, { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        total: articles.length,
        translated: articles.filter(article => article.translated).length,
        articles
    }, null, 2)}\n`, "utf8");
    console.log(`記事一覧を更新しました: status/articles.json (${articles.length}件)`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
