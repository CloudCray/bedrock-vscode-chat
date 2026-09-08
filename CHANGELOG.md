# Changelog

All notable changes to the AWS Bedrock Provider for GitHub Copilot Chat extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- **`Invalid JSON for tool call`, which stopped agent turns mid-task** (#25). This was several independent defects, not one:
  - **Output-token ceiling defaulted to 4096.** Copilot does not send `max_tokens`, so every response was capped at 4096 output tokens no matter what the model allowed. A whole-file edit call exceeds that easily, Bedrock stops mid-string with `stopReason: max_tokens`, and the half-written JSON never parses. Requests now default to the model's own ceiling, and the per-model fallback is version-aware instead of a flat 4096.
  - **Stream state was shared across concurrent requests.** One tool-argument buffer lived on the request handler and was reset at the start of every stream, so a second concurrent request wiped the arguments the first was still accumulating. That is what produced the reported error with an empty `snippet`. Buffers are now created per response.
  - **Zero-parameter tool calls were treated as failures.** A tool whose schema declares no parameters emits no argument deltas at all; the empty buffer is now emitted as `{}`.
  - **The same failure was logged twice.** Force-emitting is now terminal, so `contentBlockStop` followed by `messageStop` reports once.
  - **Legitimate repeat tool calls were dropped.** Deduplication keyed on the arguments, so a model asking to read the same file twice in one turn lost the second call. It now keys on `toolUseId`.
  - **Object-valued argument deltas became `[object Object]`.** Bedrock documents `delta.toolUse.input` as a string, but some model families return a parsed object; those are now serialized.
  - **Failures were silent.** A dropped tool call now raises a visible error naming the tool, and says which setting to raise when the output cap was the cause. Truncated arguments are deliberately never repaired, because applying half of a file-edit call would corrupt the file.
- **Text was discarded when it shared a message with tool results** (#25). Both are now sent.
- **Mid-stream Bedrock faults ended turns quietly.** Bedrock reports throttling, validation and internal errors as stream *events* rather than throwing; those are now surfaced. Conversely, a single malformed event no longer abandons the rest of the response.
- **Mismatched `tool_use` / `tool_result` pairs caused opaque 400s.** Orphan and duplicate tool results are dropped, and unanswered tool calls get a synthetic error result, so the model learns its tool did not run instead of the request failing with no detail.
- **Cancelling a request left the HTTP connection open.** Cancellation is now bridged to the AWS SDK through an abort signal.
- **Context-window display read near-empty during tool-heavy sessions** (#22). The token estimator counted only text parts; it now counts tool calls, tool results, images and binary content, with per-message overhead.

### Added

- **Token usage, context size and latency reporting** (#22). Bedrock returns all of it on the stream's `metadata` event, which the provider previously ignored. Each turn now logs input/output/total tokens, cache reads and writes, context-window percentage, latency, stop reason and tool-call count to the **Bedrock Chat** output channel, with running session totals, plus warnings when the context passes 90% full or when caching produced no activity. Note the ceiling on this: the finalized provider API gives a provider no channel for feeding usage into Copilot's own Agent debug log.
- **Prompt caching** (#19), on by default and toggleable via `promptCaching.enabled`. Checkpoints are placed on tool schemas, the system prompt and the trailing pair of user messages, so each turn reads back the checkpoint the previous turn wrote. Capped at Anthropic's four, gated on a fail-closed model capability check, and skipped entirely below the minimum cacheable prompt size.
- **Extended thinking**, off by default, with `thinking.enabled`, `thinking.effort` (`low`/`medium`/`high`/`xhigh`), `thinking.budgetTokens` and `thinking.display` (`native`/`text`/`hidden`). The right API is chosen per model: the adaptive effort API for Claude 4.6 and newer, the token-budget API for 3.7 through 4.5, and nothing for older models. Enabling it suppresses `temperature` and `topP` and relaxes a forced tool choice, as Anthropic requires. Signed reasoning is replayed verbatim on the follow-up tool-result turn, keyed by tool-use ID so concurrent requests cannot cross-contaminate. Native rendering is feature-detected at runtime rather than declared as a proposed API, since the Marketplace rejects builds that declare one.
- **Two ways to change reasoning effort without opening settings.** A status bar item (`Bedrock: think high`) opens a quick pick for the global default, writing the same settings the settings editor shows rather than keeping a second copy of the state. And with `thinking.showEffortVariants` on, each reasoning-capable model appears in the chat model picker once per effort level — because VS Code remembers the model per conversation, that makes effort per-conversation, which no provider API otherwise allows. A variant picked in the chat window wins; everything else falls back to the status bar default. Variants are off by default, since they multiply the length of the picker, and models with no reasoning mode are never expanded. Effort levels are encoded into the model ID and decoded before use, so the wire request, capability detection and inference-profile routing all still see the real Bedrock ID; an unrecognized suffix degrades to the base model rather than failing the request.
- **Native token counting** via Bedrock's `CountTokens` API, on by default and toggleable via `nativeTokenCounting`, replacing the character heuristic for the pre-flight context check. A model that permanently rejects the call is remembered, so it is not re-probed every turn; transient faults such as throttling are not held against it.
- **`maxOutputTokens` setting** to cap output tokens per response. `0` means the model's maximum.
- **Manual model declarations** (#23) for environments where model listing is blocked by a Service Control Policy but invocation is allowed.

### Changed

- Connection handling: longer streaming timeouts, keep-alive connection pooling shared per client kind, and the AWS SDK's adaptive retry mode. SDK-level retries were chosen over a hand-rolled retry around the stream, which can duplicate already-emitted output.
- `claude-v2` and `claude-instant` are no longer treated as having a thinking API. Neither carries a parseable version, so the "unrecognized ID, assume current" rule would have sent them a reasoning config that predates them by years and that Bedrock rejects. The two names are closed-ended, so recognizing them costs nothing in future-proofing.
- Cross-region routing prefixes `global.` and `apac.` are now stripped during capability detection. A `global.`-prefixed Claude 4 ID previously fell through to the default profile and sent `temperature`, which Bedrock rejects.
- The per-message request dump in the output channel is now one summary line per direction. A long agent session sends over a hundred messages per turn, and the old dump buried everything worth reading.

### Internal

- 131 offline unit tests, up from 59, covering the tool-buffer fixes, stream results and error handling, cache-point placement, tool-block reconciliation, thinking configuration and display, effort-variant encoding and precedence, usage tracking, token estimation across every part type, and per-model output ceilings. Every file touched is lint-clean.
- `scripts/live-feature-test.js`, a live end-to-end harness that drives the compiled modules against real Bedrock and asserts on the responses: cache checkpoints reading back across turns, signed reasoning on both thinking APIs, a multi-kilobyte tool call arriving as parseable JSON, an effort variant decoding back to an invocable model ID, mid-stream fault propagation, and usage captured from the metadata event. Verified 22/22 against Claude Haiku 4.5 and Sonnet 4.6 in `us-west-2`.
- `docs/mockups/` records the four UI options considered for where the effort control should live, and why the status bar plus optional picker variants won. `docs/screenshots/` shows what the built version looks like, and supersedes the mockups where the two disagree.
- Packaging hygiene: `docs/` and the dev-only `scripts/` directory are excluded from the VSIX.

## 0.0.6

### Fixed

- **Temperature sent to Claude 5+ models** (#21): Bedrock rejects the `temperature` inference parameter for Claude 4+ models, and version detection only matched literal Claude 4 IDs. Detection now parses the major version (#24, thanks @Josh-Karp) and fails closed: unrecognized Anthropic model IDs omit temperature instead of failing every request (#26).

### Internal

- Modular Playwright e2e harness (`e2e/lib/` + `e2e/stages/`) with a live Claude Sonnet 5 temperature-regression stage and Bedrock-only model-selection guarantees: provider-group row binding grounded in VS Code 1.122.1 source, per-stage log-delta stream proofs, and session-scoped verification (#26).

## 0.0.5

### Added

- **Application inference profile overrides** (#17): configure specific models to route through AWS Bedrock application inference profiles, with region-based profile resolution. Verified end-to-end against a live application inference profile ARN.

### Fixed

- **Image format mismatch errors** (#20): the actual image format is now detected from the file's magic bytes instead of trusting VS Code's reported MIME type, fixing Bedrock API validation failures when the declared format and image data disagree.

### Internal

- Test and tooling hardening: lint out-of-memory fix, extracted a pure `buildRequestInput()`, expanded offline unit tests (provider routing, temperature configuration, stream cancellation, tool limits, auth), and a hardened Playwright end-to-end harness.

## 0.0.4

- Inference profile handling improvements and packaging hygiene.
- Route the AWS SDK through the configured proxy (#8).
- Omit `temperature` for Claude 4.x models (#9).
- End-to-end test harness (Playwright + VS Code Electron).

## 0.0.3

- Remove proposed thinking API, packaging hygiene, and marketplace listing refresh.
- Compatibility with newer VS Code releases (#4).

## 0.0.2

- Additional authentication methods (AWS profile, access keys) and native image support in chat (#1).

## 0.0.1

- Initial release.
