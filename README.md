# Voice Agent

**Voice Agent** (formerly Pure Chat LLM) lets you talk to your vault through a duplex voice agent with a background orchestrator and workers, and still turns notes into chats. It leverages Obsidian notes to provide a graphical user interface (GUI) for ChatGPT directly within your vault. This plugin transforms your notes into interactive chat windows, enabling seamless conversations, brainstorming, questions, and prompt generation — all without leaving Obsidian.

---

## Features

- **Interactive chat interface:** Engage in seamless conversations with ChatGPT and other leading AI models directly from any Obsidian note. Edit your questions or responses and continue the chat without leaving your vault.
- **Multiple AI providers:** Choose from a wide range of supported model providers, including OpenAI, Gemini, xAI, Anthropic, Cohere, Mistral AI, and DeepSeek. Easily switch between providers and models to suit your needs.
- **Note linking for context:** Use `[[Note name]]` or Markdown links to include the content of other notes in your chat, providing additional context or structuring complex prompts. (Referenced notes must start at the beginning of a line.)
- **Per-note customization:** Configure API parameters (such as `model`, `max_completion_tokens`, and more) on a per-note basis using a JSON block at the top of your note.
- **Flexible system prompts:** Modify system prompts within your notes to influence the AI’s behavior for each conversation.
- **Chat-linked notes:** Link specific notes to individual chat sessions for organized, context-rich discussions.
- **Markdown rendering:** All chat responses support full Markdown formatting, including lists, code blocks, and more.
- **Simple setup:** Just add your API key for your chosen provider in the plugin settings to get started.

> [!IMPORTANT] > **Note:** This plugin is _not_ an AI note editor. It is designed solely for chatting with AI models through notes. It does not edit or manage your notes beyond the chat interface—it simply turns notes into GUI elements for AI chat.

---

## How to Use

