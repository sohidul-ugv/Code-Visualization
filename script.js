/**
 * CodeViz - Interactive Code Visualization Engine
 * Supports C++, C, Java, and Python step-by-step execution visualization
 * Includes full support for loops (for, while, do-while, range-for),
 * conditionals (if / else if / elif / else, switch), arrays/lists,
 * user-defined functions, and direct line/iteration navigation.
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
    const hex = (Math.abs(hash) % 0xffff).toString(16).padStart(4, "0").toUpperCase();
    return `0x7FF${hex}`;
}

function formatValueForDisplay(val) {
    if (Array.isArray(val)) {
        return `[${val.map(v => formatValueForDisplay(v)).join(", ")}]`;
    }
    if (val === undefined) return "uninitialized";
    if (val === null) return "null";
    return String(val);
}

// Strip comments while preserving string/char literals
function stripInlineComment(line, lang = "cpp") {
    let inSingle = false;
    let inDouble = false;
    let result = "";

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = line[i + 1];

        if (ch === "\\" && (inSingle || inDouble)) {
            result += ch + (next || "");
            i++;
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            result += ch;
            continue;
        }
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            result += ch;
            continue;
        }

        if (!inSingle && !inDouble) {
            if (ch === "/" && next === "/") break;
            if (ch === "/" && next === "*") {
                const closeIdx = line.indexOf("*/", i + 2);
                if (closeIdx !== -1) {
                    i = closeIdx + 1;
                    continue;
                } else {
                    break;
                }
            }
            if (ch === "#" && lang === "python") {
                break;
            }
        }
        result += ch;
    }
    return result;
}

// Split string by delimiter only at top level (outside parens, brackets, braces, quotes)
function splitTopLevel(str, delimiter = ",") {
    const parts = [];
    let current = "";
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === "\\" && (inSingle || inDouble)) {
            current += ch + (str[i + 1] || "");
            i++;
            continue;
        }
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (!inSingle && !inDouble) {
            if (ch === "(") depthParen++;
            else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
            else if (ch === "[") depthBracket++;
            else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
            else if (ch === "{") depthBrace++;
            else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);

            if (
                depthParen === 0 &&
                depthBracket === 0 &&
                depthBrace === 0 &&
                str.slice(i, i + delimiter.length) === delimiter
            ) {
                parts.push(current.trim());
                current = "";
                i += delimiter.length - 1;
                continue;
            }
        }
        current += ch;
    }
    if (current.trim() !== "" || parts.length > 0) {
        parts.push(current.trim());
    }
    return parts;
}

function isIntegerType(typeName) {
    if (!typeName) return false;
    const base = typeName.replace(/\[\]|\*/g, "").trim();
    return /^(?:int|long|short|byte|size_t|unsigned|signed|char|long\s+long|unsigned\s+int|unsigned\s+long)$/.test(base);
}

function coerceToType(val, typeName) {
    if (val === undefined || val === null || Array.isArray(val)) return val;
    if (isIntegerType(typeName) && typeof val === "number" && Number.isFinite(val)) {
        return Math.trunc(val);
    }
    return val;
}

// Convert integer division in expressions where appropriate
function rewriteIntegerDivision(jsExpr, forceAllDivisions = false) {
    // Always convert Python floor division '//' to Math.trunc
    let expr = jsExpr;

    // Helper to replace binary operator op ('//' or '/') with Math.trunc((lhs)/(rhs))
    function replaceDivOp(input, op) {
        let out = input;
        let safety = 0;
        const escapedOp = op === "//" ? "\\/\\/" : "(?<![\\/])\\/(?![\\/])";
        const regex = new RegExp(
            `([a-zA-Z0-9_\\)\\]]+)\\s*${escapedOp}\\s*([+\\-]?[a-zA-Z0-9_\\(\\[]+(?:\\([^()]*\\)|\\[[^\\[\\]]*\\])*)`
        );
        while (safety++ < 25) {
            const match = out.match(regex);
            if (!match) break;
            out = out.replace(regex, "Math.trunc(($1)/($2))");
        }
        return out;
    }

    expr = replaceDivOp(expr, "//");
    if (forceAllDivisions) {
        expr = replaceDivOp(expr, "/");
    }
    return expr;
}

// Expression Evaluator in variable scope
function evaluateExpression(expr, currentVars, lang = "cpp", runtimeCtx = null) {
    if (expr === undefined || expr === null) return undefined;
    expr = String(expr).trim();
    if (expr.endsWith(";")) expr = expr.slice(0, -1).trim();
    if (!expr) return undefined;

    // Strip C-style leading type casts like (int), (double), (float), (long)
    expr = expr.replace(/^\(\s*(?:int|float|double|long|short|char|bool|unsigned)\s*\)\s*/, "");

    // Array / List literal: {1, 2, 3} or [1, 2, 3]
    if (
        (expr.startsWith("{") && expr.endsWith("}")) ||
        (expr.startsWith("[") && expr.endsWith("]"))
    ) {
        const inner = expr.slice(1, -1).trim();
        if (!inner) return [];
        const elems = splitTopLevel(inner, ",");
        return elems.map(el => evaluateExpression(el, currentVars, lang, runtimeCtx));
    }

    // Java array allocation: new int[]{1, 2, 3} or new int[5]
    const javaArrInit = expr.match(/^new\s+[a-zA-Z_]\w*\s*\[\s*\]\s*\{(.*)\}$/);
    if (javaArrInit) {
        const inner = javaArrInit[1].trim();
        if (!inner) return [];
        return splitTopLevel(inner, ",").map(el => evaluateExpression(el, currentVars, lang, runtimeCtx));
    }
    const javaArrAlloc = expr.match(/^new\s+([a-zA-Z_]\w*)\s*\[\s*(.+?)\s*\]$/);
    if (javaArrAlloc) {
        const len = Number(evaluateExpression(javaArrAlloc[2], currentVars, lang, runtimeCtx)) || 0;
        const fillVal = javaArrAlloc[1] === "boolean" ? false : 0;
        return Array(Math.max(0, Math.min(len, 200))).fill(fillVal);
    }

    // Python f-string: f"..." or f'...'
    if ((expr.startsWith('f"') && expr.endsWith('"')) || (expr.startsWith("f'") && expr.endsWith("'"))) {
        const template = expr.slice(2, -1);
        return template.replace(/\{([^{}]+)\}/g, (_, innerExpr) => {
            const val = evaluateExpression(innerExpr.trim(), currentVars, lang, runtimeCtx);
            return val !== undefined ? formatValueForDisplay(val) : innerExpr;
        });
    }

    // String literals
    if (
        (expr.startsWith('"') && expr.endsWith('"') && !expr.slice(1, -1).includes('"')) ||
        (expr.startsWith("'") && expr.endsWith("'") && !expr.slice(1, -1).includes("'"))
    ) {
        return expr.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    }

    // Numbers
    if (/^-?\d+(\.\d+)?[fFlL]?$/.test(expr)) {
        return Number(expr.replace(/[fFlL]$/, ""));
    }

    // Booleans
    if (/^(true|false|True|False)$/.test(expr)) {
        return expr.toLowerCase() === "true";
    }
    if (expr === "None" || expr === "null" || expr === "nullptr" || expr === "NULL") {
        return null;
    }

    // Simulated input expressions (input(), int(input()), sc.nextInt(), etc.)
    if (/\b(?:input\s*\(|nextInt\s*\(|nextDouble\s*\(|nextLine\s*\()/.test(expr)) {
        return 5;
    }

    // Direct variable lookup
    if (currentVars[expr] !== undefined) {
        return currentVars[expr].value !== undefined ? currentVars[expr].value : currentVars[expr];
    }

    // Direct user-defined function calls in expression
    if (runtimeCtx && runtimeCtx.functions) {
        const fnCallMatch = expr.match(/^([a-zA-Z_]\w*)\s*\((.*)\)$/);
        if (fnCallMatch && runtimeCtx.functions.has(fnCallMatch[1])) {
            const fnName = fnCallMatch[1];
            const rawArgs = fnCallMatch[2].trim() ? splitTopLevel(fnCallMatch[2].trim(), ",") : [];
            const argVals = rawArgs.map(a => evaluateExpression(a, currentVars, lang, runtimeCtx));
            return runtimeCtx.callFunction(fnName, argVals);
        }
    }

    try {
        const scopeKeys = [];
        const scopeVals = [];
        let hasFloatVar = false;

        for (const [k, v] of Object.entries(currentVars)) {
            if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)) continue;
            const rawVal = v && v.value !== undefined ? v.value : v;
            scopeKeys.push(k);
            scopeVals.push(rawVal);
            if (v && (v.type === "float" || v.type === "double")) {
                hasFloatVar = true;
            } else if (typeof rawVal === "number" && !Number.isInteger(rawVal)) {
                hasFloatVar = true;
            }
        }

        // Provide common built-in helpers in expression scope
        const builtins = {
            len: (x) => (x && x.length !== undefined ? x.length : 0),
            abs: Math.abs,
            max: Math.max,
            min: Math.min,
            pow: Math.pow,
            sqrt: Math.sqrt,
            round: Math.round,
            floor: Math.floor,
            ceil: Math.ceil,
            int: (x) => Math.trunc(Number(x) || 0),
            float: (x) => Number(x) || 0,
            str: (x) => formatValueForDisplay(x),
            bool: (x) => Boolean(x),
            sizeof: (x) => (Array.isArray(x) ? x.length * 4 : 4)
        };

        for (const [bk, bv] of Object.entries(builtins)) {
            if (!scopeKeys.includes(bk)) {
                scopeKeys.push(bk);
                scopeVals.push(bv);
            }
        }

        // Expose user-defined functions inside complex expressions (e.g. f(n-1) + f(n-2))
        if (runtimeCtx && runtimeCtx.functions) {
            for (const fnName of runtimeCtx.functions.keys()) {
                if (!scopeKeys.includes(fnName)) {
                    scopeKeys.push(fnName);
                    scopeVals.push((...args) => runtimeCtx.callFunction(fnName, args));
                }
            }
        }

        let jsExpr = expr
            .replace(/\band\b/g, "&&")
            .replace(/\bor\b/g, "||")
            .replace(/\bnot\s+/g, "!")
            .replace(/\bTrue\b/g, "true")
            .replace(/\bFalse\b/g, "false")
            .replace(/\bNone\b/g, "null")
            .replace(/\bnullptr\b/g, "null")
            .replace(/\bNULL\b/g, "null")
            .replace(/\.size\s*\(\s*\)/g, ".length")
            .replace(/\.length\s*\(\s*\)/g, ".length")
            .replace(/\bMath\.max\b/g, "max")
            .replace(/\bMath\.min\b/g, "min")
            .replace(/\bMath\.abs\b/g, "abs")
            .replace(/\bMath\.sqrt\b/g, "sqrt")
            .replace(/\bMath\.pow\b/g, "pow")
            .replace(/\bstd::(max|min|abs|sqrt|pow)\b/g, "$1");

        const hasFloatLiteral = /\d+\.\d+|\b(?:float|double)\b/.test(expr);
        const shouldUseIntDiv = lang !== "python" && !hasFloatVar && !hasFloatLiteral;
        jsExpr = rewriteIntegerDivision(jsExpr, shouldUseIntDiv);

        const fn = new Function(...scopeKeys, `return (${jsExpr});`);
        return fn(...scopeVals);
    } catch (e) {
        return expr;
    }
}

// Parse Python range(...) or array/string iterable into an array of items
function evaluateIterable(iterExpr, currentVars, lang, runtimeCtx) {
    const trimmed = iterExpr.trim();
    const rangeMatch = trimmed.match(/^range\s*\((.*)\)$/);
    if (rangeMatch) {
        const args = splitTopLevel(rangeMatch[1], ",").map(a =>
            Number(evaluateExpression(a, currentVars, lang, runtimeCtx))
        );
        let start = 0,
            stop = 0,
            step = 1;
        if (args.length === 1) {
            stop = args[0];
        } else if (args.length === 2) {
            start = args[0];
            stop = args[1];
        } else if (args.length >= 3) {
            start = args[0];
            stop = args[1];
            step = args[2] || 1;
        }
        const result = [];
        const maxLen = 500;
        if (step > 0) {
            for (let v = start; v < stop && result.length < maxLen; v += step) result.push(v);
        } else if (step < 0) {
            for (let v = start; v > stop && result.length < maxLen; v += step) result.push(v);
        }
        return result;
    }

    const evaluated = evaluateExpression(trimmed, currentVars, lang, runtimeCtx);
    if (Array.isArray(evaluated)) return evaluated;
    if (typeof evaluated === "string") return evaluated.split("");
    return [];
}

function getIndent(line) {
    let count = 0;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === " ") count++;
        else if (line[i] === "\t") count += 4;
        else break;
    }
    return count;
}

