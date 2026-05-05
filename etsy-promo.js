// ==UserScript==
// @name         New Userscript
// @namespace    http://tampermonkey.net/
// @version      2026-04-08
// @description  try to take over the world!
// @author       You
// @match        https://www.etsy.com/your/shops/me/sales-discounts*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=etsy.com
// @grant        none
// ==/UserScript==

(async function () {
    const DEFAULT_SKUS = [
        "SKU12345\tExample Product Name (optional)",
        "SKU67890\tAnother Product Name",
        "SKU11121",
        "SKU31415",
    ]; // product name is optional, but can help with verification and mismatches
    const UI_ROOT_ID = "etsy-sku-helper-ui";
    const TOGGLE_BTN_ID = "etsy-sku-helper-toggle";
    const START_MINIMIZED = true;
    const ENABLE_KEY = "etsySkuHelperEnabled";

    const SELECTORS = {
        searchRoot: '[data-test-id="listing-search"]',
        input: 'input[type="search"].input',
        searchActivator: ".input-prepend-item",
        searchActivatorSvg: ".input-prepend-item svg",
        dropdownOpen: ".dropdown.is-open",
        dropdownItems:
            "button.list-nav-item.width-full.text-body.unstyled-button",
        selectedListingsRoot: '[data-test-id="selected-listings"]',
        selectedListingName:
            'a.text-link-secondary span[data-test-id="unsanitize"]',
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const GLOBAL_STATE_KEY = "__etsySkuHelperState";

    const hasGmStorage =
        typeof GM_getValue === "function" && typeof GM_setValue === "function";
    const hasGmMenu = typeof GM_registerMenuCommand === "function";

    function getEnabledFlag() {
        if (hasGmStorage) {
            return !!GM_getValue(ENABLE_KEY, false);
        }

        try {
            return localStorage.getItem(ENABLE_KEY) === "1";
        } catch {
            return false;
        }
    }

    function setEnabledFlag(nextValue) {
        if (hasGmStorage) {
            GM_setValue(ENABLE_KEY, !!nextValue);
            return;
        }

        try {
            localStorage.setItem(ENABLE_KEY, nextValue ? "1" : "0");
        } catch {
            // Ignore storage write issues.
        }
    }

    function ensureRunToggleButton(enabled) {
        const existing = document.getElementById(TOGGLE_BTN_ID);
        if (existing) {
            existing.remove();
        }

        const btn = document.createElement("button");
        btn.id = TOGGLE_BTN_ID;
        btn.type = "button";
        btn.textContent = enabled ? "SKU Helper ON" : "SKU Helper OFF";
        btn.title = "Toggle Etsy SKU Helper";

        Object.assign(btn.style, {
            position: "fixed",
            left: "16px",
            bottom: "100px",
            zIndex: "2147483647",
            border: "none",
            borderRadius: "999px",
            padding: "8px 12px",
            fontSize: "12px",
            fontWeight: "700",
            cursor: "pointer",
            boxShadow: "0 8px 18px rgba(0,0,0,0.2)",
            background: enabled ? "#166534" : "#991b1b",
            color: "#ffffff",
        });

        btn.addEventListener("click", () => {
            setEnabledFlag(!enabled);
            location.reload();
        });

        document.body.appendChild(btn);
    }

    const isEnabled = getEnabledFlag();
    ensureRunToggleButton(isEnabled);

    if (hasGmMenu) {
        GM_registerMenuCommand(
            `Etsy SKU Helper: ${isEnabled ? "ON" : "OFF"} (toggle)`,
            () => {
                setEnabledFlag(!isEnabled);
                location.reload();
            },
        );
    }

    if (!isEnabled) {
        console.info(
            "Etsy SKU Helper is OFF. Use Tampermonkey menu command to toggle ON.",
        );
        return;
    }

    function parseSkuText(rawText) {
        return rawText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const cells = line.includes("\t")
                    ? line.split("\t")
                    : line.split(",");
                const sku = (cells[0] || "").trim();
                const expectedName = (cells[1] || "").trim();
                return { sku, expectedName };
            })
            .filter((row) => row.sku);
    }

    function sanitizeIncomingRows(rows) {
        if (!Array.isArray(rows)) return [];

        return rows
            .map((row) => ({
                sku: String(row?.sku || "").trim(),
                expectedName: String(row?.expectedName || "").trim(),
            }))
            .filter((row) => row.sku);
    }

    function ensureUi() {
        const existing = document.getElementById(UI_ROOT_ID);
        if (existing) {
            existing.remove();
        }

        const root = document.createElement("div");
        root.id = UI_ROOT_ID;
        Object.assign(root.style, {
            position: "fixed",
            right: "16px",
            bottom: "16px",
            zIndex: "2147483647",
            width: "520px",
            height: "90vh",
            maxWidth: "90vw",
            maxHeight: "90vh",
            minWidth: "280px",
            minHeight: "220px",
            pointerEvents: "auto",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRadius: "10px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
            background: "#ffffff",
        });

        const strip = document.createElement("div");
        Object.assign(strip.style, {
            display: "flex",
            alignItems: "center",
            background: "#111827",
            color: "#fff",
            padding: "0 10px",
            height: "32px",
            flexShrink: "0",
            cursor: "default",
            userSelect: "none",
            borderRadius: "10px 10px 0 0",
            gap: "6px",
        });

        const stripTitle = document.createElement("span");
        stripTitle.textContent = "Etsy SKU Helper";
        Object.assign(stripTitle.style, {
            flex: "1",
            fontSize: "13px",
            fontWeight: "600",
            letterSpacing: "0.01em",
        });

        const minimizeBtn = document.createElement("button");
        minimizeBtn.textContent = "Minimize";
        minimizeBtn.title = "Minimize";
        Object.assign(minimizeBtn.style, {
            background: "rgba(255,255,255,0.16)",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: "6px",
            color: "#fff",
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: "600",
            padding: "3px 8px",
            lineHeight: "1.2",
            flexShrink: "0",
        });

        strip.appendChild(stripTitle);
        strip.appendChild(minimizeBtn);
        root.appendChild(strip);

        let savedHeight = "90vh";
        let savedMinHeight = "220px";
        let isMinimized = false;

        function toggleMinimize() {
            isMinimized = !isMinimized;
            if (isMinimized) {
                savedHeight = root.style.height || "90vh";
                savedMinHeight = root.style.minHeight || "220px";
                iframe.style.display = "none";
                root.style.minHeight = "32px";
                root.style.height = "32px";
                strip.style.borderRadius = "10px";
                minimizeBtn.textContent = "Restore";
                minimizeBtn.title = "Restore";
            } else {
                iframe.style.display = "";
                root.style.minHeight = savedMinHeight;
                root.style.height = savedHeight;
                strip.style.borderRadius = "10px 10px 0 0";
                minimizeBtn.textContent = "Minimize";
                minimizeBtn.title = "Minimize";
            }
        }

        minimizeBtn.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleMinimize();
        });

        minimizeBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });

        const iframe = document.createElement("iframe");
        iframe.title = "Etsy SKU Helper";
        iframe.setAttribute("aria-label", "Etsy SKU Helper");
        iframe.style.flex = "1";
        iframe.style.minHeight = "0";
        iframe.style.width = "100%";
        iframe.style.border = "none";

        const sourceId = JSON.stringify(UI_ROOT_ID);
        const defaultSkuText = JSON.stringify(DEFAULT_SKUS.join("\n"));

        iframe.srcdoc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
        html, body { height: 100%; }
    body {
      margin: 0;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            overflow: hidden;
      font-family: Segoe UI, Arial, sans-serif;
      background: #ffffff;
      color: #111827;
    }
        .title { font-weight: 700; margin-bottom: 6px; font-size: 16px; }
        .subtitle { font-size: 12px; color: #4b5563; margin-bottom: 10px; }
        .label { display: block; font-size: 12px; margin-bottom: 6px; font-weight: 600; }
    textarea {
      width: 100%;
            min-height: 92px;
            height: 92px;
            resize: none;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 8px;
      font-family: Consolas, monospace;
      font-size: 12px;
    }
                .row { display: flex; gap: 8px; }
    button {
      border: none;
      border-radius: 6px;
      padding: 8px 10px;
      cursor: pointer;
    }
    .run { flex: 1; background: #111827; color: white; }
    .clear { background: #e5e7eb; color: #111827; }
    .close { background: #fee2e2; color: #991b1b; }
        .table-wrap {
            border: 1px solid #d1d5db;
            border-radius: 6px;
            overflow: auto;
            flex: 1 1 auto;
            min-height: 120px;
            background: #fff;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        thead th {
            position: sticky;
            top: 0;
            z-index: 1;
            background: #f3f4f6;
            border-bottom: 1px solid #d1d5db;
            text-align: left;
            padding: 6px 8px;
        }
        tbody td {
            border-bottom: 1px solid #f3f4f6;
            padding: 6px 8px;
            vertical-align: top;
        }
        .col-sku {
            width: 150px;
            font-family: Consolas, monospace;
            white-space: nowrap;
        }
        .col-status { width: 170px; }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 600;
            line-height: 1.4;
        }
        .badge-pending { background: #f3f4f6; color: #374151; }
        .badge-running { background: #dbeafe; color: #1d4ed8; }
        .badge-ok { background: #dcfce7; color: #166534; }
        .badge-miss { background: #fee2e2; color: #991b1b; }
        .badge-skip { background: #fef3c7; color: #92400e; }
        .summary-box {
            margin-top: 8px;
            border: 1px solid #d1d5db;
            background: #f9fafb;
            border-radius: 6px;
            padding: 8px;
            font-size: 12px;
            color: #111827;
            max-height: 120px;
            overflow-y: auto;
        }
        .summary-box ul { margin: 4px 0 0 0; padding-left: 16px; }
        .muted { color: #6b7280; }
    pre {
        margin: 0;
        height: 96px;
        flex: 0 0 auto;
      overflow: auto;
      background: #0b1020;
      color: #d6e2ff;
      padding: 10px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
    <label class="label">Input (SKU[TAB]Product Name)</label>
  <textarea id="skuText"></textarea>
    <div class="table-wrap">
        <table>
            <thead>
                <tr>
                    <th class="col-sku">SKU</th>
                    <th>Product Name</th>
                    <th class="col-status">Status</th>
                </tr>
            </thead>
            <tbody id="previewBody"></tbody>
        </table>
    </div>
    <div id="summaryBox" class="summary-box">Ready: 0 valid rows, 0 with expected names, 0 without expected names.</div>
  <div class="row">
    <button id="runBtn" class="run">Run</button>
    <button id="logToggleBtn" class="clear">Hide Log</button>
    <button id="closeBtn" class="close">Close</button>
  </div>
  <pre id="log"></pre>

  <script>
    const sourceId = ${sourceId};
    const defaultSkus = ${defaultSkuText};
    const textarea = document.getElementById("skuText");
    const runBtn = document.getElementById("runBtn");
    const logToggleBtn = document.getElementById("logToggleBtn");
    const closeBtn = document.getElementById("closeBtn");
    const logEl = document.getElementById("log");
    const previewBody = document.getElementById("previewBody");
    const summaryBox = document.getElementById("summaryBox");

    let currentRows = [];
    let rowStatusMap = [];

    textarea.value = defaultSkus;

        function parseRows(text) {
            return String(text || "")
                .split(/\\r?\\n/)
                .map(function (line) { return line.trim(); })
                .filter(Boolean)
                .map(function (line) {
                    const cells = line.indexOf("\\t") >= 0 ? line.split("\\t") : line.split(",");
                    const sku = (cells[0] || "").trim();
                    const expectedName = (cells[1] || "").trim();
                    return { sku: sku, expectedName: expectedName };
                })
                .filter(function (row) { return !!row.sku; });
        }

        function getStatusBadge(status) {
            if (status === "Searching" || status === "Selecting") {
                return '<span class="badge badge-running">' + status + '</span>';
            }

            if (status === "Added" || status === "Verified") {
                return '<span class="badge badge-ok">' + status + '</span>';
            }

            if (status === "Missing" || status === "Mismatch" || status === "Not found" || status === "Error") {
                return '<span class="badge badge-miss">' + status + '</span>';
            }

            if (status === "Skipped") {
                return '<span class="badge badge-skip">Skipped</span>';
            }

            return '<span class="badge badge-pending">Pending</span>';
        }

        function renderPreview() {
            const rows = currentRows;
            if (rows.length === 0) {
                previewBody.innerHTML = '<tr><td colspan="3" class="muted">No valid rows yet.</td></tr>';
                return rows;
            }

            previewBody.innerHTML = rows
                .map(function (row, index) {
                    const safeSku = row.sku.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                    const safeName = (row.expectedName || "")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;");
                    const status = rowStatusMap[index] || { status: "Pending", detail: "" };
                    const safeDetail = String(status.detail || "")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;");
                    const statusHtml = getStatusBadge(status.status);
                    const detailHtml = safeDetail ? '<div class="muted">' + safeDetail + '</div>' : "";
                    return '<tr><td class="col-sku">' + safeSku + '</td><td>' + (safeName || '<span class="muted">(empty)</span>') + '</td><td>' + statusHtml + detailHtml + '</td></tr>';
                })
                .join("");

            return rows;
        }

        function resetStatuses(rows) {
            rowStatusMap = rows.map(function () {
                return { status: "Pending", detail: "" };
            });
        }

        function normalizeTextareaToCleanRows() {
            const rows = parseRows(textarea.value);
            textarea.value = rows
                .map(function (row) {
                    return row.sku + "\\t" + (row.expectedName || "");
                })
                .join("\\n");
            currentRows = rows;
            resetStatuses(rows);
            return rows;
        }

        function getRowCounts(rows) {
            const total = rows.length;
            const withExpected = rows.filter(function (row) {
                return !!String(row.expectedName || "").trim();
            }).length;
            return {
                total: total,
                withExpected: withExpected,
                withoutExpected: total - withExpected,
            };
        }

    function send(type, extra) {
      window.parent.postMessage(Object.assign({ source: sourceId, type: type }, extra || {}), "*");
    }

    runBtn.addEventListener("click", function () {
            const rows = normalizeTextareaToCleanRows();
            const counts = getRowCounts(rows);
            renderPreview();
            summaryBox.textContent = rows.length > 0
              ? "Running: " + counts.total + " valid row(s), " + counts.withExpected + " with expected names, " + counts.withoutExpected + " without expected names."
              : "Running blocked: 0 valid rows parsed from input.";
            send("run", { text: textarea.value, rows: rows });
    });
    logToggleBtn.addEventListener("click", function () {
        if (logEl.style.display === "none") {
            logEl.style.display = "";
            logToggleBtn.textContent = "Hide Log";
        } else {
            logEl.style.display = "none";
            logToggleBtn.textContent = "Show Log";
        }
    });
    closeBtn.addEventListener("click", function () {
      send("close");
    });

        textarea.addEventListener("input", function () {
            currentRows = parseRows(textarea.value);
            resetStatuses(currentRows);
            renderPreview();
        });

        textarea.addEventListener("paste", function () {
            setTimeout(function () {
                const rows = normalizeTextareaToCleanRows();
                const counts = getRowCounts(rows);
                summaryBox.textContent = "Loaded: " + counts.total + " valid row(s), " + counts.withExpected + " with expected names, " + counts.withoutExpected + " without expected names.";
                renderPreview();
            }, 0);
        });

        window.addEventListener("error", function (event) {
            send("iframe-error", {
                message: String(event && event.message ? event.message : "Unknown iframe error")
            });
        });

    window.addEventListener("message", function (event) {
      const data = event.data || {};
      if (data.source !== sourceId) return;

      if (data.type === "log") {
        const timestamp = new Date().toLocaleTimeString();
        logEl.textContent += "[" + timestamp + "] " + data.message + "\\n";
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (data.type === "clear-log") {
        logEl.textContent = "";
      }

      if (data.type === "set-running") {
        runBtn.disabled = !!data.running;
        runBtn.textContent = data.running ? "Running..." : "Run";
      }

            if (data.type === "reset-statuses") {
                const rows = Array.isArray(data.rows) ? data.rows : [];
                const counts = getRowCounts(rows);
                currentRows = rows;
                resetStatuses(rows);
                summaryBox.textContent = rows.length > 0
                    ? "Ready: " + counts.total + " valid row(s), " + counts.withExpected + " with expected names, " + counts.withoutExpected + " without expected names."
                    : "Ready: 0 valid rows, 0 with expected names, 0 without expected names.";
                renderPreview();
            }

            if (data.type === "row-status") {
                const index = Number(data.index);
                if (!Number.isNaN(index) && index >= 0 && index < rowStatusMap.length) {
                    rowStatusMap[index] = {
                        status: String(data.status || "Pending"),
                        detail: String(data.detail || "")
                    };
                    renderPreview();
                }
            }

            if (data.type === "run-summary") {
                var esc = function(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
                const inputTotal = Number(data.inputTotal || 0);
                const processed = Number(data.processed || 0);
                const success = Number(data.success || 0);
                const missingCount = Number(data.missing || 0);
                const mismatchCount = Number(data.mismatch || 0);
                const withoutExpected = Number(data.withoutExpected || 0);
                const notFoundCount = Number(data.notFound || 0);
                const missingRows = Array.isArray(data.missingRows) ? data.missingRows : [];
                const mismatchRows = Array.isArray(data.mismatchRows) ? data.mismatchRows : [];
                let html = "";
                html += '<div><strong>Run:</strong> input ' + inputTotal + ', processed ' + processed + ', verified <span style="color:#166534;font-weight:600">' + success + '</span>, mismatch <span style="color:#b45309;font-weight:600">' + mismatchCount + '</span>, missing <span style="color:#991b1b;font-weight:600">' + missingCount + '</span>, no-result ' + notFoundCount + ', no-expected ' + withoutExpected + '.</div>';

                if (mismatchCount > 0) {
                    html += '<div style="margin-top:4px"><strong>Mismatch details</strong></div>';
                    html += '<ul>';
                    for (var xi = 0; xi < mismatchRows.length; xi++) {
                        var xrow = mismatchRows[xi];
                        html += '<li><span style="font-family:Consolas,monospace">' + esc(xrow.sku) + '</span>';
                        if (xrow.expectedName) { html += ' expected ' + esc(xrow.expectedName); }
                        if (xrow.actualName) { html += ', added ' + esc(xrow.actualName); }
                        html += '</li>';
                    }
                    html += '</ul>';
                }

                if (missingCount > 0) {
                    html += '<div style="margin-top:4px"><strong>Missing details</strong></div>';
                    html += '<ul>';
                    for (var mi = 0; mi < missingRows.length; mi++) {
                        var mrow = missingRows[mi];
                        html += '<li><span style="font-family:Consolas,monospace">' + esc(mrow.sku) + '</span>';
                        if (mrow.expectedName) { html += ' &mdash; ' + esc(mrow.expectedName); }
                        html += '</li>';
                    }
                    html += '</ul>';
                }
                summaryBox.innerHTML = html;
            }
    });

    send("ready");
    currentRows = parseRows(textarea.value);
    resetStatuses(currentRows);
    renderPreview();
  <\/script>
</body>
</html>`;

        root.appendChild(iframe);
        document.body.appendChild(root);

        if (START_MINIMIZED) {
            toggleMinimize();
        }

        return { root, iframe };
    }

    function postUiMessage(ui, payload) {
        if (!ui || !ui.iframe || !ui.iframe.contentWindow) return;
        ui.iframe.contentWindow.postMessage(
            { source: UI_ROOT_ID, ...payload },
            "*",
        );
    }

    function createLogger(ui) {
        return {
            write(message) {
                postUiMessage(ui, { type: "log", message });
            },
            clear() {
                postUiMessage(ui, { type: "clear-log" });
            },
        };
    }

    function postRowStatus(ui, index, status, detail = "") {
        postUiMessage(ui, {
            type: "row-status",
            index,
            status,
            detail,
        });
    }

    function setNativeInputValue(inputEl, value) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
        ).set;
        nativeInputValueSetter.call(inputEl, value);
    }

    function focusInput(inputEl) {
        if (document.activeElement !== inputEl) {
            inputEl.focus({ preventScroll: true });
            inputEl.dispatchEvent(new Event("focus", { bubbles: false }));
        }
    }

    function setInputValue(inputEl, value) {
        focusInput(inputEl);
        setNativeInputValue(inputEl, value);
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        inputEl.dispatchEvent(
            new KeyboardEvent("keyup", { bubbles: true, key: " " }),
        );
    }

    function getSearchContext() {
        const searchRoot = document.querySelector(SELECTORS.searchRoot);
        if (!searchRoot) return null;

        const inputEl = searchRoot.querySelector(SELECTORS.input);
        if (!inputEl) return null;

        return { searchRoot, inputEl };
    }

    function normalizeText(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/&/g, " and ")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function getSelectedListingNames() {
        const root = document.querySelector(SELECTORS.selectedListingsRoot);
        if (!root) return [];

        return [...root.querySelectorAll(SELECTORS.selectedListingName)]
            .map((el) => (el.textContent || "").trim())
            .filter(Boolean);
    }

    function isExpectedNamePresent(expectedName) {
        const normalizedExpected = normalizeText(expectedName);
        if (!normalizedExpected) return false;

        const selectedNames = getSelectedListingNames();
        return selectedNames.some((name) => {
            const normalizedActual = normalizeText(name);
            return (
                normalizedActual.includes(normalizedExpected) ||
                normalizedExpected.includes(normalizedActual)
            );
        });
    }

    function namesRoughlyMatch(actualName, expectedName) {
        const normalizedActual = normalizeText(actualName);
        const normalizedExpected = normalizeText(expectedName);
        if (!normalizedActual || !normalizedExpected) return false;

        return (
            normalizedActual.includes(normalizedExpected) ||
            normalizedExpected.includes(normalizedActual)
        );
    }

    function detectNewlyAddedListingName(beforeNames, afterNames) {
        const beforeCounts = {};
        for (const name of beforeNames) {
            const key = normalizeText(name);
            if (!key) continue;
            beforeCounts[key] = (beforeCounts[key] || 0) + 1;
        }

        const seenAfter = {};
        for (const name of afterNames) {
            const key = normalizeText(name);
            if (!key) continue;
            seenAfter[key] = (seenAfter[key] || 0) + 1;
            if (seenAfter[key] > (beforeCounts[key] || 0)) {
                return String(name || "").trim();
            }
        }

        return "";
    }

    async function waitForDropdownItem(searchRoot, inputEl, maxWaitMs = 5000) {
        let timeSpent = 0;
        while (timeSpent < maxWaitMs) {
            focusInput(inputEl);

            const openDropdown = searchRoot.querySelector(
                SELECTORS.dropdownOpen,
            );
            if (openDropdown) {
                const candidateItems = [
                    ...openDropdown.querySelectorAll(SELECTORS.dropdownItems),
                ].filter((el) => el.offsetParent !== null);

                if (candidateItems.length > 0) {
                    return candidateItems[0];
                }
            }

            await sleep(100);
            timeSpent += 100;
        }

        return null;
    }

    function dispatchPointerMouseSequence(target) {
        target.dispatchEvent(
            new PointerEvent("pointerdown", {
                bubbles: true,
                cancelable: true,
                pointerType: "mouse",
                isPrimary: true,
                button: 0,
                buttons: 1,
            }),
        );
        target.dispatchEvent(
            new MouseEvent("mousedown", {
                bubbles: true,
                cancelable: true,
                button: 0,
                buttons: 1,
            }),
        );
        target.dispatchEvent(
            new PointerEvent("pointerup", {
                bubbles: true,
                cancelable: true,
                pointerType: "mouse",
                isPrimary: true,
                button: 0,
                buttons: 0,
            }),
        );
        target.dispatchEvent(
            new MouseEvent("mouseup", {
                bubbles: true,
                cancelable: true,
                button: 0,
                buttons: 0,
            }),
        );
        target.dispatchEvent(
            new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
            }),
        );
    }

    function clickSearchActivator(searchRoot, inputEl) {
        const candidates = [
            searchRoot.querySelector(SELECTORS.searchActivatorSvg),
            searchRoot.querySelector(SELECTORS.searchActivator),
        ].filter(Boolean);

        for (const candidate of candidates) {
            if (candidate.offsetParent === null) continue;

            const rect = candidate.getBoundingClientRect();
            const hitTarget =
                document.elementFromPoint(
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2,
                ) || candidate;

            dispatchPointerMouseSequence(hitTarget);
            dispatchPointerMouseSequence(candidate);
            if (typeof candidate.click === "function") {
                candidate.click();
            }

            focusInput(inputEl);
            return true;
        }

        return false;
    }

    function nudgeKeyboardSelection(inputEl) {
        focusInput(inputEl);
        inputEl.dispatchEvent(
            new KeyboardEvent("keydown", {
                bubbles: true,
                key: "ArrowDown",
                code: "ArrowDown",
            }),
        );
        inputEl.dispatchEvent(
            new KeyboardEvent("keyup", {
                bubbles: true,
                key: "ArrowDown",
                code: "ArrowDown",
            }),
        );
        inputEl.dispatchEvent(
            new KeyboardEvent("keydown", {
                bubbles: true,
                key: "Enter",
                code: "Enter",
            }),
        );
        inputEl.dispatchEvent(
            new KeyboardEvent("keyup", {
                bubbles: true,
                key: "Enter",
                code: "Enter",
            }),
        );
    }

    async function processSkuList(rows, logger, shouldStop) {
        const rowsWithExpectedInput = rows.filter(
            (row) => row.expectedName,
        ).length;
        const rowsWithoutExpectedInput = rows.length - rowsWithExpectedInput;
        logger.write(
            `Starting automation: ${rows.length} input row(s), ${rowsWithExpectedInput} with expected names, ${rowsWithoutExpectedInput} without expected names.`,
        );
        console.log(`Starting automation for ${rows.length} rows...`);

        postUiMessage(ui, { type: "reset-statuses", rows });

        const verificationRows = [];

        for (let i = 0; i < rows.length; i++) {
            if (shouldStop()) {
                logger.write("Stopped by user.");
                postRowStatus(ui, i, "Skipped", "Stopped by user");
                break;
            }

            const { sku, expectedName } = rows[i];
            logger.write(`Processing ${i + 1}/${rows.length}: ${sku}`);
            postRowStatus(ui, i, "Searching", "Looking up SKU");

            const ctx = getSearchContext();
            if (!ctx) {
                logger.write(
                    "ERROR: Listing search input not found. Stopping.",
                );
                console.error(
                    "Listing search input was not found. Halting script.",
                );
                postRowStatus(ui, i, "Error", "Search input not found");
                break;
            }

            const { searchRoot, inputEl } = ctx;

            setInputValue(inputEl, "");
            await sleep(80);
            setInputValue(inputEl, sku);

            // Etsy sometimes requires one manual kick on the search icon after first input.
            if (i === 0) {
                await sleep(120);
                const clickedActivator = clickSearchActivator(
                    searchRoot,
                    inputEl,
                );
                logger.write(
                    clickedActivator
                        ? "INFO: Triggered search icon after first SKU input."
                        : "WARN: Search icon activator not found.",
                );
            }

            let dropdownItem = await waitForDropdownItem(
                searchRoot,
                inputEl,
                7000,
            );

            // If first search still fails to open reliably, try keyboard selection fallback.
            if (!dropdownItem && i === 0) {
                logger.write(
                    "INFO: First result not visible, trying keyboard fallback.",
                );
                nudgeKeyboardSelection(inputEl);
                dropdownItem = await waitForDropdownItem(
                    searchRoot,
                    inputEl,
                    1500,
                );
            }

            if (shouldStop()) {
                logger.write("Stopped by user.");
                postRowStatus(ui, i, "Skipped", "Stopped by user");
                break;
            }

            if (dropdownItem) {
                postRowStatus(ui, i, "Selecting", "Picking first result");
                const selectedNamesBefore = getSelectedListingNames();
                dropdownItem.dispatchEvent(
                    new MouseEvent("mousedown", { bubbles: true }),
                );
                dropdownItem.dispatchEvent(
                    new MouseEvent("mouseup", { bubbles: true }),
                );
                dropdownItem.click();
                logger.write(`OK: Added ${sku}`);
                postRowStatus(ui, i, "Added", "Item selected");

                await sleep(200);
                const selectedNamesAfter = getSelectedListingNames();
                const actualAddedName = detectNewlyAddedListingName(
                    selectedNamesBefore,
                    selectedNamesAfter,
                );

                if (expectedName) {
                    const matchedByActual = actualAddedName
                        ? namesRoughlyMatch(actualAddedName, expectedName)
                        : false;
                    const matchedByPresence =
                        isExpectedNamePresent(expectedName);
                    const isVerified = matchedByActual || matchedByPresence;

                    if (isVerified) {
                        verificationRows.push({
                            sku,
                            expectedName,
                            actualName: actualAddedName,
                            added: true,
                            result: "verified",
                        });
                        logger.write(`VERIFY OK: ${sku} -> ${expectedName}`);
                        postRowStatus(ui, i, "Verified", expectedName);
                    } else {
                        verificationRows.push({
                            sku,
                            expectedName,
                            actualName: actualAddedName,
                            added: true,
                            result: actualAddedName ? "mismatch" : "missing",
                        });

                        if (actualAddedName) {
                            logger.write(
                                `VERIFY MISMATCH: ${sku} expected "${expectedName}", added "${actualAddedName}"`,
                            );
                            postRowStatus(
                                ui,
                                i,
                                "Mismatch",
                                `Expected: ${expectedName} | Added: ${actualAddedName}`,
                            );
                        } else {
                            logger.write(
                                `VERIFY MISS: ${sku} -> ${expectedName}`,
                            );
                            postRowStatus(ui, i, "Missing", expectedName);
                        }
                    }
                } else {
                    verificationRows.push({
                        sku,
                        expectedName: "",
                        actualName: actualAddedName,
                        added: true,
                        result: "skipped",
                    });
                    logger.write(
                        `VERIFY SKIP: ${sku} has no expected product name.`,
                    );
                    postRowStatus(ui, i, "Skipped", "No expected product name");
                }
            } else {
                logger.write(`MISS: No dropdown item found for ${sku}`);
                console.error(`Dropdown item not found for ${sku}.`);
                postRowStatus(ui, i, "Not found", "No dropdown result");

                if (expectedName) {
                    verificationRows.push({
                        sku,
                        expectedName,
                        actualName: "",
                        added: false,
                        result: "missing",
                    });
                    logger.write(`VERIFY MISS: ${sku} -> ${expectedName}`);
                    postRowStatus(ui, i, "Missing", expectedName);
                } else {
                    verificationRows.push({
                        sku,
                        expectedName: "",
                        actualName: "",
                        added: false,
                        result: "skipped",
                    });
                    logger.write(
                        `VERIFY SKIP: ${sku} has no expected product name.`,
                    );
                    postRowStatus(ui, i, "Skipped", "No expected product name");
                }
            }

            await sleep(1000);

            setInputValue(inputEl, "");
            await sleep(500);
        }

        const rowsWithExpected = verificationRows.filter((r) => r.expectedName);
        const processedCount = verificationRows.length;
        const addedCount = verificationRows.filter((r) => r.added).length;
        const notFoundCount = verificationRows.filter((r) => !r.added).length;
        const withoutExpectedCount = verificationRows.filter(
            (r) => !r.expectedName,
        ).length;
        const mismatches = rowsWithExpected.filter(
            (r) => r.result === "mismatch",
        );
        const missing = rowsWithExpected.filter((r) => r.result === "missing");
        const success = rowsWithExpected.filter(
            (r) => r.result === "verified",
        ).length;
        if (rowsWithExpected.length > 0) {
            logger.write(
                `Summary: input ${rows.length}, processed ${processedCount}, with expected ${rowsWithExpected.length}, without expected ${withoutExpectedCount}, added ${addedCount}, no dropdown result ${notFoundCount}, verified ${success}, mismatch ${mismatches.length}, missing ${missing.length}.`,
            );
            if (mismatches.length > 0) {
                for (const row of mismatches) {
                    logger.write(
                        `MISMATCH: ${row.sku} expected "${row.expectedName}", added "${row.actualName || "(unknown)"}"`,
                    );
                }
            }
            if (missing.length > 0) {
                for (const row of missing) {
                    logger.write(`MISSING: ${row.sku} -> ${row.expectedName}`);
                }
            }
        } else {
            logger.write(
                `Summary: input ${rows.length}, processed ${processedCount}, with expected 0, without expected ${withoutExpectedCount}, added ${addedCount}, no dropdown result ${notFoundCount}, verified 0, mismatch 0, missing 0.`,
            );
        }

        postUiMessage(ui, {
            type: "run-summary",
            inputTotal: rows.length,
            processed: processedCount,
            total: rowsWithExpected.length,
            success,
            missing: missing.length,
            mismatch: mismatches.length,
            withoutExpected: withoutExpectedCount,
            added: addedCount,
            notFound: notFoundCount,
            mismatchRows: mismatches.map((r) => ({
                sku: r.sku,
                expectedName: r.expectedName,
                actualName: r.actualName,
            })),
            missingRows: missing.map((r) => ({
                sku: r.sku,
                expectedName: r.expectedName,
            })),
        });

        logger.write(
            `Automation complete: processed ${processedCount}/${rows.length} row(s).`,
        );
        console.log("Automation complete.");
    }

    const previousState = window[GLOBAL_STATE_KEY];
    if (previousState && typeof previousState.dispose === "function") {
        previousState.dispose();
    }

    const ui = ensureUi();
    const logger = createLogger(ui);

    let isRunning = false;
    let stopRequested = false;

    function disposeHelper() {
        stopRequested = true;
        if (document.body.contains(ui.root)) {
            ui.root.remove();
        }
        window.removeEventListener("message", onUiMessage);
        if (window[GLOBAL_STATE_KEY]?.dispose === disposeHelper) {
            delete window[GLOBAL_STATE_KEY];
        }
    }

    function setRunningState(running) {
        postUiMessage(ui, { type: "set-running", running });
    }

    async function onUiMessage(event) {
        if (!ui.iframe || event.source !== ui.iframe.contentWindow) return;

        const data = event.data || {};
        if (data.source !== UI_ROOT_ID) return;

        if (data.type === "ready") {
            logger.write(
                "Ready: helper loaded. Paste rows in SKU[TAB]Product Name format, then click Run.",
            );
            return;
        }

        if (data.type === "clear") {
            logger.clear();
            return;
        }

        if (data.type === "close") {
            logger.write("Closing helper UI...");
            disposeHelper();
            return;
        }

        if (data.type === "run") {
            if (isRunning) {
                logger.write("Already running. Please wait...");
                return;
            }

            const rows =
                sanitizeIncomingRows(data.rows).length > 0
                    ? sanitizeIncomingRows(data.rows)
                    : parseSkuText(String(data.text || ""));
            if (rows.length === 0) {
                logger.write(
                    "Run blocked: parsed 0 valid rows from input. Paste at least 1 SKU row.",
                );
                return;
            }

            isRunning = true;
            stopRequested = false;
            setRunningState(true);

            try {
                await processSkuList(rows, logger, () => stopRequested);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                logger.write(`ERROR: ${message}`);
                console.error(error);
            } finally {
                isRunning = false;
                if (document.body.contains(ui.root)) {
                    setRunningState(false);
                }
            }
        }

        if (data.type === "iframe-error") {
            logger.write(
                `UI ERROR: ${String(data.message || "Unknown iframe error")}`,
            );
            return;
        }
    }

    window.addEventListener("message", onUiMessage);
    window[GLOBAL_STATE_KEY] = {
        dispose: disposeHelper,
    };
})();
