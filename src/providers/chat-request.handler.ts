import * as vscode from "vscode";
import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatRequestHandleOptions,
	LanguageModelResponsePart,
	Progress,
} from "vscode";
import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockClient } from "../clients/bedrock.client";
import { StreamProcessor } from "../stream-processor";
import { convertMessages } from "../converters/messages";
import { convertTools } from "../converters/tools";
import { buildRequestInput } from "../converters/request";
import { getModelProfile } from "../profiles";
import { validateRequest } from "../validation";
import { logger } from "../logger";
import { ModelService } from "../services/model.service";
import { AuthenticationService } from "../services/authentication.service";
import { ConfigurationService } from "../services/configuration.service";
import { TokenEstimator } from "./token.estimator";
import { UsageTracker } from "../usage-tracker";
import type { BedrockMessage, ReasoningBlock, ToolCallFailure } from "../types";

/**
 * How many turns of signed reasoning to keep for replay. Extended thinking with
 * tool use requires the previous turn's reasoning to be sent back verbatim, but
 * only the turns still present in the conversation matter, so the map is trimmed
 * rather than grown without bound for the life of the window.
 */
const MAX_REASONING_ENTRIES = 64;

/**
 * Handles chat request processing for Bedrock models.
 * Coordinates message conversion, validation, and streaming.
 */
export class ChatRequestHandler {
	private bedrockClient: BedrockClient;
	private streamProcessor: StreamProcessor;
	private tokenEstimator: TokenEstimator;
	private usageTracker: UsageTracker;

	/**
	 * Reasoning captured from previous turns, keyed by a toolUseId that the turn
	 * produced.
	 *
	 * Keyed rather than held in a single "last reasoning" field on purpose. VS
	 * Code runs chat requests concurrently, so one field is overwritten by
	 * whichever request finishes last and the reasoning replayed on the next turn
	 * belongs to a different conversation, which Bedrock rejects because the
	 * signature does not match the content.
	 */
	private reasoningByToolUseId = new Map<string, ReasoningBlock[]>();

	constructor(
		private readonly modelService: ModelService,
		private readonly authService: AuthenticationService,
		private readonly configService: ConfigurationService
	) {
		const region = this.configService.getRegion();
		this.bedrockClient = new BedrockClient(region);
		this.streamProcessor = new StreamProcessor();
		this.tokenEstimator = new TokenEstimator();
		this.usageTracker = new UsageTracker();
	}

	/**
	 * Handle configuration changes
	 */
	handleConfigurationChange(): void {
		const region = this.configService.getRegion();
		this.bedrockClient.setRegion(region);
	}

