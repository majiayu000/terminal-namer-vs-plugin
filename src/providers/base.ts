// Re-export types and prompt for backward compatibility
export type { GenerateResult, AIProvider, GenerateContext } from './types';
export type { PromptMessages, PromptContext, CommandPrivacyMode } from './prompt';
export { buildPrompt, cleanName } from './prompt';
