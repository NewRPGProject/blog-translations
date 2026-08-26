window.NRP_Language = (() => {
    "use strict";

    const STORAGE_KEY = "nrp-blog-language";
    const TRANSLATION_BASE_URL =
        "https://newrpgproject.github.io/blog-translations/articles/";

    const COMMON_TRANSLATION_URL =
        "https://newrpgproject.github.io/blog-translations/common/en.json";

    const originalText = new Map();
    const originalTitle = new Map();
    const originalCommonText = new Map();
    const translationCache = new Map();

    let commonTranslationCache = null;

    let cachedTitleElement = null;
    let cachedBodyElement = null;
    let isChangingLanguage = false;

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
            Object.keys(translation.texts)
                .map(normalizeText)
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
            );
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
                dictionary[normalized];

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
                leading + translated + trailing;
        }
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
                        typeof dictionary[normalized] !== "string"
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
                dictionary[normalized];

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
                leading + translated + trailing;
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
                ".nrp-language-switch button"
            )
            .forEach(button => {
                const isEnglish =
                    button.textContent.trim() ===
                    "English";

                const selected =
                    language === "en"
                        ? isEnglish
                        : !isEnglish;

                button.disabled = selected;
                button.setAttribute(
                    "aria-pressed",
                    selected ? "true" : "false"
                );
            });
    }

    async function applyLanguage(language) {
        const articleId = getArticleId();
        applyLanguageStyle(language);

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
                    translateTextNodes(
                        bodyElement,
                        {},
                        "ja"
                    );
                }
            }

            await applyCommonLanguage("ja");

            document.documentElement.lang = "ja";
            updateButtons("ja");
            return true;
        }

        // 共通部分は、記事翻訳の有無に関係なく先に適用する
        const commonSucceeded =
            await applyCommonLanguage("en");

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

                    translateTextNodes(
                        bodyElement,
                        translation.texts,
                        "en"
                    );

                    articleSucceeded = true;
                }
            }
        }

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
        try {
            const language =
                getInitialLanguage();

            const succeeded =
                await applyLanguage(language);

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
