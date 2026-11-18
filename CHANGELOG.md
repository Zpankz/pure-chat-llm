# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0-beta.7] - 2026-11-18

Everything in beta.6, plus fixes for the orchestrator and background agents not starting, and for the caret:

- **Agents start again.** OpenAI (Responses) requests no longer fail on strict tool checking. Workers run on the orchestrator's model when the worker model has no key, and a worker that can't start is said at once. A failed background task, or an orchestrator turn that fails while it is set up, is always told to you. The agent tools (relays, tasks, memory, skills, code mode) stay on whichever tool groups you switch off.
- **Durable engine:** the voice's check_tasks and cancel_task, the call panel and the call notes now see its workers, and you can stop them from the voice or the panel. Code mode can no longer start hidden Classic workers, and a report queued behind a failed run is kept.
- **Caret:** only the newest unfinished line blinks. An interrupted speaker finishes their own line in place instead of repeating it below, and a speaker's new line closes their old one (GPT-Live and OpenAI Realtime).
- Voice Agent and Pure Chat LLM can be enabled together (own view names; panels saved under the old names reopen).
- **Memory:** a file that sync is still writing is read again before giving up, and a notice says when saving stops or resumes. Changing the memory folder copies the memory there and leaves the old file. Agents' own queries get a row limit. Tasks cut off by an earlier quit are closed. When two devices' copies merge, a cleared shared value stays cleared and each slot keeps only its newest fact.
- **Safety:** the settings tool can't change safety settings, agents can't write in the app's config folder or the memory file, and each orchestrator tool call has its own deadline.
- **Smaller fixes:** the model chooser no longer loops when the first provider has no key and no longer changes your default provider; the error box is readable; tool cards read "Searching…" while running and "Couldn't…" when they fail; Reset settings keeps your keys and added providers; a call that drops stops listening.
- The API key box is masked and asks about the provider you picked. The conversation overview redraws at most every quarter second while you type, not while hidden, and both panels unload old rendered Markdown instead of piling it up.
- Settings say which worker limits the durable engine doesn't use yet, that the task routes apply only in the Orchestrator role, and that Agent mode is about note chats. The log folder applies when you leave the field, and Refresh list of models asks only providers with a key and shows one notice.
- Screen readers hear each card's state, task titles work from the keyboard, and the overview's settings button has a label.

## [2.0.0-beta.6] - 2026-11-18

Everything in beta.5, plus:

- The voice call conversation is no longer squeezed to a sliver by the agents list below it.

## [2.0.0-beta.5] - 2026-11-18

Everything in beta.4, plus a redesigned conversation in the voice call panel and the conversation overview:

- **Turns:** your turns on the right in accent-tinted bubbles, the agent's on the left with an avatar; words still being heard are dimmed with a caret.
- **Tool and skill cards:** one card per call with an icon and colour by kind (skill, memory, vault read, search, graph, write, delete, agent, MCP), a plain label, the telling argument, a live timer, then a tick or a cross and the duration. A card opens to the arguments and the rendered result. Skills show their name as a chip. The "Running tool" notices are gone.
- **Agents:** updates from background agents and the orchestrator are cards with their message; ones that cut in are marked. Background agents show status, a live elapsed time and progress bar, what each is doing now, its question or result, its steps on demand, and buttons to open its thread or stop it.
- **Wikilinks** in both panels open on click (Ctrl/Cmd-click for a new tab) and preview on hover, like in a note.
- Light, dark and mobile follow your theme.

## [2.0.0-beta.4] - 2026-11-18

Everything in beta.3, plus:

