/**
 * CodeViz - Interactive Code Visualization Engine
 * Supports C++, C, Java, and Python step-by-step execution visualization
 */

const $ = (id) => document.getElementById(id);
const CODE_KEY = "codeVizCode";
const LANGUAGE_KEY = "codeVizLanguage";
const HISTORY_KEY = "codeVizHistory";

const STARTER_TEMPLATES = {
    cpp: `#include <iostream>
using namespace std;

int main() {
    int x = 10;
    int y = 20;
    int sum = x + y;
    cout << "Sum is: " << sum << endl;
    return 0;
}`,
    c: `#include <stdio.h>

int main() {
    int a = 15;
    int b = 25;
    int total = a + b;
    printf("Total is %d\\n", total);
    return 0;
}`,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 12;
        int y = 18;
        int sum = x + y;
        System.out.println("Sum is " + sum);
    }
}`,
    python: `# Calculate sum of two numbers
x = 10
y = 20
sum = x + y
print("Sum is:", sum)`
};

const FILE_NAMES = {
    cpp: "main.cpp",
    c: "main.c",
    java: "Main.java",
    python: "main.py"
};

// Global Visualizer State
let codeLines = [];
let analysisSteps = [];
let currentStepIndex = 0;
let outputLogs = [];
let autoPlayInterval = null;

function escapeHTML(str) {
    if (typeof str !== "string") str = String(str);
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setStatus(message, color) {
    const statusElem = $("executionStatus");
    if (statusElem) {
        statusElem.textContent = message;
        statusElem.style.color = color || "#38bdf8";
    }
}

// Memory Address Generator
function getSimulatedAddress(varName) {
    let hash = 0;
    for (let i = 0; i < varName.length; i++) {
        hash = (hash << 5) - hash + varName.charCodeAt(i);
        hash |= 0;
    }
    const hex = (Math.abs(hash) % 0xffff).toString(16).padStart(4, '0').toUpperCase();
    return `0x7FF${hex}`;
}

// Expression Evaluator in variable scope
function evaluateExpression(expr, currentVars) {
    if (!expr) return undefined;
    expr = expr.trim();
    if (expr.endsWith(";")) expr = expr.slice(0, -1).trim();

    // String literals
    if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
        return expr.slice(1, -1);
    }
    // Numbers
    if (/^-?\d+(\.\d+)?$/.test(expr)) {
        return Number(expr);
    }
    // Booleans
    if (/^(true|false|True|False)$/i.test(expr)) {
        return expr.toLowerCase() === "true";
    }

    // Direct variable lookup
    if (currentVars[expr] !== undefined) {
        return currentVars[expr].value !== undefined ? currentVars[expr].value : currentVars[expr];
    }

    try {
        const scopeKeys = [];
        const scopeVals = [];
        for (const [k, v] of Object.entries(currentVars)) {
            scopeKeys.push(k);
            scopeVals.push(v && v.value !== undefined ? v.value : v);
        }

        let jsExpr = expr
            .replace(/\band\b/g, "&&")
            .replace(/\bor\b/g, "||")
            .replace(/\bnot\b/g, "!")
            .replace(/\bTrue\b/g, "true")
            .replace(/\bFalse\b/g, "false");

        const fn = new Function(...scopeKeys, `return (${jsExpr});`);
        return fn(...scopeVals);
    } catch (e) {
        return expr;
    }
}

// Step-by-Step Execution Simulator
function generateDetailedSteps(code, lang = "cpp") {
    const rawLines = code.split(/\r?\n/);
    const steps = [];
    const vars = {};
    let pc = 0;
    const MAX_STEPS = 60; // safety limit

    while (pc < rawLines.length && steps.length < MAX_STEPS) {
        const lineNum = pc + 1;
        const line = rawLines[pc];
        const t = line.trim();

        if (!t || t === "}" || t === "{" || t === ");") {
            pc++;
            continue;
        }

        let explanation = `Executing line ${lineNum}: ${t}`;
        let out = null;
        let changedVar = null;

        // Preprocessor / Includes
        if (t.startsWith("#include")) {
            explanation = "Includes standard header library for input/output operations.";
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            pc++;
            continue;
        }

        if (t.startsWith("using namespace std")) {
            explanation = "Declares standard namespace (std) to access standard functions like cout without std:: prefix.";
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            pc++;
            continue;
        }

        // Comments
        if (t.startsWith("//") || (t.startsWith("#") && !t.startsWith("#include") && !t.startsWith("#define")) || t.startsWith("/*")) {
            explanation = "Comment line: Explains code functionality. Ignored during program execution.";
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            pc++;
            continue;
        }

        // Function headers
        if (/^(int\s+main|void\s+main|public\s+class|public\s+static\s+void\s+main|def\s+main)/.test(t)) {
            explanation = "Program execution entry point: Execution begins at main().";
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            pc++;
            continue;
        }

        // Return statement
        if (t.startsWith("return")) {
            const retMatch = t.match(/return\s*(.*?);?$/);
            const val = retMatch && retMatch[1] ? evaluateExpression(retMatch[1], vars) : 0;
            explanation = `Function returns ${val}. Program execution successfully completes.`;
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            break;
        }

        // Output: C++ cout
        if (t.startsWith("cout") || t.includes("cout <<") || t.includes("cout<<")) {
            const parts = t.replace(/^.*?cout\s*<<\s*/, "").replace(/;$/, "").split("<<");
            let lineOut = "";
            for (let part of parts) {
                part = part.trim();
                if (part === "endl" || part === '"\\n"' || part === "'\\n'") {
                    // newline
                } else {
                    const evaluated = evaluateExpression(part, vars);
                    lineOut += (evaluated !== undefined ? evaluated : part);
                }
            }
            out = lineOut;
            explanation = `Evaluates stream expression and outputs "${lineOut}" to the console.`;
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            pc++;
            continue;
        }

        // Output: Python print
        if (t.startsWith("print(") || t.startsWith("print ")) {
            const contentMatch = t.match(/print\s*\((.*)\)/);
            if (contentMatch) {
                const args = contentMatch[1].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
                let lineOut = args.map(arg => {
                    const evaluated = evaluateExpression(arg.trim(), vars);
                    return evaluated !== undefined ? evaluated : arg.trim();
                }).join(" ");
                out = lineOut;
                explanation = `Standard Python print function outputs "${lineOut}" to the console.`;
                steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
                pc++;
                continue;
            }
        }

        // Output: Java System.out.println
        if (t.includes("System.out.println") || t.includes("System.out.print")) {
            const contentMatch = t.match(/System\.out\.print(?:ln)?\s*\((.*)\);?/);
            if (contentMatch) {
                const evaluated = evaluateExpression(contentMatch[1], vars);
                out = String(evaluated !== undefined ? evaluated : contentMatch[1]);
                explanation = `Java System.out prints "${out}" to the standard output.`;
                steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
                pc++;
                continue;
            }
        }

        // Output: C printf
        if (t.startsWith("printf(") || t.includes("printf(")) {
            const contentMatch = t.match(/printf\s*\((.*)\);?/);
            if (contentMatch) {
                const args = contentMatch[1].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
                let formatStr = evaluateExpression(args[0].trim(), vars);
                if (typeof formatStr === "string") {
                    let argIdx = 1;
                    formatStr = formatStr.replace(/%d|%i|%f|%s|%c/g, (match) => {
                        if (argIdx < args.length) {
                            const val = evaluateExpression(args[argIdx++].trim(), vars);
                            return val !== undefined ? val : match;
                        }
                        return match;
                    }).replace(/\\n/g, "");
                    out = formatStr;
                } else {
                    out = String(formatStr);
                }
                explanation = `C standard printf formatted output prints "${out}" to console.`;
                steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
                pc++;
                continue;
            }
        }

        // Variable declaration with type (C, C++, Java): int x = 10;
        if (/^(?:const\s+)?(?:int|float|double|char|string|String|bool|long|auto|var)\s+([a-zA-Z_]\w*)\s*(?:=\s*(.+?))?;?$/.test(t)) {
            const match = t.match(/^(?:const\s+)?([a-zA-Z_]\w*)\s+([a-zA-Z_]\w*)\s*(?:=\s*(.+?))?;?$/);
            const varType = match[1];
            const varName = match[2];
            const rawVal = match[3];
            let val = undefined;
            if (rawVal !== undefined) {
                val = evaluateExpression(rawVal, vars);
            }
            vars[varName] = {
                type: varType,
                value: val,
                address: getSimulatedAddress(varName)
            };
            changedVar = varName;
            explanation = `Variable '${varName}' declared (${varType}) at address ${vars[varName].address}${val !== undefined ? ` with value ${val}` : ""}.`;
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            pc++;
            continue;
        }

        // Variable assignment without type (Python or mutation): x = 10 or sum = x + y
        if (/^([a-zA-Z_]\w*)\s*=\s*(.+?);?$/.test(t)) {
            const match = t.match(/^([a-zA-Z_]\w*)\s*=\s*(.+?);?$/);
            const varName = match[1];
            const rawVal = match[2];
            const val = evaluateExpression(rawVal, vars);
            const inferredType = typeof val === "number" ? (Number.isInteger(val) ? "int" : "float") : (typeof val === "boolean" ? "bool" : "string");

            vars[varName] = {
                type: vars[varName] ? vars[varName].type : inferredType,
                value: val,
                address: vars[varName] ? vars[varName].address : getSimulatedAddress(varName)
            };
            changedVar = varName;
            explanation = `Assigned value ${val} to variable '${varName}' at memory address ${vars[varName].address}.`;
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            pc++;
            continue;
        }

        // Compound assignment: x += 5; x -= 2;
        if (/^([a-zA-Z_]\w*)\s*([+\-*/%]=)\s*(.+?);?$/.test(t)) {
            const match = t.match(/^([a-zA-Z_]\w*)\s*([+\-*/%]=)\s*(.+?);?$/);
            const varName = match[1];
            const op = match[2];
            const operand = evaluateExpression(match[3], vars);
            if (vars[varName]) {
                const oldVal = vars[varName].value;
                const calcExpr = `${oldVal} ${op[0]} ${operand}`;
                try {
                    vars[varName].value = eval(calcExpr);
                } catch(e) {}
                changedVar = varName;
                explanation = `Updated '${varName}' from ${oldVal} to ${vars[varName].value} (${op} ${operand}).`;
                steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            }
            pc++;
            continue;
        }

        // Increments: x++; ++x;
        if (/^([a-zA-Z_]\w*)(\+\+|--);?$/.test(t) || /^(\+\+|--)([a-zA-Z_]\w*);?$/.test(t)) {
            const varName = t.replace(/[;+\-]/g, "").trim();
            if (vars[varName]) {
                const oldVal = vars[varName].value;
                if (t.includes("++")) vars[varName].value = Number(oldVal) + 1;
                else vars[varName].value = Number(oldVal) - 1;
                changedVar = varName;
                explanation = `Incremented/decremented '${varName}' from ${oldVal} to ${vars[varName].value}.`;
                steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            }
            pc++;
            continue;
        }

        // Condition check: if (condition)
        if (/^if\s*\(?(.+?)\)?\s*(?:\{|:)?$/.test(t)) {
            const match = t.match(/^if\s*\(?(.+?)\)?\s*(?:\{|:)?$/);
            const cond = match[1].replace(/\{$/, "").trim();
            const res = evaluateExpression(cond, vars);
            explanation = `Condition check 'if (${cond})': Evaluated to ${res ? "TRUE (Branch taken)" : "FALSE (Branch skipped)"}.`;
            steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
            pc++;
            continue;
        }

        // Fallback step
        steps.push({ line: lineNum, codeText: line, explanation, vars: JSON.parse(JSON.stringify(vars)), out, changedVar });
        pc++;
    }

    return steps;
}

// Lifecycle Initialization
document.addEventListener("DOMContentLoaded", () => {
    initHome();
    initEditor();
    initVisualizer();
    initHistory();
});

// Home Page Controller
function initHome() {
    const runExampleBtn = $("runExampleBtn");
    if (runExampleBtn) {
        runExampleBtn.onclick = (e) => {
            e.preventDefault();
            localStorage.setItem(CODE_KEY, STARTER_TEMPLATES.cpp);
            localStorage.setItem(LANGUAGE_KEY, "cpp");
            window.location.href = "visualizer.html";
        };
    }
}

// Code Editor Controller
function initEditor() {
    const codeInput = $("codeInput"),
          runButton = $("runButton"),
          lineNumbers = $("lineNumbers"),
          langSelect = $("language"),
          fileName = $("fileName");

    if (!codeInput || !runButton) return;

    // Load saved or default language
    const currentLang = localStorage.getItem(LANGUAGE_KEY) || "cpp";
    if (langSelect) langSelect.value = currentLang;
    if (fileName) fileName.textContent = FILE_NAMES[currentLang] || "main.cpp";

    // Set initial code template if empty
    if (!codeInput.value.trim()) {
        const saved = localStorage.getItem(CODE_KEY);
        codeInput.value = saved || STARTER_TEMPLATES[currentLang] || STARTER_TEMPLATES.cpp;
        updateLines(codeInput.value, lineNumbers);
    }

    // Language selection change
    if (langSelect) {
        langSelect.onchange = function() {
            const chosen = this.value;
            if (fileName) fileName.textContent = FILE_NAMES[chosen] || "main.cpp";
            
            // If current text is empty or matches another template, switch to new template
            const currentVal = codeInput.value.trim();
            const isTemplate = Object.values(STARTER_TEMPLATES).some(tmpl => tmpl.trim() === currentVal);
            if (!currentVal || isTemplate) {
                codeInput.value = STARTER_TEMPLATES[chosen] || "";
                updateLines(codeInput.value, lineNumbers);
            }
        };
    }

    codeInput.oninput = () => updateLines(codeInput.value, lineNumbers);
    codeInput.onscroll = () => { if (lineNumbers) lineNumbers.scrollTop = codeInput.scrollTop; };

    // Run Code Button Click
    runButton.onclick = () => {
        const code = codeInput.value.trim();
        if (!code) {
            alert("Please enter some code to visualize.");
            return;
        }

        const selectedLang = langSelect ? langSelect.value : "cpp";
        localStorage.setItem(CODE_KEY, code);
        localStorage.setItem(LANGUAGE_KEY, selectedLang);

        // Record to History
        saveToHistory(FILE_NAMES[selectedLang] || "main.cpp", selectedLang, code);

        window.location.href = "visualizer.html";
    };
}

function updateLines(text, elem) {
    if (!elem) return;
    const count = text.split(/\r?\n/).length;
    elem.textContent = Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1).join("\n");
}

function saveToHistory(file, lang, code) {
    try {
        const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        const entry = {
            id: Date.now(),
            fileName: file,
            language: lang,
            code: code,
            date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ", " + new Date().toLocaleDateString()
        };
        history.unshift(entry);
        if (history.length > 20) history.pop();
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch(e) {}
}

// Visualizer Controller
function initVisualizer() {
    const codeDisplay = $("codeDisplay"),
          nextBtn = $("nextButton"),
          prevBtn = $("previousButton"),
          resetBtn = $("resetButton"),
          autoPlayBtn = $("autoPlayButton"),
          stepCounter = $("stepCounter");

    if (!codeDisplay || !nextBtn) return;

    let savedCode = localStorage.getItem(CODE_KEY);
    let lang = localStorage.getItem(LANGUAGE_KEY) || "cpp";

    // If opened directly without prior code, seed default template
    if (!savedCode || !savedCode.trim()) {
        savedCode = STARTER_TEMPLATES.cpp;
        lang = "cpp";
        localStorage.setItem(CODE_KEY, savedCode);
        localStorage.setItem(LANGUAGE_KEY, lang);
    }

    const langElem = $("currentLanguage");
    if (langElem) langElem.textContent = lang.toUpperCase();

    // Render code line by line
    codeLines = savedCode.split(/\r?\n/);
    codeDisplay.innerHTML = "";
    codeLines.forEach((line, i) => {
        codeDisplay.innerHTML += `
            <div class="code-line-visual" id="visual-line-${i + 1}">
                <span class="code-line-number">${i + 1}</span>
                <span class="code-line-text">${escapeHTML(line) || " "}</span>
            </div>
        `;
    });

    // Parse and generate analysis steps
    analysisSteps = generateDetailedSteps(savedCode, lang);
    currentStepIndex = 0;
    outputLogs = [];

    setStatus("● Ready to execute", "#22c55e");
    updateStepCounter(0, analysisSteps.length);
    if ($("aiExplanationText")) {
        $("aiExplanationText").textContent = "Code loaded and analyzed! Click 'Next Step' or 'Auto Run' to begin execution visualization.";
    }

    // Step Forward
    nextBtn.onclick = () => {
        if (currentStepIndex < analysisSteps.length) {
            updateUI(analysisSteps[currentStepIndex]);
            currentStepIndex++;
            updateStepCounter(currentStepIndex, analysisSteps.length);
        } else {
            setStatus("● Execution Finished", "#22c55e");
            stopAutoPlay();
            if ($("aiExplanationText")) $("aiExplanationText").textContent = "Program execution completed successfully.";
        }
    };

    // Step Backward
    if (prevBtn) {
        prevBtn.onclick = () => {
            stopAutoPlay();
            if (currentStepIndex > 1) {
                currentStepIndex -= 2;
                if (currentStepIndex < 0) currentStepIndex = 0;
                // Replay up to currentStepIndex
                replayToStep(currentStepIndex);
                currentStepIndex++;
                updateStepCounter(currentStepIndex, analysisSteps.length);
            } else if (currentStepIndex === 1) {
                resetVisualizer();
            }
        };
    }

    // Reset Execution
    if (resetBtn) {
        resetBtn.onclick = () => {
            stopAutoPlay();
            resetVisualizer();
        };
    }

    // Auto Run / Pause
    if (autoPlayBtn) {
        autoPlayBtn.onclick = () => {
            if (autoPlayInterval) {
                stopAutoPlay();
            } else {
                startAutoPlay();
            }
        };
    }

    function startAutoPlay() {
        if (autoPlayBtn) autoPlayBtn.innerHTML = "<span>⏸</span> Pause";
        autoPlayInterval = setInterval(() => {
            if (currentStepIndex < analysisSteps.length) {
                updateUI(analysisSteps[currentStepIndex]);
                currentStepIndex++;
                updateStepCounter(currentStepIndex, analysisSteps.length);
            } else {
                setStatus("● Execution Finished", "#22c55e");
                stopAutoPlay();
                if ($("aiExplanationText")) $("aiExplanationText").textContent = "Program execution completed successfully.";
            }
        }, 1200);
    }

    function stopAutoPlay() {
        if (autoPlayInterval) {
            clearInterval(autoPlayInterval);
            autoPlayInterval = null;
        }
        if (autoPlayBtn) autoPlayBtn.innerHTML = "<span>▶</span> Auto Run";
    }

    function resetVisualizer() {
        currentStepIndex = 0;
        outputLogs = [];
        $("outputPanel").innerHTML = `<span class="console-symbol">&gt;</span><span>Program output will appear here.</span>`;
        $("variablesPanel").innerHTML = `<p class="empty-message">No variables yet.</p>`;
        $("memoryPanel").innerHTML = `<p class="empty-message">Memory will appear here.</p>`;
        document.querySelectorAll(".code-line-visual").forEach(r => r.classList.remove("active"));
        if ($("aiExplanationText")) $("aiExplanationText").textContent = "Execution reset. Click 'Next Step' or 'Auto Run' to begin.";
        setStatus("● Ready to execute", "#22c55e");
        updateStepCounter(0, analysisSteps.length);
    }

    function replayToStep(targetIndex) {
        outputLogs = [];
        for (let i = 0; i <= targetIndex; i++) {
            updateUI(analysisSteps[i], false);
        }
    }

    function updateStepCounter(current, total) {
        if (stepCounter) {
            stepCounter.textContent = `Step ${current} / ${total}`;
        }
    }
}

// Update Visualizer UI Elements
function updateUI(step, scroll = true) {
    if (!step) return;

    // Highlight active code line
    document.querySelectorAll(".code-line-visual").forEach(r => r.classList.remove("active"));
    const row = document.getElementById(`visual-line-${step.line}`);
    if (row) {
        row.classList.add("active");
        if (scroll) {
            row.scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    // Update Logic Explanation
    const expElem = $("aiExplanationText");
    if (expElem) {
        expElem.textContent = step.explanation;
        expElem.style.color = "#d8b4fe";
    }
    setStatus(`● Executing Line ${step.line}`, "#38bdf8");

    // Update Variables and Memory panels
    const vPanel = $("variablesPanel"), mPanel = $("memoryPanel");
    if (vPanel && mPanel) {
        vPanel.innerHTML = "";
        mPanel.innerHTML = "";
        let hasVars = false;

        Object.entries(step.vars).forEach(([k, item]) => {
            hasVars = true;
            const val = item.value !== undefined ? item.value : item;
            const type = item.type || typeof val;
            const addr = item.address || getSimulatedAddress(k);
            const isChanged = step.changedVar === k;
            const highlightStyle = isChanged ? 'style="border-color: #38bdf8; background: rgba(56, 189, 248, 0.15);"' : '';

            vPanel.innerHTML += `
                <div class="variable-item" ${highlightStyle}>
                    <span class="variable-name">${escapeHTML(k)} <span style="font-size: 11px; color: #94a3b8;">(${escapeHTML(type)})</span></span>
                    <span class="variable-value">${escapeHTML(String(val))}</span>
                </div>
            `;

            mPanel.innerHTML += `
                <div class="memory-box" ${highlightStyle}>
                    <div>
                        <span class="memory-name">${escapeHTML(k)}</span>
                        <span style="font-size: 11px; color: #64748b; margin-left: 8px;">${addr}</span>
                    </div>
                    <span class="memory-value">${escapeHTML(String(val))}</span>
                </div>
            `;
        });

        if (!hasVars) {
            vPanel.innerHTML = `<p class="empty-message">No variables yet.</p>`;
            mPanel.innerHTML = `<p class="empty-message">Memory will appear here.</p>`;
        }
    }

    // Update Terminal Console Output
    const outPanel = $("outputPanel");
    if (outPanel && step.out !== null && step.out !== undefined) {
        outputLogs.push(step.out);
        outPanel.innerHTML = outputLogs.map(o => `
            <div class="console-line"><span class="console-symbol">&gt;</span> ${escapeHTML(String(o))}</div>
        `).join("");
        outPanel.scrollTop = outPanel.scrollHeight;
    }
}

// History Page Controller
function initHistory() {
    const historyList = $("historyList");
    if (!historyList) return;

    // Attach replay handlers to existing and dynamic rows
    document.querySelectorAll(".replay-btn").forEach(btn => {
        btn.onclick = function() {
            const lang = this.getAttribute("data-lang") || "cpp";
            const code = STARTER_TEMPLATES[lang] || STARTER_TEMPLATES.cpp;
            localStorage.setItem(CODE_KEY, code);
            localStorage.setItem(LANGUAGE_KEY, lang);
            window.location.href = "visualizer.html";
        };
    });

    try {
        const savedHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        if (savedHistory && savedHistory.length > 0) {
            historyList.innerHTML = "";
            savedHistory.forEach(item => {
                const row = document.createElement("div");
                row.className = "history-row";
                row.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 15px; border-bottom: 1px solid var(--border-color); font-size: 14px;";
                row.innerHTML = `
                    <span style="flex: 1; color: var(--text-main); font-family: var(--font-code);">${escapeHTML(item.fileName)}</span>
                    <span style="flex: 1; color: var(--accent-blue); font-weight: 600;">${escapeHTML(item.language.toUpperCase())}</span>
                    <span style="flex: 1; color: var(--text-muted);">${escapeHTML(item.date)}</span>
                    <span style="flex: 1; text-align: right;">
                        <button class="custom-replay-btn run-btn" style="padding: 6px 12px; font-size: 12px;">Replay</button>
                    </span>
                `;
                const repBtn = row.querySelector(".custom-replay-btn");
                repBtn.onclick = () => {
                    localStorage.setItem(CODE_KEY, item.code);
                    localStorage.setItem(LANGUAGE_KEY, item.language);
                    window.location.href = "visualizer.html";
                };
                historyList.appendChild(row);
            });
        }
    } catch(e) {}
}