window.NRP_Language = (() => {
"use strict";

const STORAGE_KEY = "nrp-blog-language";
const ENGLISH_LOADING_CLASS = "nrp-en-loading";
// Github障害時や通信が遅い環境でもこの時間（ms）で解除
const INITIAL_REVEAL_TIMEOUT_MS = 500;
const TRANSLATION_BASE_URL =
    "https://newrpgproject.github.io/blog-translations/articles/";

const COMMON_TRANSLATION_URL =
    "https://newrpgproject.github.io/blog-translations/common/en.json";

const originalText = new Map();
const originalTitle = new Map();
const originalCommonText = new Map();
const translationCache = new Map();
const originalLineContent = new WeakMap();

let commonTranslationCache = null;

let cachedTitleElement = null;
let cachedBodyElement = null;
let isChangingLanguage = false;

function setInitialEnglishLoading(isLoading) {
    document.documentElement.classList.toggle(
        ENGLISH_LOADING_CLASS,
        isLoading
    );
}

function waitForNextPaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });
}

async function loadTranslation(articleId) {
    if (!articleId) {
        return null;
    }

    if (translationCache.has(articleId)) {
        return translationCache.get(articleId);
    }

    const url =
        TRANSLATION_BASE_URL +
        encodeURIComponent(articleId) +
        ".json";

    const response = await fetch(url, {
        cache: "default"
    });

    if (!response.ok) {
        if (response.status === 404) {
            console.warn(
                "[NRP Language] 翻訳データがありません:",
                articleId
            );
            return null;
        }

        throw new Error(
            "翻訳データの取得に失敗しました: HTTP " +
            response.status
        );
    }

    const translation = await response.json();

    if (
        !translation ||
        String(translation.articleId) !== String(articleId) ||
        typeof translation.title !== "string" ||
        typeof translation.texts !== "object"
    ) {
        throw new Error(
            "翻訳JSONの形式が正しくありません: " + url
        );
    }

    translationCache.set(articleId, translation);
    return translation;
}

async function loadCommonTranslation() {
    if (commonTranslationCache) {
        return commonTranslationCache;
    }

    const response = await fetch(
        COMMON_TRANSLATION_URL,
        { cache: "default" }
    );

    if (!response.ok) {
        if (response.status === 404) {
            console.warn(
                "[NRP Language] 共通翻訳データがありません。"
            );
            return null;
        }

        throw new Error(
            "共通翻訳データの取得に失敗しました: HTTP " +
            response.status
        );
    }

    const translation = await response.json();

    if (
        !translation ||
        typeof translation.texts !== "object" ||
        translation.texts === null
    ) {
        throw new Error(
            "共通翻訳JSONの形式が正しくありません。"
        );
    }

    commonTranslationCache = translation;
    return translation;
}

function getArticleId() {
    const match =
        location.pathname.match(/\/article\/(\d+)\.html/);

    return match ? match[1] : null;
}

function findArticleTitle(articleId) {
    const selectors = [
        ".article-title a",
        ".article__title a",
        ".entry-title a",
        ".entry-title",
        "article h1 a",
        "article h2 a",
        "article h3 a",
        "article h1",
        "article h2",
        "article h3"
    ];

    for (const selector of selectors) {
        const elements =
            document.querySelectorAll(selector);

        for (const element of elements) {
            const href =
                element.getAttribute?.("href") || "";

            if (
                href.includes(
                    "/article/" + articleId + ".html"
                ) ||
                element.closest(
                    "article, .article, .entry"
                )
            ) {
                return element;
            }
        }
    }

    const links = document.querySelectorAll(
        `a[href*="/article/${articleId}.html"]`
    );

    for (const link of links) {
        if (
            link.closest(
                "#sidebar, .sidebar, .side, aside, " +
                ".recent-entry, .recent-article"
            )
        ) {
            continue;
        }

        return link;
    }

    return null;
}