- **Shared memory** (Settings → Shared memory, off by default). One graph database, [relate](https://relatedb.ai) compiled to WebAssembly and built into the plugin, that the voice agent, the orchestrator (Classic and Durable), workers and agent chats all read and write, saved as `Voice Agent/Memory/memory.json` so new sessions and other devices start from it. It holds facts (preferences, instructions, decisions, todos, summaries, observations) linked to the people, projects and notes they are about, the calls, app sessions and tasks that ran, and shared state. Each agent's instructions start with a short brief from it.
- **Memory tools:** `memory_recall` (full-text and by subject), `memory_remember` (with slots and corrections that close the old fact; nothing is deleted), `memory_forget`, `memory_state` (values every agent sees now, per call or global) and `memory_query` (an agent's own read-only Cypher, with bound parameters and a row cap; writes are refused).
- Copies of memory.json from two devices are merged, and a memory file that can't be read is never replaced.
- main.js is larger (about 4.4 MB) because it carries the graph engine.

## [2.0.0-beta.3] - 2026-11-18

Everything in beta.2, plus:

- **Diagnostics log** (Settings → Diagnostics log, off by default). Records console output, every model request and response, every tool call with its arguments, result and duration, voice transcripts and the orchestrator's steps, as one JSON line per event in `Voice Agent/Diagnostics/<date>/<session>.jsonl`. API keys, tokens and auth headers are always removed. Files are capped at 5 MB (a session continues in a new part), day folders older than 14 days are removed at startup, and each call note links its log file under `diagnostics:`.

## [2.0.0-beta.2] - 2026-11-17

Second test build, for trying the durable engine. Everything in beta.1, plus:

- **Agent engine setting** under the orchestrator settings: Classic (as before) or Durable (in testing, desktop only). A call keeps the engine it started with.
- **Durable engine** (Pi Durable): the orchestrator's conversation, its tool calls and its background workers are kept in the app's storage, so a reload or crash resumes where it stopped and workers report back after a restart.
- **Voice calls on the durable engine:** requests reach the durable orchestrator, `tell_user` speaks in the call, an answer without it is still spoken, and a failed request is said in words. The call notes record what the orchestrator did.
- **Durable workers** take questions back to the orchestrator, timed check-ins (a quiet note while they move, one stuck report when they stop) and follow-ups after they finish.

Not yet in this build: durable workers don't show in the call panel's task list.

## [2.0.0-beta.1] - 2026-11-15

Test build of Voice Agent 2.0 for installing with BRAT. It holds everything listed under Unreleased below, plus:

- **Settings tab no longer freezes Obsidian** when Agent settings render the code mode section.
- **Groundwork for a durable engine** (Pi Durable). It is not switched on in this build: calls run on the Classic engine as before.

This is a pre-release: settings move from Pure Chat LLM to the new `voice-agent` id on first load, and hotkeys need binding again.

## [Unreleased]

### Added

- **New voice providers**: OpenAI GPT-Live (`gpt-live-1`, full duplex) and xAI Grok voice (`grok-voice-latest`).
- **GPT-Live duplex agent settings**: choose OpenAI Responses or this plugin as the backend agent, with backend model, instructions, reasoning effort, tool choice, parallel calls, service tier, web search, acknowledgement delay and session storage.
- **Code mode tool** (`codemode`): models write one sandboxed JavaScript script that calls several tools, with tool search, a key/value store between runs and inline limits.
- **Agent Skills**: skills in the agentskills.io format load from a vault folder with progressive disclosure (`activate_skill`, `read_skill_file`).
- **Remote MCP servers**: Streamable HTTP client for MCP 2026-07-28 with fallback to 2025-11-25, bearer tokens, custom headers, tool allow-lists, and bridge or native mode. Tools appear under a new MCP tool category.
- **Layered voice agents**: voice, orchestrator, worker and optional evaluator layers, each with its own provider, model, reasoning effort and API. The orchestrator agent sees the whole call and short worker summaries and reads a worker's thread on demand; the voice sees what the orchestrator says and an overview of its activity; workers see only their brief.
- **Background workers** with hooks for started, progress, needs advice, stuck, timed check-ins, finished, failed and cancelled; per-event routing; GPT-Live-style timing with a relevance check that interrupts only when an update changes what you are saying.
- **Two-reviewer writes**: workers create notes freely; edits and deletes need two independent reviewers, with a backup before edits and deletes to the trash.
- **Sign in with ChatGPT** (desktop) for layers that run on a ChatGPT plan, through the Responses API. Tokens are kept in Obsidian's secret storage.
- **Responses API** support for OpenAI layers (needed for tool calls on newer models).
- **Meta** endpoint (`api.meta.ai`) for Muse models.
- **Typed graph tools**: `traverse_graph` with typed relations, `vault_ontology` and `graph_cli` with saved traversal commands.
- **djs engine** for code mode, with the Web Worker as fallback.
- **OAuth sign-in for remote MCP servers**, with tokens in secret storage.
- **Voice settings** for every provider, a live transcript in the voice call panel, and a choice to expose all tools or only code mode to voice models.
- **Calls saved as linked notes**: each voice call saves its transcript, the orchestrator's conversation and every worker thread as notes in a folder you choose (default `Voice Agent`). The call note links to the orchestrator note, which links to each thread, and each thread links back.
- **Duplex agent settings in six groups**: Voice, Orchestrator, Workers, Evaluator, Interruptions and Check-ins.
- **Sign in with Google** (desktop) for Gemini layers, using an OAuth client in your own Google Cloud project. Tokens are kept in Obsidian's secret storage.
- **Install with BRAT**: a release workflow attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release for each version tag, after checking the tag matches the manifest and running the tests.
- **Unit tests**: `npm test` runs tools against an in-memory vault with Node's built-in test runner.

### Changed

- **Renamed to Voice Agent**, with the new plugin id `voice-agent`. Your Pure Chat LLM settings are copied on first load and sign-ins carry over. Hotkeys need binding again, and Pure Chat LLM should be turned off if it is still on.
- **One tool contract**: every tool reports failures in one format (`Error: Type: reason` with what to try), data tools can return compact JSON (code mode asks for it by default), and each tool lists the layers it may run in. Background workers no longer get tools that open dialogs, change your tabs or flash notices.
- **Voice calls fail gracefully** on phones and other devices without microphone access, WebRTC or audio worklets: the call button explains why and what still works, and a call that fails to connect no longer leaves a call note.
- Skills can name their main file after the skill folder instead of `SKILL.md`.
- Code mode scripts can't call image or music generation or change plugin settings, so they have no network beyond MCP servers.
- Folder lookups and search accept folder names in any case; search can be limited to a folder.

- **OpenAI realtime** now uses the GA session shape with `gpt-realtime-2.1`, semantic VAD, noise reduction, input transcription, reasoning effort and parallel tool calls.
- **Gemini live** now defaults to `gemini-3.8-live`, sends audio with `realtimeInput.audio`, and supports non-blocking tools with scheduling, context compression, session resumption, `goAway` reconnects, transcripts, proactive audio and thinking levels.

## [1.12.1] - 2026-02-09

### Added

- **Realtime System Prompt File Setting**: Added a new setting to configure a file path for the realtime voice call system prompt. When configured, the plugin will read the system prompt from the specified file instead of using hardcoded defaults. This makes it easy to customize the AI's behavior during voice calls. The feature includes:
  - New `realtimeSystemPromptFile` setting in plugin settings
  - UI control in settings with file path autocomplete (press `/` or `[` to browse files)
  - Automatic fallback to default prompts if file is not found or empty
  - User notifications when file reading fails or file is empty
  - Works with both OpenAI Realtime and Gemini Live providers

## [1.12.0] - 2026-01-27

### Added

- **ToolOutputBuilder Utility**: Introduced a new `ToolOutputBuilder` class that provides a fluent API for creating consistent, structured tool outputs across all tools with ASCII-only formatting.
- **Enhanced Tool Output Formatting**: Completely redesigned tool outputs to be more informative and actionable for the LLM:
  - **Rich Metadata**: Tools now return detailed metadata including file sizes, line counts, timestamps, and content statistics.
  - **ASCII-Only Structure**: All outputs use only ASCII characters with markdown-style separators (`---`) for maximum compatibility.
  - **Tabular Data**: File listings use markdown tables with human-readable sizes and relative timestamps.
  - **Suggested Actions**: All tools provide contextual suggestions for logical next steps to guide the LLM.
  - **Structured Errors**: Error messages include specific error types and actionable recovery options with example tool calls.
- **Tool Output Format Guide**: Added comprehensive documentation in `src/tools/GUIDE.md` explaining output conventions, formatting standards, and interpretation guidelines.
- **Setting to Remove Empty Messages**: Added a new setting option to automatically filter out empty or whitespace-only messages from chat sessions, improving chat cleanliness and relevance.
- **Enhanced Tool Message Handling**: Improved tool message processing with better descriptions and more robust error handling.
- **Diff Functionality in EditReview**: Implemented visual diff comparison in the EditReview component for enhanced content change visualization.
- **onRender Callback in ResolutionGraphRenderer**: Added callback support for improved rendering control and extensibility in graph visualization.
- **Async Stream Callbacks**: Enhanced `LLMService` and `ToolExecutor` to support asynchronous stream callbacks for more flexible response handling.

### Changed

- **ReadFile Output**: Enhanced to include file metadata (size, lines, last modified), content statistics (headings, links, tags), pagination info, and navigation suggestions.
- **SearchVault Output**: Now displays search statistics (files searched, time taken), numbered results with line numbers, and follow-up suggestions.
- **GlobFiles Output**: Upgraded to show results in table format with file sizes, modification times, summary statistics, and suggested actions.
- **Backlinks Output**: Enhanced to show relationship strength using ASCII brackets `[***]`/`[**-]`/`[*--]`, sort by connection count, and provide exploration suggestions.
- **ListFolders Output**: Now includes folder statistics (file counts, total sizes) with summary information.
- **DeleteNote Modal**: Updated confirmation dialog to show file details (size, last modified) before deletion.
- **Edit Operations (CreateNote, PatchNote, ReplaceInNote)**: Approval messages now include operation details, line counts, character counts, and suggested next actions.
- **Error Messages**: All file-not-found and operation errors now follow a consistent format with specific error types, recovery suggestions, and correct glob patterns for root-level files.
- **ASCII-Only Output**: Replaced all non-ASCII characters (Unicode box drawing, bullets, checkmarks, arrows, curly quotes) with ASCII equivalents throughout all tool outputs and documentation.
- **Tool Descriptions**: Refined all tool descriptions and error messages for improved clarity and user experience.
- **Title Generation Logic**: Updated title generation to include numbered files, allowing better handling of copied notes with automatic title numbering.
- **JSON Parsing in ChatMarkdownAdapter**: Refactored JSON parsing for improved type safety and error resilience.

### Fixed

- **Tool Error Handling**: Enhanced error handling across all vault tools with better error messages and recovery strategies.
- **Root-Level File Glob Patterns**: Fixed invalid glob patterns (`/*.md`) generated for root-level files, now correctly uses `*.md` pattern.
- **Conditional Suggestions**: Fixed empty suggestion strings in ListFolders output when recursive mode is enabled.
- **Streaming Performance**: Resolved UI freezing during heavy LLM response streaming by implementing buffered updates (100ms debouncing) instead of updating the editor on every token.
- **Memory Leak**: Fixed potential memory leaks in response streaming by adding proper `ReadableStream` reader cancellation on errors and early termination.

### Documentation

- Updated `src/tools/GUIDE.md` with a new "Tool Output Format Guide" section
- Added before/after examples for key tools (ReadFile, SearchVault, GlobFiles)
- Documented ASCII-only formatting standards and conventions
- Included interpretation guidelines for LLMs
- Updated CHANGELOG.md to consolidate all changes into version 1.11.1

## [1.11.0] - 2026-01-16

### Added

- **Graph View Mode**: Introduced a new visual way to explore file dependencies.
  - **Interactive Graph**: Navigate the dependency tree with zoom, pan, and drag capabilities.
  - **Minimap & Tooltips**: Added a minimap for better orientation and tooltips for file details.
  - **Fit-to-View**: Automatically adjust the graph to fit the available viewport.
  - **Touch Support**: Enabled interaction on touch devices.
  - **Persistent View Mode**: The plugin now remembers your preference between Tree View and Graph View.

### Changed

- **Architectural Refactor**: Significant separation of concerns to improve code maintainability and testability.
  - **Domain-Driven Design**: Introduced `ChatSession`, `ChatMarkdownAdapter`, and `ToolExecutor` classes to decouple business logic from UI.
  - **FileSystem Port**: Abstracted file system operations behind a `FileSystemPort` interface.
  - **Unified Rendering**: Centralized rendering logic for different views.

### Fixed

- **Memory Management**: Addressed critical memory leaks in the `ResolutionGraphRenderer`.
- **Graph View Stability**: Fixed multiple issues related to click detection, icon duplication during zoom, and layout aspect ratios.
- **Rendering Issues**: Corrected canvas clearing and dimension calculations for sharper graphics.
- **Link Handling**: Improved support for links with whitespace and nested file resolution.

## [1.10.0] - 2026-01-14

### Added

- **Blue File Resolution System**: Introduced a robust, specialized file resolution engine (`BlueFileResolver`) designed to recursively resolve note links, images, and audio files. This system replaces the previous ad-hoc logic with a graph-based approach that intelligently handles circular dependencies, depth limits, and caching for optimal performance.
- **Blue Resolution Tree View**: Implemented a new "Blue Resolution Tree" side panel view. This interactive visualization allows users to explore the dependency graph of the current note in real-time.
  - **Interactive Hierarchy**: Expand and collapse nodes to see exactly what files are being pulled into the context.
  - **Status Indicators**: Visual cues for resolution status (resolved, missing, cyclic dependency, ignored).
  - **Cyber-Neon Aesthetic**: A distinct visual style with "Blue" accents to differentiate it from standard Obsidian views.
  - **Navigation**: Click on any node in the tree to immediately open that file in the editor.
- **Enhanced Documentation**: Added `BLUE_FILE_RESOLUTION.md` providing in-depth architectural details and usage guides for the new resolution system.
- **Visual Updates**: Updated icons for the Conversation Overview and Voice Call views to better align with the new design language.
- **Settings Overhaul**: Refactored the settings UI to accommodate the new resolution options, improving organization and usability.

### Changed

- **Core Logic Refactor**: Completely centralized all file resolution logic from `Chat.ts` into the `BlueFileResolver` class. This major architectural change improves maintainability and reliability of context generation.
- **Dependency Management**: Updated the minimum required Obsidian app version to 1.11.4 to leverage the latest API capabilities.
- **UI/UX Improvements**: Various refinements to the user interface and internal code structure for better stability and performance.

### Fixed

- **Stability Improvements**: Addressed various minor bugs and edge cases in the file resolution and chat handling logic.

## [1.9.3] - 2026-01-14

### Added

- **Voice Call Feature**: Introduced a dedicated Voice Call side panel with real-time audio interaction capabilities.
- **Multi-Provider Realtime Support**: Integrated both OpenAI Realtime API and Google Gemini Live API.
- **WebRTC Integration**: Leveraged WebRTC for high-performance, low-latency audio streaming.
- **Tool Integration in Voice**: Enabled the AI to use vault tools (like searching and reading notes) during live voice conversations.
- **Provider Selection UI**: Added a UI to switch between different voice call providers (OpenAI, Gemini).
- **Audio Feedback**: Implemented visual audio levels and connection status indicators in the side panel.

### Changed

- **Realtime Architecture Refactor**: Overhauled the voice architecture to use a more robust provider pattern for better extensibility and maintenance.
- **Improved Type Safety**: Enhanced type safety in `GeminiLiveProvider` and other realtime modules by defining explicit interfaces and reducing `any` usage.
- **Refined Command Palette**: Removed redundant commands to streamline the user experience.

### Fixed

- **Audio Stability**: Fixed issues with audio playback underruns in Gemini Live by optimizing the scheduling logic.
- **Connection Reliability**: Resolved a bug where the Gemini provider would hang at the "connecting..." state.
- **API Authentication**: Fixed 401 Unauthorized errors by implementing proper API key validation for realtime endpoints.
- **Tool Definition Format**: Corrected the tool definition format to comply with OpenAI's Realtime API requirements.

## [1.9.2] - 2026-01-04

### Added

- **Suno API Integration**: Integrated Suno AI for generating music directly from the chat interface via tool calls.
- **Tool Classification System**: Introduced a new settings-based classification system for tools, allowing users to enable/disable categories of tools.
- **Enhanced Image Generation**: Updated the image generation tool with support for more model configurations and improved API endpoints.

### Changed

- **Modular Architecture Refactor**: Migrated chat-related types and constants to a centralized `src/assets/constants.ts` file.
- **Service Integration**: Integrated `LLMService` into the core `PureChatLLMChat` class for more consistent API interactions.
- **Global Naming Refactor**: Performed a project-wide refactor of symbols and variables for better consistency and readability.

### Fixed

- **Metadata Parsing**: Improved the robustness of chat metadata parsing and setting migration logic.

## [1.9.1] - 2025-12-30

### Added

- **YAML Front Matter Support**: Added a new setting to store chat metadata (model, temperature, etc.) in YAML front matter instead of JSON code blocks.
- **Model Suggestions**: The editor now provides autocomplete suggestions for model names within both YAML front matter and JSON configuration blocks.

### Changed

- **Improved Tool Handling**: Refined logic for enabling all available tools when `tools: true` is set in the chat configuration.
- **Enhanced Editor Suggestions**: Updated the suggest provider to recognize more trigger patterns for model selection.

## [1.9.0] - 2025-12-29

### Added

- **Agentic Capabilities**: Added a suite of tools for the LLM to interact with the vault:
  - `create_obsidian_note`: Create new notes with frontmatter.
  - `delete_obsidian_note`: Delete notes or files with user confirmation.
  - `read_file`: Read file contents efficiently with pagination.
  - `patch_note`: Append content to specific sections/headings atomically.
  - `replace_in_note`: Perform search and replace or regex updates in notes.
  - `search_vault`: Search for text or regex patterns across all notes.
  - `glob_vault_files`: Find files using glob patterns with metadata filtering.
  - `list_vault_folders`: Explore the vault's directory structure.
  - `get_backlinks`: Find all notes linking to a specific file.
  - `smart_connections_rag`: Perform semantic search using Smart Connections for RAG.
  - `manage_workspace`: Control workspace layout (open/close files, split panes).
  - `get_active_context`: Retrieve context about the active file and selection.
  - `show_obsidian_notice`: Display transient notifications.
  - `manage_plugin_settings`: Read and update plugin-specific settings.
  - `manage_templates`: List and apply Obsidian templates.
- **Safety Workflow**: Implemented `EditReview`, `DeleteConfirmation`, and `SettingsConfirmation` systems where modifications, deletions, and setting changes trigger a user approval modal before application.
- **High-Performance Architecture**:
  - Utilized `app.vault.cachedRead` for fast, memory-efficient reading.
  - Utilized `app.vault.process` for atomic, race-condition-free file updates.
  - Leveraged `app.metadataCache` for smart link resolution and structural editing.

## [1.8.0] - 2025-12-29

### Changed

- Modularized project structure: reorganized `src/` into `assets/`, `core/`, `ui/`, and `utils/`
- Renamed UI components for clarity (e.g., `models.ts` -> `Modals.ts`)
- Updated imports and configuration to reflect the new structure
- Enhanced ESLint configuration for better code quality
- Removed unused `src/test.ts` file
- Improved code readability in `ImageGen.ts` and `settings.ts`

## [1.7.1] - 2025-12-28

### Added

- New setting to automatically concatenate consecutive messages from the same role

## [1.7.0] - 2025-12-27

### Added

- Comprehensive CHANGELOG.md
- New "Open code preview" context menu item for code blocks
- Code block tracking extension to detect when cursor is inside a code block

### Changed

- Refactored code for consistency and readability
- Updated dependencies and added ESLint configuration
- Moved `CodePreview` to a separate file `src/CodepreView.ts`
- Refactored `Chat.ts` for better type safety and error handling
- Updated `ChatRequestOptions` interface
- Improved error handling in `ImportChatGPT.ts`
- Updated dependencies in `package.json`
- Applied `void` operator to unawaited promises for better linting compliance

## [1.6.0] - 2025-12-07

### Added

- Comprehensive error notifications to sendChatRequest with detailed HTTP status code messages

### Changed

- Improved code clarity by simplifying error extraction logic
- Enhanced error message handling based on code review feedback

## [1.5.0] - 2025-11-28

### Changed

- Refactored settings and templates for improved readability and functionality

## [1.4.8] - 2025-11-18

### Changed

- Minor updates and improvements

## [1.4.7] - 2025-11-16

### Changed

- Minor updates and improvements

## [1.4.6] - 2025-11-02

### Changed

- Minor updates and improvements

## [1.4.5] - 2025-11-02

### Fixed

- Fix add new template on mobile (Fixes #15)

## [1.4.4] - 2025-11-02

### Changed

- Minor updates and improvements

## [1.4.3] - 2025-11-02

### Changed

- Minor updates and improvements

## [1.4.2] - 2025-10-25

### Changed

- Minor updates and improvements

## [1.4.1] - 2025-10-25

### Fixed

- Convert max_completion_tokens to max_tokens for Mistral AI compatibility

## [1.3.14] - 2025-10-12

### Fixed

- Fixed titling of message boxes (Issue #11)

## [1.3.13] - 2025-09-21

### Changed

- Minor updates and improvements

## [1.3.12] - 2025-09-20

### Changed

- Minor updates and improvements

## [1.3.11] - 2025-09-20

### Changed

- Minor updates and improvements

## [1.3.10] - 2025-09-20

### Changed

- Minor updates and improvements

## [1.3.9] - 2025-08-28

### Changed

- Minor updates and improvements

## [1.3.8] - 2025-08-26

### Changed

- Minor updates and improvements

## [1.3.7] - 2025-08-26

### Changed

- Minor updates and improvements

## [1.3.6] - 2025-08-26

### Changed

- Minor updates and improvements

## [1.3.5] - 2025-08-26

### Changed

- Minor updates and improvements

## [1.3.4] - 2025-08-24

### Added

- Import conversations from ChatGPT app feature (Issue #5)

## [1.3.2] - 2025-08-19

### Changed

- Minor updates and improvements

## [1.3.1] - 2025-07-02

### Changed

- Minor updates and improvements

## [1.3.0] - 2025-07-01

### Added

- Image generation and recognition support (Issue #6)
- Auto-detect model provider from model name (Issue #3)

## [1.2.12] - 2025-06-25

### Changed

- Minor updates and improvements

## [1.2.11] - 2025-06-21

### Changed

- Minor updates and improvements

## [1.2.10] - 2025-06-17

### Added

- Custom LLM provider management
- Input placeholders for LLM provider settings in EditModalProviders

### Changed

- Enhanced cursor behavior in PureChatLLMSideView
- Improved template management in SelectionPromptEditor

## [1.2.9] - 2025-06-16

### Changed

- Refactored README.md installation instructions
- Updated package-lock.json dependencies
- Initialized messages array in PureChatLLMChat
- Replaced EditSelectionModal with EditWand
- Enhanced SideView cursor behavior
- Improved settings management in main.ts and types.ts

## [1.2.8] - 2025-06-11

### Changed

- Minor updates and improvements

## [1.2.7] - 2025-06-06

### Changed

- Minor updates and improvements

## [1.2.6] - 2025-06-04

### Changed

- Minor updates and improvements

## [1.2.5] - 2025-05-30

### Changed

- Minor updates and improvements

## [1.2.4] - 2025-05-30

### Changed

- Minor updates and improvements

## [1.2.3] - 2025-05-25

### Changed

- Minor updates and improvements

## [1.2.2] - 2025-05-23

### Changed

- Minor updates and improvements

## [1.2.1] - 2025-05-22

### Changed

- Minor updates and improvements

## [1.2.0] - 2025-05-21

### Changed

- Minor updates and improvements

## [1.1.6] - 2025-05-15

### Changed

- Minor updates and improvements

## [1.1.5] - 2025-05-07

### Changed

- Minor updates and improvements

## [1.1.4] - 2025-05-02

### Changed

- Minor updates and improvements

## [1.1.3] - 2025-05-02

### Changed

- Improved API key handling
- Updated dependencies

## [1.1.2] - 2025-05-01

### Changed

- Minor updates and improvements

## [1.1.1] - 2025-05-01

### Added

- Enhanced all classes with detailed documentation

## [1.1.0] - 2025-04-30

### Added

- Implemented multiple API endpoints support

## [1.0.5] - 2025-04-24

### Changed

- Removed OpenAI API package dependency

### Added

- Powerful selection tools

## [1.0.1] - 2025-04-23

### Added

- Initial release with core chat functionality
- Interactive chat interface with ChatGPT directly in Obsidian notes
- Support for OpenAI API
- Note linking for context using `[[Note name]]` syntax
- Per-note customization with JSON blocks
- Flexible system prompts
- Markdown rendering support
- Side panel view with streaming support
- Selection command handling
- Simple API key setup

### Changed

- Switched from Rollup to ESBuild for bundling
- Upgraded to modern build system
- Improved settings management
- Enhanced code quality with ESLint

### Technical

- Target ES2018
- Use ESBuild for fast builds
- Add version bump automation
- Implement type checking with TypeScript
- Add proper licensing (MIT)