// Build Structural Block Map for Loops, Conditionals, Switch, and Functions
function buildBlockMap(rawLines, cleanLines, lang) {
    const n = rawLines.length;
    const ifChainsByHeader = new Map(); // headerLine -> { chain, branchIndex }
    const loopsByHeader = new Map(); // headerLine -> loopMeta
    const doWhileByFooter = new Map(); // footerLine -> loopMeta
    const switchByHeader = new Map(); // headerLine -> switchMeta
    const functionsByName = new Map(); // fnName -> fnMeta
    const functionsByHeader = new Map(); // headerLine -> fnMeta

    if (lang === "python") {
        // Helper to find indented block range for line i ending with ':'
        function getPythonBlock(headerIdx) {
            const baseIndent = getIndent(rawLines[headerIdx]);
            const bodyStart = headerIdx + 1;
            let bodyEnd = headerIdx;
            for (let j = headerIdx + 1; j < n; j++) {
                if (!cleanLines[j]) continue;
                const ind = getIndent(rawLines[j]);
                if (ind > baseIndent) {
                    bodyEnd = j;
                } else {
                    break;
                }
            }
            return {
                bodyStart,
                bodyEnd,
                closeLine: bodyEnd,
                afterBlockLine: bodyEnd + 1,
                baseIndent
            };
        }

        const visitedIfHeaders = new Set();

        for (let i = 0; i < n; i++) {
            const t = cleanLines[i];
            if (!t) continue;

            // Function definition: def name(params):
            const defMatch = t.match(/^def\s+([a-zA-Z_]\w*)\s*\((.*)\)\s*:$/);
            if (defMatch) {
                const fnName = defMatch[1];
                const params = defMatch[2].trim()
                    ? splitTopLevel(defMatch[2].trim(), ",").map(p => p.split("=")[0].trim())
                    : [];
                const blk = getPythonBlock(i);
                const meta = {
                    name: fnName,
                    headerLine: i,
                    params,
                    bodyStart: blk.bodyStart,
                    bodyEnd: blk.bodyEnd,
                    afterFuncLine: blk.afterBlockLine
                };
                functionsByName.set(fnName, meta);
                functionsByHeader.set(i, meta);
                continue;
            }

            // Python for loop: for var in iterable:
            const forMatch = t.match(/^for\s+([a-zA-Z_]\w*)\s+in\s+(.+)\s*:$/);
            if (forMatch) {
                const blk = getPythonBlock(i);
                loopsByHeader.set(i, {
                    kind: "for-each",
                    headerLine: i,
                    varName: forMatch[1],
                    iterableExpr: forMatch[2].trim(),
                    bodyStart: blk.bodyStart,
                    bodyEnd: blk.bodyEnd,
                    afterLoopLine: blk.afterBlockLine
                });
                continue;
            }

            // Python while loop: while cond:
            const whileMatch = t.match(/^while\s+(.+)\s*:$/);
            if (whileMatch) {
                const blk = getPythonBlock(i);
                loopsByHeader.set(i, {
                    kind: "while",
                    headerLine: i,
                    condExpr: whileMatch[1].trim(),
                    bodyStart: blk.bodyStart,
                    bodyEnd: blk.bodyEnd,
                    afterLoopLine: blk.afterBlockLine
                });
                continue;
            }

            // Python if / elif / else chain
            const ifMatch = t.match(/^if\s+(.+)\s*:$/);
            if (ifMatch && !visitedIfHeaders.has(i)) {
                const baseIndent = getIndent(rawLines[i]);
                const branches = [];
                let currHeader = i;

                while (currHeader < n) {
                    const ct = cleanLines[currHeader];
                    const blk = getPythonBlock(currHeader);
                    let bType = "if";
                    let condExpr = null;

                    if (ct.startsWith("if ")) {
                        bType = "if";
                        condExpr = ct.replace(/^if\s+/, "").replace(/:$/, "").trim();
                    } else if (ct.startsWith("elif ")) {
                        bType = "elif";
                        condExpr = ct.replace(/^elif\s+/, "").replace(/:$/, "").trim();
                    } else if (/^else\s*:$/.test(ct)) {
                        bType = "else";
                        condExpr = null;
                    } else {
                        break;
                    }

                    visitedIfHeaders.add(currHeader);
                    branches.push({
                        headerLine: currHeader,
                        type: bType,
                        condExpr,
                        bodyStart: blk.bodyStart,
                        bodyEnd: blk.bodyEnd
                    });

                    // Look for next non-empty line to see if it's elif or else at the same indent
                    let nextNonEmpty = blk.afterBlockLine;
                    while (nextNonEmpty < n && !cleanLines[nextNonEmpty]) nextNonEmpty++;
                    if (
                        nextNonEmpty < n &&
                        getIndent(rawLines[nextNonEmpty]) === baseIndent &&
                        (/^elif\s+.+:$/.test(cleanLines[nextNonEmpty]) || /^else\s*:$/.test(cleanLines[nextNonEmpty]))
                    ) {
                        currHeader = nextNonEmpty;
                    } else {
                        break;
                    }
                }

                const chainEndLine = branches[branches.length - 1].bodyEnd + 1;
                const chainObj = { branches, chainEndLine };
                branches.forEach((b, idx) => {
                    ifChainsByHeader.set(b.headerLine, { chain: chainObj, branchIndex: idx });
                });
            }
        }

        return {
            ifChainsByHeader,
            loopsByHeader,
            doWhileByFooter,
            switchByHeader,
            functionsByName,
            functionsByHeader
        };
    }

    // Brace-based languages: C, C++, Java
    const bracePairs = new Map(); // openLine -> closeLine
    const braceStack = [];

    for (let i = 0; i < n; i++) {
        const line = cleanLines[i];
        let inSingle = false;
        let inDouble = false;
        for (let c = 0; c < line.length; c++) {
            const ch = line[c];
            if (ch === "\\" && (inSingle || inDouble)) {
                c++;
                continue;
            }
            if (ch === "'" && !inDouble) inSingle = !inSingle;
            else if (ch === '"' && !inSingle) inDouble = !inDouble;
            else if (!inSingle && !inDouble) {
                if (ch === "{") {
                    braceStack.push(i);
                } else if (ch === "}") {
                    if (braceStack.length > 0) {
                        const openLine = braceStack.pop();
                        if (!bracePairs.has(openLine)) {
                            bracePairs.set(openLine, i);
                        }
                    }
                }
            }
        }
    }

    function getCBlock(headerIdx) {
        if (bracePairs.has(headerIdx)) {
            const closeLine = bracePairs.get(headerIdx);
            return {
                bodyStart: headerIdx + 1,
                bodyEnd: Math.max(headerIdx, closeLine - 1),
                closeLine,
                afterBlockLine: closeLine + 1,
                hasBraces: true
            };
        }
        let nextLine = headerIdx + 1;
        while (nextLine < n && !cleanLines[nextLine]) nextLine++;
        if (nextLine < n && cleanLines[nextLine].startsWith("{") && bracePairs.has(nextLine)) {
            const closeLine = bracePairs.get(nextLine);
            return {
                bodyStart: nextLine + 1,
                bodyEnd: Math.max(nextLine, closeLine - 1),
                closeLine,
                afterBlockLine: closeLine + 1,
                hasBraces: true
            };
        }
        // Braceless single-statement body
        const singleLine = nextLine < n ? nextLine : headerIdx;
        return {
            bodyStart: singleLine,
            bodyEnd: singleLine,
            closeLine: singleLine,
            afterBlockLine: singleLine + 1,
            hasBraces: false
        };
    }

    const visitedIfHeaders = new Set();

    for (let i = 0; i < n; i++) {
        const rawT = cleanLines[i];
        if (!rawT) continue;
        // Strip leading closing brace for lines like '} else if (...) {' or '} else {'
        const t = rawT.replace(/^\}\s*/, "").trim();

        // Function definitions (C/C++/Java)
        const fnDefMatch = t.match(
            /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:inline\s+)?([a-zA-Z_][\w<>[\]*\s]*?)\s+([a-zA-Z_]\w*)\s*\(([^;]*)\)\s*\{?$/
        );
        if (
            fnDefMatch &&
            !/^(?:if|for|while|switch|catch|else|return)$/.test(fnDefMatch[2]) &&
            !/^class\b/.test(t)
        ) {
            const fnName = fnDefMatch[2];
            const paramStr = fnDefMatch[3].trim();
            const params = paramStr && paramStr !== "void"
                ? splitTopLevel(paramStr, ",").map(p => {
                      const tokens = p.trim().replace(/\[.*\]/g, "").replace(/[&*]/g, " ").trim().split(/\s+/);
                      return tokens[tokens.length - 1];
                  })
                : [];
            const blk = getCBlock(i);
            const meta = {
                name: fnName,
                returnType: fnDefMatch[1].trim(),
                headerLine: i,
                params,
                bodyStart: blk.bodyStart,
                bodyEnd: blk.bodyEnd,
                afterFuncLine: blk.afterBlockLine
            };
            functionsByName.set(fnName, meta);
            functionsByHeader.set(i, meta);
            continue;
        }

        // Standard C/C++/Java for loop: for (init; cond; update)
        const forMatch = t.match(/^for\s*\((.*)\)\s*\{?$/);
        if (forMatch) {
            const inside = forMatch[1].trim();
            const blk = getCBlock(i);
            if (inside.includes(";")) {
                const parts = splitTopLevel(inside, ";");
                loopsByHeader.set(i, {
                    kind: "for-c",
                    headerLine: i,
                    initStmt: (parts[0] || "").trim(),
                    condExpr: (parts[1] || "true").trim() || "true",
                    updateStmt: (parts[2] || "").trim(),
                    bodyStart: blk.bodyStart,
                    bodyEnd: blk.bodyEnd,
                    afterLoopLine: blk.afterBlockLine
                });
            } else if (inside.includes(":")) {
                // Range-based for: for (int x : arr)
                const [lhs, rhs] = splitTopLevel(inside, ":");
                const lhsTokens = lhs.trim().split(/\s+/);
                const varName = lhsTokens[lhsTokens.length - 1].replace(/[&*]/g, "");
                loopsByHeader.set(i, {
                    kind: "for-each",
                    headerLine: i,
                    varName,
                    iterableExpr: rhs.trim(),
                    bodyStart: blk.bodyStart,
                    bodyEnd: blk.bodyEnd,
                    afterLoopLine: blk.afterBlockLine
                });
            }
            continue;
        }

        // do-while loop: do { ... } while (cond);
        if (/^do(?:\s*\{)?$/.test(t)) {
            const blk = getCBlock(i);
            let footerLine = blk.closeLine;
            let footerText = cleanLines[footerLine] || "";
            if (!/while\s*\(/.test(footerText)) {
                let nextL = blk.closeLine + 1;
                while (nextL < n && !cleanLines[nextL]) nextL++;
                if (nextL < n && /^while\s*\(/.test(cleanLines[nextL])) {
                    footerLine = nextL;
                    footerText = cleanLines[footerLine];
                }
            }
            const condMatch = footerText.match(/while\s*\((.*)\)\s*;?$/);
            const condExpr = condMatch ? condMatch[1].trim() : "false";
            const loopMeta = {
                kind: "do-while",
                headerLine: i,
                footerLine,
                condExpr,
                bodyStart: blk.bodyStart,
                bodyEnd: Math.max(blk.bodyStart, footerLine - 1),
                afterLoopLine: footerLine + 1
            };
            loopsByHeader.set(i, loopMeta);
            doWhileByFooter.set(footerLine, loopMeta);
            continue;
        }

        // while loop: while (cond) (ignoring do-while footer lines)
        const whileMatch = t.match(/^while\s*\((.*)\)\s*\{?$/);
        if (whileMatch && !doWhileByFooter.has(i) && !rawT.endsWith(";")) {
            const blk = getCBlock(i);
            loopsByHeader.set(i, {
                kind: "while",
                headerLine: i,
                condExpr: whileMatch[1].trim(),
                bodyStart: blk.bodyStart,
                bodyEnd: blk.bodyEnd,
                afterLoopLine: blk.afterBlockLine
            });
            continue;
        }

        // switch statement: switch (expr) { ... }
        const switchMatch = t.match(/^switch\s*\((.*)\)\s*\{?$/);
        if (switchMatch) {
            const blk = getCBlock(i);
            const cases = [];
            let defaultLine = null;
            for (let k = blk.bodyStart; k <= blk.bodyEnd; k++) {
                const kt = cleanLines[k];
                const caseM = kt.match(/^case\s+(.+?)\s*:/);
                if (caseM) {
                    cases.push({ valueExpr: caseM[1].trim(), line: k });
                } else if (/^default\s*:/.test(kt)) {
                    defaultLine = k;
                }
            }
            switchByHeader.set(i, {
                headerLine: i,
                expr: switchMatch[1].trim(),
                cases,
                defaultLine,
                bodyStart: blk.bodyStart,
                bodyEnd: blk.bodyEnd,
                afterSwitchLine: blk.afterBlockLine
            });
            continue;
        }

        // if / else if / else chain
        if (/^if\s*\(/.test(t) && !visitedIfHeaders.has(i)) {
            const branches = [];
            let currHeader = i;

            while (currHeader < n) {
                const currClean = cleanLines[currHeader].replace(/^\}\s*/, "").trim();
                const blk = getCBlock(currHeader);
                let bType = "if";
                let condExpr = null;

                const elifM = currClean.match(/^else\s+if\s*\((.*)\)\s*\{?$/);
                const ifM = currClean.match(/^if\s*\((.*)\)\s*\{?$/);
                const elseM = currClean.match(/^else(?:\s*\{)?$/);

                if (elifM) {
                    bType = "elif";
                    condExpr = elifM[1].trim();
                } else if (ifM) {
                    bType = "if";
                    condExpr = ifM[1].trim();
                } else if (elseM) {
                    bType = "else";
                    condExpr = null;
                } else {
                    break;
                }

                visitedIfHeaders.add(currHeader);
                branches.push({
                    headerLine: currHeader,
                    type: bType,
                    condExpr,
                    bodyStart: blk.bodyStart,
                    bodyEnd: blk.bodyEnd,
                    closeLine: blk.closeLine
                });

                // Check if the closing brace line itself starts the next '} else if' or '} else'
                const closeText = cleanLines[blk.closeLine] || "";
                if (blk.closeLine > currHeader && /^\}\s*else\b/.test(closeText)) {
                    currHeader = blk.closeLine;
                    continue;
                }

                // Or check if the next non-empty line after closeLine starts with 'else'
                let nextNonEmpty = blk.afterBlockLine;
                while (nextNonEmpty < n && !cleanLines[nextNonEmpty]) nextNonEmpty++;
                if (nextNonEmpty < n && /^else\b/.test(cleanLines[nextNonEmpty])) {
                    currHeader = nextNonEmpty;
                    continue;
                }
                break;
            }

            const lastBranch = branches[branches.length - 1];
            const chainEndLine = lastBranch.closeLine + 1;
            const chainObj = { branches, chainEndLine };
            branches.forEach((b, idx) => {
                ifChainsByHeader.set(b.headerLine, { chain: chainObj, branchIndex: idx });
            });
        }
    }

    return {
        ifChainsByHeader,
        loopsByHeader,
        doWhileByFooter,
        switchByHeader,
        functionsByName,
        functionsByHeader
    };
}

// Execute a single non-control statement (declarations, assignments, mutations, outputs)
function executeSimpleStatement(stmt, vars, lang = "cpp", runtimeCtx = null) {
    let t = stmt.trim();
    if (t.endsWith(";")) t = t.slice(0, -1).trim();
    if (!t) return { handled: false };

    let explanation = "";
    let out = null;
    let outNewline = true;
    let changedVars = [];

    // 1. C++ cout
    if (t.startsWith("cout") || t.startsWith("std::cout") || /\bcout\s*<</.test(t)) {
        const streamBody = t.replace(/^.*?\bcout\s*<<\s*/, "");
        const parts = splitTopLevel(streamBody, "<<");
        let lineOut = "";
        let hasEndl = false;

        for (let part of parts) {
            part = part.trim();
            if (part === "endl" || part === "std::endl") {
                hasEndl = true;
            } else if (part === '"\\n"' || part === "'\\n'") {
                hasEndl = true;
            } else {
                const evaluated = evaluateExpression(part, vars, lang, runtimeCtx);
                if (typeof evaluated === "string" && evaluated.endsWith("\n")) {
                    lineOut += evaluated.slice(0, -1);
                    hasEndl = true;
                } else {
                    lineOut += evaluated !== undefined ? formatValueForDisplay(evaluated) : part;
                }
            }
        }
        out = lineOut;
        outNewline = hasEndl;
        explanation = `Evaluates stream expression and outputs "${lineOut}" to the console.`;
        return { handled: true, explanation, out, outNewline, changedVars };
    }

    // 2. C++ cin / C scanf simulated input
    if (t.startsWith("cin") || t.startsWith("std::cin") || /\bcin\s*>>/.test(t)) {
        const targets = splitTopLevel(t.replace(/^.*?\bcin\s*>>\s*/, ""), ">>");
        const assignedDesc = [];
        targets.forEach((varName, idx) => {
            varName = varName.trim();
            if (/^[a-zA-Z_]\w*$/.test(varName)) {
                const existing = vars[varName];
                const defaultVal = existing && existing.value !== undefined ? existing.value : 5 + idx;
                vars[varName] = {
                    type: existing ? existing.type : "int",
                    value: defaultVal,
                    address: existing ? existing.address : getSimulatedAddress(varName)
                };
                changedVars.push(varName);
                assignedDesc.push(`${varName} = ${defaultVal}`);
            }
        });
        explanation = `Reads input from standard input stream (${assignedDesc.join(", ")}).`;
        return { handled: true, explanation, out, outNewline, changedVars };
    }

    if (t.startsWith("scanf(") || t.includes("scanf(")) {
        const m = t.match(/scanf\s*\((.*)\)$/);
        if (m) {
            const args = splitTopLevel(m[1], ",").slice(1);
            const assignedDesc = [];
            args.forEach((arg, idx) => {
                const varName = arg.replace(/^[&\s]+/, "").trim();
                if (/^[a-zA-Z_]\w*$/.test(varName)) {
                    const existing = vars[varName];
                    const defaultVal = existing && existing.value !== undefined ? existing.value : 5 + idx;
                    vars[varName] = {
                        type: existing ? existing.type : "int",
                        value: defaultVal,
                        address: existing ? existing.address : getSimulatedAddress(varName)
                    };
                    changedVars.push(varName);
                    assignedDesc.push(`${varName} = ${defaultVal}`);
                }
            });
            explanation = `Reads formatted input via scanf (${assignedDesc.join(", ")}).`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 3. Python print(...)
    if (t.startsWith("print(") || t.startsWith("print ")) {
        const contentMatch = t.match(/^print\s*\((.*)\)$/);
        if (contentMatch) {
            const rawArgs = contentMatch[1].trim() ? splitTopLevel(contentMatch[1], ",") : [];
            let sep = " ";
            let endStr = "\n";
            const valueArgs = [];

            for (const arg of rawArgs) {
                const kwMatch = arg.match(/^(sep|end)\s*=\s*(.+)$/);
                if (kwMatch) {
                    const kwVal = evaluateExpression(kwMatch[2], vars, lang, runtimeCtx);
                    if (kwMatch[1] === "sep") sep = String(kwVal);
                    if (kwMatch[1] === "end") endStr = String(kwVal);
                } else {
                    const evaluated = evaluateExpression(arg, vars, lang, runtimeCtx);
                    valueArgs.push(evaluated !== undefined ? formatValueForDisplay(evaluated) : arg);
                }
            }
            let lineOut = valueArgs.join(sep);
            if (endStr && endStr !== "\n") {
                lineOut += endStr;
                outNewline = false;
            } else {
                outNewline = endStr === "\n";
            }
            out = lineOut;
            explanation = `Python print() outputs "${lineOut}" to the console.`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 4. Java System.out.println / System.out.print / System.out.printf
    if (t.includes("System.out.print")) {
        const isLn = t.includes("System.out.println");
        const contentMatch = t.match(/System\.out\.print(?:ln|f)?\s*\((.*)\)$/);
        if (contentMatch) {
            const inner = contentMatch[1].trim();
            let lineOut = "";
            if (inner) {
                const evaluated = evaluateExpression(inner, vars, lang, runtimeCtx);
                lineOut = evaluated !== undefined ? formatValueForDisplay(evaluated) : inner;
            }
            out = lineOut;
            outNewline = isLn;
            explanation = `Java System.out outputs "${lineOut}" to standard output.`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 5. C printf(...)
    if (t.startsWith("printf(") || t.includes("printf(")) {
        const contentMatch = t.match(/printf\s*\((.*)\)$/);
        if (contentMatch) {
            const args = splitTopLevel(contentMatch[1], ",");
            let formatStr = evaluateExpression(args[0], vars, lang, runtimeCtx);
            let hasTrailingNewline = false;
            if (typeof formatStr === "string") {
                let argIdx = 1;
                formatStr = formatStr.replace(/%(?:\.\d+)?(?:ld|lld|zu|d|i|u|f|lf|s|c)/g, match => {
                    if (argIdx < args.length) {
                        const val = evaluateExpression(args[argIdx++], vars, lang, runtimeCtx);
                        return val !== undefined ? formatValueForDisplay(val) : match;
                    }
                    return match;
                });
                if (formatStr.endsWith("\n")) {
                    hasTrailingNewline = true;
                    formatStr = formatStr.slice(0, -1);
                }
                out = formatStr;
                outNewline = hasTrailingNewline;
            } else {
                out = formatValueForDisplay(formatStr);
            }
            explanation = `C printf() outputs "${out}" to the console.`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 6. Array / List methods: arr.push_back(x), arr.append(x), arr.pop_back(), arr.pop()
    const pushMatch = t.match(/^([a-zA-Z_]\w*)\.(push_back|append)\s*\((.+)\)$/);
    if (pushMatch && vars[pushMatch[1]] && Array.isArray(vars[pushMatch[1]].value)) {
        const arrName = pushMatch[1];
        const val = evaluateExpression(pushMatch[3], vars, lang, runtimeCtx);
        vars[arrName].value.push(val);
        changedVars.push(arrName);
        explanation = `Appended ${formatValueForDisplay(val)} to '${arrName}' (now ${formatValueForDisplay(vars[arrName].value)}).`;
        return { handled: true, explanation, out, outNewline, changedVars };
    }

    const popMatch = t.match(/^([a-zA-Z_]\w*)\.(pop_back|pop)\s*\(\s*\)$/);
    if (popMatch && vars[popMatch[1]] && Array.isArray(vars[popMatch[1]].value)) {
        const arrName = popMatch[1];
        const removed = vars[arrName].value.pop();
        changedVars.push(arrName);
        explanation = `Removed last element (${formatValueForDisplay(removed)}) from '${arrName}'.`;
        return { handled: true, explanation, out, outNewline, changedVars };
    }

    // 7. C/C++/Java Array Declaration: int arr[5] = {1, 2, 3}; or int[] arr = {1, 2, 3}; or vector<int> arr = {1, 2};
    const arrDeclMatch = t.match(
        /^(?:const\s+)?(int|float|double|long|short|char|bool|boolean|string|String|vector\s*<[^>]+>)\s*(\[\s*\])?\s+([a-zA-Z_]\w*)\s*(?:\[\s*([^\]]*)\s*\])?\s*(?:=\s*(.+))?$/
    );
    if (arrDeclMatch && (arrDeclMatch[2] || arrDeclMatch[4] !== undefined || /^vector/.test(arrDeclMatch[1]))) {
        const baseType = arrDeclMatch[1].replace(/\s+/g, "");
        const varName = arrDeclMatch[3];
        const sizeExpr = arrDeclMatch[4];
        const initExpr = arrDeclMatch[5];

        let arrVal = [];
        if (initExpr !== undefined) {
            const evaluated = evaluateExpression(initExpr, vars, lang, runtimeCtx);
            arrVal = Array.isArray(evaluated) ? evaluated : [evaluated];
        } else if (sizeExpr) {
            const len = Number(evaluateExpression(sizeExpr, vars, lang, runtimeCtx)) || 0;
            arrVal = Array(Math.max(0, Math.min(len, 200))).fill(0);
        }

        if (sizeExpr && initExpr !== undefined) {
            const targetLen = Number(evaluateExpression(sizeExpr, vars, lang, runtimeCtx)) || arrVal.length;
            while (arrVal.length < targetLen && arrVal.length < 200) arrVal.push(0);
        }

        vars[varName] = {
            type: `${baseType}[${arrVal.length}]`,
            value: arrVal,
            address: getSimulatedAddress(varName)
        };
        changedVars.push(varName);
        explanation = `Array '${varName}' (${vars[varName].type}) initialized at ${vars[varName].address} with ${formatValueForDisplay(arrVal)}.`;
        return { handled: true, explanation, out, outNewline, changedVars };
    }

    // 8. Typed Variable Declaration (supports single or comma-separated multi-declarations: int a = 1, b = 2, sum = 0)
    const typedDeclMatch = t.match(
        /^(?:const\s+)?(unsigned\s+long\s+long|long\s+long|unsigned\s+int|unsigned\s+long|int|float|double|char|string|String|bool|boolean|long|short|auto|var|size_t)\s+(.+)$/
    );
    if (typedDeclMatch && !t.includes("(") || (typedDeclMatch && /=/.test(typedDeclMatch[2]))) {
        const varType = typedDeclMatch[1].trim();
        const declarators = splitTopLevel(typedDeclMatch[2], ",");
        const descriptions = [];

        for (const decl of declarators) {
            const dm = decl.match(/^([a-zA-Z_]\w*)\s*(?:=\s*(.+))?$/);
            if (!dm) continue;
            const varName = dm[1];
            const rawVal = dm[2];
            let val = 0;
            if (rawVal !== undefined) {
                val = evaluateExpression(rawVal, vars, lang, runtimeCtx);
                val = coerceToType(val, varType);
            } else if (varType === "string" || varType === "String") {
                val = "";
            } else if (varType === "bool" || varType === "boolean") {
                val = false;
            }
            vars[varName] = {
                type: varType,
                value: val,
                address: getSimulatedAddress(varName)
            };
            changedVars.push(varName);
            descriptions.push(
                rawVal !== undefined
                    ? `'${varName}' = ${formatValueForDisplay(val)}`
                    : `'${varName}' (${varType})`
            );
        }

        if (changedVars.length > 0) {
            explanation =
                changedVars.length === 1
                    ? `Variable ${descriptions[0]} (${varType}) declared at address ${vars[changedVars[0]].address}.`
                    : `Declared ${varType} variables: ${descriptions.join(", ")}.`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 9. Array Element Assignment / Compound Assignment: arr[i] = val; arr[i] += val;
    const arrAssignMatch = t.match(/^([a-zA-Z_]\w*)\s*\[\s*(.+?)\s*\]\s*(=|\+=|-=|\*=|\/=|%=)\s*(.+)$/);
    if (arrAssignMatch) {
        const arrName = arrAssignMatch[1];
        const idxVal = Number(evaluateExpression(arrAssignMatch[2], vars, lang, runtimeCtx));
        const op = arrAssignMatch[3];
        const rhsVal = evaluateExpression(arrAssignMatch[4], vars, lang, runtimeCtx);

        if (vars[arrName] && Array.isArray(vars[arrName].value) && Number.isInteger(idxVal) && idxVal >= 0) {
            const oldVal = vars[arrName].value[idxVal] || 0;
            let newVal = rhsVal;
            if (op === "+=") newVal = oldVal + rhsVal;
            else if (op === "-=") newVal = oldVal - rhsVal;
            else if (op === "*=") newVal = oldVal * rhsVal;
            else if (op === "/=") newVal = Math.trunc(oldVal / rhsVal);
            else if (op === "%=") newVal = oldVal % rhsVal;

            vars[arrName].value[idxVal] = newVal;
            changedVars.push(arrName);
            explanation = `Updated ${arrName}[${idxVal}] from ${formatValueForDisplay(oldVal)} to ${formatValueForDisplay(newVal)}.`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 10. Array Element Increment/Decrement: arr[i]++; arr[i]--;
    const arrIncMatch = t.match(/^([a-zA-Z_]\w*)\s*\[\s*(.+?)\s*\]\s*(\+\+|--)$/);
    if (arrIncMatch) {
        const arrName = arrIncMatch[1];
        const idxVal = Number(evaluateExpression(arrIncMatch[2], vars, lang, runtimeCtx));
        const delta = arrIncMatch[3] === "++" ? 1 : -1;
        if (vars[arrName] && Array.isArray(vars[arrName].value) && Number.isInteger(idxVal) && idxVal >= 0) {
            const oldVal = Number(vars[arrName].value[idxVal]) || 0;
            vars[arrName].value[idxVal] = oldVal + delta;
            changedVars.push(arrName);
            explanation = `Updated ${arrName}[${idxVal}] from ${oldVal} to ${oldVal + delta}.`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 11. Comma-separated updates (e.g. in for-loop headers: i++, j-- or i = 0, j = n - 1)
    if (t.includes(",")) {
        const topCommaParts = splitTopLevel(t, ",");
        // Check if this is Python tuple assignment: a, b = expr1, expr2
        const eqParts = splitTopLevel(t, "=");
        if (
            eqParts.length === 2 &&
            !t.includes("+=") &&
            !t.includes("-=") &&
            !t.includes("*=") &&
            !t.includes("/=") &&
            !t.includes("==")
        ) {
            const lhsTargets = splitTopLevel(eqParts[0], ",");
            const rhsExprs = splitTopLevel(eqParts[1], ",");
            if (lhsTargets.length > 1 && lhsTargets.length === rhsExprs.length) {
                const evaluatedRhs = rhsExprs.map(r => evaluateExpression(r, vars, lang, runtimeCtx));
                const assignDescs = [];
                lhsTargets.forEach((target, idx) => {
                    const val = evaluatedRhs[idx];
                    const arrTargetMatch = target.match(/^([a-zA-Z_]\w*)\s*\[\s*(.+?)\s*\]$/);
                    if (arrTargetMatch) {
                        const aName = arrTargetMatch[1];
                        const aIdx = Number(evaluateExpression(arrTargetMatch[2], vars, lang, runtimeCtx));
                        if (vars[aName] && Array.isArray(vars[aName].value)) {
                            vars[aName].value[aIdx] = val;
                            if (!changedVars.includes(aName)) changedVars.push(aName);
                            assignDescs.push(`${aName}[${aIdx}] = ${formatValueForDisplay(val)}`);
                        }
                    } else if (/^[a-zA-Z_]\w*$/.test(target)) {
                        const existing = vars[target];
                        const inferredType = Array.isArray(val)
                            ? `list[${val.length}]`
                            : typeof val === "number"
                            ? Number.isInteger(val)
                                ? "int"
                                : "float"
                            : typeof val === "boolean"
                            ? "bool"
                            : "string";
                        vars[target] = {
                            type: existing ? existing.type : inferredType,
                            value: existing ? coerceToType(val, existing.type) : val,
                            address: existing ? existing.address : getSimulatedAddress(target)
                        };
                        changedVars.push(target);
                        assignDescs.push(`${target} = ${formatValueForDisplay(vars[target].value)}`);
                    }
                });
                if (assignDescs.length > 0) {
                    explanation = `Simultaneous assignment: ${assignDescs.join(", ")}.`;
                    return { handled: true, explanation, out, outNewline, changedVars };
                }
            }
        }

        // Multiple comma-separated statements (like i++, j--)
        if (topCommaParts.length > 1) {
            const subExplanations = [];
            let allHandled = true;
            for (const part of topCommaParts) {
                const subRes = executeSimpleStatement(part, vars, lang, runtimeCtx);
                if (subRes.handled) {
                    subExplanations.push(subRes.explanation);
                    subRes.changedVars.forEach(v => {
                        if (!changedVars.includes(v)) changedVars.push(v);
                    });
                } else {
                    allHandled = false;
                }
            }
            if (allHandled && subExplanations.length > 0) {
                return {
                    handled: true,
                    explanation: subExplanations.join(" "),
                    out: null,
                    outNewline: true,
                    changedVars
                };
            }
        }
    }

    // 12. Compound Assignment: x += 5; x -= 2; x *= 3; x /= 10; x %= 2; x //= 10;
    const compoundMatch = t.match(/^([a-zA-Z_]\w*)\s*(\+=|-=|\*=|\/\/=|\/=|%=)\s*(.+)$/);
    if (compoundMatch) {
        const varName = compoundMatch[1];
        const op = compoundMatch[2];
        const operand = evaluateExpression(compoundMatch[3], vars, lang, runtimeCtx);
        if (vars[varName] !== undefined) {
            const oldVal = vars[varName].value;
            let newVal = oldVal;
            if (op === "+=") newVal = oldVal + operand;
            else if (op === "-=") newVal = oldVal - operand;
            else if (op === "*=") newVal = oldVal * operand;
            else if (op === "//=") newVal = Math.trunc(oldVal / operand);
            else if (op === "/=") {
                const rawDiv = oldVal / operand;
                newVal = isIntegerType(vars[varName].type) ? Math.trunc(rawDiv) : rawDiv;
            } else if (op === "%=") newVal = oldVal % operand;

            vars[varName].value = coerceToType(newVal, vars[varName].type);
            changedVars.push(varName);
            explanation = `Updated '${varName}' from ${formatValueForDisplay(oldVal)} to ${formatValueForDisplay(vars[varName].value)} (${op} ${formatValueForDisplay(operand)}).`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 13. Increment / Decrement: x++; ++x; x--; --x;
    const incMatch = t.match(/^([a-zA-Z_]\w*)\s*(\+\+|--)$/) || t.match(/^(\+\+|--)\s*([a-zA-Z_]\w*)$/);
    if (incMatch) {
        const isPrefix = incMatch[1] === "++" || incMatch[1] === "--";
        const varName = isPrefix ? incMatch[2] : incMatch[1];
        const op = isPrefix ? incMatch[1] : incMatch[2];
        if (vars[varName] !== undefined) {
            const oldVal = Number(vars[varName].value) || 0;
            const newVal = op === "++" ? oldVal + 1 : oldVal - 1;
            vars[varName].value = newVal;
            changedVars.push(varName);
            explanation = `${op === "++" ? "Incremented" : "Decremented"} '${varName}' from ${oldVal} to ${newVal}.`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    // 14. Standard Assignment (untyped or mutation): x = expr
    const assignMatch = t.match(/^([a-zA-Z_]\w*)\s*=\s*(.+)$/);
    if (assignMatch && !t.includes("==")) {
        const varName = assignMatch[1];
        const rawVal = assignMatch[2];
        let val = evaluateExpression(rawVal, vars, lang, runtimeCtx);
        const existing = vars[varName];
        const inferredType = Array.isArray(val)
            ? `list[${val.length}]`
            : typeof val === "number"
            ? Number.isInteger(val)
                ? "int"
                : "float"
            : typeof val === "boolean"
            ? "bool"
            : "string";
        const targetType = existing ? existing.type : inferredType;
        val = coerceToType(val, targetType);

        vars[varName] = {
            type: Array.isArray(val) ? `list[${val.length}]` : targetType,
            value: val,
            address: existing ? existing.address : getSimulatedAddress(varName)
        };
        changedVars.push(varName);
        explanation = `Assigned ${formatValueForDisplay(val)} to '${varName}' at memory address ${vars[varName].address}.`;
        return { handled: true, explanation, out, outNewline, changedVars };
    }

    // 15. Standalone user-defined function call: myFunc(a, b);
    if (runtimeCtx && runtimeCtx.functions) {
        const callMatch = t.match(/^([a-zA-Z_]\w*)\s*\((.*)\)$/);
        if (callMatch && runtimeCtx.functions.has(callMatch[1])) {
            const fnName = callMatch[1];
            const rawArgs = callMatch[2].trim() ? splitTopLevel(callMatch[2].trim(), ",") : [];
            const argVals = rawArgs.map(a => evaluateExpression(a, vars, lang, runtimeCtx));
            const retVal = runtimeCtx.callFunction(fnName, argVals);
            explanation = `Called function ${fnName}(${argVals.map(v => formatValueForDisplay(v)).join(", ")})${retVal !== undefined ? ` -> returned ${formatValueForDisplay(retVal)}` : ""}.`;
            return { handled: true, explanation, out, outNewline, changedVars };
        }
    }

    return { handled: false };
}

// Step-by-Step Execution Simulator (supports loops, branches, arrays, and functions)
function generateDetailedSteps(code, lang = "cpp") {
    const rawLines = code.split(/\r?\n/);
    const cleanLines = rawLines.map(l => stripInlineComment(l, lang).trim());
    const blockMap = buildBlockMap(rawLines, cleanLines, lang);

    const steps = [];
    const globalVars = {};
    const consoleBuffer = { lines: [""], hasOutput: false };
    const MAX_STEPS = 2000;

    function appendConsoleOutput(text, newline = true) {
        if (text === null || text === undefined) return;
        consoleBuffer.hasOutput = true;
        const segments = String(text).split("\n");
        consoleBuffer.lines[consoleBuffer.lines.length - 1] += segments[0];
        for (let i = 1; i < segments.length; i++) {
            consoleBuffer.lines.push(segments[i]);
        }
        if (newline) {
            consoleBuffer.lines.push("");
        }
    }

    function getConsoleSnapshot() {
        if (!consoleBuffer.hasOutput) return [];
        const lines = consoleBuffer.lines;
        if (lines.length > 1 && lines[lines.length - 1] === "") {
            return lines.slice(0, -1);
        }
        return [...lines];
    }

    function recordStep(lineNum, explanation, scopeVars, changedVars = [], out = null, iterationInfo = null) {
        if (steps.length >= MAX_STEPS) return;
        steps.push({
            line: lineNum,
            codeText: rawLines[lineNum - 1] || "",
            explanation,
            vars: JSON.parse(JSON.stringify(scopeVars)),
            outputLogs: getConsoleSnapshot(),
            out,
            changedVar: changedVars[0] || null,
            changedVars: [...changedVars],
            iterationInfo
        });
    }

    // Execute a range of lines [startPc .. endPc] with a given variable scope
    function runBlockRange(startPc, endPc, scopeVars, isFunctionCall = false) {
        let pc = startPc;
        const loopStack = []; // active loops
        const branchJumpStack = []; // active if/elif/else jumps { bodyEnd, chainEndLine }
        let returnValue = undefined;

        const runtimeCtx = {
            functions: blockMap.functionsByName,
            callFunction: (fnName, argVals) => {
                const fnMeta = blockMap.functionsByName.get(fnName);
                if (!fnMeta || steps.length >= MAX_STEPS) return undefined;
                const localVars = JSON.parse(JSON.stringify(scopeVars));
                const paramDescs = [];
                fnMeta.params.forEach((pName, idx) => {
                    if (!pName) return;
                    const val = argVals[idx] !== undefined ? argVals[idx] : 0;
                    localVars[pName] = {
                        type: typeof val === "number" ? (Number.isInteger(val) ? "int" : "float") : "auto",
                        value: val,
                        address: getSimulatedAddress(`${fnName}_${pName}`)
                    };
                    paramDescs.push(`${pName} = ${formatValueForDisplay(val)}`);
                });
                recordStep(
                    fnMeta.headerLine + 1,
                    `Entering function '${fnName}(${paramDescs.join(", ")})'.`,
                    localVars,
                    fnMeta.params
                );
                return runBlockRange(fnMeta.bodyStart, fnMeta.bodyEnd, localVars, true);
            }
        };

        function getActiveLoopBadge() {
            if (loopStack.length === 0) return null;
            const active = loopStack.filter(l => l.kind !== "switch");
            if (active.length === 0) return null;
            if (active.length === 1) {
                return `Iteration ${active[0].iteration}`;
            }
            return active.map((l, idx) => `L${idx + 1} Iter ${l.iteration}`).join(" · ");
        }

        function resolveNextPc(candidatePc) {
            let nextPc = candidatePc;
            let changed = true;
            while (changed) {
                changed = false;
                while (
                    branchJumpStack.length > 0 &&
                    nextPc > branchJumpStack[branchJumpStack.length - 1].bodyEnd
                ) {
                    const finishedBranch = branchJumpStack.pop();
                    nextPc = finishedBranch.chainEndLine;
                    changed = true;
                }
                if (loopStack.length > 0) {
                    const topLoop = loopStack[loopStack.length - 1];
                    if (topLoop.kind === "switch") {
                        if (nextPc > topLoop.bodyEnd) {
                            loopStack.pop();
                            nextPc = topLoop.afterSwitchLine;
                            changed = true;
                        }
                    } else if (nextPc > topLoop.bodyEnd) {
                        if (topLoop.kind === "do-while") {
                            nextPc = topLoop.footerLine;
                        } else {
                            nextPc = topLoop.headerLine;
                        }
                        break;
                    }
                }
            }
            return nextPc;
        }

        while (pc <= endPc && pc < rawLines.length && steps.length < MAX_STEPS) {
            const lineNum = pc + 1;
            const rawLine = rawLines[pc];
            const rawClean = cleanLines[pc];

            // Skip blank lines or standalone braces
            if (
                !rawClean ||
                rawClean === "{" ||
                rawClean === "}" ||
                rawClean === "});" ||
                rawClean === ");"
            ) {
                pc = resolveNextPc(pc + 1);
                continue;
            }

            // Strip leading closing brace on lines like '} else if (...) {'
            const t = rawClean.replace(/^\}\s*/, "").trim();

            // 1. Preprocessor / Includes / Package / Import
            if (t.startsWith("#include") || t.startsWith("import ") || t.startsWith("from ") || t.startsWith("package ")) {
                recordStep(lineNum, "Includes/imports library dependencies for program operations.", scopeVars);
                pc = resolveNextPc(pc + 1);
                continue;
            }

            if (t.startsWith("using namespace std")) {
                recordStep(
                    lineNum,
                    "Declares standard namespace (std) to access standard library symbols like cout and endl.",
                    scopeVars
                );
                pc = resolveNextPc(pc + 1);
                continue;
            }

            // 2. Full-line comments
            const trimmedRaw = rawLine.trim();
            if (
                trimmedRaw.startsWith("//") ||
                trimmedRaw.startsWith("/*") ||
                trimmedRaw.startsWith("*") ||
                (trimmedRaw.startsWith("#") && !trimmedRaw.startsWith("#include") && !trimmedRaw.startsWith("#define"))
            ) {
                recordStep(lineNum, "Comment line: Explains code logic and is ignored during execution.", scopeVars);
                pc = resolveNextPc(pc + 1);
                continue;
            }

            // 3. Class header or main() entry point
            if (/^(?:public\s+)?class\s+\w+/.test(t)) {
                recordStep(lineNum, "Defines program class container.", scopeVars);
                pc = resolveNextPc(pc + 1);
                continue;
            }

            if (/^(?:int\s+main|void\s+main|public\s+static\s+void\s+main)/.test(t)) {
                recordStep(lineNum, "Program execution entry point: Execution begins at main().", scopeVars);
                pc = resolveNextPc(pc + 1);
                continue;
            }

            // Skip non-main function definitions during top-level scan until called
            if (!isFunctionCall && blockMap.functionsByHeader.has(pc)) {
                const fnMeta = blockMap.functionsByHeader.get(pc);
                if (fnMeta.name !== "main") {
                    recordStep(
                        lineNum,
                        `Function '${fnMeta.name}(${fnMeta.params.join(", ")})' registered and ready to be called.`,
                        scopeVars
                    );
                    pc = resolveNextPc(fnMeta.afterFuncLine);
                    continue;
                }
            }

            // 4. break and continue inside loops / switch
            if (/^break\s*;?$/.test(t)) {
                if (loopStack.length > 0) {
                    const exited = loopStack.pop();
                    while (
                        branchJumpStack.length > 0 &&
                        branchJumpStack[branchJumpStack.length - 1].bodyEnd <= exited.bodyEnd
                    ) {
                        branchJumpStack.pop();
                    }
                    const targetLine = exited.kind === "switch" ? exited.afterSwitchLine : exited.afterLoopLine;
                    recordStep(
                        lineNum,
                        exited.kind === "switch"
                            ? "Break statement: Exits the switch block."
                            : `Break statement: Terminates loop early at iteration ${exited.iteration}.`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    pc = resolveNextPc(targetLine);
                    continue;
                }
            }

            if (/^continue\s*;?$/.test(t)) {
                let targetLoop = null;
                for (let i = loopStack.length - 1; i >= 0; i--) {
                    if (loopStack[i].kind !== "switch") {
                        targetLoop = loopStack[i];
                        break;
                    }
                }
                if (targetLoop) {
                    while (
                        branchJumpStack.length > 0 &&
                        branchJumpStack[branchJumpStack.length - 1].bodyEnd <= targetLoop.bodyEnd
                    ) {
                        branchJumpStack.pop();
                    }
                    recordStep(
                        lineNum,
                        `Continue statement: Skips remaining statements in iteration ${targetLoop.iteration} and jumps to next iteration check.`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    pc = targetLoop.kind === "do-while" ? targetLoop.footerLine : targetLoop.headerLine;
                    continue;
                }
            }

            // 5. Return statement
            if (/^return(?:\s+.*)?;$|^return(?:\s+.*)?$/.test(t)) {
                const retMatch = t.match(/^return\s*(.*?);?$/);
                const val =
                    retMatch && retMatch[1]
                        ? evaluateExpression(retMatch[1], scopeVars, lang, runtimeCtx)
                        : 0;
                returnValue = val;
                recordStep(
                    lineNum,
                    isFunctionCall
                        ? `Function returns ${formatValueForDisplay(val)} to caller.`
                        : `Function returns ${formatValueForDisplay(val)}. Program execution completes.`,
                    scopeVars,
                    [],
                    null,
                    getActiveLoopBadge()
                );
                return returnValue;
            }

            // 6. Do-While Footer Check: } while (cond);
            if (blockMap.doWhileByFooter.has(pc)) {
                const loopMeta = blockMap.doWhileByFooter.get(pc);
                const activeLoop =
                    loopStack.length > 0 && loopStack[loopStack.length - 1].headerLine === loopMeta.headerLine
                        ? loopStack[loopStack.length - 1]
                        : null;
                const condRes = Boolean(evaluateExpression(loopMeta.condExpr, scopeVars, lang, runtimeCtx));
                if (condRes) {
                    if (activeLoop) activeLoop.iteration++;
                    recordStep(
                        lineNum,
                        `Do-while condition '(${loopMeta.condExpr})' evaluated to TRUE — repeating loop (Iteration ${activeLoop ? activeLoop.iteration : 2}).`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    pc = loopMeta.bodyStart;
                } else {
                    if (activeLoop) loopStack.pop();
                    recordStep(
                        lineNum,
                        `Do-while condition '(${loopMeta.condExpr})' evaluated to FALSE — exiting loop.`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    pc = resolveNextPc(loopMeta.afterLoopLine);
                }
                continue;
            }

            // 7. Loop Headers (for-c, for-each, while, do-while)
            if (blockMap.loopsByHeader.has(pc)) {
                const loopMeta = blockMap.loopsByHeader.get(pc);
                const topLoop = loopStack.length > 0 ? loopStack[loopStack.length - 1] : null;
                const isReentry = topLoop && topLoop.headerLine === pc;

                if (loopMeta.kind === "for-c") {
                    if (!isReentry) {
                        // First entry: execute init statement, then check condition
                        let initChanged = [];
                        let initDesc = "";
                        if (loopMeta.initStmt) {
                            const initRes = executeSimpleStatement(loopMeta.initStmt, scopeVars, lang, runtimeCtx);
                            if (initRes.handled) {
                                initChanged = initRes.changedVars;
                                initDesc = initRes.explanation.replace(/\.$/, "");
                            }
                        }
                        const condRes = Boolean(evaluateExpression(loopMeta.condExpr, scopeVars, lang, runtimeCtx));
                        if (condRes) {
                            loopStack.push({
                                ...loopMeta,
                                iteration: 1
                            });
                            recordStep(
                                lineNum,
                                `For-loop initialized${initDesc ? ` (${loopMeta.initStmt})` : ""}. Condition '(${loopMeta.condExpr})' is TRUE — entering Iteration 1.`,
                                scopeVars,
                                initChanged,
                                null,
                                getActiveLoopBadge()
                            );
                            pc = loopMeta.bodyStart;
                        } else {
                            recordStep(
                                lineNum,
                                `For-loop initialized${initDesc ? ` (${loopMeta.initStmt})` : ""}. Condition '(${loopMeta.condExpr})' is FALSE — skipping loop.`,
                                scopeVars,
                                initChanged,
                                null,
                                getActiveLoopBadge()
                            );
                            pc = resolveNextPc(loopMeta.afterLoopLine);
                        }
                    } else {
                        // Re-entry after body: execute update statement, then check condition
                        let updChanged = [];
                        if (loopMeta.updateStmt) {
                            const updRes = executeSimpleStatement(loopMeta.updateStmt, scopeVars, lang, runtimeCtx);
                            if (updRes.handled) {
                                updChanged = updRes.changedVars;
                            }
                        }
                        const condRes = Boolean(evaluateExpression(loopMeta.condExpr, scopeVars, lang, runtimeCtx));
                        if (condRes) {
                            topLoop.iteration++;
                            const updVarSummary = updChanged
                                .map(v => `${v} = ${formatValueForDisplay(scopeVars[v]?.value)}`)
                                .join(", ");
                            recordStep(
                                lineNum,
                                `For-loop update (${loopMeta.updateStmt}${updVarSummary ? ` → ${updVarSummary}` : ""}). Condition '(${loopMeta.condExpr})' is TRUE — continuing to Iteration ${topLoop.iteration}.`,
                                scopeVars,
                                updChanged,
                                null,
                                getActiveLoopBadge()
                            );
                            pc = loopMeta.bodyStart;
                        } else {
                            const updVarSummary = updChanged
                                .map(v => `${v} = ${formatValueForDisplay(scopeVars[v]?.value)}`)
                                .join(", ");
                            loopStack.pop();
                            recordStep(
                                lineNum,
                                `For-loop update (${loopMeta.updateStmt}${updVarSummary ? ` → ${updVarSummary}` : ""}). Condition '(${loopMeta.condExpr})' is FALSE — exiting loop.`,
                                scopeVars,
                                updChanged,
                                null,
                                getActiveLoopBadge()
                            );
                            pc = resolveNextPc(loopMeta.afterLoopLine);
                        }
                    }
                    continue;
                }

                if (loopMeta.kind === "for-each") {
                    if (!isReentry) {
                        const items = evaluateIterable(loopMeta.iterableExpr, scopeVars, lang, runtimeCtx);
                        if (items.length > 0) {
                            const firstVal = items[0];
                            scopeVars[loopMeta.varName] = {
                                type: typeof firstVal === "number" ? (Number.isInteger(firstVal) ? "int" : "float") : "string",
                                value: firstVal,
                                address: getSimulatedAddress(loopMeta.varName)
                            };
                            loopStack.push({
                                ...loopMeta,
                                items,
                                index: 0,
                                iteration: 1
                            });
                            recordStep(
                                lineNum,
                                `For-loop Iteration 1 of ${items.length}: '${loopMeta.varName}' set to ${formatValueForDisplay(firstVal)}.`,
                                scopeVars,
                                [loopMeta.varName],
                                null,
                                getActiveLoopBadge()
                            );
                            pc = loopMeta.bodyStart;
                        } else {
                            recordStep(
                                lineNum,
                                `For-loop sequence '${loopMeta.iterableExpr}' is empty — skipping loop.`,
                                scopeVars,
                                [],
                                null,
                                getActiveLoopBadge()
                            );
                            pc = resolveNextPc(loopMeta.afterLoopLine);
                        }
                    } else {
                        topLoop.index++;
                        if (topLoop.index < topLoop.items.length) {
                            topLoop.iteration++;
                            const nextVal = topLoop.items[topLoop.index];
                            scopeVars[loopMeta.varName] = {
                                type: scopeVars[loopMeta.varName]?.type || "int",
                                value: nextVal,
                                address: scopeVars[loopMeta.varName]?.address || getSimulatedAddress(loopMeta.varName)
                            };
                            recordStep(
                                lineNum,
                                `For-loop Iteration ${topLoop.iteration} of ${topLoop.items.length}: '${loopMeta.varName}' updated to ${formatValueForDisplay(nextVal)}.`,
                                scopeVars,
                                [loopMeta.varName],
                                null,
                                getActiveLoopBadge()
                            );
                            pc = loopMeta.bodyStart;
                        } else {
                            const totalDone = topLoop.items.length;
                            loopStack.pop();
                            recordStep(
                                lineNum,
                                `For-loop completed all ${totalDone} iteration(s) — exiting loop.`,
                                scopeVars,
                                [],
                                null,
                                getActiveLoopBadge()
                            );
                            pc = resolveNextPc(loopMeta.afterLoopLine);
                        }
                    }
                    continue;
                }

                if (loopMeta.kind === "while") {
                    const condRes = Boolean(evaluateExpression(loopMeta.condExpr, scopeVars, lang, runtimeCtx));
                    if (condRes) {
                        if (!isReentry) {
                            loopStack.push({
                                ...loopMeta,
                                iteration: 1
                            });
                        } else {
                            topLoop.iteration++;
                        }
                        const currIter = loopStack[loopStack.length - 1].iteration;
                        recordStep(
                            lineNum,
                            `While-loop condition '(${loopMeta.condExpr})' is TRUE — ${currIter === 1 ? "entering Iteration 1" : `continuing to Iteration ${currIter}`}.`,
                            scopeVars,
                            [],
                            null,
                            getActiveLoopBadge()
                        );
                        pc = loopMeta.bodyStart;
                    } else {
                        if (isReentry) loopStack.pop();
                        recordStep(
                            lineNum,
                            `While-loop condition '(${loopMeta.condExpr})' is FALSE — exiting loop.`,
                            scopeVars,
                            [],
                            null,
                            getActiveLoopBadge()
                        );
                        pc = resolveNextPc(loopMeta.afterLoopLine);
                    }
                    continue;
                }

                if (loopMeta.kind === "do-while") {
                    if (!isReentry) {
                        loopStack.push({
                            ...loopMeta,
                            iteration: 1
                        });
                    }
                    recordStep(
                        lineNum,
                        `Entering do-while loop body (Iteration ${loopStack[loopStack.length - 1].iteration}).`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    pc = loopMeta.bodyStart;
                    continue;
                }
            }

            // 8. Switch Statement Header
            if (blockMap.switchByHeader.has(pc)) {
                const swMeta = blockMap.switchByHeader.get(pc);
                const swVal = evaluateExpression(swMeta.expr, scopeVars, lang, runtimeCtx);
                let matchedLine = null;
                let matchedLabel = "";

                for (const c of swMeta.cases) {
                    const cVal = evaluateExpression(c.valueExpr, scopeVars, lang, runtimeCtx);
                    if (cVal === swVal) {
                        matchedLine = c.line;
                        matchedLabel = `case ${c.valueExpr}`;
                        break;
                    }
                }
                if (matchedLine === null && swMeta.defaultLine !== null) {
                    matchedLine = swMeta.defaultLine;
                    matchedLabel = "default";
                }

                if (matchedLine !== null) {
                    loopStack.push({
                        kind: "switch",
                        headerLine: pc,
                        bodyEnd: swMeta.bodyEnd,
                        afterSwitchLine: swMeta.afterSwitchLine,
                        iteration: 1
                    });
                    recordStep(
                        lineNum,
                        `Switch expression '(${swMeta.expr})' evaluated to ${formatValueForDisplay(swVal)} — jumping to ${matchedLabel}.`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    pc = matchedLine + 1;
                } else {
                    recordStep(
                        lineNum,
                        `Switch expression '(${swMeta.expr})' evaluated to ${formatValueForDisplay(swVal)} — no matching case found.`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    pc = resolveNextPc(swMeta.afterSwitchLine);
                }
                continue;
            }

            // Skip switch case/default labels during fallthrough
            if (/^(?:case\s+.+:|default\s*:)$/.test(t)) {
                pc = resolveNextPc(pc + 1);
                continue;
            }

            // 9. Conditionals: if / else if / elif / else chains
            if (blockMap.ifChainsByHeader.has(pc)) {
                const { chain, branchIndex } = blockMap.ifChainsByHeader.get(pc);
                const branch = chain.branches[branchIndex];

                if (branch.type === "else") {
                    recordStep(
                        lineNum,
                        "Entering 'else' branch because all preceding condition(s) evaluated to FALSE.",
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    branchJumpStack.push({
                        bodyEnd: branch.bodyEnd,
                        chainEndLine: chain.chainEndLine
                    });
                    pc = resolveNextPc(branch.bodyStart);
                    continue;
                }

                const condRes = Boolean(evaluateExpression(branch.condExpr, scopeVars, lang, runtimeCtx));
                const keywordLabel = branch.type === "elif" ? (lang === "python" ? "elif" : "else if") : "if";

                if (condRes) {
                    recordStep(
                        lineNum,
                        `Condition '${keywordLabel} (${branch.condExpr})' evaluated to TRUE (branch taken).`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    branchJumpStack.push({
                        bodyEnd: branch.bodyEnd,
                        chainEndLine: chain.chainEndLine
                    });
                    pc = resolveNextPc(branch.bodyStart);
                } else {
                    const nextBranch = chain.branches[branchIndex + 1];
                    recordStep(
                        lineNum,
                        `Condition '${keywordLabel} (${branch.condExpr})' evaluated to FALSE (branch skipped).`,
                        scopeVars,
                        [],
                        null,
                        getActiveLoopBadge()
                    );
                    if (nextBranch) {
                        pc = nextBranch.headerLine;
                    } else {
                        pc = resolveNextPc(chain.chainEndLine);
                    }
                }
                continue;
            }

            // 10. Simple Statements (Declarations, Assignments, Increments, Outputs, Function Calls)
            const stmtRes = executeSimpleStatement(t, scopeVars, lang, runtimeCtx);
            if (stmtRes.handled) {
                if (stmtRes.out !== null && stmtRes.out !== undefined) {
                    appendConsoleOutput(stmtRes.out, stmtRes.outNewline);
                }
                recordStep(
                    lineNum,
                    stmtRes.explanation,
                    scopeVars,
                    stmtRes.changedVars,
                    stmtRes.out,
                    getActiveLoopBadge()
                );
                pc = resolveNextPc(pc + 1);
                continue;
            }

            // Fallback step for unrecognized lines
            recordStep(lineNum, `Executing line ${lineNum}: ${t}`, scopeVars, [], null, getActiveLoopBadge());
            pc = resolveNextPc(pc + 1);
        }

        return returnValue;
    }

    runBlockRange(0, rawLines.length - 1, globalVars, false);
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
        runExampleBtn.onclick = e => {
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
        langSelect.onchange = function () {
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
    codeInput.onscroll = () => {
        if (lineNumbers) lineNumbers.scrollTop = codeInput.scrollTop;
    };

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
            date:
                new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
                ", " +
                new Date().toLocaleDateString()
        };
        history.unshift(entry);
        if (history.length > 20) history.pop();
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {}
}

// Visualizer Controller
function initVisualizer() {
    const codeDisplay = $("codeDisplay"),
        nextBtn = $("nextButton"),
        prevBtn = $("previousButton"),
        resetBtn = $("resetButton"),
        autoPlayBtn = $("autoPlayButton"),
        stepCounter = $("stepCounter"),
        lineJumpInput = $("lineJumpInput"),
        lineJumpBtn = $("lineJumpButton");

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

    // Parse and generate analysis steps first so we know line execution occurrences
    analysisSteps = generateDetailedSteps(savedCode, lang);
    currentStepIndex = 0;
    outputLogs = [];

    // Count how many times each line is executed (helpful for loops)
    const lineStepIndices = new Map();
    analysisSteps.forEach((step, idx) => {
        if (!lineStepIndices.has(step.line)) {
            lineStepIndices.set(step.line, []);
        }
        lineStepIndices.get(step.line).push(idx);
    });

    // Render code line by line
    codeLines = savedCode.split(/\r?\n/);
    codeDisplay.innerHTML = "";
    codeLines.forEach((line, i) => {
        const lineNum = i + 1;
        const occurrences = lineStepIndices.get(lineNum) || [];
        const row = document.createElement("div");
        row.className = "code-line-visual";
        row.id = `visual-line-${lineNum}`;
        row.dataset.line = lineNum;
        row.title =
            occurrences.length > 1
                ? `Line ${lineNum} executes ${occurrences.length} times (click to jump / cycle through iterations)`
                : `Click to jump directly to line ${lineNum}`;
        row.innerHTML = `
            <span class="code-line-number">${lineNum}</span>
            <span class="code-line-text">${escapeHTML(line) || " "}</span>
        `;
        row.onclick = () => jumpToLine(lineNum);
        codeDisplay.appendChild(row);
    });

    if (lineJumpInput) {
        lineJumpInput.max = codeLines.length;
        lineJumpInput.onkeydown = e => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleLineJumpInput();
            }
        };
    }

    if (lineJumpBtn) {
        lineJumpBtn.onclick = handleLineJumpInput;
    }

    function handleLineJumpInput() {
        if (!lineJumpInput) return;
        const targetLine = parseInt(lineJumpInput.value, 10);
        if (isNaN(targetLine) || targetLine < 1 || targetLine > codeLines.length) {
            setStatus(`● Enter line 1–${codeLines.length}`, "#f59e0b");
            return;
        }
        jumpToLine(targetLine);
    }

    setStatus("● Ready to execute", "#22c55e");
    updateStepCounter(0, analysisSteps.length);
    if ($("aiExplanationText")) {
        $("aiExplanationText").textContent =
            "Code loaded and analyzed! Click any line of code to jump directly, or use 'Next Step' / 'Auto Run'.";
    }

    // Direct jump to any specific line of code (cycles through iterations if clicked repeatedly on a loop line)
    function jumpToLine(lineNumber) {
        if (lineNumber < 1 || lineNumber > codeLines.length) return;
        stopAutoPlay();
        if (lineJumpInput) lineJumpInput.value = lineNumber;

        const matchingIndices = lineStepIndices.get(lineNumber) || [];
        if (matchingIndices.length > 0) {
            const activeIdx = currentStepIndex - 1;
            const posInMatches = matchingIndices.indexOf(activeIdx);
            // If already viewing an occurrence of this line, advance to the next occurrence (wrapping around)
            const chosenMatchPos =
                posInMatches !== -1 ? (posInMatches + 1) % matchingIndices.length : 0;
            const targetStepIdx = matchingIndices[chosenMatchPos];

            replayToStep(targetStepIdx, true);
            currentStepIndex = targetStepIdx + 1;
            updateStepCounter(currentStepIndex, analysisSteps.length);

            if (matchingIndices.length > 1) {
                setStatus(
                    `● Line ${lineNumber} (Occurrence ${chosenMatchPos + 1}/${matchingIndices.length})`,
                    "#38bdf8"
                );
            }
            return;
        }

        // Line is a non-step line (e.g., blank line or block brace '{' / '}')
        let prevStepIdx = -1;
        for (let i = 0; i < analysisSteps.length; i++) {
            if (analysisSteps[i].line < lineNumber) {
                prevStepIdx = i;
            }
        }

        const prevStep = prevStepIdx >= 0 ? analysisSteps[prevStepIdx] : null;
        const rawText = (codeLines[lineNumber - 1] || "").trim();
        const lineExplanation = rawText
            ? `Line ${lineNumber} ('${rawText}'): Structural block delimiter. Showing program state at this point.`
            : `Line ${lineNumber}: Empty line (no operation). Showing program state at this point.`;

        const syntheticStep = {
            line: lineNumber,
            codeText: codeLines[lineNumber - 1] || "",
            explanation: lineExplanation,
            vars: prevStep ? prevStep.vars : {},
            outputLogs: prevStep ? prevStep.outputLogs : [],
            out: null,
            changedVar: null,
            changedVars: []
        };

        updateUI(syntheticStep, true);
        currentStepIndex = prevStepIdx + 1;
        updateStepCounter(currentStepIndex, analysisSteps.length);
    }

    // Step Forward
    nextBtn.onclick = () => {
        if (currentStepIndex < analysisSteps.length) {
            replayToStep(currentStepIndex, true);
            currentStepIndex++;
            updateStepCounter(currentStepIndex, analysisSteps.length);
        } else {
            setStatus("● Execution Finished", "#22c55e");
            stopAutoPlay();
            if ($("aiExplanationText")) {
                $("aiExplanationText").textContent = "Program execution completed successfully.";
            }
        }
    };

    // Step Backward
    if (prevBtn) {
        prevBtn.onclick = () => {
            stopAutoPlay();
            if (currentStepIndex > 1) {
                currentStepIndex -= 2;
                if (currentStepIndex < 0) currentStepIndex = 0;
                replayToStep(currentStepIndex, true);
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
                replayToStep(currentStepIndex, true);
                currentStepIndex++;
                updateStepCounter(currentStepIndex, analysisSteps.length);
            } else {
                setStatus("● Execution Finished", "#22c55e");
                stopAutoPlay();
                if ($("aiExplanationText")) {
                    $("aiExplanationText").textContent = "Program execution completed successfully.";
                }
            }
        }, 900);
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
        if (lineJumpInput) lineJumpInput.value = "";
        $("outputPanel").innerHTML =
            `<span class="console-symbol">&gt;</span><span>Program output will appear here.</span>`;
        $("variablesPanel").innerHTML = `<p class="empty-message">No variables yet.</p>`;
        $("memoryPanel").innerHTML = `<p class="empty-message">Memory will appear here.</p>`;
        document.querySelectorAll(".code-line-visual").forEach(r => r.classList.remove("active"));
        if ($("aiExplanationText")) {
            $("aiExplanationText").textContent =
                "Execution reset. Click any line of code to jump directly, or click 'Next Step' / 'Auto Run'.";
        }
        setStatus("● Ready to execute", "#22c55e");
        updateStepCounter(0, analysisSteps.length);
    }

    function replayToStep(targetIndex, scroll = false) {
        const step = analysisSteps[targetIndex];
        if (!step) return;
        updateUI(step, scroll);
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

    const lineJumpInput = $("lineJumpInput");
    if (lineJumpInput) {
        lineJumpInput.value = step.line;
    }

    // Update Logic Explanation
    const expElem = $("aiExplanationText");
    if (expElem) {
        expElem.textContent = step.iterationInfo
            ? `[${step.iterationInfo}] ${step.explanation}`
            : step.explanation;
        expElem.style.color = "#d8b4fe";
    }

    const statusLabel = step.iterationInfo
        ? `● Line ${step.line} (${step.iterationInfo})`
        : `● Executing Line ${step.line}`;
    setStatus(statusLabel, "#38bdf8");

    // Update Variables and Memory panels
    const vPanel = $("variablesPanel"),
        mPanel = $("memoryPanel");
    if (vPanel && mPanel) {
        vPanel.innerHTML = "";
        mPanel.innerHTML = "";
        let hasVars = false;
        const changedSet = new Set(step.changedVars || (step.changedVar ? [step.changedVar] : []));

        Object.entries(step.vars).forEach(([k, item]) => {
            hasVars = true;
            const val = item && item.value !== undefined ? item.value : item;
            const displayVal = formatValueForDisplay(val);
            const type = (item && item.type) || typeof val;
            const addr = (item && item.address) || getSimulatedAddress(k);
            const isChanged = changedSet.has(k);
            const highlightStyle = isChanged
                ? 'style="border-color: #38bdf8; background: rgba(56, 189, 248, 0.15);"'
                : "";

            vPanel.innerHTML += `
                <div class="variable-item" ${highlightStyle}>
                    <span class="variable-name">${escapeHTML(k)} <span style="font-size: 11px; color: #94a3b8;">(${escapeHTML(type)})</span></span>
                    <span class="variable-value">${escapeHTML(displayVal)}</span>
                </div>
            `;

            mPanel.innerHTML += `
                <div class="memory-box" ${highlightStyle}>
                    <div>
                        <span class="memory-name">${escapeHTML(k)}</span>
                        <span style="font-size: 11px; color: #64748b; margin-left: 8px;">${addr}</span>
                    </div>
                    <span class="memory-value">${escapeHTML(displayVal)}</span>
                </div>
            `;
        });

        if (!hasVars) {
            vPanel.innerHTML = `<p class="empty-message">No variables yet.</p>`;
            mPanel.innerHTML = `<p class="empty-message">Memory will appear here.</p>`;
        }
    }

    // Update Terminal Console Output from step snapshot
    const outPanel = $("outputPanel");
    if (outPanel) {
        const logs = Array.isArray(step.outputLogs) ? step.outputLogs : [];
        if (logs.length > 0) {
            outPanel.innerHTML = logs
                .map(
                    o => `
                <div class="console-line"><span class="console-symbol">&gt;</span> ${escapeHTML(String(o))}</div>
            `
                )
                .join("");
            outPanel.scrollTop = outPanel.scrollHeight;
        } else {
            outPanel.innerHTML = `<span class="console-symbol">&gt;</span><span>Program output will appear here.</span>`;
        }
    }
}

// History Page Controller
function initHistory() {
    const historyList = $("historyList");
    if (!historyList) return;

    // Attach replay handlers to existing and dynamic rows
    document.querySelectorAll(".replay-btn").forEach(btn => {
        btn.onclick = function () {
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
                row.style.cssText =
                    "display: flex; justify-content: space-between; align-items: center; padding: 15px; border-bottom: 1px solid var(--border-color); font-size: 14px;";
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
    } catch (e) {}
}