	/**
	 * Process a chat request and stream the response
	 */
	async handleChatRequest(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatMessage[],
		options: LanguageModelChatRequestHandleOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					logger.error("[Chat Request Handler] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};

		// Bridge cancellation to the SDK so stopping a request actually tears down
		// the HTTP connection instead of just ending our read loop.
		const abortController = new AbortController();
		const cancellationSubscription = token.onCancellationRequested(() => abortController.abort());

		try {
			const authConfig = await this.authService.getAuthConfig();
			if (!authConfig) {
				throw new Error("Bedrock authentication not configured");
			}

			// One summary line, not one line per message. A long agent session sends
			// over a hundred messages per turn, and the old per-message dump buried
			// everything worth reading in the output channel.
			logger.log("[Chat Request Handler] Converting messages", {
				count: messages.length,
				parts: tallyParts(messages),
			});

			const profile = getModelProfile(model.id);
			const thinkingRequested = this.configService.isThinkingEnabled();
			const thinkingPossible = thinkingRequested && profile.thinkingApi !== "none";

			const converted = convertMessages(messages, model.id, {
				// Only replay reasoning when it will actually be needed. Sending it to
				// a request that has thinking off is a validation error.
				reasoningByToolUseId: thinkingPossible ? this.reasoningByToolUseId : undefined,
			});
			validateRequest(messages);

			logger.log("[Chat Request Handler] Converted to Bedrock messages", {
				count: converted.messages.length,
				systemBlocks: converted.system.length,
				blocks: tallyBlocks(converted.messages),
			});

			const toolConfig = convertTools(options, model.id);

			if (options.tools && options.tools.length > 128) {
				throw new Error("Cannot have more than 128 tools per request.");
			}

			const built = buildRequestInput({
				model,
				converted,
				options,
				profile,
				toolConfig,
				maxOutputTokensOverride: this.configService.getMaxOutputTokens(),
				thinking: {
					enabled: thinkingRequested,
					effort: this.configService.getThinkingEffort(),
					budgetTokens: this.configService.getThinkingBudgetTokens(),
				},
				promptCaching: this.configService.isPromptCachingEnabled(),
			});
			const requestInput = built.input;

			// Substitute invocation target (override ARN or system profile) at the wire level.
			// This keeps the bare model ID for getModelProfile() so capability detection
			// (e.g. temperature suppression for Claude 4+) still works correctly.
			const invocationTarget = this.modelService.getInvocationTarget(model.id);
			if (invocationTarget) {
				requestInput.modelId = invocationTarget;
			}

			const credentials = this.authService.getCredentials(authConfig);

			const tokenLimit = Math.max(1, model.maxInputTokens);
			const { inputTokens, source } = await this.countInputTokens({
				credentials,
				modelId: requestInput.modelId ?? model.id,
				requestInput,
				messages,
				converted,
				toolConfig,
				abortSignal: abortController.signal,
			});

			if (inputTokens > tokenLimit) {
				logger.error("[Chat Request Handler] Message exceeds token limit", {
					total: inputTokens,
					tokenLimit,
					source,
				});
				throw new Error(
					`Message exceeds token limit (${inputTokens} > ${tokenLimit}). Start a new chat or remove some context.`
				);
			}

			logger.log("[Chat Request Handler] Starting streaming request", {
				modelId: requestInput.modelId,
				maxTokens: requestInput.inferenceConfig?.maxTokens,
				thinking: built.thinkingEnabled,
				cachePoints: built.cachePoints,
				inputTokens,
				tokenSource: source,
			});

			const stream = await this.bedrockClient.startConversationStream(
				credentials,
				requestInput,
				abortController.signal
			);

			logger.log("[Chat Request Handler] Processing stream events");
			const result = await this.streamProcessor.processStream(stream, trackingProgress, token, {
				thinkingDisplay: built.thinkingEnabled ? this.configService.getThinkingDisplay() : "hidden",
			});
			logger.log("[Chat Request Handler] Finished processing stream");

			this.usageTracker.record({
				modelId: model.id,
				stopReason: result.stopReason,
				usage: result.usage,
				latencyMs: result.latencyMs,
				estimatedInputTokens: inputTokens,
				estimateSource: source,
				maxInputTokens: tokenLimit,
				maxOutputTokens: requestInput.inferenceConfig?.maxTokens ?? 0,
				emittedToolCalls: result.emittedToolCalls,
				cachePoints: built.cachePoints,
				thinkingEnabled: built.thinkingEnabled,
			});

			this.rememberReasoning(result.reasoning, result.toolUseIds);

			if (result.toolCallFailures.length > 0 && !token.isCancellationRequested) {
				throw new Error(
					describeToolCallFailure(
						result.toolCallFailures,
						result.stopReason,
						requestInput.inferenceConfig?.maxTokens ?? 0,
						model.maxOutputTokens
					)
				);
			}
		} catch (err) {
			// Cancellation is not a failure and should not raise an error toast.
			if (abortController.signal.aborted || token.isCancellationRequested) {
				logger.log("[Chat Request Handler] Request cancelled");
				return;
			}

			const errorMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Chat Request Handler] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			vscode.window.showErrorMessage(`Bedrock chat request failed: ${errorMsg}`);
			throw err;
		} finally {
			cancellationSubscription.dispose();
		}
	}

	/**
	 * Determine the input token count for a request, preferring Bedrock's own
	 * tokenizer over the character heuristic.
	 */
	private async countInputTokens(params: {
		credentials: Parameters<BedrockClient["countTokens"]>[0];
		modelId: string;
		requestInput: ConverseStreamCommandInput;
		messages: readonly LanguageModelChatMessage[];
		converted: { messages: unknown[]; system: unknown[] };
		toolConfig: unknown;
		abortSignal: AbortSignal;
	}): Promise<{ inputTokens: number; source: "native" | "heuristic" }> {
		const heuristic =
			this.tokenEstimator.estimateMessagesTokens(params.messages) +
			this.tokenEstimator.estimateToolTokens(params.toolConfig as never) +
			this.tokenEstimator.estimateSystemTokens(
				(params.converted.system as Array<{ text?: string }>) ?? []
			);

		if (!this.configService.isNativeTokenCountingEnabled()) {
			return { inputTokens: heuristic, source: "heuristic" };
		}

		const native = await this.bedrockClient.countTokens(
			params.credentials,
			params.modelId,
			{
				messages: params.requestInput.messages,
				system: params.requestInput.system,
				toolConfig: params.requestInput.toolConfig,
			},
			params.abortSignal
		);

		return native !== undefined
			? { inputTokens: native, source: "native" }
			: { inputTokens: heuristic, source: "heuristic" };
	}

