# Implementation Plan: Memory & Chat Integrity, plus the high-impact fixes (Engram Obsidian plugin)

## Problem statement
In Engram, the memory file can lose entries or be replaced by a nearly empty file. Five code paths cause this:
- trimming that deletes old entries,
- full-file rewrites that keep only parsed entry lines,
- a fresh file being created when the file is temporarily missing,
- AI file tools that can reach the memory file or its parent folders,
- read-then-write races with the user's own edits.

Chat persistence has related bugs: clearing a chat deletes it, unsaved messages are lost when Obsidian closes, and data.json writes can overwrite each other. Separately, provider handling and permission checks have high-impact bugs.

## Requirements (user decisions: trimming = never delete from the file, edit only the specific memory being updated and preserve everything else; file format = preserve everything; auto-extraction = off by default, /memory with a review dialog)
1. Memory file contents are preserved. The plugin may only: add new entry lines; replace the text of one entry when asked to update it; remove one entry when asked to delete it; remove all entry lines when the user explicitly clears memory. Every other byte stays unchanged (headings, free text, frontmatter, user formatting).
2. No automatic trimming. The memory budget (maxMemoryTokens) only limits what is sent to the model.
3. New update_memory(id, fact) tool that changes one entry in place.
4. A missing file never means "start over". If a memory file existed before and is now missing, the plugin does not create a blank one. It queues the facts and offers to restore from a backup.
5. AI tools can never modify, move, rename, copy-from, or delete the memory file, its parent folders, the chat folder, or the backups. This holds even when memory is disabled.
6. Auto-extraction is off by default. Existing users are migrated to off once. /memory opens a review dialog where the user picks which facts to save.
7. Chats on disk always match the UI: clearing a chat keeps it; pending saves are flushed on close or switch; the plugin's own file events are never mistaken for external changes; deleting a non-active chat keeps you in your current chat.
8. All 12 high-impact items are fixed. Medium items touching memory or chats are fixed too: the Stop race, chat-folder changes, Edit/Regenerate acting on the wrong message.
9. Tests: Vitest with an in-memory Obsidian vault mock. Each task ships with tests.

