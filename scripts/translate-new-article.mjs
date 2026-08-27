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
const INITIAL_MONITOR_LOOKBACK_HOURS = 24;
const EXTRACTION_VERSION = 4;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const RETRY_TRANSLATION_INSTRUCTION = `
This is a correction retry because the previous result was incomplete or included an HTML anchor tag.
Translate every Japanese word and character in source into natural English, including isolated terms embedded in an otherwise English sentence.
Do not copy Japanese from source or context into translation. Keep only URLs, file names, code, identifiers, escape characters, version numbers, and Japanese string literals inside code unchanged.
Never output HTML tags such as <a> or </a>. Context is for understanding only, never for copying.
Return only the replacement text for each supplied source item.
`.trim();
const LINK_CONTEXT_INSTRUCTION = `
In context, [[link: ...]] represents the text inside an original HTML link. It is context only: never output the markers, HTML tags, or the linked text unless that text is also in source.
When source immediately follows a link marker, translate it as a grammatical continuation of that link text. Include an ordinary ASCII space at the boundary when English requires one, and never repeat the link text.
`.trim();
const CODE_FRAGMENT_INSTRUCTION = `
Items whose type starts with "code-" are natural-language fragments extracted from a code example. Translate only that fragment.
Always translate Japanese in these fragments; any rule about preserving source code applies to the surrounding syntax, which has already been removed from source.
Do not add quotation marks, comment markers, Markdown, or code syntax. Preserve identifiers, escape sequences, and version numbers embedded in the fragment.
`.trim();
const BROWSER_HEADERS = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    "referer": "https://newrpg.seesaa.net/"
};
const JAPANESE_CHARACTERS = /[ぁ-んァ-ヶ一-龠々〆〤ー]/u;
const WHITESPACE = /\s+/gu;
const IGNORED_TAGS = new Set([
    "script", "style", "noscript", "textarea", "select", "option"
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const CODE_CONTAINER_TAGS = new Set(["blockquote", "pre", "code"]);
const LINE_BOUNDARY_TAGS = new Set([
    "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "p", "td", "th", "figcaption", "center", "table", "ul", "ol", "blockquote", "pre"
]);
const STRUCTURAL_PUNCTUATION_TRANSLATIONS = new Map([
    ["&", "&"],
    ["（", " ("],
    ["）", ") "]
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

function stripBom(value) {
    return value.replace(/^\uFEFF/u, "");
}

function hasUntranslatedJapanese(value) {
    return JAPANESE_CHARACTERS.test(String(value));
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

function isWithinInitialMonitorWindow(lastModified) {
    const modifiedAt = new Date(lastModified);
    const earliestTarget = Date.now() - INITIAL_MONITOR_LOOKBACK_HOURS * 60 * 60 * 1000;
    return !Number.isNaN(modifiedAt.valueOf()) && modifiedAt.valueOf() >= earliestTarget;
}

async function readJson(path) {
    try {
        return JSON.parse(stripBom(await readFile(path, "utf8")));
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

async function readMonitorState() {
    const state = await readJson(MONITOR_STATE_PATH) || {};
    return {
        lastCheckedAt: state.lastCheckedAt || null,
        articles: state.articles && typeof state.articles === "object" ? state.articles : {}
    };
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
        if (CODE_CONTAINER_TAGS.has(name)) return "code";
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
    return segments
        .map(segment => segment.link ? `[[link: ${segment.raw}]]` : segment.raw)
        .join("")
        .replace(/\s+/gu, " ")
        .trim();
}

function tokenizeHtml(html) {
    const tokens = [];
    let textStart = 0;
    let index = 0;
    while (index < html.length) {
        if (html[index] !== "<") {
            index++;
            continue;
        }

        if (html.startsWith("<!--", index)) {
            const commentEnd = html.indexOf("-->", index + 4);
            if (commentEnd < 0) break;
            if (textStart < index) tokens.push(html.slice(textStart, index));
            tokens.push(html.slice(index, commentEnd + 3));
            index = commentEnd + 3;
            textStart = index;
            continue;
        }

        let quote = null;
        let tagEnd = -1;
        for (let cursor = index + 1; cursor < html.length; cursor++) {
            const character = html[cursor];
            if (quote) {
                if (character === quote) quote = null;
            } else if (character === "\"" || character === "'") {
                quote = character;
            } else if (character === ">") {
                tagEnd = cursor;
                break;
            }
        }
        if (tagEnd < 0) {
            index++;
            continue;
        }

        if (textStart < index) tokens.push(html.slice(textStart, index));
        tokens.push(html.slice(index, tagEnd + 1));
        index = tagEnd + 1;
        textStart = index;
    }
    if (textStart < html.length) tokens.push(html.slice(textStart));
    return tokens;
}

function trimCodeSpan(source, start, end, type) {
    while (start < end && /\s/u.test(source[start])) start++;
    while (end > start && /\s/u.test(source[end - 1])) end--;
    if (start >= end || !JAPANESE_CHARACTERS.test(source.slice(start, end))) return null;
    return { start, end, type, source: source.slice(start, end) };
}

function findClosingQuote(source, start, quote) {
    for (let index = start; index < source.length; index++) {
        if (source[index] === "\\") {
            index++;
            continue;
        }
        if (source[index] === quote) return index;
    }
    return source.length;
}

function findMatchingTemplateExpression(source, start) {
    let depth = 1;
    for (let index = start; index < source.length; index++) {
        if (source[index] === "\\") {
            index++;
            continue;
        }
        if (source[index] === "{") depth++;
        if (source[index] === "}" && --depth === 0) return index;
    }
    return source.length;
}

function extractCodeTranslationSegments(source) {
    const segments = [];
    const add = (start, end, type) => {
        const segment = trimCodeSpan(source, start, end, type);
        if (segment) segments.push(segment);
    };

    for (let index = 0; index < source.length;) {
        if (source.startsWith("//", index)) {
            add(index + 2, source.length, "comment");
            break;
        }
        if (source.startsWith("/*", index)) {
            const end = source.indexOf("*/", index + 2);
            add(index + 2, end < 0 ? source.length : end, "comment");
            index = end < 0 ? source.length : end + 2;
            continue;
        }

        const quote = source[index];
        if (quote === "\"" || quote === "'") {
            const end = findClosingQuote(source, index + 1, quote);
            add(index + 1, end, "string");
            index = end + 1;
            continue;
        }
        if (quote === "`") {
            let segmentStart = index + 1;
            index++;
            while (index < source.length && source[index] !== "`") {
                if (source[index] === "\\") {
                    index += 2;
                    continue;
                }
                if (source.startsWith("${", index)) {
                    add(segmentStart, index, "template");
                    const expressionEnd = findMatchingTemplateExpression(source, index + 2);
                    index = expressionEnd + 1;
                    segmentStart = index;
                    continue;
                }
                index++;
            }
            add(segmentStart, index, "template");
            index++;
            continue;
        }
        index++;
    }
    return segments;
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

    const tokens = tokenizeHtml(articleHtml);
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
        for (let index = 0; index < segments.length; index++) {
            const segment = segments[index];
            const fixedTranslation = STRUCTURAL_PUNCTUATION_TRANSLATIONS.get(segment.source)
                || (!JAPANESE_CHARACTERS.test(segment.source) && segment.type === "link"
                    ? segment.source
                    : null);
            const codeSegments = segment.type === "code"
                ? extractCodeTranslationSegments(segment.source)
                : null;
            if (!segment.source || (!JAPANESE_CHARACTERS.test(segment.source) && !fixedTranslation)) continue;
            if (segment.type === "code" && codeSegments.length === 0) continue;
            if (segment.source.length === 1 && /^[\p{P}\p{S}]$/u.test(segment.source)
                && !fixedTranslation) continue;
            const count = (counters.get(segment.type) || 0) + 1;
            counters.set(segment.type, count);
            blocks.push({
                id: `${segment.type}-${String(count).padStart(3, "0")}`,
                type: segment.type,
                source: segment.source,
                sourceHash: hash(segment.source),
                context,
                fixedTranslation,
                codeSegments,
                linkAdjacent: segment.link || segments[index - 1]?.link || segments[index + 1]?.link
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
        return stripBom(await readFile(path, "utf8"));
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

async function translateChunk(blocks, apiKey, rules, glossary, retry = false) {
    const instructions = [
        rules,
        LINK_CONTEXT_INSTRUCTION,
        blocks.some(block => block.type.startsWith("code-")) ? CODE_FRAGMENT_INSTRUCTION : null,
        retry ? RETRY_TRANSLATION_INSTRUCTION : null,
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

function addUsage(total, addition) {
    total.input += addition.input_tokens || 0;
    total.output += addition.output_tokens || 0;
    total.reasoning += addition.output_tokens_details?.reasoning_tokens || 0;
    total.total += addition.total_tokens || 0;
}

async function translateSimpleBlocks(blocks, apiKey, rules, glossary) {
    const usage = { input: 0, output: 0, reasoning: 0, total: 0 };
    for (const chunk of createChunks(blocks)) {
        const result = await translateChunk(chunk, apiKey, rules, glossary);
        const retryBlocks = [];
        for (const block of chunk) {
            const translation = result.translations.get(block.id);
            if (typeof translation !== "string" || !translation.trim()) {
                retryBlocks.push({ block, initialTranslation: null });
                continue;
            }
            if (hasUntranslatedJapanese(translation) || /<\/?a\b/iu.test(translation)) {
                retryBlocks.push({ block, initialTranslation: translation });
                continue;
            }
            block.translation = translation;
        }
        addUsage(usage, result.usage);

        if (retryBlocks.length > 0) {
            console.log(`翻訳漏れまたは未返却を検出したため、${retryBlocks.length}ブロックを再翻訳します。`);
            const retryResult = await translateChunk(
                retryBlocks.map(item => item.block),
                apiKey,
                rules,
                glossary,
                true
            );
            addUsage(usage, retryResult.usage);

            for (const { block, initialTranslation } of retryBlocks) {
                const translation = retryResult.translations.get(block.id);
                if (typeof translation !== "string" || !translation.trim()
                    || hasUntranslatedJapanese(translation)
                    || /<\/?a\b/iu.test(translation)) {
                    fail(`翻訳漏れまたは未返却を検出しました: ${block.id} (${block.source} → ${initialTranslation || "翻訳なし"} → ${translation || "翻訳なし"})`);
                }
                block.translation = translation;
            }
        }
    }
    return usage;
}

function restoreCodeTranslation(block, fragments) {
    let sourceCursor = 0;
    let restored = "";
    for (const fragment of fragments) {
        const translation = fragment.translation;
        if (typeof translation !== "string" || !translation.trim()) {
            fail(`コード断片の翻訳がありません: ${block.id}`);
        }
        restored += block.source.slice(sourceCursor, fragment.start);
        restored += translation;
        sourceCursor = fragment.end;
    }
    restored += block.source.slice(sourceCursor);

    // All non-translatable portions are copied from source. Verify that this
    // invariant was retained before writing the reconstructed code line.
    let restoredCursor = 0;
    sourceCursor = 0;
    for (const fragment of fragments) {
        const fixed = block.source.slice(sourceCursor, fragment.start);
        if (restored.slice(restoredCursor, restoredCursor + fixed.length) !== fixed) {
            fail(`コード構文の保全チェックに失敗しました: ${block.id}`);
        }
        restoredCursor += fixed.length + fragment.translation.length;
        sourceCursor = fragment.end;
    }
    const tail = block.source.slice(sourceCursor);
    if (restored.slice(restoredCursor) !== tail) {
        fail(`コード構文の保全チェックに失敗しました: ${block.id}`);
    }
    return restored;
}

async function translateCodeBlocks(blocks, apiKey, rules, glossary) {
    const fragments = [];
    for (const block of blocks) {
        for (const [index, segment] of (block.codeSegments || []).entries()) {
            fragments.push({
                id: `${block.id}::${index + 1}`,
                type: `code-${segment.type}`,
                source: segment.source,
                sourceHash: hash(segment.source),
                context: block.source,
                parent: block,
                start: segment.start,
                end: segment.end
            });
        }
    }
    const usage = await translateSimpleBlocks(fragments, apiKey, rules, glossary);
    for (const block of blocks) {
        const blockFragments = fragments
            .filter(fragment => fragment.parent === block)
            .sort((left, right) => left.start - right.start);
        block.translation = restoreCodeTranslation(block, blockFragments);
    }
    return usage;
}

async function translateBlocks(blocks, apiKey, rules, glossary) {
    const usage = { input: 0, output: 0, reasoning: 0, total: 0 };
    const ordinaryBlocks = blocks.filter(block => block.type !== "code");
    const codeBlocks = blocks.filter(block => block.type === "code");
    if (ordinaryBlocks.length > 0) addUsage(usage, await translateSimpleBlocks(ordinaryBlocks, apiKey, rules, glossary));
    if (codeBlocks.length > 0) addUsage(usage, await translateCodeBlocks(codeBlocks, apiKey, rules, glossary));
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

function splitReusableBlocks(blocks, existingArticle, retranslateLinkContexts = false, retranslateCodeBlocks = false) {
    const previous = buildPreviousTranslations(existingArticle);
    const pending = [];
    for (const block of blocks) {
        if (block.fixedTranslation) {
            block.translation = block.fixedTranslation;
            continue;
        }
        const exactKey = `${block.type}\u0000${block.sourceHash}\u0000${contextHash(block)}`;
        const translation = previous.exact.get(exactKey)
            || (block.type === "title" ? existingArticle?.title : null)
            || previous.bySource.get(block.source);
        const refreshThisLinkContext = retranslateLinkContexts && block.linkAdjacent;
        const refreshThisCodeBlock = retranslateCodeBlocks && block.type === "code";
        if (!refreshThisLinkContext && !refreshThisCodeBlock && translation && !hasUntranslatedJapanese(translation)) {
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

function sameContext(left, right) {
    if (left.context && right.context) return left.context === right.context;
    return Boolean(left.contextHash && right.contextHash && left.contextHash === right.contextHash);
}

function repairLinkBoundarySpaces(blocks) {
    let repaired = false;
    for (let index = 1; index < blocks.length; index++) {
        const previous = blocks[index - 1];
        const current = blocks[index];
        if (!sameContext(previous, current)
            || (previous.type !== "link" && current.type !== "link")
            || !previous.translation || !current.translation
            || /\s$/u.test(previous.translation)
            || /^\s/u.test(current.translation)
            || !/[A-Za-z0-9)\]}]$/u.test(previous.translation)
            || !/^[A-Za-z0-9([{]/u.test(current.translation)) {
            continue;
        }
        previous.translation += " ";
        repaired = true;
    }
    return repaired;
}

function preserveFullWidthAngleBrackets(blocks) {
    let repaired = false;
    for (const block of blocks) {
        const source = block.source?.trim() || "";
        if (!/^＜.+＞$/u.test(source) || !block.translation?.trim()) continue;

        const leadingWhitespace = /^\s*/u.exec(block.translation)?.[0] || "";
        const trailingWhitespace = /\s*$/u.exec(block.translation)?.[0] || "";
        let content = block.translation.trim();
        content = content.replace(/^＜/u, "<").replace(/＞$/u, ">");
        if (!content.startsWith("<")) content = `<${content}`;
        if (!content.endsWith(">")) content = `${content}>`;
        const corrected = `${leadingWhitespace}${content}${trailingWhitespace}`;
        if (corrected !== block.translation) {
            block.translation = corrected;
            repaired = true;
        }
    }
    return repaired;
}

function normalizeOpenParenthesisBoundaries(blocks) {
    let repaired = false;
    for (const block of blocks) {
        if (!block.source?.endsWith("（") || !block.translation) continue;
        // The opening parenthesis belongs to this source block, not to the
        // following link.  Do not depend on the model having emitted it.
        const body = block.translation.replace(/\s*[（(“"]+\s*$/u, "").trimEnd();
        const corrected = `${body} (`;
        if (corrected !== block.translation) {
            block.translation = corrected;
            repaired = true;
        }
    }
    return repaired;
}

function synchronizeTextsFromBlocks(article) {
    article.texts ||= {};
    for (const block of article.blocks || []) {
        if (block.type !== "title" && block.source && block.translation) {
            article.texts[block.source] = block.translation;
        }
    }
}

function makeOutput({ articleId, articleUrl, lastModified, blocks }) {
    const titleBlock = blocks.find(block => block.type === "title");
    const texts = Object.fromEntries(blocks
        .filter(block => block.type !== "title")
        .map(block => [block.source, block.translation]));
    return {
        articleId,
        sourceUrl: articleUrl,
        extractionVersion: EXTRACTION_VERSION,
        sourceUpdatedAt: lastModified || null,
        sourceHash: sourceHashFor(blocks),
        translatedAt: new Date().toISOString(),
        title: titleBlock.translation,
        blocks: blocks.map(({ context, fixedTranslation, codeSegments, linkAdjacent, ...block }) => ({
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
            return state.lastCheckedAt
                ? isMoreRecent(entry.lastModified, state.lastCheckedAt)
                : isWithinInitialMonitorWindow(entry.lastModified);
        });
        if (!state.lastCheckedAt) {
            console.log(`初回監視: 既存JSONと直近${INITIAL_MONITOR_LOOKBACK_HOURS}時間の更新記事を確認します。`);
        }
    }

    let translatedArticleCount = 0;
    let checkedArticleCount = 0;
    let usage = { input: 0, output: 0, reasoning: 0, total: 0 };
    for (const target of targets) {
        const outputPath = join(ARTICLES_DIRECTORY, `${target.articleId}.json`);
        const existingArticle = await readJson(outputPath);
        const trackedArticle = state.articles[target.articleId];
        const knownUpdatedAt = trackedArticle?.sourceUpdatedAt || existingArticle?.sourceUpdatedAt;
        if (knownUpdatedAt && target.lastModified
            && !isMoreRecent(target.lastModified, knownUpdatedAt)) {
            continue;
        }

        checkedArticleCount++;
        console.log(`記事を確認します: ${target.url}`);
        const html = await fetchText(target.url);
        const title = extractTitle(html);
        const blocks = parseBlocks(extractArticleHtml(html), title);
        const newSourceHash = sourceHashFor(blocks);
        const rememberArticleState = () => {
            if (target.lastModified) {
                state.articles[target.articleId] = {
                    sourceHash: newSourceHash,
                    sourceUpdatedAt: target.lastModified
                };
            }
        };
        if ((existingArticle?.sourceHash || trackedArticle?.sourceHash) === newSourceHash) {
            console.log(`本文に差分はありません: articles/${target.articleId}.json`);
            const existingBlocks = existingArticle?.blocks || [];
            const repairedLinkSpaces = !dryRun && repairLinkBoundarySpaces(existingBlocks);
            const repairedAngleBrackets = !dryRun && preserveFullWidthAngleBrackets(existingBlocks);
            const repairedParentheses = !dryRun && normalizeOpenParenthesisBoundaries(existingBlocks);
            if (repairedLinkSpaces || repairedAngleBrackets || repairedParentheses) {
                synchronizeTextsFromBlocks(existingArticle);
                await writeFile(outputPath, `${JSON.stringify(existingArticle, null, 2)}\n`, "utf8");
                translatedArticleCount++;
                console.log(`リンク境界の空白を修正しました: articles/${target.articleId}.json`);
            }
            if (!dryRun) rememberArticleState();
            continue;
        }

        const pending = splitReusableBlocks(
            blocks,
            existingArticle,
            // Legacy JSON has no context hash. It is still safe to reuse by
            // source text; forcing all of its link-adjacent blocks would
            // needlessly retranslate already-reviewed articles.
            Number.isInteger(existingArticle?.extractionVersion)
                && existingArticle.extractionVersion < 3,
            existingArticle?.extractionVersion !== EXTRACTION_VERSION
        );
        console.log(`翻訳対象: ${blocks.length}ブロック（変更・追加: ${pending.length}ブロック）`);
        if (dryRun) continue;

        if (existingArticle && pending.length === 0) {
            rememberArticleState();
            console.log(`翻訳内容に差分はありません: articles/${target.articleId}.json`);
            continue;
        }

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

        repairLinkBoundarySpaces(blocks);
        preserveFullWidthAngleBrackets(blocks);
        normalizeOpenParenthesisBoundaries(blocks);

        const output = makeOutput({
            articleId: target.articleId,
            articleUrl: target.url,
            lastModified: target.lastModified,
            blocks
        });
        await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
        rememberArticleState();
        translatedArticleCount++;
        console.log(`JSONを更新しました: articles/${target.articleId}.json`);
    }

    if (!requestedArticle && !dryRun) {
        await writeFile(MONITOR_STATE_PATH, `${JSON.stringify({
            lastCheckedAt: new Date().toISOString(),
            articles: state.articles
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
