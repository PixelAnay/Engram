# Engram for Obsidian

> **The AI that remembers you.** A persistent personal intelligence for Obsidian with evolving memory, multi-provider support, interactive slash commands, and secure, scoped vault access.

---

## 🧠 What is Engram?

Engram transforms Obsidian's sidebar chat from a simple query assistant into a **persistent thinking partner**. By maintaining a structured, auto-summarizing memory file (`memory.md`), Engram accumulates knowledge about your projects, preferences, habits, and beliefs over time. It reasons over your vault safely, costs pennies to run, and respects your privacy.

---

## ✨ Key Features

### 1. Evolving Personal Memory System
*   **Structured Evolving Memory:** Engram tracks your core identity, ongoing projects, habits, and life events in a dedicated, markdown-based memory file (`memory.md`).
*   **Auto-Summarization:** When your memory file grows, Engram automatically condenses older entries to minimize LLM token costs without losing context.
*   **Interactive Control:** Use `/memory` to prompt the AI to extract and summarize key takeaways from your current chat session, review them in a confirmation modal, and save them. Use `/forget` to open and edit your memory file at any time.

### 2. Multi-Provider Compatibility
Engram supports all major local and cloud LLM providers out of the box:
*   **Cloud Providers:** OpenAI (GPT-4o/o1), Anthropic Claude (via Messages API), Google Gemini, DeepSeek, Mistral, Groq, and xAI.
*   **Local Models:** Ollama, LM Studio, and llama.cpp (with full local tool-calling capabilities).
*   **Aggregators:** OpenRouter (one API key for 100+ models).
*   **CORS-Safe Architecture:** Uses Obsidian's native request APIs to bypass CORS blocks for cloud integrations, and fully supports SSE-based text streaming.

### 3. Granular Vault Scoping & Safety
*   **Knowledge Scopes:** Restrict the AI to specific directories using **Allowlists** or **Denylists**. Files in private folders are fully excluded from indexing, searches, and context injection.
*   **Interactive Permissions Badge:** Toggle permissions directly in the chat footer with a single click:
    *   `🔍 Read` — Read-only access (safe browsing).
    *   `✏️ Append` — AI can only append details to the end of notes.
    *   `⚠️ Full Edit` — Full modification, creation, and deletion capabilities.
*   **Destructive Protections:** Shows a real Obsidian confirmation modal before the AI can overwrite notes, create files, or delete items.

### 4. Premium, Modern User Interface
*   **Slash Commands & Mentions:** Type `/` to select commands or `@` to autocomplete note names as context links.
*   **Token Budget Bar:** A color-coded progress bar in the footer showing active token usage against your provider's context window.
*   **Dynamic Welcome Chips:** Prompts you with suggestions based on your most recently edited notes or top vault tags.
*   **Undo History Panel:** Review and selectively undo any file creation, append, or overwrite operation performed by the AI.

### 5. Local Offline PDF Attachment Parsing
*   Drag and drop or attach a PDF.
*   Select a page range (e.g. page 1–3) using an interactive popup.
*   Engram converts and extracts pages **locally** into images using a built-in PDF.js worker—no external servers, 100% offline.

---

## 🚀 Installation

### Option 1: Via BRAT (Recommended)
1. Install the **BRAT (Beta Reviewer's Auto-update Tool)** plugin from Obsidian's community store.
2. In Obsidian Settings, go to **Beta Reviewer's Auto-update Tool**.
3. Click **Add Beta plugin** and paste this repository URL:
   `https://github.com/PixelAnay/Engram`
4. Enable **Engram** under Community Plugins.

### Option 2: Manual Installation
1. Go to the [Releases](https://github.com/PixelAnay/Engram/releases) tab.
2. Download `main.js`, `manifest.json`, and `styles.css`.
3. Create a folder named `obsidian-engram` inside your vault's plugins folder:
   `<VaultPath>/.obsidian/plugins/obsidian-engram/`
4. Copy the downloaded files into that directory.
5. Reload Obsidian and enable the plugin.

---

## 🛠️ Usage & Commands

*   **Ribbon Icon:** Click the Brain icon 🧠 in the left ribbon to open the chat sidebar.
*   **Slash Commands:**
    *   `/memory` — Extract and save notes/facts from the current conversation.
    *   `/forget` — Open the active memory file to prune or view entries.
    *   `/persona [name]` — Switch between configured LLM personas.
    *   `/export` — Save the active chat session to a Markdown file.
    *   `/clear` — Clear the current session.
    *   `/scope` — Display the folders the AI currently has permission to read.
*   **Command Palette:**
    *   `Open Engram sidebar`
    *   `Engram: Re-index vault`
    *   `Engram: Open memory file`

---

## 🔒 Security Hardening

*   **Sandbox Boundaries:** Note content is wrapped in strict `[VAULT DATA START]` and `[VAULT DATA END]` markers inside the LLM prompt. The system instructions mandate that the AI treat everything inside these boundaries strictly as data rather than instructions, mitigating prompt injection attacks.
*   **Key Security:** API keys are excluded from `data.json` and are not synced with Git, Obsidian Sync, or iCloud.

---

## 💻 Development

If you want to build the plugin from source:

1. Clone this repository:
   `git clone https://github.com/PixelAnay/Engram.git`
2. Install dependencies:
   `npm install`
3. Build the production bundle:
   `npm run build`
4. Sync to your development vault:
   Set your dev vault path using an environment variable:
   ```powershell
   # Windows (PowerShell)
   setx OBSIDIAN_VAULT_PATH "C:\Path\To\Your\Vault"
   ```
   Run the sync script:
   ```bash
   npm run deploy
   ```

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
