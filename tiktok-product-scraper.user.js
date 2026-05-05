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

    const LS_PREFIX          = 'tts_prod_';
    const LS_QUEUE_PENDING   = 'tts_queue_pending';
    const LS_QUEUE_INFLIGHT  = 'tts_queue_inflight';
    const LS_QUEUE_TOTAL     = 'tts_queue_total';
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

        // Advance queue when a product tab saves its row
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

    }

    function mainEdit() {
        const productId = getProductId();
        if (!productId) return;

        const panel = buildPanel(productId);
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

        const timer = setInterval(() => {
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
                            keywords: '', highlights: '', weight: '', weightUnit: '',
                            height: '', width: '', length: '', dimUnit: '', shippingFee: '',
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
                            keywords: '', highlights: '', weight: '', weightUnit: '',
                            height: '', width: '', length: '', dimUnit: '', shippingFee: '',
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
