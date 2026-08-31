import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = dirname(SCRIPT_DIRECTORY);
const HOME_URL = "https://newrpg.seesaa.net/";
const OUTPUT_PATH = join(REPOSITORY_DIRECTORY, "common", "en.json");
const LEGACY_INPUT_PATH = join(REPOSITORY_DIRECTORY, "en.json");
const STATE_PATH = join(REPOSITORY_DIRECTORY, ".common-translation-monitor.json");
const RULES_PATH = join(REPOSITORY_DIRECTORY, "glossary", "translation_rules.md");
const GLOSSARY_PATH = join(REPOSITORY_DIRECTORY, "glossary", "glossary.json");
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const DRY_RUN = /^true$/iu.test(process.env.COMMON_DRY_RUN || "");
const JAPANESE_CHARACTERS = /[ぁ-んァ-ヶ一-龠々〆〤ー]/u;
const IGNORED_TAGS = new Set(["script", "style", "noscript", "textarea", "select", "option"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BROWSER_HEADERS = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    "referer": HOME_URL
};

function normalizeText(value) {
    return String(value || "")
        .replace(/\r/gu, "")
        .replace(/^[\s\u3000]+|[\s\u3000]+$/gu, "")
        .replace(/\s+/gu, " ");
}

function decodeHtml(value) {
    return String(value)
        .replace(/&nbsp;/giu, " ")
        .replace(/&lt;/giu, "<")
        .replace(/&gt;/giu, ">")
        .replace(/&quot;/giu, "\"")
        .replace(/&#39;/giu, "'")
        .replace(/&amp;/giu, "&")
        .replace(/&#x([0-9a-f]+);/giu, (_, hexadecimal) =>
            String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
        .replace(/&#([0-9]+);/gu, (_, decimal) =>
            String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function hash(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasJapanese(value) {
    return JAPANESE_CHARACTERS.test(String(value || ""));
}

async function readOptional(path, fallback = null) {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return fallback;
        throw error;
    }
}

async function readJson(path, fallback = null) {
    const value = await readOptional(path, null);
    return value === null ? fallback : JSON.parse(value.replace(/^\uFEFF/u, ""));
}

async function fetchText(url) {
    const response = await fetch(url, { headers: BROWSER_HEADERS });
    if (!response.ok) {
        const detail = (await response.text()).replace(/\s+/gu, " ").slice(0, 200);
        throw new Error(`取得に失敗しました (${response.status}): ${url}${detail ? ` / ${detail}` : ""}`);
    }
    // Seesaa's top page is currently Shift_JIS.  response.text() assumes
    // UTF-8 in this response and would turn Japanese into mojibake, making
    // the Japanese-text detector find zero entries.
    const bytes = await response.arrayBuffer();
    const header = response.headers.get("content-type") || "";
    const charset = /charset=([^;\s]+)/iu.exec(header)?.[1]?.toLowerCase();
    return new TextDecoder(
        charset?.includes("shift") || charset?.includes("sjis") ? "shift_jis" : "utf-8"
    ).decode(bytes);
}

function parseTag(token) {
    const match = /^<\/?([a-z][a-z0-9:-]*)\b/iu.exec(token);
    if (!match) return null;
    const closing = /^<\//u.test(token);
    const classMatch = /\bclass\s*=\s*(["'])(.*?)\1/iu.exec(token);
    return {
        name: match[1].toLowerCase(),
        closing,
        selfClosing: /\/>$/u.test(token) || VOID_TAGS.has(match[1].toLowerCase()),
        classes: new Set((classMatch?.[2] || "").split(/\s+/u).filter(Boolean)),
        keepLanguage: !closing && /(?:^|\s)keep-lang(?:\s|=|\/?>)/iu.test(token)
    };
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
            const end = html.indexOf("-->", index + 4);
            if (end < 0) break;
            if (textStart < index) tokens.push(html.slice(textStart, index));
            tokens.push(html.slice(index, end + 3));
            index = end + 3;
            textStart = index;
            continue;
        }
        // Do not mistake visible comparison operators for HTML tags.
        if (!/^<\/?[a-z][a-z0-9:-]*(?=[\s/>])/iu.test(html.slice(index))) {
            index++;
            continue;
        }
        let quote = null;
        let end = -1;
        for (let cursor = index + 1; cursor < html.length; cursor++) {
            const character = html[cursor];
            if (quote) {
                if (character === quote) quote = null;
            } else if (character === "\"" || character === "'") {
                quote = character;
            } else if (character === ">") {
                end = cursor;
                break;
            }
        }
        if (end < 0) {
            index++;
            continue;
        }
        if (textStart < index) tokens.push(html.slice(textStart, index));
        tokens.push(html.slice(index, end + 1));
        index = end + 1;
        textStart = index;
    }
    if (textStart < html.length) tokens.push(html.slice(textStart));
    return tokens;
}

function isTargetRegion(tag) {
    if (tag.classes.has("description") || tag.classes.has("sidetitle")) {
        return true;
    }
    return tag.classes.has("side") && !tag.classes.has("recent-articles");
}

function findMatchingElementEnd(html, tagName, contentStart) {
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "giu");
    tagPattern.lastIndex = contentStart;
    let depth = 1;
    for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
        if (/^<\//u.test(match[0])) {
            depth--;
            if (depth === 0) {
                return { contentEnd: match.index, elementEnd: tagPattern.lastIndex };
            }
        } else if (!/\/>$/u.test(match[0])) {
            depth++;
        }
    }
    return null;
}

function findCommonRegions(html) {
    // Seesaa's shared areas are currently div/span elements.  Extract each
    // outer region first so nested sidebar markup cannot affect its scope.
    const openingTag = /<(div|span)\b[^>]*\bclass\s*=\s*(["'])(.*?)\2[^>]*>/giu;
    const regions = [];
    for (let match = openingTag.exec(html); match; match = openingTag.exec(html)) {
        const classes = new Set(match[3].split(/\s+/u).filter(Boolean));
        const tag = { classes };
        if (!isTargetRegion(tag)) continue;

        const end = findMatchingElementEnd(html, match[1], openingTag.lastIndex);
        if (!end) continue;
        regions.push(html.slice(openingTag.lastIndex, end.contentEnd));
        // A target region may contain nested div/span elements.  It is one
        // source area, so do not collect those children a second time.
        openingTag.lastIndex = end.elementEnd;
    }
    return regions;
}

function collectVisibleTexts(html) {
    const texts = new Set();
    const stack = [];
    let ignoredDepth = 0;
    let keepLanguageDepth = 0;

    const closeTagsFrom = index => {
        const closed = stack.splice(index);
        for (const item of closed) {
            if (item.ignored) ignoredDepth--;
            if (item.keepLanguage) keepLanguageDepth--;
        }
    };

    for (const token of tokenizeHtml(html)) {
        if (!token.startsWith("<")) {
            if (ignoredDepth > 0 || keepLanguageDepth > 0) continue;
            const text = normalizeText(decodeHtml(token));
            if (text && hasJapanese(text)) texts.add(text);
            continue;
        }
        if (/^<!--/u.test(token)) continue;
        const tag = parseTag(token);
        if (!tag) continue;
        if (tag.closing) {
            const index = stack.map(item => item.name).lastIndexOf(tag.name);
            if (index >= 0) closeTagsFrom(index);
            continue;
        }
        const item = {
            name: tag.name,
            ignored: IGNORED_TAGS.has(tag.name),
            keepLanguage: tag.keepLanguage
        };
        stack.push(item);
        if (item.ignored) ignoredDepth++;
        if (item.keepLanguage) keepLanguageDepth++;
        if (tag.selfClosing) closeTagsFrom(stack.length - 1);
    }
    return texts;
}

function collectCommonTexts(html) {
    const texts = new Set();
    for (const region of findCommonRegions(html)) {
        for (const text of collectVisibleTexts(region)) texts.add(text);
    }
    return [...texts];
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

async function translateChunk(items, apiKey, rules, glossary) {
    const instructions = [
        rules,
        "Translate each source string from Japanese to natural English. Return only the translation for each item.",
        "These are stable website labels from the header or sidebar. Do not add explanations.",
        "Keep URLs, file names, JavaScript identifiers, version numbers, and text inside <span keep-lang> unchanged.",
        glossary ? `Required glossary:\n${glossary}` : null
    ].filter(Boolean).join("\n\n");
    const response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model: MODEL,
            instructions,
            input: `Translate this JSON array:\n${JSON.stringify(items)}`,
            text: {
                verbosity: "low",
                format: {
                    type: "json_schema",
                    name: "common_translations",
                    strict: true,
                    schema: outputSchema()
                }
            }
        })
    });
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`OpenAI APIエラー (${response.status}): ${body.slice(0, 500)}`);
    }
    const result = JSON.parse(body);
    const output = result.output?.flatMap(item => item.content || [])
        .find(item => item.type === "output_text")?.text;
    if (!output) throw new Error("OpenAI APIから翻訳テキストが返されませんでした。");
    return {
        translations: new Map((JSON.parse(output).translations || [])
            .map(item => [item.id, item.translation])),
        usage: result.usage || {}
    };
}