1. Create a new note in Obsidian.
2. Write your question, prompt, or message.
3. To initiate chat, press **Shift + Enter** or use the **Complete chat response** command.
4. Your note will transform into a chat interface, allowing you to continue the conversation.
5. To customize API parameters, add a JSON block at the top of your note, specifying options like:
   - `model` (e.g., `"gpt-4.1-nano"`)
   - `max_completion_tokens`
   - `stream`
   - Other API options (see [OpenAI API documentation](https://platform.openai.com/docs/api-reference/create))
6. To include content from other notes, use `[[Note name]]` within your note. This will insert the entire content of that note at the position, which can be used as part of your message or role, helping you structure complex prompts or context.

---

## Example Chat

> [!NOTE]
> To include the content from another note, use the following JSON configuration:
>
> ```json
> {
>   "model": "gpt-4.1-nano",
>   "max_completion_tokens": 4096,
>   "stream": true
> }
> ```
>
> Then, start your message with:
>
> ```markdown
> # role: system
>
> You are a helpful assistant.
>
> # role: user
>
> [[Introduction]]
>
> # role: assistant
>
> Hello! How can I assist you today?
> ```
>
> _(In this example, the content of the note named "Introduction" will be included in the message.)_
>
> **Note:** The note you reference must start at the beginning of a line in your markdown for this feature to work correctly.

---

## Installation

### With BRAT (this fork)

Voice Agent isn't in the community plugin browser yet. Install it from this repository's GitHub releases with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from **Settings → Community plugins → Browse**.
2. Run the command **BRAT: Plugins: Add a beta plugin for testing**.
3. Enter the repository, `Zpankz/pure-chat-llm` (use the new name if the repository is renamed), and pick the latest version.
4. Enable **Voice Agent** under **Settings → Community plugins**.

BRAT installs `main.js`, `manifest.json` and `styles.css` from the newest release, and can check for updates.

**Moving from Pure Chat LLM:** Voice Agent has its own plugin id (`voice-agent`). On first load it copies your Pure Chat LLM settings, and sign-ins carry over. Hotkeys don't carry over, so bind them again under **Settings → Hotkeys**, and turn off Pure Chat LLM if it's still on.

### Making a release (maintainers)

1. Bump the version: `npm version <x.y.z> --no-git-tag-version` updates `package.json`, `manifest.json` and `versions.json`.
2. Add a `## [x.y.z]` section to `CHANGELOG.md` and commit.
3. Push a tag that equals the manifest version, with no `v`: `git tag x.y.z && git push origin x.y.z`.

The release workflow checks that the tag matches `manifest.json`, runs the tests, builds, and attaches the three files to a GitHub release. A tag like `x.y.z-beta.1` makes a pre-release.

### Original Pure Chat LLM

The original plugin is in the community plugin browser as **Pure Chat LLM**.

---

## Setting Your API key

Before using the **Pure Chat LLM** plugin, you must enter your OpenAI API key:

- Navigate to **Settings** -> **Community Plugins** -> **Pure Chat LLM**
- Find the **API key** field
- Enter your OpenAI API key (you can generate one from the [OpenAI API keys page](https://platform.openai.com/account/api-keys))
- Save your settings

_Note:_ The API key must be set before initiating chats. If you use the **Complete chat response** command without a configured API key, the plugin will prompt you to enter it.

---

## Usage Reminder

- When you first try to run **Complete chat response** or start a new chat, if the API key isn't configured, you'll be prompted to enter it.
- After entering your API key, it will be saved for future sessions. You won't need to re-enter it unless you change it.

---

## Voice Call Feature

Talk to your vault with a live voice model. Pick the provider under **Settings → Voice agents**; the API key comes from the matching model provider (OpenAI, Gemini or xAI).

| Provider        | Default model                                                   | Transport                        | Notes                                                                |
| --------------- | --------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| OpenAI realtime | `gpt-realtime-2.1` (also `gpt-realtime-2.1-mini`)               | WebRTC, `/v1/realtime/calls`     | Semantic VAD, noise reduction, input transcription, reasoning effort |
| OpenAI GPT-Live | `gpt-live-1`                                                    | WebRTC, `/v1/live/sessions`      | Full duplex: keeps talking while a backend agent works               |
| Gemini live     | `gemini-3.8-live` (also extended thinking and 2.5 native audio) | WebSocket, `BidiGenerateContent` | Non-blocking tools, context compression, session resumption          |
| Grok voice      | `grok-voice-latest`                                             | WebSocket, `/v1/realtime`        | Ephemeral client secret, web and X search                            |

Every model and voice field accepts free text, so newer model ids work without a plugin update.

### GPT-Live duplex agent

GPT-Live hands reasoning and tool use to a backend agent while it keeps the conversation going. Choose who runs that agent in settings:

- **OpenAI Responses**: OpenAI runs the backend model (default `gpt-6-luna`) with your vault tools, remote MCP servers and optional web search. You can set the backend model, instructions, reasoning effort, tool choice, parallel calls and service tier.
- **This plugin**: your default chat provider and model run the backend inside Obsidian with your vault tools, and the result is handed back to GPT-Live. You can set the acknowledgement delay and instructions.

### Tools for voice models

With **Agent mode** on, voice models can use every enabled tool. To keep a voice model's context small, set **Tools exposed to voice models** to **Code mode only**: the model then gets one `codemode` tool and writes a short script that calls the other tools. Tool results are trimmed to a configurable length before they are sent back, and the voice model is told to answer in plain spoken language.

### Layered voice agents

By default (**Voice model role: Layered**) a call runs on four layers, each with its own model, reasoning effort and context. Set them under **Settings → Voice orchestrator and sub-agents**.

| Layer        | Job                                                                                                   | Default                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Voice        | Talks with you, filters noise, answers small talk, relays everything else                             | The voice provider you picked                                        |
| Orchestrator | Plans, does quick read-only lookups and code mode, writes briefs, runs workers, decides what you hear | `gpt-6.1-sol`, medium effort, OpenAI key or **Sign in with ChatGPT** |
| Workers      | Background sub-agents with every vault tool, skill, MCP server and code mode                          | `muse-spark-1.3-contributor` on Meta, extra-high effort (see below)  |
| Evaluator    | Optional: checks plans and results when the orchestrator asks (`request_evaluation`)                  | Off; `gemini-4-argon`, high effort                                   |

What each layer sees:

- **Orchestrator:** the whole call (each relay carries the transcript lines it hasn't seen), plus a short summary of each worker event. It opens a worker's full thread only when it chooses to (`read_task_thread`).
- **Voice:** what the orchestrator tells it (`tell_user`, with interrupt, pause or silent timing) and a quiet overview of the orchestrator's activity: which tools it used and which tasks it started, never their outputs. `orchestrator_activity` lists them on demand.
- **Workers:** only the brief the orchestrator writes.

Updates follow GPT-Live's timing: results and questions wait for a pause, quiet context is passed silently, and an update cuts in only when it would overrule or change what you are saying right now (checked by the worker model, or by keywords). Each event type (started, progress, needs advice, stuck, timed check-in, finished, failed, cancelled) can be routed differently. Ask for "updates every minute" and the voice turns on spoken progress.

**Voice model role: Orchestrator** keeps the earlier two-layer setup (the voice model delegates to workers itself), and **Direct** lets the voice model call tools itself.

Workers' edits and deletes go to two independent reviewer agents, each seeing only the proposed change. The change is made only when both approve; the note is backed up first, and deleted notes go to the trash. New notes are created straight away. Each action's rule can be changed (allow, two reviewers, ask me, never).

#### Sign-in and model notes

- **Sign in with ChatGPT** uses OpenAI's official sign-in for local apps (desktop only, since it opens a local sign-in page). Layers set to it run on your ChatGPT plan through the Responses API. Tokens are kept in Obsidian's secret storage, not in the vault or the settings file. Remote MCP sign-in tokens are kept there too.
- **Gemini, xAI and Meta** use API keys. None of them documents a way for third-party apps to use a consumer subscription, so the plugin doesn't offer one.
- **Muse Ember 1.0 contributor** isn't on Meta's public model list; set the worker model to it if your account lists it. Contributor models are cheaper because your prompts may be used for training.
- **Gemini 4 Hydrogen** has no public model id; the evaluator defaults to Gemini 4 Argon.

### Using voice calls

1. Open the voice call panel from the ribbon or the command palette ("Open voice call panel").
2. Pick a provider and press **Start call**, then allow microphone access.
3. Mute or end the call from the panel. A live transcript shows what you and the model said, and which tools ran.

## Agent tools

### Code mode

The `codemode` tool (modelled on pi's code mode) lets a model write one JavaScript async function body that calls several tools, filters results and returns only what matters. It runs on the [djs](https://github.com/earendil-works/djs) engine when `djs.wasm` is in the plugin folder, and otherwise in a Web Worker, a weaker sandbox with no instruction or memory limits. djs has no official prebuilt release yet (as of 15 November 2026 its repository publishes source only), so the plugin ships none and downloads none by default: build it with `scripts/build-wasm.sh` from the djs repository and copy it in, or set a download address with its pinned SHA-256 in settings. Scripts have no network access except through your MCP servers, can't change plugin settings, and go through the same write rules as the tools they call: a worker's script can read anything and create notes, while its edits and deletes need the two reviewers. Inside the script:

- `await tools.<name>(args)` calls any enabled tool; `searchTools(query)`, `describeTool(name)` and `ALL_TOOLS` help find them.
- `text(value)` adds output for the model; `console.log` is captured; `store(key, value)` and `load(key)` keep small values between scripts; `exit(value)` stops early.
- An optional first line `// @options: {"timeout_ms": 30000, "max_output_tokens": 4000}` overrides the limits.

### Agent Skills

Put skills in the **Skills folder** (default `Skills`, hidden folders such as `.agents/skills` also work). Each skill is a folder whose main note is named after it (for example `review/review.md`), so the vault doesn't fill up with identical names; a `SKILL.md` in the [Agent Skills format](https://agentskills.io/specification) also works. The orchestrator and workers use skills and MCP servers; the voice layer doesn't. Models see each skill's name and description, load the full instructions with `activate_skill` when a task matches, and read bundled files with `read_skill_file`.

### Remote MCP servers

Add Streamable HTTP servers under **Settings → Remote MCP servers**. The client speaks the current MCP spec (2026-07-28, stateless requests with `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` headers) and falls back to the 2025-11-25 session-based protocol for older servers. Authentication is a bearer token, custom headers, or OAuth sign-in through your browser (with dynamic client registration and token renewal).

- **Bridge** (default): the plugin calls the server, and its tools appear to every model as `mcp__server__tool` under the MCP category.
- **Native where supported**: OpenAI realtime, GPT-Live (Responses backend) and Grok voice call the server directly. Those providers receive the server's token and headers. Other models still use the bridge.

### Typed graph traversal

Workers explore the vault's link graph, including typed relations from the [Typed Graph](https://github.com/volland/obsigraph) plugin's schema notes (frontmatter with `tgs:`, such as a `_types` folder):

- `traverse_graph`: multi-hop outgoing links, backlinks and unresolved links, filtered by relation (`edge_types`), node type, folder and tag, with the route to each note. Inline fields in a note's text (`field:: [[x]]`) count as typed relations, like frontmatter. Notes can be named by path, name, alias or folder note.
- `vault_ontology`: the declared node and edge types, how often each is used, tags and properties. A short version goes into every worker's instructions.
- `graph_cli`: single-purpose commands (`path`, `hubs`, `related`), plus `save` and `run` for traversal scripts that worked well, kept as notes in **Saved graph commands folder** so they become reusable commands.

### Troubleshooting

- **Connection fails:** check that the matching provider has an API key and that your account can use that model.
- **Tools not working:** turn on Agent mode, and check the tool categories that are enabled.
- **MCP server shows an error:** press the test button next to it; the message comes from the server.
- **Tool execution fails:** check the developer console for details.

---

## Useful Links

- [OpenAI API documentation](https://platform.openai.com/docs)
- [API authentication](https://platform.openai.com/docs/api-reference/authentication)
- [Chat API reference](https://platform.openai.com/docs/api-reference/chat)
- [Responses & parameters](https://platform.openai.com/docs/api-reference/responses/create)
