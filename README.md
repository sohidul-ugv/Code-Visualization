# CodeViz - Interactive Code Visualization Platform

CodeViz is an interactive code visualization and execution learning tool supporting **C++**, **C**, **Java**, and **Python**. It allows developers and students to trace variable assignments, memory allocations, arithmetic logic, and control flow line-by-line.

---

## 🚀 How to Run the Project

You can run this project in several easy ways:

### Option 1: Press F5 in VS Code (Recommended)
1. Open the project in VS Code.
2. Open [`index.html`](file:///d:/Code-Visualization/index.html).
3. Press **F5** (or click **Run & Debug** ▶).
4. Chrome or Microsoft Edge will open [`index.html`](file:///d:/Code-Visualization/index.html) immediately with zero setup required.

---

### Option 2: Open Directly in Browser
- Simply double-click [`index.html`](file:///d:/Code-Visualization/index.html) in File Explorer, or drag and drop it into any modern web browser (Chrome, Edge, Firefox, Brave).

---

### Option 3: Run with a Local Web Server
If you prefer running via `localhost:8080`:

**Using Node.js / npm:**
```bash
npm start
```
or
```bash
npm run dev
```

**Using Python:**
```bash
python -m http.server 8080
```
Then visit: `http://localhost:8080`

---

## 🌟 Key Features
- **Multi-Language Support**: Interactive visualization for C++, C, Java, and Python.
- **Dynamic Expression Evaluation**: Evaluates math operations, variable referencing (`x + y`), compound assignments (`+=`, `++`), and conditionals.
- **Simulated Memory Layout**: Displays variable names, types, values, and memory addresses (`0x7FF...`).
- **Interactive Controls**:
  - `Next Step` (Step forward)
  - `Previous` (Step backward)
  - `Auto Run` (Play / Pause animation)
  - `Reset` (Restart simulation)
- **Interactive Console**: Real-time terminal output stream.
- **Execution History**: Automatically saves runs and provides 1-click **Replay**.