	/**
	 * Store this turn's reasoning against every tool call it produced, so the
	 * follow-up request carrying those tool results can replay it.
	 */
	private rememberReasoning(reasoning: ReasoningBlock[], toolUseIds: string[]): void {
		if (reasoning.length === 0 || toolUseIds.length === 0) {
			return;
		}
		for (const id of toolUseIds) {
			this.reasoningByToolUseId.set(id, reasoning);
		}
		while (this.reasoningByToolUseId.size > MAX_REASONING_ENTRIES) {
			const oldest = this.reasoningByToolUseId.keys().next();
			if (oldest.done) {
				break;
			}
			this.reasoningByToolUseId.delete(oldest.value);
		}
	}
}

/** Count the incoming VS Code content parts by kind, for one compact log line. */
function tallyParts(messages: readonly LanguageModelChatMessage[]): Record<string, number> {
	const tally: Record<string, number> = {};
	const bump = (kind: string) => {
		tally[kind] = (tally[kind] ?? 0) + 1;
	};

	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				bump("text");
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				bump("toolCall");
			} else if (isImagePart(part)) {
				bump("image");
			} else {
				bump("toolResult");
			}
		}
	}
	return tally;
}

function isImagePart(part: unknown): boolean {
	if (!part || typeof part !== "object" || !("mimeType" in part)) {
		return false;
	}
	const mimeType = (part as { mimeType?: unknown }).mimeType;
	return typeof mimeType === "string" && mimeType.startsWith("image/");
}

/** Count the outgoing Bedrock content blocks by kind. */
function tallyBlocks(messages: readonly BedrockMessage[]): Record<string, number> {
	const tally: Record<string, number> = {};
	const bump = (kind: string) => {
		tally[kind] = (tally[kind] ?? 0) + 1;
	};

	for (const message of messages) {
		for (const block of message.content) {
			if ("text" in block) {
				bump("text");
			} else if ("image" in block) {
				bump("image");
			} else if ("toolUse" in block) {
				bump("toolUse");
			} else if ("reasoningContent" in block) {
				bump("reasoning");
			} else if ("cachePoint" in block) {
				bump("cachePoint");
			} else {
				bump("toolResult");
			}
		}
	}
	return tally;
}

/**
 * Turn a dropped tool call into something the user can act on.
 *
 * The original behaviour logged "Invalid JSON for tool call" and returned
 * normally, so the agent simply stopped with no visible reason. Truncation from
 * an output-token cap is by far the most common cause, so name that explicitly
 * when the stop reason confirms it. The call is deliberately not repaired or
 * invented: half a tool call for a file edit would apply a truncated
 * replacement string and corrupt the file.
 */
export function describeToolCallFailure(
	failures: readonly ToolCallFailure[],
	stopReason: string | undefined,
	maxTokens: number,
	modelMaxOutputTokens: number
): string {
	const names = failures.map((f) => f.name ?? `#${f.index}`).join(", ");

	if (stopReason === "max_tokens") {
		const ceiling = modelMaxOutputTokens > 0 ? ` The model allows up to ${modelMaxOutputTokens}.` : "";
		return (
			`The model ran out of output tokens partway through a tool call (${names}), so its arguments were cut off ` +
			`and could not be used. The response was limited to ${maxTokens} output tokens.${ceiling} ` +
			`Raise "languageModelChatProvider.bedrock.maxOutputTokens" or ask for a smaller change, then retry.`
		);
	}

	return (
		`The model produced a tool call (${names}) whose arguments were not valid JSON, so it could not be run. ` +
		`Retry the request. See the "Bedrock Chat" output channel for the partial arguments.`
	);
}
