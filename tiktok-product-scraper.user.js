// ==UserScript==
// @name         TikTok Seller Product Scraper
// @namespace    https://seller-us.tiktok.com/
// @version      1.0.0
// @description  Scrapes product data (keywords, highlights, shipping) from TikTok Seller product edit pages and saves to localStorage for export.
// @author       User
// @match        https://seller-us.tiktok.com/product/edit/*
// @match        https://seller-us.tiktok.com/product/manage*
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    const LS_PREFIX = "tts_prod_";
    const LS_QUEUE_PENDING = "tts_queue_pending";
    const LS_QUEUE_INFLIGHT = "tts_queue_inflight";
    const LS_QUEUE_TOTAL = "tts_queue_total";
    const LS_HL_MAP = "tts_hl_map";
    const LS_HL_PENDING = "tts_hl_queue_pending";
    const LS_HL_INFLIGHT = "tts_hl_queue_inflight";
    const LS_HL_TOTAL = "tts_hl_queue_total";
    const LS_HL_DONE_PREFIX = "tts_hl_done_";
    const POLL_INTERVAL_MS = 800;
    const POLL_TIMEOUT_MS = 30000; // total wait budget for the page + shipping fee

    // ─── Helpers ───────────────────────────────────────────────────────────────

    function getProductId() {
        const m = window.location.pathname.match(/\/product\/edit\/(\d+)/);
        return m ? m[1] : null;
    }

    function loadRows() {
        const rows = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(LS_PREFIX)) {
                try {
                    rows.push(JSON.parse(localStorage.getItem(key)));
                } catch {}
            }
        }
        rows.sort((a, b) =>
            (a.collectedAt || "").localeCompare(b.collectedAt || ""),
        );
        return rows;
    }

    // Each product gets its own key — no shared array, no write conflicts across tabs.
    function saveRow(row) {
        localStorage.setItem(LS_PREFIX + row.id, JSON.stringify(row));
        // Other tabs pick this up via the native 'storage' event automatically.
    }

    function alreadySaved(productId) {
        return localStorage.getItem(LS_PREFIX + productId) !== null;
    }

    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    function writeJson(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function openNextHighlightTab() {
        const pending = readJson(LS_HL_PENDING, []);
        const inflight = readJson(LS_HL_INFLIGHT, []);
        if (inflight.length > 0 || pending.length === 0) return;
        const id = pending.shift();
        writeJson(LS_HL_PENDING, pending);
        writeJson(LS_HL_INFLIGHT, [id]);
        GM_openInTab(`https://seller-us.tiktok.com/product/edit/${id}`, {
            active: true,
            insert: true,
        });
    }

    // Opens up to 5 product tabs from the pending queue, moving each ID to inflight.
    function openNextBatch() {
        let pending = JSON.parse(
            localStorage.getItem(LS_QUEUE_PENDING) || "[]",
        );
        let inflight = JSON.parse(
            localStorage.getItem(LS_QUEUE_INFLIGHT) || "[]",
        );
        while (inflight.length < 20 && pending.length > 0) {
            const id = pending.shift();
            inflight.push(id);
            GM_openInTab(`https://seller-us.tiktok.com/product/edit/${id}`, {
                active: false,
                insert: true,
            });
        }
        localStorage.setItem(LS_QUEUE_PENDING, JSON.stringify(pending));
        localStorage.setItem(LS_QUEUE_INFLIGHT, JSON.stringify(inflight));
    }

    // ─── Scraping ──────────────────────────────────────────────────────────────

    function scrapeKeywords() {
        // Find label that contains "Search keywords" text, then find input inside its form block
        const labels = Array.from(
            document.querySelectorAll(
                'label, [class*="formLabel"], span._title_80dgt_103',
            ),
        );
        for (const el of labels) {
            if (el.textContent.trim() === "Search keywords") {
                // Walk up to the form item wrapper and find the input
                let container = el;
                for (let i = 0; i < 6; i++) {
                    container = container.parentElement;
                    if (!container) break;
                    const inp = container.querySelector(
                        'input[data-tid="m4b_input"]',
                    );
                    if (inp) return inp.value.trim();
                }
            }
        }
        // Fallback: find by data-id attribute pattern
        const byDataId = document.querySelector(
            '[data-id*="keyword"] input, [data-id*="search_keyword"] input',
        );
        if (byDataId) return byDataId.value.trim();
        return "";
    }

    function scrapeHighlights() {
        const proseMirror = document.querySelector(
            "#key_product_features .ProseMirror",
        );
        if (!proseMirror) return "";
        const items = Array.from(proseMirror.querySelectorAll("li"));
        return items
            .map((li) => li.textContent.trim())
            .filter(Boolean)
            .join(" | ");
    }

    function scrapeShipping() {
        const shippingSection = document.getElementById(
            "add_product_shipping_title",
        );
        if (!shippingSection) return {};

        // Package weight value
        const weightInput = shippingSection.querySelector(
            'input[placeholder="Enter the package weight"]',
        );
        const weight = weightInput ? weightInput.value.trim() : "";

        // Weight unit: the select shows the selected unit text
        const weightUnitEl = shippingSection.querySelector(
            ".core-select-view-value",
        );
        const weightUnit = weightUnitEl ? weightUnitEl.textContent.trim() : "";

        // Package dimensions
        const heightInput = shippingSection.querySelector(
            'input[placeholder="Height"]',
        );
        const widthInput = shippingSection.querySelector(
            'input[placeholder="Width"]',
        );
        const lengthInput = shippingSection.querySelector(
            'input[placeholder="Length"]',
        );
        const height = heightInput ? heightInput.value.trim() : "";
        const width = widthInput ? widthInput.value.trim() : "";
        const length = lengthInput ? lengthInput.value.trim() : "";

        // Dimension unit (all share the same unit, grab the first suffix)
        const dimUnitEl = shippingSection.querySelector(
            ".core-input-number-suffix",
        );
        const dimUnit = dimUnitEl ? dimUnitEl.textContent.trim() : "";

        // Estimated shipping fee: text near "Estimated shipping fee"
        let shippingFee = "";
        const allParas = Array.from(shippingSection.querySelectorAll("p"));
        for (const p of allParas) {
            if (p.textContent.includes("Estimated shipping fee")) {
                const sibling = p.parentElement
                    ? p.parentElement.querySelector("span")
                    : null;
                if (sibling) shippingFee = sibling.textContent.trim();
                break;
            }
        }
        // Fallback: grep spans/divs for dollar sign near the label
        if (!shippingFee) {
            const feeContainer = Array.from(
                shippingSection.querySelectorAll("div.flex"),
            ).find((d) => d.textContent.includes("Estimated shipping fee"));
            if (feeContainer) {
                const spans = feeContainer.querySelectorAll("span");
                for (const s of spans) {
                    if (/^\$[\d.]+$/.test(s.textContent.trim())) {
                        shippingFee = s.textContent.trim();
                        break;
                    }
                }
            }
        }

        return {
            weight,
            weightUnit,
            height,
            width,
            length,
            dimUnit,
            shippingFee,
        };
    }

    function hasShippingSectionLoaded() {
        return !!document.getElementById("add_product_shipping_title");
    }

    // Returns true once the estimated shipping fee span is populated (e.g. "$4.84").
    function hasFeeLoaded() {
        const section = document.getElementById("add_product_shipping_title");
        if (!section) return false;
        const feeContainer = Array.from(
            section.querySelectorAll("div.flex"),
        ).find((d) => d.textContent.includes("Estimated shipping fee"));
        if (!feeContainer) return false;
        return Array.from(feeContainer.querySelectorAll("span")).some((s) =>
            /^\$[\d.]+$/.test(s.textContent.trim()),
        );
    }

    function findHighlightsEditor() {
        const direct = document.querySelector(
            "#key_product_features .ProseMirror[contenteditable='true']",
        );
        if (direct) return direct;
        const fallback = document.querySelector(
            "#key_product_features .ProseMirror",
        );
        if (fallback) return fallback;
        const labels = Array.from(
            document.querySelectorAll("label, span, p, div"),
        );
        for (const el of labels) {
            if ((el.textContent || "").trim() !== "Product highlights")
                continue;
            let parent = el;
            for (let i = 0; i < 8; i++) {
                parent = parent.parentElement;
                if (!parent) break;
                const editor = parent.querySelector(".ProseMirror");
                if (editor) return editor;
            }
        }
        return null;
    }

    function normalizeHighlights(lines) {
        const out = [];
        const seen = new Set();
        for (const line of lines) {
            let text = String(line || "").trim();
            // Google Sheets exports sometimes wrap full cell values in quotes.
            // Remove only the outer quotes to keep inner quotes intact.
            if (
                text.length >= 2 &&
                ((text.startsWith('"') && text.endsWith('"')) ||
                    (text.startsWith("'") && text.endsWith("'")))
            ) {
                text = text.slice(1, -1).trim();
            }
            if (!text || seen.has(text)) continue;
            seen.add(text);
            out.push(text);
        }
        return out;
    }

    function clearHighlightsEditor(editor) {
        editor.focus();
        try {
            document.execCommand("selectAll", false);
            document.execCommand("delete", false);
        } catch {}
        editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }

    function insertTextToEditor(editor, text) {
        editor.focus();
        let inserted = false;
        try {
            inserted = !!document.execCommand("insertText", false, text);
        } catch {
            inserted = false;
        }
        if (!inserted) {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) {
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                if (sel) {
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
            const activeSel = window.getSelection();
            if (activeSel && activeSel.rangeCount > 0) {
                const range = activeSel.getRangeAt(0);
                range.deleteContents();
                range.insertNode(document.createTextNode(text));
                range.collapse(false);
                activeSel.removeAllRanges();
                activeSel.addRange(range);
            } else {
                editor.textContent = (editor.textContent || "") + text;
            }
        }
        editor.dispatchEvent(
            new InputEvent("input", { bubbles: true, data: text }),
        );
    }

    function pressEnterInEditor(editor) {
        const keyOpts = {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
        };
        editor.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
        editor.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
        editor.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isElementVisible(el) {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden")
            return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function findVisibleCaptchaElement() {
        const hardSelectors = [
            'iframe[src*="captcha"]',
            'iframe[src*="recaptcha"]',
            'iframe[src*="hcaptcha"]',
            '[data-testid*="captcha"]',
            '[data-e2e*="captcha"]',
            '[class*="captcha-mask"]',
            '[class*="captcha"] iframe',
        ];
        for (const sel of hardSelectors) {
            const nodes = Array.from(document.querySelectorAll(sel));
            const visible = nodes.find((n) => isElementVisible(n));
            if (visible) return visible;
        }
        const softSelectors = Array.from(
            document.querySelectorAll(
                '[class*="captcha"], [id*="captcha"], [aria-label*="captcha" i]',
            ),
        );
        for (const el of softSelectors) {
            if (!isElementVisible(el)) continue;
            const txt = (el.textContent || "").toLowerCase();
            if (/(verify|puzzle|slide|security check|human)/.test(txt))
                return el;
        }
        return null;
    }

    function isCaptchaVisible() {
        return !!findVisibleCaptchaElement();
    }

    async function waitForCaptchaClear(panel) {
        let informed = false;
        while (isCaptchaVisible()) {
            if (!informed) {
                panel._setStatus(
                    "🛡 Captcha detected. Solve it to continue…",
                    "#fff3e0",
                    "#e65100",
                );
                informed = true;
            }
            await delay(700);
        }
    }

    function monitorCaptchaState(panel, onResume, onPause) {
        let paused = false;
        return setInterval(() => {
            const visible = isCaptchaVisible();
            if (visible && !paused) {
                paused = true;
                if (typeof onPause === "function") onPause();
                panel._setStatus(
                    "⏸ Captcha detected. Solve it; script will reset this product and continue.",
                    "#fff3e0",
                    "#e65100",
                );
                return;
            }
            if (!visible && paused) {
                paused = false;
                if (typeof onResume === "function") onResume();
            }
        }, 500);
    }

    function escapeHtml(str) {
        const t = document.createElement("div");
        t.textContent = str;
        return t.innerHTML;
    }

    async function fillHighlights(editor, lines, mode) {
        editor.focus();
        await delay(100);

        if (mode === "replace") {
            const validLines = lines.filter((l) => l.trim());
            editor.innerHTML =
                "<ul>" +
                validLines
                    .map((l) => "<li>" + escapeHtml(l) + "</li>")
                    .join("") +
                "</ul>";
        } else {
            // append mode
            let ul = editor.querySelector("ul");
            if (!ul) {
                editor.innerHTML = "<ul></ul>";
                ul = editor.querySelector("ul");
            }
            const existing = new Set(
                Array.from(ul.querySelectorAll("li")).map((li) =>
                    li.textContent.trim(),
                ),
            );
            for (const line of lines) {
                if (!line.trim()) continue;
                if (existing.has(line.trim())) continue;
                const li = document.createElement("li");
                li.textContent = line;
                ul.appendChild(li);
            }
        }

        editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        await delay(300);
    }

    function isLikelySubmitButton(el) {
        if (!(el instanceof HTMLElement)) return false;
        const button = el.closest("button");
        if (!button) return false;
        const txt = (button.textContent || "").trim().toLowerCase();
        return ["submit", "save", "publish", "update"].some((k) =>
            txt.includes(k),
        );
    }

    function observeSubmitSuccess(onSuccess) {
        let done = false;
        const maybeSuccess = () => {
            if (done) return;
            const texts = Array.from(
                document.querySelectorAll(
                    '[role="alert"], .auxo-notification, .toast, .message, [class*="toast"], [class*="message"]',
                ),
            )
                .map((n) => (n.textContent || "").trim())
                .join(" ")
                .toLowerCase();
            if (
                /\b(success|saved|updated|submitted|published)\b/.test(texts) &&
                !/\b(fail|failed|error)\b/.test(texts)
            ) {
                done = true;
                observer.disconnect();
                onSuccess();
            }
        };
        const observer = new MutationObserver(() => maybeSuccess());
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        const stopTimer = setTimeout(() => observer.disconnect(), 90000);
        return () => {
            clearTimeout(stopTimer);
            observer.disconnect();
        };
    }

    function runHighlightsFlow(productId, panel) {
        const hlMap = readJson(LS_HL_MAP, {});
        const rawLines = Array.isArray(hlMap[productId])
            ? hlMap[productId]
            : [];
        const lines = normalizeHighlights(rawLines);
        if (lines.length === 0) {
            panel._setStatus(
                "ℹ No highlights mapped for this product.",
                "#f5f5f5",
                "#555",
            );
            return false;
        }
        let filled = false;
        let stopObservingSubmit = null;
        let selectedMode = null;
        let isCaptchaPaused = false;
        let modePromptShown = false;
        let submitClickedAt = 0;
        let doneMarked = false;
        let manualRestartRequestedAt = 0;

        function markCurrentProductDone(reason) {
            if (doneMarked) return;
            doneMarked = true;
            localStorage.setItem(
                LS_HL_DONE_PREFIX + productId,
                String(Date.now()),
            );
            if (reason === "submit-success") {
                panel._setStatus(
                    "✅ Submit success detected. You can close this tab.",
                    "#e8f5e9",
                    "#2e7d32",
                );
            } else if (reason === "submit-close-fallback") {
                panel._setStatus(
                    "✅ Marked done on tab close after submit.",
                    "#e8f5e9",
                    "#2e7d32",
                );
            }
        }

        function resetCurrentProductState(reasonText) {
            filled = false;
            selectedMode = null;
            modePromptShown = false;
            submitClickedAt = 0;
            doneMarked = false;
            manualRestartRequestedAt = Date.now();
            const existingModeUi = document.getElementById("tts-hl-mode-wrap");
            if (existingModeUi) existingModeUi.remove();
            panel._setStatus(
                reasonText ||
                    "🔄 Restarted. Waiting for Product Highlights input…",
                "#e3f2fd",
                "#0d47a1",
            );
        }

        function editorHasExistingHighlights(editor) {
            const items = Array.from(editor.querySelectorAll("li"))
                .map((li) => (li.textContent || "").trim())
                .filter(Boolean);
            if (items.length > 0) return true;
            const rawText = (editor.textContent || "")
                .replace(/\u200B/g, "")
                .trim();
            return rawText.length > 0;
        }

        function showModeButtons(onChoose) {
            const body = document.getElementById("tts-scraper-body");
            if (!body) {
                onChoose("replace");
                return;
            }
            const existingWrap = body.querySelector("#tts-hl-mode-wrap");
            if (existingWrap) existingWrap.remove();
            const row = document.createElement("div");
            row.id = "tts-hl-mode-row";
            row.style.cssText = "display:flex;gap:6px;";
            const label = document.createElement("div");
            label.textContent = "Existing highlights detected:";
            label.style.cssText = "font-size:11px;color:#444;";
            const wrap = document.createElement("div");
            wrap.id = "tts-hl-mode-wrap";
            wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";

            function makeActionBtn(text, bg, mode) {
                const btn = document.createElement("button");
                btn.textContent = text;
                btn.style.cssText = `flex:1;padding:6px 0;background:${bg};color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:600;font-size:12px;`;
                btn.addEventListener("click", () => {
                    row.remove();
                    onChoose(mode);
                });
                return btn;
            }

            row.appendChild(makeActionBtn("Replace", "#00897b", "replace"));
            row.appendChild(makeActionBtn("Append", "#6d4c41", "append"));
            wrap.appendChild(label);
            wrap.appendChild(row);
            body.appendChild(wrap);
        }

        const tryFill = async () => {
            if (filled || !selectedMode || isCaptchaPaused) return;
            await waitForCaptchaClear(panel);
            const editor = findHighlightsEditor();
            if (!editor) {
                panel._setStatus(
                    "⏳ Waiting for Product Highlights input…",
                    "#fff9c4",
                    "#f57f17",
                );
                return;
            }
            editor.scrollIntoView({ behavior: "smooth", block: "center" });
            filled = true;
            panel._setStatus("✍ Filling highlights…", "#fff9c4", "#f57f17");
            await fillHighlights(editor, lines, selectedMode);
            panel._setStatus("✅ Filled. Click Submit.", "#e8f5e9", "#2e7d32");
            stopObservingSubmit = observeSubmitSuccess(() => {
                markCurrentProductDone("submit-success");
            });
        };

        const waitEditorTimer = setInterval(() => {
            if (filled || selectedMode || isCaptchaPaused) return;
            if (Date.now() - manualRestartRequestedAt < 300) return;
            const editor = findHighlightsEditor();
            if (!editor) {
                panel._setStatus(
                    "⏳ Waiting for Product Highlights input…",
                    "#fff9c4",
                    "#f57f17",
                );
                return;
            }
            editor.scrollIntoView({ behavior: "smooth", block: "center" });
            if (editorHasExistingHighlights(editor)) {
                if (modePromptShown) return;
                modePromptShown = true;
                panel._setStatus(
                    "⚙ Existing highlights found. Choose Replace or Append.",
                    "#e3f2fd",
                    "#0d47a1",
                );
                showModeButtons((mode) => {
                    selectedMode = mode;
                    tryFill();
                });
                return;
            }
            selectedMode = "append";
            tryFill();
        }, 300);

        // Always-available manual restart + mark-done actions per product edit tab.
        (function addRestartButton() {
            const body = document.getElementById("tts-scraper-body");
            if (!body || body.querySelector("#tts-hl-restart-btn")) return;

            const doneBtn = document.createElement("button");
            doneBtn.id = "tts-hl-done-btn";
            doneBtn.textContent = "✔ Mark as Done & Next";
            doneBtn.style.cssText =
                "width:100%;padding:7px 0;border:none;border-radius:6px;background:#2e7d32;color:#fff;cursor:pointer;font-weight:600;font-size:12px;";
            doneBtn.addEventListener("click", () => {
                markCurrentProductDone("manual-done");
                panel._setStatus(
                    "✅ Marked done. Closing tab…",
                    "#e8f5e9",
                    "#2e7d32",
                );
                setTimeout(() => window.close(), 800);
            });
            body.appendChild(doneBtn);

            const restartBtn = document.createElement("button");
            restartBtn.id = "tts-hl-restart-btn";
            restartBtn.textContent = "↻ Restart Current Product";
            restartBtn.style.cssText =
                "width:100%;padding:7px 0;border:none;border-radius:6px;background:#546e7a;color:#fff;cursor:pointer;font-weight:600;font-size:12px;";
            restartBtn.addEventListener("click", () => {
                resetCurrentProductState(
                    "🔄 Manual restart requested. Waiting for Product Highlights input…",
                );
            });
            body.appendChild(restartBtn);
        })();

        document.addEventListener(
            "click",
            (e) => {
                if (!filled) return;
                if (!isLikelySubmitButton(e.target)) return;
                submitClickedAt = Date.now();
                panel._setStatus(
                    "⏳ Waiting for submit success…",
                    "#fff9c4",
                    "#f57f17",
                );
            },
            true,
        );

        const captchaWatch = monitorCaptchaState(
            panel,
            () => {
                isCaptchaPaused = false;
                resetCurrentProductState(
                    "🔄 Captcha solved. Restarting this product highlights process…",
                );
            },
            () => {
                isCaptchaPaused = true;
            },
        );

        window.addEventListener("beforeunload", () => {
            // Fallback: if user clicked Submit then closes before toast is observed,
            // treat as done so the queue can continue.
            if (!doneMarked && filled && submitClickedAt > 0) {
                markCurrentProductDone("submit-close-fallback");
            }
            if (typeof stopObservingSubmit === "function")
                stopObservingSubmit();
            clearInterval(waitEditorTimer);
            clearInterval(captchaWatch);
        });
        return true;
    }

    function scrapeAndSave(productId) {
        const keywords = scrapeKeywords();
        const highlights = scrapeHighlights();
        const shipping = scrapeShipping();

        const row = {
            id: productId,
            url: `https://seller-us.tiktok.com/product/edit/${productId}`,
            keywords: keywords || "[empty]",
            highlights: highlights || "[empty]",
            weight: shipping.weight || "",
            weightUnit: shipping.weightUnit || "",
            height: shipping.height || "",
            width: shipping.width || "",
            length: shipping.length || "",
            dimUnit: shipping.dimUnit || "",
            shippingFee: shipping.shippingFee || "",
            collectedAt: new Date().toISOString(),
        };

        saveRow(row);
        return row;
    }

    // ─── Export helpers ────────────────────────────────────────────────────────

    const COLUMNS = [
        { key: "id", header: "Product ID" },
        { key: "url", header: "URL" },
        { key: "keywords", header: "Search Keywords" },
        { key: "highlights", header: "Product Highlights" },
        { key: "weight", header: "Weight" },
        { key: "weightUnit", header: "Weight Unit" },
        { key: "height", header: "Height" },
        { key: "width", header: "Width" },
        { key: "length", header: "Length" },
        { key: "dimUnit", header: "Dim Unit" },
        { key: "shippingFee", header: "Est. Shipping Fee" },
        { key: "collectedAt", header: "Collected At" },
        { key: "error", header: "Error" },
    ];

    function rowsToTSV(rows) {
        const header = COLUMNS.map((c) => c.header).join("\t");
        const lines = rows.map((r) =>
            COLUMNS.map((c) => (r[c.key] || "").replace(/\t/g, " ")).join("\t"),
        );
        return [header, ...lines].join("\n");
    }

    function csvQuote(val) {
        const s = String(val || "");
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    }

    function rowsToCSV(rows) {
        const header = COLUMNS.map((c) => csvQuote(c.header)).join(",");
        const lines = rows.map((r) =>
            COLUMNS.map((c) => csvQuote(r[c.key] || "")).join(","),
        );
        return [header, ...lines].join("\n");
    }

    function downloadCSV(rows) {
        const csv = rowsToCSV(rows);
        const blob = new Blob(["\uFEFF" + csv], {
            type: "text/csv;charset=utf-8;",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `tiktok-products-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function copyTSV(rows, btn) {
        const tsv = rowsToTSV(rows);
        navigator.clipboard
            .writeText(tsv)
            .then(() => {
                const orig = btn.textContent;
                btn.textContent = "✓ Copied!";
                setTimeout(() => {
                    btn.textContent = orig;
                }, 2000);
            })
            .catch(() => {
                // Fallback for older browsers
                const ta = document.createElement("textarea");
                ta.value = tsv;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
                const orig = btn.textContent;
                btn.textContent = "✓ Copied!";
                setTimeout(() => {
                    btn.textContent = orig;
                }, 2000);
            });
    }

    // ─── UI ────────────────────────────────────────────────────────────────────

    function buildPanel(productId) {
        const panel = document.createElement("div");
        panel.id = "tts-scraper-panel";
        Object.assign(panel.style, {
            position: "fixed",
            top: "60px",
            right: "16px",
            zIndex: "2147483647",
            width: "280px",
            background: "#fff",
            border: "1.5px solid #e0e0e0",
            borderRadius: "10px",
            boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
            fontFamily: "system-ui, sans-serif",
            fontSize: "13px",
            color: "#222",
            userSelect: "none",
            overflow: "hidden",
        });

        // Header (draggable)
        const header = document.createElement("div");
        header.id = "tts-scraper-header";
        Object.assign(header.style, {
            background: "#161823",
            color: "#fff",
            padding: "10px 14px",
            cursor: "move",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderRadius: "8px 8px 0 0",
        });

        const title = document.createElement("span");
        title.id = "tts-scraper-title";
        title.textContent = "TikTok Scraper";
        title.style.fontWeight = "600";

        const toggleBtn = document.createElement("button");
        toggleBtn.textContent = "▾";
        Object.assign(toggleBtn.style, {
            background: "none",
            border: "none",
            color: "#fff",
            cursor: "pointer",
            fontSize: "14px",
            padding: "0",
            lineHeight: "1",
        });

        header.appendChild(title);
        header.appendChild(toggleBtn);
        panel.appendChild(header);

        // Body
        const body = document.createElement("div");
        body.id = "tts-scraper-body";
        Object.assign(body.style, {
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
        });

        // Status row
        const statusEl = document.createElement("div");
        statusEl.id = "tts-scraper-status";
        Object.assign(statusEl.style, {
            padding: "6px 10px",
            borderRadius: "6px",
            background: "#f5f5f5",
            fontSize: "12px",
        });
        statusEl.textContent = "Waiting for page to load…";

        // Count row
        const countEl = document.createElement("div");
        countEl.id = "tts-scraper-count";
        countEl.style.fontSize = "12px";
        countEl.style.color = "#666";

        function refreshCount() {
            const rows = loadRows();
            countEl.textContent = `${rows.length} product${rows.length !== 1 ? "s" : ""} collected`;
        }
        refreshCount();

        // Buttons
        function makeBtn(label, color, onClick) {
            const btn = document.createElement("button");
            btn.textContent = label;
            Object.assign(btn.style, {
                width: "100%",
                padding: "7px 0",
                border: "none",
                borderRadius: "6px",
                background: color,
                color: "#fff",
                cursor: "pointer",
                fontWeight: "600",
                fontSize: "12px",
            });
            btn.addEventListener("mouseover", () => {
                btn.style.opacity = "0.85";
            });
            btn.addEventListener("mouseout", () => {
                btn.style.opacity = "1";
            });
            btn.addEventListener("click", onClick);
            return btn;
        }

        const copyBtn = makeBtn("📋 Copy as TSV (GSheets)", "#4caf50", () => {
            copyTSV(loadRows(), copyBtn);
        });

        const dlBtn = makeBtn("⬇ Download CSV (Excel)", "#1976d2", () => {
            const rows = loadRows();
            if (rows.length === 0) {
                alert("No data collected yet.");
                return;
            }
            downloadCSV(rows);
        });

        const clearBtn = makeBtn("🗑 Clear All Data", "#e53935", () => {
            if (
                confirm(
                    `Delete all ${loadRows().length} collected rows? This cannot be undone.`,
                )
            ) {
                const keysToRemove = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith(LS_PREFIX)) keysToRemove.push(k);
                }
                keysToRemove.forEach((k) => localStorage.removeItem(k));
                refreshCount();
                setStatus("🗑 Data cleared.", "#fff3e0", "#e65100");
            }
        });

        body.appendChild(statusEl);
        body.appendChild(countEl);
        body.appendChild(copyBtn);
        body.appendChild(dlBtn);
        body.appendChild(clearBtn);
        panel.appendChild(body);

        document.body.appendChild(panel);

        // ── Collapse toggle ──
        let collapsed = false;
        toggleBtn.addEventListener("click", () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? "none" : "flex";
            toggleBtn.textContent = collapsed ? "▸" : "▾";
        });

        // ── Drag logic ──
        let dragging = false,
            dragOffX = 0,
            dragOffY = 0;
        header.addEventListener("mousedown", (e) => {
            if (e.target === toggleBtn) return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffX = e.clientX - rect.left;
            dragOffY = e.clientY - rect.top;
            document.body.style.userSelect = "none";
        });
        document.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            panel.style.right = "auto";
            panel.style.left = e.clientX - dragOffX + "px";
            panel.style.top = e.clientY - dragOffY + "px";
        });
        document.addEventListener("mouseup", () => {
            dragging = false;
            document.body.style.userSelect = "";
        });

        // ── Cross-tab storage updates ──
        window.addEventListener("storage", (e) => {
            if (!e.key || e.key.startsWith(LS_PREFIX)) refreshCount();
        });

        // ── Status helper exposed on panel ──
        function setStatus(text, bg, fg) {
            statusEl.textContent = text;
            statusEl.style.background = bg || "#f5f5f5";
            statusEl.style.color = fg || "#222";
        }

        panel._setStatus = setStatus;
        panel._refreshCount = refreshCount;
        return panel;
    }

    // ─── Main ──────────────────────────────────────────────────────────────────

    function isManagePage() {
        return window.location.pathname.startsWith("/product/manage");
    }

    function mainManage() {
        const panel = buildPanel(null);
        const rows = loadRows();
        if (rows.length > 0) {
            panel._setStatus(
                `📊 ${rows.length} product${rows.length !== 1 ? "s" : ""} ready to export`,
                "#e3f2fd",
                "#0d47a1",
            );
        } else {
            panel._setStatus(
                "📭 No data yet – open product tabs to collect",
                "#f5f5f5",
                "#555",
            );
        }

        // ── Queue section ──────────────────────────────────────────────────
        const body = document.getElementById("tts-scraper-body");

        const divider = document.createElement("hr");
        divider.style.cssText =
            "border:none;border-top:1px solid #eee;margin:2px 0;";
        body.appendChild(divider);

        const qToggleRow = document.createElement("div");
        Object.assign(qToggleRow.style, {
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: "600",
            color: "#444",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
        });
        qToggleRow.innerHTML =
            '<span>⚡ Tab Queue</span><span id="tts-qtoggle-icon">▸</span>';
        body.appendChild(qToggleRow);

        const qBody = document.createElement("div");
        Object.assign(qBody.style, {
            display: "none",
            flexDirection: "column",
            gap: "6px",
        });
        body.appendChild(qBody);

        const ta = document.createElement("textarea");
        ta.placeholder = "Paste product IDs or URLs\n(one per line)";
        Object.assign(ta.style, {
            width: "100%",
            height: "80px",
            fontSize: "11px",
            border: "1px solid #ddd",
            borderRadius: "4px",
            padding: "6px",
            boxSizing: "border-box",
            resize: "vertical",
        });
        qBody.appendChild(ta);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:6px;";

        function makeQBtn(label, bg, onClick) {
            const b = document.createElement("button");
            b.textContent = label;
            Object.assign(b.style, {
                flex: "1",
                padding: "6px 0",
                background: bg,
                color: "#fff",
                border: "none",
                borderRadius: "5px",
                cursor: "pointer",
                fontWeight: "600",
                fontSize: "12px",
            });
            b.addEventListener("mouseover", () => {
                b.style.opacity = "0.85";
            });
            b.addEventListener("mouseout", () => {
                b.style.opacity = "1";
            });
            b.addEventListener("click", onClick);
            return b;
        }

        const qStatus = document.createElement("div");
        Object.assign(qStatus.style, {
            fontSize: "11px",
            color: "#555",
            minHeight: "16px",
        });

        function parseIds(text) {
            return text
                .split("\n")
                .map((line) => {
                    line = line.trim();
                    const m = line.match(/\/product\/edit\/(\d+)/);
                    if (m) return m[1];
                    if (/^\d+$/.test(line)) return line;
                    return null;
                })
                .filter(Boolean);
        }

        function updateQueueStatus() {
            const pending = JSON.parse(
                localStorage.getItem(LS_QUEUE_PENDING) || "[]",
            );
            const inflight = JSON.parse(
                localStorage.getItem(LS_QUEUE_INFLIGHT) || "[]",
            );
            const total = parseInt(
                localStorage.getItem(LS_QUEUE_TOTAL) || "0",
                10,
            );
            if (total === 0) {
                qStatus.textContent = "";
                return;
            }
            const done = total - pending.length - inflight.length;
            if (done >= total) {
                qStatus.style.color = "#2e7d32";
                qStatus.textContent = `✓ All ${total} products collected!`;
            } else {
                qStatus.style.color = "#555";
                qStatus.textContent = `${done}/${total} done · ${inflight.length} open · ${pending.length} queued`;
            }
        }

        const startBtn = makeQBtn("▶ Start", "#7b1fa2", () => {
            const ids = parseIds(ta.value);
            if (ids.length === 0) {
                alert("No valid product IDs or URLs found.");
                return;
            }
            localStorage.setItem(LS_QUEUE_PENDING, JSON.stringify(ids));
            localStorage.setItem(LS_QUEUE_INFLIGHT, JSON.stringify([]));
            localStorage.setItem(LS_QUEUE_TOTAL, String(ids.length));
            openNextBatch();
            updateQueueStatus();
        });

        const stopBtn = makeQBtn("■ Stop", "#e53935", () => {
            localStorage.setItem(LS_QUEUE_PENDING, JSON.stringify([]));
            localStorage.setItem(LS_QUEUE_INFLIGHT, JSON.stringify([]));
            qStatus.style.color = "#e65100";
            qStatus.textContent = "⏹ Queue stopped.";
        });

        btnRow.appendChild(startBtn);
        btnRow.appendChild(stopBtn);
        qBody.appendChild(btnRow);
        qBody.appendChild(qStatus);

        let qExpanded = false;
        function setQExpanded(val) {
            qExpanded = val;
            qBody.style.display = qExpanded ? "flex" : "none";
            document.getElementById("tts-qtoggle-icon").textContent = qExpanded
                ? "▾"
                : "▸";
        }
        qToggleRow.addEventListener("click", () => {
            setQExpanded(!qExpanded);
            if (qExpanded) updateQueueStatus();
        });

        // Advance scrape queue when a product tab saves its row
        window.addEventListener("storage", (e) => {
            if (e.key && e.key.startsWith(LS_PREFIX)) {
                const savedId = e.key.slice(LS_PREFIX.length);
                let inflight = JSON.parse(
                    localStorage.getItem(LS_QUEUE_INFLIGHT) || "[]",
                );
                if (inflight.includes(savedId)) {
                    inflight = inflight.filter((id) => id !== savedId);
                    localStorage.setItem(
                        LS_QUEUE_INFLIGHT,
                        JSON.stringify(inflight),
                    );
                    openNextBatch();
                    updateQueueStatus();
                    panel._refreshCount();
                }
            }
            if (e.key && e.key.startsWith(LS_HL_DONE_PREFIX)) {
                const doneId = e.key.slice(LS_HL_DONE_PREFIX.length);
                let inflight = readJson(LS_HL_INFLIGHT, []);
                if (inflight.includes(doneId)) {
                    inflight = inflight.filter((id) => id !== doneId);
                    writeJson(LS_HL_INFLIGHT, inflight);
                    openNextHighlightTab();
                    updateHighlightsQueueStatus();
                }
            }
        });

        // Restore queue state if one was in progress when the page was (re)loaded
        const resumePending = JSON.parse(
            localStorage.getItem(LS_QUEUE_PENDING) || "[]",
        );
        const resumeInflight = JSON.parse(
            localStorage.getItem(LS_QUEUE_INFLIGHT) || "[]",
        );
        if (resumePending.length > 0 || resumeInflight.length > 0) {
            setQExpanded(true);
            updateQueueStatus();
        }

        // ── Highlights queue section ───────────────────────────────────────
        const hlDivider = document.createElement("hr");
        hlDivider.style.cssText =
            "border:none;border-top:1px solid #eee;margin:2px 0;";
        body.appendChild(hlDivider);

        const hlToggleRow = document.createElement("div");
        Object.assign(hlToggleRow.style, {
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: "600",
            color: "#444",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
        });
        hlToggleRow.innerHTML =
            '<span>✍ Bulk Fill Highlights</span><span id="tts-hltoggle-icon">▸</span>';
        body.appendChild(hlToggleRow);

        const hlBody = document.createElement("div");
        Object.assign(hlBody.style, {
            display: "none",
            flexDirection: "column",
            gap: "6px",
        });
        body.appendChild(hlBody);

        const hlTa = document.createElement("textarea");
        hlTa.placeholder =
            "Paste TSV rows: productId<TAB>highlight\nExample:\n123456789\tFast shipping";
        Object.assign(hlTa.style, {
            width: "100%",
            height: "96px",
            fontSize: "11px",
            border: "1px solid #ddd",
            borderRadius: "4px",
            padding: "6px",
            boxSizing: "border-box",
            resize: "vertical",
        });
        hlBody.appendChild(hlTa);

        const hlBtnRow = document.createElement("div");
        hlBtnRow.style.cssText = "display:flex;gap:6px;";
        const hlStatus = document.createElement("div");
        hlStatus.style.cssText = "font-size:11px;color:#555;min-height:16px;";

        function parseHighlightsTsv(text) {
            const map = {};
            const order = [];
            const rawLines = text.split(/\r?\n/);
            let i = 0;
            while (i < rawLines.length) {
                const line = rawLines[i].trim();
                i++;
                if (!line) continue;
                const tabIdx = line.indexOf("\t");
                if (tabIdx === -1) continue;
                const id = line.slice(0, tabIdx).trim();
                if (!/^\d+$/.test(id)) continue;
                let valueStr = line.slice(tabIdx + 1);
                // Handle CSV-style quoted multi-line blocks: "line1\nline2\n...lineN"
                if (valueStr.startsWith('"')) {
                    // Collect continuation lines until the block's closing quote is found
                    while (!valueStr.endsWith('"') && i < rawLines.length) {
                        valueStr += "\n" + rawLines[i];
                        i++;
                    }
                    // Strip the outer quotes
                    valueStr = valueStr.slice(1);
                    if (valueStr.endsWith('"'))
                        valueStr = valueStr.slice(0, -1);
                    // Each newline-separated segment is an individual highlight
                    const segments = valueStr
                        .split(/\r?\n/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                    if (!map[id]) {
                        map[id] = [];
                        order.push(id);
                    }
                    map[id].push(...segments);
                    continue;
                }
                const highlight = valueStr.trim();
                if (!highlight) continue;
                if (!map[id]) {
                    map[id] = [];
                    order.push(id);
                }
                map[id].push(highlight);
            }
            Object.keys(map).forEach((id) => {
                map[id] = normalizeHighlights(map[id]);
                if (map[id].length === 0) delete map[id];
            });
            return {
                map,
                queue: order.filter(
                    (id) => Array.isArray(map[id]) && map[id].length > 0,
                ),
            };
        }

        function updateHighlightsQueueStatus() {
            const pending = readJson(LS_HL_PENDING, []);
            const inflight = readJson(LS_HL_INFLIGHT, []);
            const total = parseInt(
                localStorage.getItem(LS_HL_TOTAL) || "0",
                10,
            );
            if (total === 0) {
                hlStatus.textContent = "";
                return;
            }
            const done = total - pending.length - inflight.length;
            if (done >= total) {
                hlStatus.style.color = "#2e7d32";
                hlStatus.textContent = `✓ Highlights done for ${total} products`;
            } else {
                hlStatus.style.color = "#555";
                hlStatus.textContent = `${done}/${total} done · ${inflight.length} open · ${pending.length} queued`;
            }
        }

        const hlStartBtn = makeQBtn("▶ Start HL", "#00897b", () => {
            const parsed = parseHighlightsTsv(hlTa.value);
            if (parsed.queue.length === 0) {
                alert("No valid TSV rows found. Use: productId<TAB>highlight");
                return;
            }
            writeJson(LS_HL_MAP, parsed.map);
            writeJson(LS_HL_PENDING, parsed.queue);
            writeJson(LS_HL_INFLIGHT, []);
            localStorage.setItem(LS_HL_TOTAL, String(parsed.queue.length));
            parsed.queue.forEach((id) =>
                localStorage.removeItem(LS_HL_DONE_PREFIX + id),
            );
            openNextHighlightTab();
            updateHighlightsQueueStatus();
        });

        const hlStopBtn = makeQBtn("■ Stop HL", "#ef6c00", () => {
            writeJson(LS_HL_PENDING, []);
            writeJson(LS_HL_INFLIGHT, []);
            localStorage.setItem(LS_HL_TOTAL, "0");
            hlStatus.style.color = "#e65100";
            hlStatus.textContent = "⏹ Highlights queue stopped.";
        });

        hlBtnRow.appendChild(hlStartBtn);
        hlBtnRow.appendChild(hlStopBtn);
        hlBody.appendChild(hlBtnRow);
        hlBody.appendChild(hlStatus);

        let hlExpanded = false;
        function setHlExpanded(val) {
            hlExpanded = val;
            hlBody.style.display = hlExpanded ? "flex" : "none";
            document.getElementById("tts-hltoggle-icon").textContent =
                hlExpanded ? "▾" : "▸";
        }
        hlToggleRow.addEventListener("click", () => {
            setHlExpanded(!hlExpanded);
            if (hlExpanded) updateHighlightsQueueStatus();
        });

        const resumeHlPending = readJson(LS_HL_PENDING, []);
        const resumeHlInflight = readJson(LS_HL_INFLIGHT, []);
        if (resumeHlPending.length > 0 || resumeHlInflight.length > 0) {
            setHlExpanded(true);
            updateHighlightsQueueStatus();
        }
    }

    function mainEdit() {
        const productId = getProductId();
        if (!productId) return;

        const panel = buildPanel(productId);
        const hlMap = readJson(LS_HL_MAP, {});
        const hasHighlightsTask =
            hlMap &&
            typeof hlMap === "object" &&
            Array.isArray(hlMap[productId]) &&
            hlMap[productId].length > 0;
        if (hasHighlightsTask) {
            runHighlightsFlow(productId, panel);
            return;
        }
        const isOverwrite = alreadySaved(productId);

        panel._setStatus(
            isOverwrite
                ? "🔄 Re-scraping (overwrite)…"
                : "⏳ Waiting for page to load…",
            "#fff9c4",
            "#f57f17",
        );

        let elapsed = 0;
        let shippingFoundAt = null;
        let captchaPaused = false;

        const captchaWatch = monitorCaptchaState(
            panel,
            () => {
                captchaPaused = false;
                elapsed = 0;
                shippingFoundAt = null;
                panel._setStatus(
                    "🔄 Captcha solved. Restarting this product…",
                    "#e3f2fd",
                    "#0d47a1",
                );
            },
            () => {
                captchaPaused = true;
            },
        );

        const timer = setInterval(() => {
            if (captchaPaused) return;
            elapsed += POLL_INTERVAL_MS;

            const shippingReady = hasShippingSectionLoaded();

            // Record the moment the shipping section first appears
            if (shippingReady && !shippingFoundAt) {
                shippingFoundAt = Date.now();
                panel._setStatus(
                    "⏳ Waiting for shipping fee…",
                    "#fff9c4",
                    "#f57f17",
                );
            }

            const feeReady = shippingReady && hasFeeLoaded();

            if (feeReady) {
                clearInterval(timer);
                clearInterval(captchaWatch);

                // Short delay so React finishes populating all input values
                setTimeout(() => {
                    try {
                        scrapeAndSave(productId);
                        panel._setStatus(
                            "✓ Collected! Closing tab…",
                            "#e8f5e9",
                            "#2e7d32",
                        );
                        panel._refreshCount();
                        setTimeout(() => window.close(), 1200);
                    } catch (err) {
                        saveRow({
                            id: productId,
                            url: `https://seller-us.tiktok.com/product/edit/${productId}`,
                            keywords: "",
                            highlights: "",
                            weight: "",
                            weightUnit: "",
                            height: "",
                            width: "",
                            length: "",
                            dimUnit: "",
                            shippingFee: "",
                            collectedAt: new Date().toISOString(),
                            error: err.message,
                        });
                        panel._setStatus(
                            "✗ Scrape error: " + err.message,
                            "#ffebee",
                            "#c62828",
                        );
                        panel._refreshCount();
                        console.error("[TTS Scraper]", err);
                        setTimeout(() => window.close(), 2000);
                    }
                }, 400);
            } else if (elapsed >= POLL_TIMEOUT_MS) {
                clearInterval(timer);
                clearInterval(captchaWatch);
                // Fee never appeared — scrape anyway so at least other fields are saved
                panel._setStatus(
                    "⚠ Fee timed out, scraping without it…",
                    "#fff3e0",
                    "#e65100",
                );
                setTimeout(() => {
                    try {
                        scrapeAndSave(productId);
                        panel._setStatus(
                            "⚠ Collected (no fee). Closing tab…",
                            "#fff3e0",
                            "#e65100",
                        );
                        panel._refreshCount();
                        setTimeout(() => window.close(), 1200);
                    } catch (err) {
                        saveRow({
                            id: productId,
                            url: `https://seller-us.tiktok.com/product/edit/${productId}`,
                            keywords: "",
                            highlights: "",
                            weight: "",
                            weightUnit: "",
                            height: "",
                            width: "",
                            length: "",
                            dimUnit: "",
                            shippingFee: "",
                            collectedAt: new Date().toISOString(),
                            error: err.message,
                        });
                        panel._setStatus(
                            "✗ Scrape error: " + err.message,
                            "#ffebee",
                            "#c62828",
                        );
                        panel._refreshCount();
                        console.error("[TTS Scraper]", err);
                        setTimeout(() => window.close(), 2000);
                    }
                }, 400);
            }
        }, POLL_INTERVAL_MS);
    }

    function main() {
        if (isManagePage()) {
            mainManage();
        } else {
            mainEdit();
        }
    }

    // Wait for body to be ready (document-idle should be enough, but guard anyway)
    if (document.body) {
        main();
    } else {
        document.addEventListener("DOMContentLoaded", main);
    }
})();
