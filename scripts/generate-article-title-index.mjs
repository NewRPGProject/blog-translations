import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = dirname(SCRIPT_DIRECTORY);
const ARTICLES_DIRECTORY = join(REPOSITORY_DIRECTORY, "articles");
const OUTPUT_DIRECTORY = join(REPOSITORY_DIRECTORY, "common");
const OUTPUT_PATH = join(OUTPUT_DIRECTORY, "article-titles.json");

function stripBom(value) {
    return String(value).replace(/^\uFEFF/u, "");
}

function normalizeTitle(value) {
    return String(value || "")
        .replace(/\s+/gu, " ")
        .trim();
}

// Links often omit category labels such as 【RPG制作講座】, whether the label
// appears before or after the actual title. Keep both variants for matching.
function stripJapaneseCategories(value) {
    return normalizeTitle(String(value || "").replace(/【[^】]*】/gu, ""));
}

function stripEnglishCategories(value) {
    return normalizeTitle(stripJapaneseCategories(value).replace(/\[[^\]]*\]/gu, ""));
}

function sourceTitle(article) {
    return article?.blocks?.find(block => block?.type === "title")?.source
        || article?.sourceTitle
        || "";
}

async function main() {
    let files = [];
    try {
        files = await readdir(ARTICLES_DIRECTORY, { withFileTypes: true });
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }

    const titles = {};
    for (const file of files) {
        if (!file.isFile() || !/^\d+\.json$/u.test(file.name)) continue;

        try {
            const article = JSON.parse(stripBom(await readFile(
                join(ARTICLES_DIRECTORY, file.name),
                "utf8"
            )));
            const source = normalizeTitle(sourceTitle(article));
            const title = normalizeTitle(article?.title);
            if (!source || !title) continue;

            const id = file.name.slice(0, -5);
            titles[id] = {
                source,
                sourceShort: stripJapaneseCategories(source),
                title,
                titleShort: stripEnglishCategories(title)
            };
        } catch (error) {
            console.warn(`タイトルを読み取れませんでした: ${file.name}`);
        }
    }

    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        titles
    }, null, 2)}\n`, "utf8");
    console.log(`記事タイトル索引を更新しました: common/article-titles.json (${Object.keys(titles).length}件)`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