function findArticleBody(translation = null) {
    if (!translation?.texts) {
        return null;
    }

    const sourceTexts = new Set(
        [
            ...Object.keys(translation.texts),
            ...(translation.lines || []).flatMap(line =>
                (line.parts || []).map(part => part.source)
            )
        ]
            .flatMap(source => textLookupKeys(source))
            .filter(Boolean)
    );

    if (sourceTexts.size === 0) {
        return null;
    }

    const matchedParents = [];
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                const parent = node.parentElement;

                if (!parent) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (
                    parent.closest(
                        "script, style, pre, code, textarea, " +
                        "#sidebar, .sidebar, .side, aside"
                    )
                ) {
                    return NodeFilter.FILTER_REJECT;
                }

                const text = normalizeText(node.nodeValue);

                return sourceTexts.has(text)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        }
    );

    while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;

        if (parent && !matchedParents.includes(parent)) {
            matchedParents.push(parent);
        }
    }

    if (matchedParents.length === 0) {
        console.warn(
            "[NRP Language] JSON内の日本語原文と一致する要素がありません。"
        );
        return null;
    }

    // 一致した複数のテキスト要素を全て含む、
    // できるだけ小さい共通親要素を取得
    let commonAncestor = matchedParents[0];

    while (
        commonAncestor &&
        !matchedParents.every(element =>
            commonAncestor.contains(element)
        )
    ) {
        commonAncestor = commonAncestor.parentElement;
    }

    if (
        !commonAncestor ||
        commonAncestor === document.body ||
        commonAncestor === document.documentElement
    ) {
        // 共通親が大きすぎる場合は、最初に一致した文章から
        // 記事らしい親要素を探す
        let element = matchedParents[0];

        while (
            element?.parentElement &&
            element.parentElement !== document.body
        ) {
            const parent = element.parentElement;
            const matchedCount = matchedParents.filter(item =>
                parent.contains(item)
            ).length;

            if (matchedCount >= 2) {
                return parent;
            }

            element = parent;
        }

        return matchedParents[0].parentElement;
    }

    return commonAncestor;
}

function getArticleElements(articleId, translation = null) {
    if (
        !cachedTitleElement ||
        !document.contains(cachedTitleElement)
    ) {
        cachedTitleElement = findArticleTitle(articleId);
    }

    if (
        !cachedBodyElement ||
        !document.contains(cachedBodyElement)
    ) {
        cachedBodyElement = findArticleBody(translation);
    }

    return {
        titleElement: cachedTitleElement,
        bodyElement: cachedBodyElement
    };
}

function normalizeText(text) {
    return String(text)
        .replace(/\r/g, "")
        .replace(
            /^[\s\u3000]+|[\s\u3000]+$/g,
            ""
        )
        // Match the normalization used when generating JSON. In particular,
        // Seesaa may emit an ideographic space (U+3000) inside a sentence.
        .replace(/\s+/g, " ");
}

function decodeHtmlEntities(text) {
    // The browser has the complete HTML named-entity table. Decode here rather
    // than maintaining a growing list such as &divide;, &times;, and so on.
    // A textarea uses RCDATA parsing, so text that resembles an HTML tag is
    // retained as text while character references are decoded.
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(text);
    return textarea.value;
}

function textLookupKeys(text) {
    const normalized = normalizeText(text);
    const decoded = normalizeText(decodeHtmlEntities(text));
    return decoded === normalized ? [normalized] : [normalized, decoded];
}

function lookupTranslation(dictionary, normalized) {
    const texts = dictionary.texts || dictionary;
    if (typeof texts[normalized] === "string") {
        return texts[normalized];
    }
    return texts[normalizeText(decodeHtmlEntities(normalized))];
}

function createArticleDictionary(translation) {
    const allOccurrences = new Map();
    for (const block of translation.blocks || []) {
        if (
            block.type === "title" ||
            typeof block.source !== "string" ||
            typeof block.translation !== "string"
        ) {
            continue;
        }
        for (const key of textLookupKeys(block.source)) {
            if (!key) continue;
            const occurrences = allOccurrences.get(key) || [];
            occurrences.push(block.translation);
            allOccurrences.set(key, occurrences);
        }
    }

    // The legacy texts map uses source text as its key. When the same Japanese
    // fragment occurs in different sentences, that key can overwrite a
    // context-specific translation. Keep ordered alternatives only for such
    // conflicts and consume them in DOM order.
    const conflicts = new Map(
        [...allOccurrences].filter(([, translations]) =>
            new Set(translations).size > 1
        )
    );
    const texts = { ...(translation.texts || {}) };
    for (const [source, translated] of Object.entries(texts)) {
        for (const key of textLookupKeys(source)) {
            if (typeof texts[key] !== "string") {
                texts[key] = translated;
            }
        }
    }
    return {
        texts,
        conflicts,
        positions: new Map()
    };
}