function createChunks(texts) {
    const chunks = [];
    let chunk = [];
    let length = 0;
    for (const text of texts) {
        if (chunk.length > 0 && (chunk.length >= 50 || length + text.length > 12000)) {
            chunks.push(chunk);
            chunk = [];
            length = 0;
        }
        chunk.push(text);
        length += text.length;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

async function main() {
    const html = await fetchText(HOME_URL);
    const sourceTexts = collectCommonTexts(html);
    const sourceHash = hash(sourceTexts.join("\n"));
    const existing = await readJson(OUTPUT_PATH, null)
        || await readJson(LEGACY_INPUT_PATH, { language: "en", texts: {} });
    const texts = { ...(existing.texts || {}) };
    const pending = sourceTexts.filter(source =>
        typeof texts[source] !== "string" || !texts[source].trim() || hasJapanese(texts[source])
    );
    const previousState = await readJson(STATE_PATH, null);

    console.log(`共通部を確認: ${sourceTexts.length}件（追加・未翻訳: ${pending.length}件）`);
    if (pending.length === 0) {
        if (previousState?.sourceHash === sourceHash) {
            console.log("共通部に差分はありません。");
            return;
        }
        if (DRY_RUN) {
            console.log("COMMON_DRY_RUN=true のため、監視情報を更新しません。");
            return;
        }
        await writeFile(STATE_PATH, `${JSON.stringify({ sourceHash, checkedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
        console.log("共通部の監視情報を更新しました。");
        return;
    }
    if (DRY_RUN) {
        console.log("COMMON_DRY_RUN=true のため、API翻訳とファイル更新を行いません。");
        for (const source of pending) console.log(`- ${source}`);
        return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY が設定されていません。");
    const [rules, glossary] = await Promise.all([
        readOptional(RULES_PATH, ""),
        readOptional(GLOSSARY_PATH, "")
    ]);
    const usage = { input: 0, output: 0, reasoning: 0, total: 0 };
    for (const chunk of createChunks(pending)) {
        const items = chunk.map((source, index) => ({ id: String(index), source }));
        const result = await translateChunk(items, apiKey, rules, glossary);
        usage.input += result.usage.input_tokens || 0;
        usage.output += result.usage.output_tokens || 0;
        usage.reasoning += result.usage.output_tokens_details?.reasoning_tokens || 0;
        usage.total += result.usage.total_tokens || 0;
        for (const item of items) {
            const translation = String(result.translations.get(item.id) || "").trim();
            if (!translation || hasJapanese(translation)) {
                throw new Error(`共通部の翻訳漏れを検出しました: ${item.source} → ${translation || "翻訳なし"}`);
            }
            texts[item.source] = translation;
        }
    }

    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify({ ...existing, language: "en", texts }, null, 2)}\n`, "utf8");
    await writeFile(STATE_PATH, `${JSON.stringify({ sourceHash, checkedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    console.log(`共通辞書を更新しました: common/en.json（追加・更新: ${pending.length}件）`);
    console.log(`API使用量: 入力 ${usage.input} / 出力 ${usage.output} / 推論 ${usage.reasoning} / 合計 ${usage.total}`);
}

main().catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
});
