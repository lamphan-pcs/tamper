// ==UserScript==
// @name         TikTok Creator Search Automation Tool
// @namespace    https://affiliate-us.tiktok.com/
// @version      1.0.0
// @description  Automates bulk creator username searches on TikTok Affiliate. Adds a floating widget to the page.
// @author       User
// @match        https://affiliate-us.tiktok.com/connection/creator*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    // Prevent duplicate instances
    if (document.getElementById("tiktok-automator-ui")) {
        alert("Tool is already running!");
        return;
    }

    // --- Save original fetch ---
    const _fetch = window.fetch.bind(window);

    // --- Direct API Engine ---
    // Captures a real search request, then replays it directly for speed
    const apiEngine = {
        captured: null, // { url, method, headers, body }
        capturePromise: null,
        _captureResolve: null,

        init() {
            const self = this;
            self.capturePromise = new Promise((res) => {
                self._captureResolve = res;
            });

            window.fetch = async function (input, init) {
                const url = typeof input === "string" ? input : input.url;

                if (
                    url.includes("creator/search/suggestions") &&
                    !self.captured
                ) {
                    try {
                        // Extract headers
                        const headers = {};
                        if (init?.headers) {
                            if (init.headers instanceof Headers) {
                                init.headers.forEach((v, k) => {
                                    headers[k] = v;
                                });
                            } else if (typeof init.headers === "object") {
                                Object.assign(headers, init.headers);
                            }
                        }

                        // Extract body
                        let body = null;
                        if (init?.body) {
                            body =
                                typeof init.body === "string"
                                    ? init.body
                                    : await new Response(init.body).text();
                        }

                        self.captured = {
                            url: url,
                            method: init?.method || "GET",
                            headers: headers,
                            body: body,
                            parsedBody: null,
                        };

                        // Try to parse the body as JSON
                        if (body) {
                            try {
                                self.captured.parsedBody = JSON.parse(body);
                            } catch (e) {}
                        }

                        console.log("[Tool] API request captured:");
                        console.log("  Method:", self.captured.method);
                        console.log(
                            "  URL:",
                            self.captured.url.substring(0, 120) + "...",
                        );
                        console.log("  Headers:", JSON.stringify(headers));
                        console.log("  Body:", body);
                        console.log("  Parsed body:", self.captured.parsedBody);
                        self._captureResolve(true);
                    } catch (e) {
                        console.error("[Tool] Capture error:", e);
                        self._captureResolve(false);
                    }
                }

                return _fetch(input, init);
            };
        },

        // Build a new JSON body with the username swapped in
        _buildBody(username) {
            if (!this.captured.parsedBody) return this.captured.body;
            const cloned = JSON.parse(JSON.stringify(this.captured.parsedBody));
            if (cloned.request && "query" in cloned.request) {
                cloned.request.query = username;
            } else if ("query" in cloned) {
                cloned.query = username;
            }
            return JSON.stringify(cloned);
        },

        // Fire a direct API call for a username (bypasses UI entirely)
        async search(username) {
            if (!this.captured) {
                console.warn("[Tool] search() called but nothing captured");
                return null;
            }
            const body = this._buildBody(username);
            try {
                console.log(`[Tool] Fetching for "${username}"...`);
                console.log("  URL:", this._url.substring(0, 120) + "...");
                console.log("  Body:", body);
                const r = await _fetch(this._url, {
                    method: this.captured.method,
                    headers: { ...this.captured.headers },
                    body: body,
                    credentials: "include",
                });
                console.log(
                    `[Tool] Response for "${username}": status=${r.status} ${r.statusText}`,
                );
                if (!r.ok) {
                    const errText = await r.text().catch(() => "(unreadable)");
                    console.error(
                        `[Tool] Non-OK response body:`,
                        errText.substring(0, 500),
                    );
                    return null;
                }
                const json = await r.json();
                console.log(
                    `[Tool] JSON for "${username}":`,
                    JSON.stringify(json).substring(0, 300),
                );
                return json;
            } catch (e) {
                console.error(`[Tool] Fetch error for "${username}":`, e);
                return null;
            }
        },

        // Test which URL variant works: with signatures first, then without
        async testDirect(username) {
            console.log("[Tool] === Testing direct API call ===");

            // Try 1: Keep X-Bogus & X-Gnarly
            console.log("[Tool] Try 1: WITH X-Bogus & X-Gnarly");
            this._url = this.captured.url;
            let data = await this.search(username);
            console.log(
                "[Tool] Try 1 result:",
                data
                    ? `code=${data.code}, message=${data.message}`
                    : "null/failed",
            );
            if (data && typeof data === "object" && data.code === 0) {
                console.log("[Tool] Direct mode works WITH signatures");
                return true;
            }

            // Try 2: Strip signatures
            console.log("[Tool] Try 2: WITHOUT X-Bogus & X-Gnarly");
            const urlObj = new URL(this.captured.url);
            urlObj.searchParams.delete("X-Bogus");
            urlObj.searchParams.delete("X-Gnarly");
            this._url = urlObj.toString();
            data = await this.search(username);
            console.log(
                "[Tool] Try 2 result:",
                data
                    ? `code=${data.code}, message=${data.message}`
                    : "null/failed",
            );
            if (data && typeof data === "object" && data.code === 0) {
                console.log("[Tool] Direct mode works WITHOUT signatures");
                return true;
            }

            console.error(
                "[Tool] Both direct call attempts FAILED. Direct mode not available.",
            );
            if (data)
                console.error(
                    "[Tool] Last response:",
                    JSON.stringify(data).substring(0, 500),
                );
            return false;
        },

        isReady() {
            return this.captured && this.captured.parsedBody;
        },
    };
    apiEngine.init();

    // --- Configuration ---
    const CONFIG = {
        dropdownSelector: '[data-tid="m4b_dropdown_menu"]', // The container from your snippet
        itemSelector: ".arco-menu-item", // The clickable items
        markSelector: "mark", // The highlighted text tag
        typingDelay: 100, // Ms between keystrokes
        searchWaitTime: 2000, // Max wait time for dropdown to appear/update
        preferDirectApi: false, // Set true to bypass UI once the request shape is captured
        humanInteraction: {
            enabled: true,
            minPause: 180,
            maxPause: 700,
            actionsPerWait: 2,
        },
    };

    let targetInput = null;
    let isRunning = false;
    let results = [];

    // --- UI Construction ---
    const ui = document.createElement("div");
    ui.id = "tiktok-automator-ui";
    ui.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        width: 350px;
        background: white;
        border: 1px solid #e1e1e1;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        border-radius: 8px;
        z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-size: 13px;
        max-height: 90vh;
        overflow-y: auto;
    `;

    ui.innerHTML = `
        <h3 style="margin: 0; font-size: 16px; font-weight: 600;">Creator Search Tool</h3>

        <div style="display: flex; gap: 8px; align-items: center; background: #f5f5f5; padding: 8px; border-radius: 4px;">
            <button id="btn-target" style="padding: 6px 12px; cursor: pointer; background: #fff; border: 1px solid #ccc; border-radius: 4px;">🎯 Select Input</button>
            <span id="target-status" style="color: #666;">No input selected</span>
        </div>

        <textarea id="user-list" placeholder="Paste usernames here (one per line)..." style="width: 100%; height: 100px; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; resize: vertical;"></textarea>

        <button id="btn-run" style="padding: 10px; background: #fe2c55; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; opacity: 0.5; pointer-events: none;">START SEARCH</button>

        <div id="progress-bar" style="height: 4px; background: #eee; width: 100%; border-radius: 2px; overflow: hidden;">
            <div id="progress-fill" style="width: 0%; height: 100%; background: #25c48b; transition: width 0.3s;"></div>
        </div>
        <div id="status-text" style="color: #666; font-size: 12px;">Ready</div>

        <div id="results-area" style="display: none; flex-direction: column; gap: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong>Results</strong>
                <button id="btn-copy" style="padding: 4px 8px; font-size: 11px; cursor: pointer;">📋 Copy Table</button>
            </div>
            <div style="border: 1px solid #eee; border-radius: 4px; overflow: hidden; max-height: 200px; overflow-y: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                    <thead style="background: #f8f8f8; text-align: left; position: sticky; top: 0;">
                        <tr><th style="padding: 6px;">Username</th><th style="padding: 6px;">Found</th></tr>
                    </thead>
                    <tbody id="result-tbody"></tbody>
                </table>
            </div>
        </div>
    `;

    document.body.appendChild(ui);

    // --- Helpers ---
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const randomInt = (min, max) =>
        Math.floor(Math.random() * (max - min + 1)) + min;

    const dispatchMouseSequence = (element, clientX, clientY) => {
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
            (type) => {
                element.dispatchEvent(
                    new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        clientX,
                        clientY,
                        button: 0,
                    }),
                );
            },
        );
    };

    const clickRandomInputPosition = (element, value) => {
        if (!element || typeof element.getBoundingClientRect !== "function") {
            return;
        }

        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        const length = Math.max(String(value || element.value || "").length, 1);
        const charIndex = randomInt(0, length);
        const horizontalPadding = Math.min(24, rect.width * 0.15);
        const usableWidth = Math.max(rect.width - horizontalPadding * 2, 12);
        const ratio = charIndex / length;
        const clientX =
            rect.left +
            horizontalPadding +
            Math.min(ratio * usableWidth, usableWidth);
        const clientY = rect.top + rect.height / 2 + randomInt(-2, 2);

        element.focus();
        dispatchMouseSequence(element, clientX, clientY);
    };

    const highlightRandomTextRange = (element, value) => {
        if (!element || typeof element.setSelectionRange !== "function") {
            return;
        }

        const text = String(value || element.value || "");
        if (!text.length) return;

        const start = randomInt(0, Math.max(text.length - 1, 0));
        const maxSpan = Math.min(4, text.length - start);
        const end = start + Math.max(1, randomInt(1, Math.max(maxSpan, 1)));

        element.focus();
        try {
            element.setSelectionRange(start, end);
        } catch (e) {
            // Ignore inputs that do not allow selection ranges.
        }
    };

    const simulateHumanInputWait = async (element, value, waitMs) => {
        if (!CONFIG.humanInteraction.enabled || !element || waitMs <= 0) {
            await sleep(waitMs);
            return;
        }

        const actionCount = randomInt(
            1,
            CONFIG.humanInteraction.actionsPerWait,
        );
        let elapsed = 0;

        for (let i = 0; i < actionCount && elapsed < waitMs; i++) {
            const remaining = waitMs - elapsed;
            const pause = Math.min(
                remaining,
                randomInt(
                    CONFIG.humanInteraction.minPause,
                    CONFIG.humanInteraction.maxPause,
                ),
            );

            await sleep(pause);
            elapsed += pause;

            if (Math.random() < 0.5) {
                clickRandomInputPosition(element, value);
            } else {
                highlightRandomTextRange(element, value);
            }
        }

        const remaining = waitMs - elapsed;
        if (remaining > 0) {
            await sleep(remaining);
        }
    };

    // Run fn over items with limited concurrency
    const parallelMap = async (items, fn, concurrency = 3) => {
        const out = new Array(items.length);
        let idx = 0;
        const worker = async () => {
            while (idx < items.length) {
                const i = idx++;
                out[i] = await fn(items[i], i);
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(concurrency, items.length) }, () =>
                worker(),
            ),
        );
        return out;
    };

    const checkJSONForUsername = (data, username) => {
        try {
            const target = username.trim().toLowerCase();
            const root = data.data || data;

            // Fast path: empty data object means no results
            if (
                !root ||
                (typeof root === "object" &&
                    !Array.isArray(root) &&
                    Object.keys(root).length === 0)
            ) {
                return false;
            }

            const isMatch = (val) =>
                typeof val === "string" && val.trim().toLowerCase() === target;

            // Identity-field keys that hold usernames/handles
            const ID_KEYS = ["handle", "unique_id"];

            const traverse = (obj) => {
                if (!obj) return false;

                if (Array.isArray(obj)) {
                    return obj.some((item) => {
                        if (typeof item === "object" && item !== null) {
                            // Check identity keys on this object
                            for (const k of ID_KEYS) {
                                if (item[k] && isMatch(item[k])) return true;
                            }
                            // Recurse into known nested containers
                            if (
                                item.creator_info &&
                                traverse(item.creator_info)
                            )
                                return true;
                            if (item.author && traverse(item.author))
                                return true;
                        }
                        return false;
                    });
                }

                if (typeof obj === "object") {
                    // Check identity keys on this level too
                    for (const k of ID_KEYS) {
                        if (obj[k] && isMatch(obj[k])) return true;
                    }
                    // Dig into nested objects/arrays only
                    return Object.values(obj).some(
                        (v) =>
                            typeof v === "object" && v !== null && traverse(v),
                    );
                }
                return false;
            };

            return traverse(root);
        } catch (e) {
            console.error("Error analyzing JSON:", e);
            return false;
        }
    };

    const setNativeValue = (element, value) => {
        const valueSetter = Object.getOwnPropertyDescriptor(element, "value")
            ? Object.getOwnPropertyDescriptor(element, "value").set
            : Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype,
                  "value",
              ).set;

        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(
            prototype,
            "value",
        )
            ? Object.getOwnPropertyDescriptor(prototype, "value").set
            : null;

        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else if (valueSetter) {
            valueSetter.call(element, value);
        } else {
            element.value = value;
        }

        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const copyToClipboard = (text) => {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
    };

    // --- Logic ---

    // 1. Target Selector
    const btnTarget = document.getElementById("btn-target");
    const statusLabel = document.getElementById("target-status");
    const btnRun = document.getElementById("btn-run");
    const btnCopy = document.getElementById("btn-copy");

    btnTarget.addEventListener("click", () => {
        const originalText = btnTarget.innerText;
        btnTarget.innerText = "Click the Search Box now...";
        document.body.style.cursor = "crosshair";

        const clickHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const input = e.target.closest("input");

            if (input) {
                targetInput = input;
                targetInput.style.outline = "2px solid #fe2c55";
                statusLabel.innerText = "Input Selected ✅";
                statusLabel.style.color = "green";
                btnTarget.innerText = "Target Set";
                btnRun.style.opacity = "1";
                btnRun.style.pointerEvents = "auto";
            } else {
                statusLabel.innerText = "Failed: Not an input";
                btnTarget.innerText = "Try Again";
            }

            document.body.style.cursor = "default";
        };

        document.addEventListener("click", clickHandler, {
            capture: true,
            once: true,
        });
    });

    // 2. Search Process
    btnRun.addEventListener("click", async () => {
        if (isRunning) return;

        const rawText = document.getElementById("user-list").value;
        const usernames = rawText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);

        if (usernames.length === 0) {
            alert("Please enter at least one username.");
            return;
        }

        if (!targetInput) {
            alert("Please select the search input field first.");
            return;
        }

        isRunning = true;
        results = [];
        btnRun.innerText = "Running...";
        btnRun.style.opacity = "0.7";
        document.getElementById("results-area").style.display = "flex";
        const tbody = document.getElementById("result-tbody");
        tbody.innerHTML = ""; // Clear previous

        // === Helper to add a result row to the UI ===
        const addRow = (user, found) => {
            const row = document.createElement("tr");
            row.style.borderBottom = "1px solid #f0f0f0";
            row.innerHTML = `
                <td style="padding: 6px; color: #333;">${user}</td>
                <td style="padding: 6px; font-weight: bold; color: ${found === true ? "#25c48b" : "#ff4d4f"}">${found}</td>
            `;
            tbody.appendChild(row);
            const c = document.querySelector("#results-area > div:last-child");
            if (c) c.scrollTop = c.scrollHeight;
        };

        let completed = 0;
        const updateProg = (user) => {
            completed++;
            document.getElementById("status-text").innerText =
                `Checked ${completed}/${usernames.length}: ${user}`;
            document.getElementById("progress-fill").style.width =
                `${(completed / usernames.length) * 100}%`;
        };

        // ==========================================
        // Step 1: Trigger ONE UI search to capture the API request pattern
        // ==========================================
        const firstUser = usernames[0];
        document.getElementById("status-text").innerText =
            `Capturing API pattern with: ${firstUser}...`;

        targetInput.focus();
        setNativeValue(targetInput, "");
        setNativeValue(targetInput, firstUser);

        const captureHumanWait = simulateHumanInputWait(
            targetInput,
            firstUser,
            1200,
        );

        // Wait for the fetch interceptor to fire (max 4s)
        const capturedOk = await Promise.race([
            apiEngine.capturePromise,
            sleep(4000).then(() => false),
        ]);
        await captureHumanWait;

        let directMode = false;

        console.log(
            "[Tool] Capture result:",
            capturedOk,
            "| captured:",
            !!apiEngine.captured,
            "| isReady:",
            apiEngine.isReady(),
        );

        if (capturedOk && apiEngine.captured && CONFIG.preferDirectApi) {
            if (apiEngine.isReady()) {
                directMode = await apiEngine.testDirect(firstUser);
                if (directMode) {
                    console.log("[Tool] Direct parallel mode enabled!");
                } else {
                    console.warn(
                        "[Tool] Direct call rejected, falling back to UI mode",
                    );
                }
            } else {
                console.warn(
                    "[Tool] Captured but not ready. parsedBody:",
                    apiEngine.captured.parsedBody,
                );
            }
        } else if (
            capturedOk &&
            apiEngine.captured &&
            !CONFIG.preferDirectApi
        ) {
            console.log(
                "[Tool] Direct API mode skipped because preferDirectApi is disabled.",
            );
        } else {
            console.warn(
                "[Tool] Failed to capture API request. capturedOk:",
                capturedOk,
            );
        }

        // ==========================================
        // FAST PATH: Direct parallel API calls
        // ==========================================
        if (directMode) {
            document.getElementById("status-text").innerText =
                `Direct mode: Processing ${usernames.length} usernames (3 parallel)...`;

            results = await parallelMap(
                usernames,
                async (user) => {
                    let found = false;
                    try {
                        const data = await apiEngine.search(user);
                        found = data ? checkJSONForUsername(data, user) : false;
                    } catch (e) {
                        found = "Error";
                    }
                    addRow(user, found);
                    updateProg(user);
                    return { username: user, found };
                },
                5, // concurrency
            );
        } else {
            // ==========================================
            // SLOW PATH: Sequential UI-based fallback
            // ==========================================
            console.log("[Tool] Using sequential UI mode");

            for (let i = 0; i < usernames.length; i++) {
                const user = usernames[i];
                let found = false;

                try {
                    targetInput.focus();
                    setNativeValue(targetInput, "");
                    setNativeValue(targetInput, user);

                    // Wait for DOM to update while simulating light user activity.
                    await simulateHumanInputWait(targetInput, user, 1500);

                    const menu = document.querySelector(
                        CONFIG.dropdownSelector,
                    );
                    if (menu && menu.offsetParent !== null) {
                        let items = Array.from(
                            menu.querySelectorAll(
                                '[data-tid="m4b_dropdown_menu_item"]',
                            ),
                        );
                        if (items.length === 0) {
                            items = Array.from(
                                menu.querySelectorAll(CONFIG.itemSelector),
                            );
                        }
                        found = items.some((item) => {
                            const handleEl = item.querySelector(
                                ".text-body-m-medium",
                            );
                            if (handleEl) {
                                return (
                                    handleEl.textContent
                                        .trim()
                                        .toLowerCase() === user.toLowerCase()
                                );
                            }
                            const marks = item.querySelectorAll(
                                CONFIG.markSelector,
                            );
                            return Array.from(marks).some(
                                (mark) =>
                                    mark.parentElement.textContent
                                        .trim()
                                        .toLowerCase() === user.toLowerCase(),
                            );
                        });
                    }
                } catch (err) {
                    console.error(err);
                    found = "Error";
                }

                results.push({ username: user, found });
                addRow(user, found);
                updateProg(user);
                await sleep(100);
            }
        }

        // Finish
        document.getElementById("progress-fill").style.width = "100%";
        document.getElementById("status-text").innerText = "Done!";
        btnRun.innerText = "START SEARCH";
        btnRun.style.opacity = "1";
        isRunning = false;

        // Auto Copy
        const tsv = results.map((r) => `${r.username}\t${r.found}`).join("\n");
        copyToClipboard(tsv);
        btnCopy.innerText = "Copied! ✅";
        setTimeout(() => (btnCopy.innerText = "📋 Copy Table"), 3000);
    });

    // 3. Copy Button Logic
    btnCopy.addEventListener("click", () => {
        if (results.length === 0) return;
        const tsv = results.map((r) => `${r.username}\t${r.found}`).join("\n");
        copyToClipboard(tsv);
        btnCopy.innerText = "Copied! ✅";
        setTimeout(() => (btnCopy.innerText = "📋 Copy Table"), 2000);
    });
})();