function takeTranslation(dictionary, normalized) {
    const alternatives = dictionary.conflicts?.get(normalized);
    if (alternatives) {
        const position = dictionary.positions.get(normalized) || 0;
        dictionary.positions.set(normalized, position + 1);
        if (position < alternatives.length) {
            return alternatives[position];
        }
    }
    return lookupTranslation(dictionary, normalized);
}

function translateTextNodes(
    root,
    dictionary,
    language
) {
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                const parent = node.parentElement;

                if (!parent) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (
                    parent.closest(
                        "script, style, pre, code, " +
                        "textarea, .nrp-language-switch"
                    )
                ) {
                    return NodeFilter.FILTER_REJECT;
                }

                return normalizeText(node.nodeValue)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        }
    );

    const nodes = [];

    while (walker.nextNode()) {
        nodes.push(walker.currentNode);
    }

    for (const node of nodes) {
        if (!originalText.has(node)) {
            originalText.set(
                node,
                node.nodeValue
            );
        }

        const original =
            originalText.get(node);

        if (language === "ja") {
            node.nodeValue = original;
            continue;
        }

        const normalized =
            normalizeText(original);

        const translated =
            takeTranslation(dictionary, normalized);

        if (typeof translated !== "string") {
            continue;
        }

        const leading =
            original.match(
                /^[\s\u3000]*/
            )?.[0] || "";

        const trailing =
            original.match(
                /[\s\u3000]*$/
            )?.[0] || "";

        node.nodeValue =
            leading + decodeHtmlEntities(translated) + trailing;
    }
}

function getLineTextNodes(root) {
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent || parent.closest(
                    "script, style, pre, code, textarea, .nrp-language-switch"
                )) {
                    return NodeFilter.FILTER_REJECT;
                }
                return normalizeText(node.nodeValue)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        }
    );
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
}

function findLineNodeMatch(nodes, startAt, line) {
    const parts = line.parts || [];
    if (parts.length === 0) return null;
    for (let start = startAt; start + parts.length <= nodes.length; start++) {
        let matches = true;
        for (let index = 0; index < parts.length; index++) {
            const node = nodes[start + index];
            const part = parts[index];
            if (normalizeText(decodeHtmlEntities(node.nodeValue)) !==
                normalizeText(decodeHtmlEntities(part.source))) {
                matches = false;
                break;
            }
            if (part.link && !node.parentElement?.closest("a")) {
                matches = false;
                break;
            }
        }
        if (matches) return { start, nodes: nodes.slice(start, start + parts.length) };
    }
    return null;
}

function makeLineFragment(line, matchedNodes) {
    const fragment = document.createDocumentFragment();
    const linkNodes = new Map();
    for (let index = 0; index < line.parts.length; index++) {
        const part = line.parts[index];
        if (part.linkIndex) {
            linkNodes.set(
                part.linkIndex,
                matchedNodes[index].parentElement.closest("a")
            );
        }
    }

    const marker = /\[\[LINK_(\d+)\]\]([\s\S]*?)\[\[\/LINK_\1\]\]/g;
    let cursor = 0;
    let match;
    while ((match = marker.exec(line.translation))) {
        fragment.append(
            document.createTextNode(
                decodeHtmlEntities(line.translation.slice(cursor, match.index))
            )
        );
        const originalLink = linkNodes.get(Number(match[1]));
        if (!originalLink) {
            throw new Error("リンク行の元リンクが見つかりません: " + line.id);
        }
        const link = originalLink.cloneNode(false);
        link.textContent = decodeHtmlEntities(match[2]);
        fragment.append(link);
        cursor = marker.lastIndex;
    }
    fragment.append(
        document.createTextNode(decodeHtmlEntities(line.translation.slice(cursor)))
    );
    return fragment;
}

