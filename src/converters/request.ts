import type { LanguageModelChatInformation, LanguageModelChatRequestHandleOptions } from "vscode";
import { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { ModelProfile } from "../profiles";
import type { BedrockMessage, BedrockSystemBlock, BedrockToolConfig } from "../types";
import { applyCachePoints } from "./cache-points";

/** Effort levels accepted by the adaptive thinking API. */
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh";

export interface ThinkingSettings {
	enabled: boolean;
	effort: ThinkingEffort;
	/** Token budget for models on the legacy budget API. */
	budgetTokens: number;
}

/**
 * Token budget to request from a legacy (pre-adaptive) thinking model for a
 * given effort level. Anthropic requires at least 1024 and the budget must stay
 * below maxTokens, which the caller clamps.
 */
export function budgetForEffort(effort: ThinkingEffort): number {
	switch (effort) {
		case "low":
			return 2048;
		case "medium":
			return 8192;
		case "high":
			return 16384;
		case "xhigh":
			return 32768;
	}
}

export interface BuildRequestResult {
	input: ConverseStreamCommandInput;
	/** True when extended thinking was actually enabled for this request. */
	thinkingEnabled: boolean;
	/** Number of prompt-cache checkpoints inserted. */
	cachePoints: number;
}

/**
 * Build the Bedrock ConverseStream request from already-converted pieces.
 *
 * Pure function (no I/O) so the inferenceConfig assembly — temperature omission
 * for models that deprecated it, the output-token cap, thinking configuration
 * and cache checkpoints — is unit-testable without a live Bedrock call.
 */
export function buildRequestInput(params: {
	model: Pick<LanguageModelChatInformation, "id" | "maxOutputTokens">;
	converted: { messages: BedrockMessage[]; system: BedrockSystemBlock[] };
	options: LanguageModelChatRequestHandleOptions;
	profile: ModelProfile;
	toolConfig?: BedrockToolConfig;
	/** User override for max output tokens. 0 or undefined means "use the model maximum". */
	maxOutputTokensOverride?: number;
	thinking?: ThinkingSettings;
	promptCaching?: boolean;
}): BuildRequestResult {
	const { model, converted, options, profile, toolConfig, maxOutputTokensOverride, thinking } = params;

	// Output-token budget.
	//
	// This used to default to 4096, which is the single biggest cause of the
	// "Invalid JSON for tool call" reports: Copilot does not send max_tokens, so
	// every response was capped at 4096 output tokens regardless of the model's
	// real limit. A whole-file edit tool call easily exceeds that, Bedrock stops
	// mid-string with stopReason "max_tokens", and the half-written JSON never
	// parses. Default to what the model actually allows instead.
	const modelCeiling = Math.max(1, model.maxOutputTokens);
	const requested = numericOption(options.modelOptions?.max_tokens) ?? maxOutputTokensOverride ?? modelCeiling;
	const maxTokens = Math.max(1, Math.min(requested, modelCeiling));

	const thinkingEnabled = Boolean(thinking?.enabled) && profile.thinkingApi !== "none";

	const cached = applyCachePoints(
		{ messages: converted.messages, system: converted.system, toolConfig },
		profile,
		Boolean(params.promptCaching)
	);

	const requestInput: ConverseStreamCommandInput = {
		modelId: model.id,
		messages: cached.messages as ConverseStreamCommandInput["messages"],
		inferenceConfig: {
			maxTokens,
			// Temperature must be omitted for models that have deprecated it (e.g. Claude 4+),
			// and also whenever extended thinking is on: Anthropic rejects any sampling
			// override alongside thinking.
			...(profile.supportsTemperature &&
				!thinkingEnabled && {
					temperature: numericOption(options.modelOptions?.temperature) ?? 0.7,
				}),
		},
	};

	if (cached.system.length > 0) {
		requestInput.system = cached.system as ConverseStreamCommandInput["system"];
	}

	if (options.modelOptions) {
		const mo = options.modelOptions as Record<string, unknown>;
		// topP is a sampling parameter, so it is subject to the same restriction
		// as temperature when thinking is active.
		if (typeof mo.top_p === "number" && !thinkingEnabled) {
			requestInput.inferenceConfig!.topP = mo.top_p;
		}
		if (typeof mo.stop === "string") {
			requestInput.inferenceConfig!.stopSequences = [mo.stop];
		} else if (Array.isArray(mo.stop)) {
			requestInput.inferenceConfig!.stopSequences = mo.stop.filter((s): s is string => typeof s === "string");
		}
	}

	if (cached.toolConfig) {
		const wireToolConfig = { ...cached.toolConfig } as BedrockToolConfig;
		// Thinking models must be free to reason before choosing a tool, so a
		// forced tool choice has to be relaxed to auto rather than sent as-is.
		if (thinkingEnabled && wireToolConfig.toolChoice && !wireToolConfig.toolChoice.auto) {
			wireToolConfig.toolChoice = { auto: {} };
		}
		requestInput.toolConfig = wireToolConfig as ConverseStreamCommandInput["toolConfig"];
	}

	if (thinkingEnabled && thinking) {
		const effort = thinking.effort;
		const existingFields = (requestInput.additionalModelRequestFields ?? {}) as Record<string, unknown>;
		if (profile.thinkingApi === "adaptive") {
			// Claude 4.6+ picks its own budget from a stated effort level.
			requestInput.additionalModelRequestFields = {
				...existingFields,
				thinking: { type: "adaptive" },
				output_config: { effort },
			};
		} else {
			// Legacy budget API. The budget must leave room for a visible answer,
			// so cap it below maxTokens rather than letting Bedrock reject the pair.
			const desired = thinking.budgetTokens > 0 ? thinking.budgetTokens : budgetForEffort(effort);
			const budget = Math.max(1024, Math.min(desired, maxTokens - 1));
			requestInput.additionalModelRequestFields = {
				...existingFields,
				reasoning_config: { type: "enabled", budget_tokens: budget },
			};
		}
	}

	return { input: requestInput, thinkingEnabled, cachePoints: cached.inserted };
}

function numericOption(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
