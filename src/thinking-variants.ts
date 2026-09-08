import type { ThinkingEffort } from "./converters/request";
import { budgetForEffort } from "./converters/request";

/** Effort levels in ascending order, as offered in the UI. */
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * Separator between a Bedrock model ID and an effort level encoded into it.
 *
 * The chat window has no API for a provider to contribute its own controls, so
 * the only way to make effort selectable per conversation is to expose each
 * level as its own entry in the model picker. VS Code treats the model ID as an
 * opaque string and remembers it per conversation, which is exactly the
 * behaviour wanted — but the ID is also what gets sent to Bedrock, so it has to
 * be decoded again before use.
 *
 * `#` is chosen because it cannot occur in a Bedrock model ID or an inference
 * profile ARN, so splitting is unambiguous and an ID that was never encoded is
 * returned untouched.
 */
export const VARIANT_SEPARATOR = "#think=";

export interface DecodedModelId {
	/** The real Bedrock model ID, safe to send on the wire. */
	baseId: string;
	/**
	 * Effort level baked into the picked model, if any. `undefined` means the
	 * conversation inherits the global default rather than overriding it.
	 */
	effort?: ThinkingEffort;
}

export function isThinkingEffort(value: string): value is ThinkingEffort {
	return (THINKING_EFFORTS as readonly string[]).includes(value);
}

/** Build the picker ID for one effort level of a model. */
export function encodeVariantId(baseId: string, effort: ThinkingEffort): string {
	return `${baseId}${VARIANT_SEPARATOR}${effort}`;
}

/**
 * Split a picker ID back into the model to invoke and the effort to request.
 *
 * Deliberately total and forgiving: an unrecognized suffix degrades to the base
 * model with no override rather than throwing. A stale ID persisted by a
 * conversation from a newer build must still be invocable, and getting the
 * effort wrong is far less costly than failing the request outright.
 */
export function decodeVariantId(id: string): DecodedModelId {
	const at = id.indexOf(VARIANT_SEPARATOR);
	if (at === -1) {
		return { baseId: id };
	}

	const baseId = id.slice(0, at);
	if (!baseId) {
		// Nothing before the separator: not something this code produced.
		return { baseId: id };
	}

	const suffix = id.slice(at + VARIANT_SEPARATOR.length);
	return isThinkingEffort(suffix) ? { baseId, effort: suffix } : { baseId };
}

/**
 * Resolve the effort to request for one turn.
 *
 * Precedence: an effort chosen in the chat window's model picker wins, because
 * it is the more specific and more recent expression of intent. Otherwise the
 * global default from the status bar (equivalently, the settings page) applies,
 * and that default can also be off entirely.
 */
export function resolveThinkingForTurn(
	variantEffort: ThinkingEffort | undefined,
	defaults: { enabled: boolean; effort: ThinkingEffort }
): { enabled: boolean; effort: ThinkingEffort; source: "model-picker" | "default" } {
	if (variantEffort !== undefined) {
		return { enabled: true, effort: variantEffort, source: "model-picker" };
	}
	return { enabled: defaults.enabled, effort: defaults.effort, source: "default" };
}

/** Short label for an effort level, or the off state, used by the quick pick. */
export function describeEffort(effort: ThinkingEffort): string {
	return `${budgetForEffort(effort).toLocaleString("en-US")}-token budget`;
}