function restoreLineTranslations(root) {
    const records = originalLineContent.get(root);
    if (!records) return;
    for (const record of records.values()) {
        if (!record.start.parentNode || !record.end.parentNode) continue;
        const range = document.createRange();
        range.setStartAfter(record.start);
        range.setEndBefore(record.end);
        range.deleteContents();
        range.insertNode(record.original.cloneNode(true));
        record.start.remove();
        record.end.remove();
    }
    records.clear();
}

function translateLinkedLines(root, translation, language) {
    if (language === "ja") {
        restoreLineTranslations(root);
        return;
    }
    const lines = translation.lines || [];
    if (lines.length === 0 || originalLineContent.get(root)?.size) return;

    const nodes = getLineTextNodes(root);
    const replacements = [];
    let cursor = 0;
    for (const line of lines) {
        const matched = findLineNodeMatch(nodes, cursor, line);
        if (!matched) continue;
        replacements.push({ line, ...matched });
        cursor = matched.start + matched.nodes.length;
    }

    const records = new Map();
    for (const replacement of replacements.reverse()) {
        const firstPart = replacement.line.parts[0];
        const lastPart = replacement.line.parts[
            replacement.line.parts.length - 1
        ];
        const firstNode = replacement.nodes[0];
        const lastNode = replacement.nodes[replacement.nodes.length - 1];
        const firstUnit = firstPart.link
            ? firstNode.parentElement.closest("a")
            : firstNode;
        const lastUnit = lastPart.link
            ? lastNode.parentElement.closest("a")
            : lastNode;
        const range = document.createRange();
        range.setStartBefore(firstUnit);
        range.setEndAfter(lastUnit);
        const original = range.cloneContents();
        range.deleteContents();

        const start = document.createComment("nrp-line-start:" + replacement.line.id);
        const end = document.createComment("nrp-line-end:" + replacement.line.id);
        const replacementFragment = document.createDocumentFragment();
        replacementFragment.append(start);
        replacementFragment.append(makeLineFragment(replacement.line, replacement.nodes));
        replacementFragment.append(end);
        range.insertNode(replacementFragment);
        records.set(replacement.line.id, { start, end, original });
    }
    if (records.size > 0) originalLineContent.set(root, records);
}

function isAfterOrInside(node, startElement) {
    if (!startElement) {
        return false;
    }

    if (
        node === startElement ||
        startElement.contains(node)
    ) {
        return true;
    }

    return Boolean(
        startElement.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_FOLLOWING
    );
}

function isBeforeOrInside(node, endElement) {
    if (!endElement) {
        return false;
    }

    if (
        node === endElement ||
        endElement.contains(node)
    ) {
        return true;
    }

    return Boolean(
        endElement.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_PRECEDING
    );
}

function isInsideArticleArea(node) {
    const parent = node.parentElement;

    if (!parent) {
        return false;
    }

    const articleId = getArticleId();

    if (!articleId) {
        return false;
    }

    if (
        !cachedTitleElement ||
        !document.contains(cachedTitleElement)
    ) {
        cachedTitleElement =
            findArticleTitle(articleId);
    }

    const switchElement =
        document.querySelector(
            ".nrp-language-switch"
        );

    // 記事タイトルから言語切替ボタンまでだけを除外する。
    // cachedBodyElementや広いCSSクラスは使用しない。
    return Boolean(
        cachedTitleElement &&
        switchElement &&
        isAfterOrInside(parent, cachedTitleElement) &&
        isBeforeOrInside(parent, switchElement)
    );
}

function translateCommonTextNodes(
    dictionary,
    language
) {
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                const parent = node.parentElement;

                if (!parent) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (
                    parent.closest(
                        "script, style, pre, code, textarea, " +
                        ".nrp-language-switch"
                    )
                ) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (isInsideArticleArea(node)) {
                    return NodeFilter.FILTER_REJECT;
                }

                const normalized =
                    normalizeText(node.nodeValue);

                if (!normalized) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (
                    language === "en" &&
                    typeof lookupTranslation(dictionary, normalized) !== "string"
                ) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const nodes = [];

    while (walker.nextNode()) {
        nodes.push(walker.currentNode);
    }

    for (const node of nodes) {
        if (!originalCommonText.has(node)) {
            originalCommonText.set(
                node,
                node.nodeValue
            );
        }

        const original =
            originalCommonText.get(node);

        if (language === "ja") {
            node.nodeValue = original;
            continue;
        }

        const normalized =
            normalizeText(original);

        const translated =
            lookupTranslation(dictionary, normalized);

        if (typeof translated !== "string") {
            continue;
        }

        const leading =
            original.match(
                /^[\s\u3000]*/
            )?.[0] || "";

        const trailing =
            original.match(
                /[\s\u3000]*$/
            )?.[0] || "";

        node.nodeValue =
            leading + decodeHtmlEntities(translated) + trailing;
    }
}

