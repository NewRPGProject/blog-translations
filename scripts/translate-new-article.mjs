import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = dirname(SCRIPT_DIRECTORY);
const ARTICLES_DIRECTORY = join(REPOSITORY_DIRECTORY, "articles");
const RSS_URL = "https://newrpg.seesaa.net/index.rdf";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
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

const DEFAULT_RULES = `
You translate articles from a Japanese game-development blog into natural English.
Use terminology consistent with the English version of RPG Maker MZ.
Preserve URLs, file names, code, parameter names, plugin commands, escape characters, and identifiers.
Do not add explanations or information absent from the source.
Preserve the author's restrained, matter-of-fact tone.
Each item replaces one text node in the original HTML. Its context is the complete source line and can include <a>link display text</a>; use it to understand the full sentence.
Translate only source, never return HTML tags or the context itself. A source whose type is link is the visible text of a link and must be translated when it is Japanese.
Links, English product names, URLs, file names, code, parameter names, escape characters, and identifiers shown only in context are fixed context, not text to return.
The page will concatenate adjacent translated text nodes without adding whitespace.
When adjacent items are part of one English sentence, include the necessary leading or trailing ASCII spaces in translations so the concatenated result is natural English.
Do not add boundary spaces to a standalone sentence or paragraph.
Translate all Japanese text completely, including text inside links. Do not leave Japanese characters in a translation.
Return a translation for every supplied id.
`.trim();

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
        headers: {
            "user-agent": "NRPBlogTranslationBot/1.0"
        }
    });
    if (!response.ok) {
        fail(`取得に失敗しました (${response.status}): ${url}`);
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

async function getTargetUrl() {
    const requestedUrl = process.env.ARTICLE_URL?.trim();
    if (requestedUrl) {
        if (!extractArticleId(requestedUrl)) {
            fail("ARTICLE_URL は /article/記事ID.html の形式にしてください。");
        }
        return requestedUrl;
    }

    const rss = await fetchText(RSS_URL);
    const articleUrl = /rdf:about=["'](https?:\/\/[^"']+\/article\/\d+\.html)["']/iu.exec(rss)?.[1]
        || /https?:\/\/[^<\s"']+\/article\/\d+\.html/iu.exec(rss)?.[0];
    if (!articleUrl) {
        fail("RSSから最新記事のURLを取得できませんでした。");
    }
    return articleUrl.replace(/&amp;/gu, "&");
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
    const path = join(REPOSITORY_DIRECTORY, fileName);
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
        DEFAULT_RULES,
        rules ? `Additional translation rules:\n${rules}` : null,
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

async function exists(path) {
    try {
        await access(path, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const dryRun = process.env.DRY_RUN === "1";
    if (!apiKey && !dryRun) {
        fail("OPENAI_API_KEY が設定されていません。");
    }

    const articleUrl = await getTargetUrl();
    const articleId = extractArticleId(articleUrl);
    if (!articleId) fail("記事IDを取得できませんでした。");
    const outputPath = join(ARTICLES_DIRECTORY, `${articleId}.json`);
    if (!dryRun && await exists(outputPath)) {
        console.log(`既存JSONがあるためスキップします: articles/${articleId}.json`);
        return;
    }

    console.log(`記事を取得します: ${articleUrl}`);
    const html = await fetchText(articleUrl);
    const title = extractTitle(html);
    const blocks = parseBlocks(extractArticleHtml(html), title);
    console.log(`翻訳対象: ${blocks.length}ブロック`);
    if (dryRun) {
        console.log(`検証のみ: ${title}`);
        console.log("API呼び出し・JSON書き込みは行いません。");
        return;
    }

    const rules = await readOptionalConfiguration("translation_rules.md");
    const glossary = selectRelevantGlossary(
        await readOptionalConfiguration("glossary.json"),
        blocks
    );
    const usage = await translateBlocks(blocks, apiKey, rules, glossary);

    const titleBlock = blocks.find(block => block.type === "title");
    const texts = Object.fromEntries(blocks
        .filter(block => block.type !== "title")
        .map(block => [block.source, block.translation]));
    const output = {
        articleId,
        sourceUrl: articleUrl,
        sourceHash: hash(blocks.map(block => `${block.id}:${block.sourceHash}`).join("\n")),
        translatedAt: new Date().toISOString(),
        title: titleBlock.translation,
        blocks: blocks.map(({ context, ...block }) => block),
        texts
    };

    await mkdir(ARTICLES_DIRECTORY, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(`JSONを作成しました: articles/${articleId}.json`);
    console.log(`API使用量: 入力 ${usage.input} / 出力 ${usage.output} / 推論 ${usage.reasoning} / 合計 ${usage.total}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