## Background (from code review)
- src/memory/MemoryManager.ts: trimIfNeeded deletes entries; writeBack rebuilds the file with buildContent; load() returns '' when the file is missing and append then creates a new file; forget() of the last entry is blocked by the empty-list guard but still returns true.
- src/tools.ts: isMemoryPath returns false when memoryEnabled is false; move_note, rename_note, copy_note (source) and delete_note on ancestor folders are unguarded; new_name is not validated; replace_block and create_folder are allowed under read_append.
- src/utils/pathUtils.ts: isPathAllowed always allows the memory path (fine for reads).
- src/main.ts: upsertChatSession deletes the file for empty sessions but doesn't mark it as its own deletion, so the delete handler removes the session; onunload clears save timers without running them; saveSettings, persistIndex and loadChatSessions each do independent read-modify-write on data.json; vault events are registered before onLayoutReady.
- src/providers/*: on errors an empty assistant message is pushed into history; Anthropic has no image conversion, no CORS header, max_tokens = 30% of context window, temperature up to 2; OpenAI health check sends a real chat completion when a model is set; one API key is shared across all presets.
- vault.process(file, fn) (atomic read-modify-write) is available; minAppVersion is 1.7.2.
- No test setup exists yet. Project files: src/{main,ChatView,tools,indexer,embeddings,context,settings,types}.ts, src/memory/{MemoryManager,MemoryExtractor}.ts, src/chat/{ChatHistoryStore,SessionManager,AttachmentHandler,MentionAutocomplete}.ts, src/providers/{ProviderFactory,OpenAIProvider,AnthropicProvider,types}.ts, src/ui/{MessageRenderer,ConfirmDialog,TokenBudgetBar}.ts, src/commands/SlashCommandHandler.ts, src/utils/{pathUtils,tokenEstimator}.ts.

## Proposed solution

### Memory write flow
Memory op (add / update / delete / clear) -> serialized queue -> if file missing at memoryPath: if memoryState.everExisted is true, queue facts in data.json, show Notice, offer restore from backup, create NO file; if never existed, create from template and set everExisted=true -> if file exists: rotate local backup to .obsidian/plugins/engram-chat/memory-backups/ -> vault.process applies a line-level edit to the latest on-disk text -> invariant check (only target lines changed?): if not, return the original text unchanged, log + Notice; else write.

### Memory design
- New file src/memory/memoryFormat.ts: pure functions only, no Obsidian imports.
  - parseEntries(text) returns {id, date, fact, startLine, endLine}[]. An entry is a line matching ^\s*-\s+\[(\d{4}-\d{2}-\d{2})\|([^\]]+)\]\s+(.+)$ plus any following lines indented with two or more spaces (old multi-line format).
  - addEntries(text, facts, date, idGen): inserts new lines right after the last existing entry; if no entries but the "# 💾 Stored Memories" heading exists, inserts after the heading; otherwise appends the heading and entries at the end of the file.
  - updateEntry(text, id, fact): replaces only that entry's lines with one line; date and id stay.
  - removeEntry(text, id): removes only that entry's lines.
  - removeAllEntries(text): removes only entry lines.
  - verifyOnlyTargetChanged(oldText, newText, op): checks the non-target lines of the old text appear unchanged and in order in the new text.
  - Facts are normalized to one line: newlines collapsed to spaces, trimmed, 500-char cap.
- Rewrite MemoryManager: add, update, forget, clearAll all go through the queue, vault.process and the invariant check. parse() is read-only. Delete trimIfNeeded, buildContent and the full-file writeBack. Keep a template only for first creation.
- Missing-file safety: store memoryState: { path, everExisted, lastEntryCount } and pendingMemoryFacts in data.json. When the memory path's create event fires (e.g. sync delivers the file), flush pending facts into it. Never write before onLayoutReady.
- Backups: before each write, save a timestamped copy with app.vault.adapter.write to .obsidian/plugins/engram-chat/memory-backups/ (use plugin manifest dir). Keep the last 20. AI tools can't reach that folder (validateVaultPath blocks .obsidian). Add a "Restore memory from backup" command that lists backups and restores the chosen one through a confirm dialog. Stop writing Memory.md.bak; leave existing .bak files alone.
- Injection budget: maxMemoryTokens controls how much memory is sent to the model, newest entries first. The 30% rule is removed. The truncation notice appears at most once per session. Non-entry text is included only if it fits. The file is never modified for this.

### Protected paths
Add isProtectedPath(path, settings, mode) to pathUtils.ts. Protected: the memory file, every folder above it, the chat history folder and everything in it, every folder above the chat history folder. Case-insensitive, normalized. Applies to every write-type tool (append, edit, create, move/rename source and destination, copy source and destination, delete, create_folder) and to undo. Independent of memoryEnabled.

### Chat design
- OwnOpTracker (src/chat/OwnOpTracker.ts) records path -> expiresAt (5 s) for every write or delete the plugin makes itself. Vault create/modify/delete handlers ignore paths it marks. Replaces chatDeletions and the chatPersistTimers.has check.
- Empty sessions stay in memory. Their file is deleted as an own-op, and the session isn't removed from the UI.
- flushChat(id) and flushAllChats() run pending saves immediately. Called on switching chats, starting a new chat, closing the view, workspace.on('quit'), and in onunload (fire-and-forget).
- Load sessions and register vault events inside app.workspace.onLayoutReady.
- Deleting a chat only switches you away if that chat is the active one.
- syncChatsFromVault keeps empty in-memory sessions that are open in a view.

### data.json
Add PluginDataStore (src/storage/PluginDataStore.ts), the only reader/writer of data.json. It keeps an in-memory copy and applies update(mutator) calls in a queue. main.ts and settings.ts stop calling loadData/saveData directly.

## Task breakdown

**Task 1: Test harness and Obsidian mock**
- Objective: unit-test vault logic without Obsidian.
- Guidance: add vitest as devDependency (check Node >= 18; otherwise vitest 0.34). Add "test": "vitest run" script and vitest.config.ts aliasing `obsidian` to tests/mocks/obsidian.ts. The mock provides TFile and TFolder; an in-memory Vault with getAbstractFileByPath, read, modify, process, create, createFolder, delete, trash, rename, getMarkdownFiles, getAllLoadedFiles, on/trigger, and adapter.read/write/exists/list/remove/mkdir; normalizePath, Notice (records messages), Modal, requestUrl (stub), and App with workspace.onLayoutReady and fileManager.renameFile. Keep tests/ out of the tsc build or add vitest types.
- Tests: sanity test for create, read, process, rename in the mock vault.
- Demo: npm test passes and npm run build still passes.

**Task 2: PluginDataStore (fixes item 3, part 1)**
- Objective: serialized, race-free data.json writes.
- Guidance: create src/storage/PluginDataStore.ts with load(), get(), update(fn) (queued, writes merged object). Move every loadData/saveData call in main.ts and settings.ts (including persistIndex) into it. saveSettings only saves settings and passes them to services.
- Tests: concurrent update calls lose no keys, order preserved.
- Demo: fast toggling in settings while indexing runs no longer reverts settings.

**Task 3: Stop needless rebuilds and per-keystroke saves (items 3 and 12)**
- Objective: settings changes don't cause index rewrites or paid health checks.
- Guidance: in saveSettings compare a signature of scopeMode, scopeFolders, excludePatterns and call buildIndexInBackground (debounced 2 s) only when changed; compare a provider signature (activeProviderId, providerType, providerBaseUrl, API key, model) and only then call onSettingsUpdate(providerChanged). ChatView.onSettingsUpdate calls checkConnection only when providerChanged. Text fields in settings save with a 500 ms debounce; path fields use commit-on-blur from Tasks 9 and 12. OpenAIProvider.healthCheck always uses GET /models and reports whether the configured model is in the list; never a chat completion. AnthropicProvider.healthCheck uses GET /v1/models.
- Tests: typing 10 characters triggers one save and zero health checks; changing provider triggers one health check.
- Demo: typing in Temperature or Model sends no requests until you stop typing, and none to /chat/completions.

**Task 4: Memory format module**
- Objective: pure, fully tested line-level memory edits.
- Guidance: implement src/memory/memoryFormat.ts as designed above.
- Tests: free text, frontmatter, headings preserved by add/update/remove; old multi-line entries removed as a whole; removing the last entry leaves the rest as-is; removeAllEntries leaves non-entry text; adding to a file with no heading appends the heading; verifyOnlyTargetChanged rejects any other change; ids unique.
- Demo: test suite shows behaviour for each operation.

**Task 5: MemoryManager rewrite (items 5, 6, and trimming)**
- Objective: safe memory writes per the flow above.
- Guidance: rewrite MemoryManager with add(facts), update(id, fact), forget(id) (returns true only if the file actually changed), clearAll(), read-only parse(), and isReady set once onLayoutReady has run. It receives PluginDataStore for memoryState and pendingMemoryFacts. Implement missing-file safety, local backup rotation (20 copies), invariant check inside vault.process, and pending-fact flush on the memory path's create event. Remove trimIfNeeded. updateConfig no longer takes maxTokens (update callers in main.ts).
- Tests: appends never change non-entry text; missing file + everExisted=true creates no file and queues facts; no history -> file created; pending facts flushed when file appears; each write makes a backup, rotating at 20; deleting the last entry works; a user edit between queueing and the write is kept (process uses latest text); a failed invariant check leaves the file byte-identical.
- Demo: add a free-text paragraph to Memory.md, save five memories, delete one, update one; the paragraph is unchanged.

**Task 6: Memory tools, update_memory, context budget**
- Objective: tool behaviour matches new memory rules.
- Guidance: in tools.ts add update_memory(id, fact) to TOOL_DEFINITIONS and TOOL_INJECTION_PROMPT, wire into execute(); save_memory calls memoryManager.add; delete_memory and update_memory return accurate results; when the file is missing, save_memory reports "queued". Add update_memory, save_memory, delete_memory icons to MessageRenderer.TOOL_ICONS. In context.ts: rules text mentions update_memory; injection limited by maxMemoryTokens, newest entries first, notice shown once per session; omit the Memory Rules section when toolCallingMode === 'disabled'. Update the "Max memory tokens" setting description: "Maximum memory sent to the model per message. The memory file itself is never trimmed."
- Tests: update_memory changes exactly one line; injection budget cuts oldest from the prompt but never from the file; notice appears once.
- Demo: asking the AI to update a memory changes only that line.

**Task 7: Protected paths and tool permission fixes (items 7, 8, 9)**
- Objective: AI tools can't damage memory, chats or their folders; permission levels mean what they say.
- Guidance: add isProtectedPath to pathUtils.ts; apply in every write-type tool and in undoAt. Remove the memoryEnabled short-circuit from isMemoryPath. copy_note rejects the memory file as source. rename_note: new_name must have no / or \, must not be . or .., must pass validateVaultPath; keep extension rule (.md if source is .md); check isProtectedPath on old and new path. move_note checks source and destination. Permissions: read_append allows append_to_note only; edit_note (both modes) and create_folder need full_edit; update badge and setting descriptions.
- Tests (table-driven, one row per tool): memory file, Intelligence/ folder, chat folder, chat file; memory enabled and disabled; rename_note with ../x.md and sub/x.md; replace_block under read_append denied.
- Demo: asking the AI to move the Intelligence folder or delete Memory.md is refused even with Full edit and memory disabled.

**Task 8: Extraction off by default and /memory review dialog**
- Objective: no silent extraction; the user approves every fact.
- Guidance: default autoExtractMemory = false. Add settingsVersion; a one-time migration sets autoExtractMemory=false and shows a Notice explaining it. Split MemoryExtractor into extract(messages) returning candidates (no writes) and keep extractAndSave for opt-in auto mode. Add src/ui/MemoryReviewModal.ts: list of candidates with checkboxes and editable text, Save selected and Cancel. /memory uses it. Settings text for auto-extract: "After each reply, automatically save new facts (one extra model call per reply)." Fix the migration bugs in loadSettings (embedProvider / ollamaEmbedUrl migrations never run because defaults already fill values) if trivial.
- Tests: migration runs once; extraction returns candidates without writing; review modal saves only checked items.
- Demo: /memory shows candidates and only ticked ones appear in Memory.md.

**Task 9: Memory path changes and "Clear all memory"**
- Objective: changing settings never orphans or creates memory files by accident.
- Guidance: memory path field commits on blur or Enter only; validate with validateVaultPath and require .md. If the old file exists and the new path doesn't, confirm "Move existing memory file to new path?" and use fileManager.renameFile; update memoryState.path. "Clear all memory" uses showConfirmDialog (Cancel focused by default) then memoryManager.clearAll() (keeps non-entry text, takes a backup). Make ConfirmModal focus Cancel when danger: true (fixes Enter-confirms). Add "Restore memory from backup" command and a settings button.
- Tests: typing a path doesn't call updateConfig until commit; move keeps content; clear keeps free text and creates a backup.
- Demo: changing the path to Brain/Memory.md moves the file with all content intact.

**Task 10: Chat persistence core (items 1 and 2)**
- Objective: chats on disk match the UI.
- Guidance: add OwnOpTracker and use it for every ChatHistoryStore write/delete. In upsertChatSession delete the file of an empty session as an own-op and keep the session in memory. Add flushChat and flushAllChats; call from SessionManager.switchTo and createAndActivate, ChatView.onClose, workspace.on('quit'), and onunload. Move loadChatSessions and registerVaultEvents into onLayoutReady. SessionManager.delete only changes currentChatId when the deleted chat was active; the ChatView delete handler only reloads messages in that case. syncChatsFromVault keeps empty in-memory sessions open in a view. Remove chatDeletions.
- Tests: /clear keeps the session active and doesn't jump; unload flushes a pending save; outside delete removes the session; own delete doesn't; outside modify with newer updatedAt replaces the in-memory copy; deleting a non-active chat keeps the current one.
- Demo: /clear leaves you in the same, now empty, chat. Closing Obsidian within 800 ms of a reply still saves it.

**Task 11: Turn integrity in ChatView and ProviderFactory (item 11, Stop race, Edit/Regenerate)**
- Objective: no corrupted history and no mixed turns.
- Guidance: runTurn creates its own AbortController per turn; its finally only clears its own controller. Stop aborts the turn but the input stays locked until executeTurn finishes. On a provider error runTurn doesn't push an assistant message; it yields messages with an error flag. ChatView saves the user message and shows the error bubble without saving it. Add sanitizeForApi(messages) in src/providers/sanitize.ts: drop assistant messages with empty content and no tool_calls; strip attachments and autoAttachedNotes; in prompt_injection mode convert tool messages to user text ("[Tool result: name]\n...") and drop tool_calls. Both providers call it. DisplayMessage gets sourceIndex (index in this.messages), set in buildDisplayMessages and for live bubbles; editMessage and regenerateMessage use sourceIndex instead of DOM or role counting.
- Tests: history with an empty assistant message is sanitized; Stop then immediate send doesn't interleave; Regenerate after a turn with tool calls and an error targets the right user message.
- Demo: after a provider error the next message works; Regenerate re-runs the correct prompt.

**Task 12: Chat history folder change**
- Objective: changing the folder moves chats instead of scattering them.
- Guidance: path field commits on blur or Enter and is validated. Confirm dialog moves existing JSON files with a generalized ChatHistoryStore.migrateFrom(old). Then setFolderPath, reload sessions, notify views. Don't create folders for partly typed paths.
- Tests: migration moves every session; no folder created while typing.
- Demo: changing the folder to AI/Chats moves all chats and they still appear in the switcher.

**Task 13: API key per provider (item 4)**
- Objective: a key is never sent to the wrong provider.
- Guidance: add providerApiKeys: Record<string,string>. Migration moves existing providerApiKey into the current activeProviderId. The settings field reads/writes the key for the active preset. ProviderFactory.create uses providerApiKeys[activeProviderId]. OpenAI embeddings fall back to the main key only when activeProviderId === 'openai'.
- Tests: migration; switching presets shows an empty key; key resolution for embeddings.
- Demo: switching from OpenAI to OpenRouter shows an empty API key field.

**Task 14: Anthropic fixes (item 10)**
- Objective: Claude works with images, from the desktop app, with valid parameters.
- Guidance: convertMessages maps image_url data URLs to {type:'image', source:{type:'base64', media_type, data}} and text parts to {type:'text'}. Add header anthropic-dangerous-direct-browser-access: true. Add a maxOutputTokens setting (default 4096, in Advanced) used for both providers instead of 30% of context window. Clamp temperature to [0,1] for Anthropic.
- Tests: image conversion, request body max_tokens and temperature, headers.
- Demo: send an image to Claude and get a reply.

**Task 15: Wiring, docs, final verification**
- Objective: everything integrated and documented.
- Guidance: update README (memory never trimmed, update_memory, review dialog, backups and restore, permission levels, auto-extract off by default, fix "Re-index vault" and @-mention wording). Bump version in manifest.json, package.json, versions.json. Run npm test and npm run build. Provide a manual QA checklist in the final report: memory survives 50 saves plus edits; delete the memory file and send a message: no blank file, restore flow works; /clear; close mid-save; Stop then send; switch providers and check key; AI attempts against protected paths refused.
- Demo: full checklist passes.

## Open research questions (assume defaults; do not block on them)
- Backups stay local to each device in the plugin folder.
- Chat folder: AI tools get write-blocking only (reads still allowed) unless the user says otherwise.
- Add a short startup delay before the first memory write if the vault looks still-syncing; otherwise rely on onLayoutReady plus missing-file safety.