async function applyCommonLanguage(language) {
    if (language === "ja") {
        translateCommonTextNodes({}, "ja");
        return true;
    }

    let translation;

    try {
        translation =
            await loadCommonTranslation();
    } catch (error) {
        console.error(
            "[NRP Language] 共通翻訳の読み込みに失敗しました。",
            error
        );
        return false;
    }

    if (!translation) {
        return false;
    }

    translateCommonTextNodes(
        translation.texts,
        "en"
    );

    return true;
}

function updateButtons(language) {
    document
        .querySelectorAll(
            ".nrp-language-switch button, " +
            ".header-language-switch button"
        )
        .forEach(button => {
            const selected = button.dataset.language === language;

            button.disabled = selected;
            button.setAttribute(
            "aria-pressed",
            selected ? "true" : "false"
            );
        });
}

function getIndexArticles() {
  return [...document.querySelectorAll(".blogbody")]
    .map(blogBody => {
      const titleElement = blogBody.querySelector(
        "table.articletitle a[href*='/article/']"
      );

      const match = titleElement?.href.match(
        /\/article\/(\d+)\.html/
      );

      return {
        articleId: match ? match[1] : null,
        titleElement,
        bodyElement: blogBody.querySelector(".text")
      };
    })
    .filter(article =>
      article.articleId &&
      article.titleElement &&
      article.bodyElement
    );
}

async function applyIndexLanguage(language, options = {}) {
  const { progressive = false } = options;
  const articles = getIndexArticles();

  const applyArticle = async article => {
      if (language === "ja") {
        if (originalTitle.has(article.titleElement)) {
          article.titleElement.textContent =
            originalTitle.get(article.titleElement);
        }

        translateLinkedLines(article.bodyElement, null, "ja");
        translateTextNodes(article.bodyElement, {}, "ja");
        return true;
      }

      try {
        const translation = await loadTranslation(
          article.articleId
        );

        if (!translation) {
          return false;
        }

        if (!originalTitle.has(article.titleElement)) {
          originalTitle.set(
            article.titleElement,
            article.titleElement.textContent
          );
        }

        article.titleElement.textContent = translation.title;

        translateLinkedLines(article.bodyElement, translation, "en");
        translateTextNodes(
            article.bodyElement,
            createArticleDictionary(translation),
            "en"
        );

        return true;
      } catch (error) {
        console.warn(
          "[NRP Language] 記事翻訳の読み込みに失敗しました。",
          article.articleId,
          error
        );
        return false;
      }
  };

  if (language === "ja" || !progressive || articles.length < 2) {
    const results = await Promise.all(articles.map(applyArticle));
    return results.some(Boolean);
  }

  const [firstArticle, ...remainingArticles] = articles;
  const firstSucceeded = await applyArticle(firstArticle);

  // 初期表示では先頭記事だけを優先する。残りは表示後に置換する。
  void Promise.all(remainingArticles.map(applyArticle))
    .catch(error => {
      console.warn(
        "[NRP Language] 一覧記事の翻訳に失敗しました。",
        error
      );
    });

  return firstSucceeded;
}

