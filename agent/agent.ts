/**
 * THE AGENT (Azure OpenAI)
 *
 * An agent is a loop:
 *   1. Send the chat + the list of tools to Azure OpenAI.
 *   2. If the model wants to call a tool -> run it, send back the result, repeat.
 *   3. If the model answers with text -> done.
 */
import { AzureOpenAI } from "openai";
import { tools } from "./tools";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export const MODEL = process.env.AZURE_OPENAI_DEPLOYMENT || "not-configured";
const MAX_STEPS = 8;

// Reasoning models (e.g. gpt-6-sol) reject function tools on /v1/chat/completions
// unless reasoning is disabled: "Function tools with reasoning_effort are not
// supported ... set reasoning_effort to 'none'". Default to "none" so tools work
// out of the box; override with AZURE_OPENAI_REASONING_EFFORT=low|medium|high
// (or empty to omit the parameter) if your deployment supports tools + reasoning.
const REASONING_EFFORT = (process.env.AZURE_OPENAI_REASONING_EFFORT ?? "none").trim();

const SYSTEM_PROMPT =
  "You are a helpful AI agent with your own crypto wallet, acting as a team of experts: " +
  "a software ENGINEER (writes clean code via write_file/read_file/list_files), " +
  "a BUSINESSMAN / founder (practical, cost-aware, concise business advice), " +
  "and a DATA ANALYST (uses calculate and analyze_numbers for numbers, never guesses arithmetic). " +
  "Use your tools when they help. If a tool costs money, just use it: your wallet pays automatically. " +
  "When asked to write code, write the full file with write_file then summarize what you built. " +
  "Keep answers short and friendly.";

export type ChatMessage = { role: "user" | "agent"; text: string };
export type Step = { tool: string; args: unknown; result: unknown; error?: boolean };

function getClient() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview";
  if (!endpoint || !apiKey || !deployment) {
    throw new Error(
      "Missing Azure OpenAI config. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT in your .env file, then restart `npm run dev`."
    );
  }
  return {
    client: new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion }),
    deployment,
  };
}

export function isAzureConfigured() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

export async function runAgent(history: ChatMessage[], ctx: { baseUrl: string }) {
  const { client, deployment } = getClient();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m): ChatCompletionMessageParam => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })),
  ];
  const steps: Step[] = [];

  const openAiTools = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }));

  for (let i = 0; i < MAX_STEPS; i++) {
    const completion = await client.chat.completions.create({
      model: deployment,
      messages,
      tools: openAiTools,
      tool_choice: "auto",
      // Cast: Azure accepts 'none' at runtime (required for function tools on
      // reasoning models like gpt-6-sol), but this SDK version only types low|medium|high.
      ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT as unknown as "low" } : {}),
    });

    const choice = completion.choices[0]?.message;
    if (!choice) return { answer: "No response from the model.", steps };

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) return { answer: choice.content ?? "", steps };

    // Keep the assistant's tool request in history, then run each tool.
    messages.push(choice);

    for (const call of toolCalls) {
      const name = call.function.name;
      let parsed: unknown = {};
      try {
        parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        parsed = { _raw: call.function.arguments };
      }
      const tool = tools.find((t) => t.name === name);
      let result: unknown;
      let error = false;
      try {
        if (!tool) throw new Error(`No tool named ${name}`);
        result = await tool.run(parsed, ctx);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
        error = true;
      }
      steps.push({ tool: name, args: parsed, result, error });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { answer: "I hit my step limit. Try a simpler question.", steps };
}
