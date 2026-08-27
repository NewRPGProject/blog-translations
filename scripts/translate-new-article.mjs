import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = dirname(SCRIPT_DIRECTORY);
const ARTICLES_DIRECTORY = join(REPOSITORY_DIRECTORY, "articles");
const GLOSSARY_DIRECTORY = join(REPOSITORY_DIRECTORY, "glossary");
const SITEMAP_INDEX_URL = "https://newrpg.seesaa.net/sitemap.xml";
const MONITOR_STATE_PATH = join(REPOSITORY_DIRECTORY, ".translation-monitor.json");
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const BROWSER_HEADERS = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    "referer": "https://newrpg.seesaa.net/"
};
const JAPANESE_CHARACTERS = /[ぁ-んァ-ヶ一-龠々〆〤ー]/u;
const WHITESPACE = /\s+/gu;
const IGNORED_TAGS = new Set([
    "script", "style", "noscript", "pre", "code", "textarea", "select", "option"
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LINE_BOUNDARY_TAGS = new Set([
    "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "p", "td", "th", "figcaption", "center", "table", "ul", "ol"
]);

function fail(message) {
    throw new Error(message);
}

function normalizeText(value) {
    return decodeHtml(String(value))
        .replace(/\r/gu, "")
        .replace(/^[\s\u3000]+|[\s\u3000]+$/gu, "")
        .replace(WHITESPACE, " ");
}

function decodeHtml(value) {
    return value
        .replace(/&nbsp;/giu, " ")
        .replace(/&quot;/giu, "\"")
        .replace(/&#39;|&apos;/giu, "'")
        .replace(/&lt;/giu, "<")
        .replace(/&gt;/giu, ">")
        .replace(/&amp;/giu, "&")
        .replace(/&#x([0-9a-f]+);/giu, (_, hexadecimal) =>
            String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
        .replace(/&#([0-9]+);/gu, (_, decimal) =>
            String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function hash(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function extractArticleId(url) {
    return new URL(url).pathname.match(/\/article\/(\d+)\.html/i)?.[1] || null;
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: BROWSER_HEADERS
    });
    if (!response.ok) {
        const detail = (await response.text())
            .replace(/\s+/gu, " ")
            .slice(0, 200);
        fail(`取得に失敗しました (${response.status}): ${url}${detail ? ` / ${detail}` : ""}`);
    }

    const bytes = await response.arrayBuffer();
    const header = response.headers.get("content-type") || "";
    const charset = /charset=([^;\s]+)/iu.exec(header)?.[1]?.toLowerCase();
    const decoder = new TextDecoder(
        charset?.includes("shift") || charset?.includes("sjis")
            ? "shift_jis"
            : "utf-8"
    );
    return decoder.decode(bytes);
}

async function getSitemapEntries() {
    const sitemapIndex = await fetchText(SITEMAP_INDEX_URL);
    const sitemapUrls = [...sitemapIndex.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/giu)]
        .map(match => decodeHtml(match[1].trim()))
        .filter(url => url.startsWith("https://newrpg.seesaa.net/sitemap.xml"));
    if (sitemapUrls.length === 0) {
        fail("サイトマップ一覧を取得できませんでした。");
    }

    const entries = new Map();
    for (const sitemapUrl of sitemapUrls) {
        const sitemap = await fetchText(sitemapUrl);
        for (const match of sitemap.matchAll(
            /<url>\s*<loc>\s*(https?:\/\/[^<]+\/article\/(\d+)\.html)\s*<\/loc>\s*<lastmod>\s*([^<]+)\s*<\/lastmod>\s*<\/url>/giu
        )) {
            const entry = {
                url: decodeHtml(match[1].trim()),
                articleId: match[2],
                lastModified: match[3].trim()
            };
            const previous = entries.get(entry.articleId);
            if (!previous || new Date(entry.lastModified) > new Date(previous.lastModified)) {
                entries.set(entry.articleId, entry);
            }
        }
    }
    if (entries.size === 0) {
        fail("サイトマップから記事一覧を取得できませんでした。");
    }
    return entries;
}

async function getRequestedArticle() {
    const requestedUrl = process.env.ARTICLE_URL?.trim();
    if (!requestedUrl) return null;
    const articleId = extractArticleId(requestedUrl);
    if (!articleId) {
        fail("ARTICLE_URL は /article/記事ID.html の形式にしてください。");
    }
    return { url: requestedUrl, articleId, lastModified: null };
}

function isMoreRecent(first, second) {
    return !second || Number.isNaN(new Date(second).valueOf())
        || new Date(first) > new Date(second);
}

async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

async function readMonitorState() {
    return await readJson(MONITOR_STATE_PATH) || { lastCheckedAt: null };
}

function findElementInnerHtml(html, tagName, className, startAt = 0) {
    const openingTag = new RegExp(
        `<${tagName}\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
        "igu"
    );
    openingTag.lastIndex = startAt;
    const match = openingTag.exec(html);
    if (!match) {
        return null;
    }

    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "igu");
    tagPattern.lastIndex = match.index + match[0].length;
    let depth = 1;
    let token;
    while ((token = tagPattern.exec(html))) {
        if (/^<\//u.test(token[0])) {
            depth--;
            if (depth === 0) {
                return {
                    innerHtml: html.slice(match.index + match[0].length, token.index),
                    endIndex: tagPattern.lastIndex
                };
            }
        } else if (!/\/>$/u.test(token[0])) {
            depth++;
        }
    }

    fail(`.${className} の閉じタグが見つかりません。`);
}

function extractArticleHtml(html) {
    const blogBody = findElementInnerHtml(html, "div", "blogbody");
    const searchHtml = blogBody?.innerHtml || html;
    const textArea = findElementInnerHtml(searchHtml, "div", "text");
    if (!textArea) {
        fail("記事本文（.text）を取得できませんでした。");
    }
    return textArea.innerHtml;
}

function extractTitle(html) {
    const ogTitle = /<meta\b[^>]*\bproperty=["']og:title["'][^>]*\bcontent=["']([^"']*)["'][^>]*>/iu.exec(html)
        || /<meta\b[^>]*\bcontent=["']([^"']*)["'][^>]*\bproperty=["']og:title["'][^>]*>/iu.exec(html);
    if (!ogTitle) {
        fail("記事タイトルを取得できませんでした。");
    }
    return normalizeText(ogTitle[1]);
}

function parseTag(token) {
    const closing = /^<\//u.test(token);
    const match = /^<\/?\s*([a-z0-9]+)/iu.exec(token);
    if (!match) {
        return null;
    }
    return {
        name: match[1].toLowerCase(),
        closing,
        selfClosing: /\/>$/u.test(token) || /^(br|hr|img|meta|link|input)$/iu.test(match[1])
    };
}

function currentType(stack) {
    for (let index = stack.length - 1; index >= 0; index--) {
        const name = stack[index];
        if (name === "a") return "link";
        if (HEADING_TAGS.has(name)) return "heading";
        if (name === "li") return "list";
        if (name === "td" || name === "th") return "table";
        if (name === "figcaption") return "caption";
        if (name === "p") return "paragraph";
    }
    return "text";
}

function renderContext(segments) {
    let result = "";
    let inLink = false;
    for (const segment of segments) {
        if (segment.link !== inLink) {
            result += segment.link ? "<a>" : "</a>";
            inLink = segment.link;
        }
        result += segment.raw;
    }
    if (inLink) result += "</a>";
    return result.replace(/\s+/gu, " ").trim();
}

function parseBlocks(articleHtml, title) {
    const blocks = [{
        id: "title",
        type: "title",
        source: title,
        sourceHash: hash(title),
        context: title
    }];
    const counters = new Map();
    const stack = [];
    const lines = [];
    let line = [];
    let ignoredDepth = 0;

    const finishLine = () => {
        if (line.length > 0) {
            lines.push(line);
            line = [];
        }
    };

    const tokens = articleHtml.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/gu) || [];
    for (const token of tokens) {
        if (!token.startsWith("<")) {
            if (ignoredDepth > 0) continue;
            const raw = decodeHtml(token).replace(/\r/gu, "");
            if (raw) {
                line.push({
                    raw,
                    source: normalizeText(raw),
                    type: currentType(stack),
                    link: stack.includes("a")
                });
            }
            continue;
        }

        if (/^<!--/u.test(token)) continue;
        const tag = parseTag(token);
        if (!tag) continue;

        if (tag.name === "br" || tag.name === "hr") {
            finishLine();
            continue;
        }

        if (tag.closing) {
            if (LINE_BOUNDARY_TAGS.has(tag.name)) finishLine();
            const index = stack.lastIndexOf(tag.name);
            if (index >= 0) stack.splice(index, 1);
            if (IGNORED_TAGS.has(tag.name) && ignoredDepth > 0) ignoredDepth--;
            continue;
        }

        if (LINE_BOUNDARY_TAGS.has(tag.name)) finishLine();
        stack.push(tag.name);
        if (IGNORED_TAGS.has(tag.name)) ignoredDepth++;
        if (tag.selfClosing) {
            stack.pop();
            if (IGNORED_TAGS.has(tag.name) && ignoredDepth > 0) ignoredDepth--;
        }
    }
    finishLine();

    for (const segments of lines) {
        const context = renderContext(segments);
        for (const segment of segments) {
            if (!segment.source || !JAPANESE_CHARACTERS.test(segment.source)) continue;
            if (segment.source.length === 1 && /^[\p{P}\p{S}]$/u.test(segment.source)) continue;
            const count = (counters.get(segment.type) || 0) + 1;
            counters.set(segment.type, count);
            blocks.push({
                id: `${segment.type}-${String(count).padStart(3, "0")}`,
                type: segment.type,
                source: segment.source,
                sourceHash: hash(segment.source),
                context
            });
        }
    }

    if (blocks.length === 1) {
        fail("記事本文から翻訳対象の日本語を取得できませんでした。");
    }
    return blocks;
}

function createChunks(blocks) {
    const chunks = [];
    let chunk = [];
    let characters = 0;
    for (const block of blocks) {
        if (chunk.length > 0 && (chunk.length >= 50 || characters + block.source.length > 12000)) {
            chunks.push(chunk);
            chunk = [];
            characters = 0;
        }
        chunk.push(block);
        characters += block.source.length;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

async function readOptionalConfiguration(fileName) {
    const path = join(GLOSSARY_DIRECTORY, fileName);
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

function selectRelevantGlossary(glossary, blocks) {
    if (!glossary) return null;
    try {
        const entries = JSON.parse(glossary);
        if (!entries || Array.isArray(entries) || typeof entries !== "object") return glossary;
        const sources = blocks.map(block => block.source);
        const selected = Object.fromEntries(Object.entries(entries)
            .filter(([term]) => sources.some(source => source.includes(term))));
        return Object.keys(selected).length > 0 ? JSON.stringify(selected) : null;
    } catch {
        return glossary;
    }
}

function outputSchema() {
    return {
        type: "object",
        properties: {
            translations: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        translation: { type: "string" }
                    },
                    required: ["id", "translation"],
                    additionalProperties: false
                }
            }
        },
        required: ["translations"],
        additionalProperties: false
    };
}

async function translateChunk(blocks, apiKey, rules, glossary) {
    const instructions = [
        rules,
        glossary ? `Required glossary:\n${glossary}` : null
    ].filter(Boolean).join("\n\n");
    const input = JSON.stringify(blocks.map(block => ({
        id: block.id,
        type: block.type,
        source: block.source,
        context: block.context
    })));
    const response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
            "authorization": `Bearer ${apiKey}`,
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model: MODEL,
            instructions,
            input: `Translate every item in this JSON array from Japanese to English:\n${input}`,
            text: {
                verbosity: "low",
                format: {
                    type: "json_schema",
                    name: "article_translations",
                    strict: true,
                    schema: outputSchema()
                }
            }
        })
    });
    const body = await response.text();
    if (!response.ok) {
        let detail = "";
        try {
            detail = JSON.parse(body)?.error?.message || "";
        } catch {
            // API response was not JSON.
        }
        fail(`OpenAI APIエラー (${response.status}): ${detail}`);
    }

    const responseJson = JSON.parse(body);
    const outputText = responseJson.output
        ?.filter(item => item.type === "message")
        .flatMap(item => item.content || [])
        .find(item => item.type === "output_text")?.text;
    if (!outputText) {
        fail("OpenAI APIから翻訳テキストが返されませんでした。");
    }
    const parsed = JSON.parse(outputText);
    const translations = new Map((parsed.translations || []).map(item => [item.id, item.translation]));
    return {
        translations,
        usage: responseJson.usage || {}
    };
}

async function translateBlocks(blocks, apiKey, rules, glossary) {
    const usage = { input: 0, output: 0, reasoning: 0, total: 0 };
    for (const chunk of createChunks(blocks)) {
        const result = await translateChunk(chunk, apiKey, rules, glossary);
        for (const block of chunk) {
            const translation = result.translations.get(block.id);
            if (typeof translation !== "string" || !translation.trim()) {
                fail(`API応答に ${block.id} の翻訳がありません。`);
            }
            if (JAPANESE_CHARACTERS.test(translation)) {
                fail(`翻訳漏れを検出しました: ${block.id} (${block.source} → ${translation})`);
            }
            block.translation = translation;
        }
        usage.input += result.usage.input_tokens || 0;
        usage.output += result.usage.output_tokens || 0;
        usage.reasoning += result.usage.output_tokens_details?.reasoning_tokens || 0;
        usage.total += result.usage.total_tokens || 0;
    }
    return usage;
}

function contextHash(block) {
    return hash(block.context || "");
}

function buildPreviousTranslations(article) {
    const exact = new Map();
    const bySource = new Map();
    if (!article) return { exact, bySource };

    for (const block of article.blocks || []) {
        if (typeof block?.translation !== "string" || !block.translation.trim()) continue;
        if (block.contextHash) {
            exact.set(`${block.type}\u0000${block.sourceHash}\u0000${block.contextHash}`, block.translation);
        }
        if (block.source && !bySource.has(block.source)) {
            bySource.set(block.source, block.translation);
        }
    }
    for (const [source, translation] of Object.entries(article.texts || {})) {
        if (typeof translation === "string" && translation.trim() && !bySource.has(source)) {
            bySource.set(source, translation);
        }
    }
    if (article.title && article.blocks?.find(block => block.type === "title")?.source) {
        bySource.set(article.blocks.find(block => block.type === "title").source, article.title);
    }
    return { exact, bySource };
}

function splitReusableBlocks(blocks, existingArticle) {
    const previous = buildPreviousTranslations(existingArticle);
    const pending = [];
    for (const block of blocks) {
        const exactKey = `${block.type}\u0000${block.sourceHash}\u0000${contextHash(block)}`;
        const translation = previous.exact.get(exactKey)
            || (block.type === "title" ? existingArticle?.title : null)
            || previous.bySource.get(block.source);
        if (translation && !JAPANESE_CHARACTERS.test(translation)) {
            block.translation = translation;
        } else {
            pending.push(block);
        }
    }
    return pending;
}

function sourceHashFor(blocks) {
    return hash(blocks.map(block => `${block.type}:${block.sourceHash}:${contextHash(block)}`).join("\n"));
}

function makeOutput({ articleId, articleUrl, lastModified, blocks }) {
    const titleBlock = blocks.find(block => block.type === "title");
    const texts = Object.fromEntries(blocks
        .filter(block => block.type !== "title")
        .map(block => [block.source, block.translation]));
    return {
        articleId,
        sourceUrl: articleUrl,
        sourceUpdatedAt: lastModified || null,
        sourceHash: sourceHashFor(blocks),
        translatedAt: new Date().toISOString(),
        title: titleBlock.translation,
        blocks: blocks.map(({ context, ...block }) => ({
            ...block,
            contextHash: contextHash({ context })
        })),
        texts
    };
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const dryRun = process.env.DRY_RUN === "1";
    if (!apiKey && !dryRun) {
        fail("OPENAI_API_KEY が設定されていません。");
    }

    const rules = await readOptionalConfiguration("translation_rules.md");
    if (!rules?.trim()) {
        fail("glossary/translation_rules.md が見つからないか、内容が空です。");
    }
    await mkdir(ARTICLES_DIRECTORY, { recursive: true });
    const requestedArticle = await getRequestedArticle();
    const sitemapEntries = requestedArticle ? null : await getSitemapEntries();
    const state = await readMonitorState();
    const outputFiles = await readdir(ARTICLES_DIRECTORY, { withFileTypes: true });
    const existingIds = new Set(outputFiles
        .filter(entry => entry.isFile() && /^\d+\.json$/u.test(entry.name))
        .map(entry => entry.name.slice(0, -5)));

    let targets;
    if (requestedArticle) {
        targets = [requestedArticle];
    } else {
        targets = [...sitemapEntries.values()].filter(entry => {
            if (existingIds.has(entry.articleId)) return true;
            return state.lastCheckedAt && isMoreRecent(entry.lastModified, state.lastCheckedAt);
        });
        if (!state.lastCheckedAt) {
            console.log("初回監視: 既存JSONの記事だけを更新確認します。未翻訳の旧記事は対象にしません。");
        }
    }

    let translatedArticleCount = 0;
    let checkedArticleCount = 0;
    let usage = { input: 0, output: 0, reasoning: 0, total: 0 };
    for (const target of targets) {
        const outputPath = join(ARTICLES_DIRECTORY, `${target.articleId}.json`);
        const existingArticle = await readJson(outputPath);
        if (existingArticle?.sourceUpdatedAt && target.lastModified
            && !isMoreRecent(target.lastModified, existingArticle.sourceUpdatedAt)) {
            continue;
        }

        checkedArticleCount++;
        console.log(`記事を確認します: ${target.url}`);
        const html = await fetchText(target.url);
        const title = extractTitle(html);
        const blocks = parseBlocks(extractArticleHtml(html), title);
        const newSourceHash = sourceHashFor(blocks);
        if (existingArticle?.sourceHash === newSourceHash) {
            console.log(`本文に差分はありません: articles/${target.articleId}.json`);
            if (!dryRun && target.lastModified && existingArticle.sourceUpdatedAt !== target.lastModified) {
                existingArticle.sourceUpdatedAt = target.lastModified;
                await writeFile(outputPath, `${JSON.stringify(existingArticle, null, 2)}\n`, "utf8");
            }
            continue;
        }

        const pending = splitReusableBlocks(blocks, existingArticle);
        console.log(`翻訳対象: ${blocks.length}ブロック（変更・追加: ${pending.length}ブロック）`);
        if (dryRun) continue;

        if (pending.length > 0) {
            const glossary = selectRelevantGlossary(
                await readOptionalConfiguration("glossary.json"),
                pending
            );
            const articleUsage = await translateBlocks(pending, apiKey, rules, glossary);
            usage.input += articleUsage.input;
            usage.output += articleUsage.output;
            usage.reasoning += articleUsage.reasoning;
            usage.total += articleUsage.total;
        }

        const output = makeOutput({
            articleId: target.articleId,
            articleUrl: target.url,
            lastModified: target.lastModified,
            blocks
        });
        await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
        translatedArticleCount++;
        console.log(`JSONを更新しました: articles/${target.articleId}.json`);
    }

    if (!requestedArticle && !dryRun) {
        await writeFile(MONITOR_STATE_PATH, `${JSON.stringify({
            lastCheckedAt: new Date().toISOString()
        }, null, 2)}\n`, "utf8");
    }
    console.log(`確認記事数: ${checkedArticleCount} / JSON更新数: ${translatedArticleCount}`);
    if (dryRun) {
        console.log("検証のみ: API呼び出し・JSON書き込みは行いません。");
    } else {
        console.log(`API使用量: 入力 ${usage.input} / 出力 ${usage.output} / 推論 ${usage.reasoning} / 合計 ${usage.total}`);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