async function applyLanguage(language, options = {}) {
    const { progressiveIndex = false } = options;
    const articleId = getArticleId();
    applyLanguageStyle(language);

    // 日本語の場合
    if (language === "ja") {
        if (articleId) {
            const { titleElement, bodyElement } =
                getArticleElements(articleId);

            if (
                titleElement &&
                originalTitle.has(titleElement)
            ) {
                titleElement.textContent =
                    originalTitle.get(titleElement);
            }

            if (bodyElement) {
                translateLinkedLines(bodyElement, null, "ja");
                translateTextNodes(
                    bodyElement,
                    {},
                    "ja"
                );
            }
        } else {
            await applyIndexLanguage("ja");
        }

        await applyCommonLanguage("ja");

        document.documentElement.lang = "ja";
        updateButtons("ja");
        return true;
    }

    //---------------------------------------------
    // 英訳する場合
    //---------------------------------------------
    // 共通部分は、記事翻訳の有無に関係なく先に適用する
    const commonPromise = applyCommonLanguage("en");

    let articleSucceeded = false;

    if (articleId) {
        let translation = null;

        try {
            translation =
                await loadTranslation(articleId);
        } catch (error) {
            console.error(
                "[NRP Language] 記事翻訳の読み込みに失敗しました。",
                error
            );
        }

        if (translation) {
            const {
                titleElement,
                bodyElement
            } = getArticleElements(
                articleId,
                translation
            );

            if (!bodyElement) {
                console.error(
                    "[NRP Language] 記事本文が見つかりません。"
                );
            } else {
                if (
                    titleElement &&
                    !originalTitle.has(titleElement)
                ) {
                    originalTitle.set(
                        titleElement,
                        titleElement.textContent
                    );
                }

                if (titleElement) {
                    titleElement.textContent =
                        translation.title;
                }

                translateLinkedLines(bodyElement, translation, "en");
                translateTextNodes(
                    bodyElement,
                    createArticleDictionary(translation),
                    "en"
                );

                articleSucceeded = true;
            }
        }
    } else {
        articleSucceeded = await applyIndexLanguage("en", {
            progressive: progressiveIndex
        });
    }

    const commonSucceeded = await commonPromise;

    document.documentElement.lang = "en";
    updateButtons("en");

    // 共通部分だけでも翻訳できれば英語切替成功とみなす
    return commonSucceeded || articleSucceeded;
}

async function setLanguage(language) {
    if (
        language !== "ja" &&
        language !== "en"
    ) {
        return;
    }

    if (isChangingLanguage) {
        return;
    }

    isChangingLanguage = true;

    try {
        const succeeded =
            await applyLanguage(language);

        if (succeeded) {
            localStorage.setItem(
                STORAGE_KEY,
                language
            );
        }
    } finally {
        isChangingLanguage = false;
    }
}

function getInitialLanguage() {
    const saved =
        localStorage.getItem(STORAGE_KEY);

    if (
        saved === "ja" ||
        saved === "en"
    ) {
        return saved;
    }

    const browserLanguages =
        navigator.languages ||
        [navigator.language || "en"];

    const isJapanese =
        browserLanguages.some(language =>
            String(language)
                .toLowerCase()
                .startsWith("ja")
        );

    // return isJapanese ? "ja" : "en";
    return "ja";
}

async function initialize() {
    let revealTimer = null;
    try {
        const language =
            getInitialLanguage();

        const shouldHideForEnglish = language === "en";
        if (shouldHideForEnglish) {
            setInitialEnglishLoading(true);
            revealTimer = window.setTimeout(() => {
                // 回線不調時に白画面のまま固定されることを防ぐ。
                setInitialEnglishLoading(false);
            }, INITIAL_REVEAL_TIMEOUT_MS);
        }

        const succeeded =
            await applyLanguage(language, {
                progressiveIndex: shouldHideForEnglish
            });

        if (
            !succeeded &&
            language === "en"
        ) {
            await applyLanguage("ja");
        }
    } catch (error) {
        console.error(
            "[NRP Language] 初期化に失敗しました。",
            error
        );
    } finally {
        if (revealTimer !== null) {
            window.clearTimeout(revealTimer);
        }

        // 共通部分と先頭記事のDOM更新をブラウザが描画できる状態で表示する。
        await waitForNextPaint();
        setInitialEnglishLoading(false);
    }
}

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initialize
    );
} else {
    initialize();
}

return {
    set: setLanguage,
    apply: applyLanguage
};

// <body class="lang-en">を設定
function applyLanguageStyle(language) {
    document.body.classList.toggle("lang-en", language === "en");
}
})();
