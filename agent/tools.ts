/**
 * YOUR AGENT'S TOOLS
 *
 * A tool is just a function the agent is allowed to call.
 * Azure OpenAI reads the `description` to decide WHEN to use it,
 * and `parameters` to know WHAT to pass in.
 *
 * Add your own tool: copy one of the objects below, change it,
 * and save. It shows up in the "Tools" list on the page.
 *
 * File tools are sandboxed to ./workspace so the agent can't
 * overwrite your app code. Web/business tools have no side effects.
 */
import fs from "fs";
import path from "path";
import { getWalletAddress, getWalletBalance, payAndFetch } from "./wallet";

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema describing the inputs. */
  parameters: object;
  /** The code that runs when the agent calls this tool. */
  run: (args: any, ctx: { baseUrl: string }) => Promise<unknown>;
};

const WORKSPACE = path.join(process.cwd(), "workspace");

function safePath(name: string) {
  if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });
  const resolved = path.resolve(WORKSPACE, name);
  if (!resolved.startsWith(WORKSPACE)) throw new Error("Path escapes workspace. Use a plain file name.");
  return resolved;
}

export const tools: Tool[] = [
  // ─── 1. A paid API: the agent's wallet signs a payment to unlock it ───
  {
    name: "get_weather",
    description:
      "Get the current weather for a city. Costs 0.01 USDC, paid automatically from the agent's wallet.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. Mumbai" },
      },
      required: ["city"],
    },
    run: async ({ city }, { baseUrl }) => {
      return payAndFetch(`${baseUrl}/api/weather?city=${encodeURIComponent(city)}`);
    },
  },

  // ─── 2. Wallet tool: read the agent's own wallet ───
  {
    name: "get_my_wallet",
    description: "Get the agent's own wallet address and its ETH balance on Base Sepolia (testnet).",
    parameters: { type: "object", properties: {} },
    run: async () => ({
      address: getWalletAddress(),
      balance: await getWalletBalance(),
      network: "Base Sepolia (testnet)",
    }),
  },

  // ─── 3. A plain tool: no wallet, no API ───
  {
    name: "roll_dice",
    description: "Roll a dice with the given number of sides.",
    parameters: {
      type: "object",
      properties: {
        sides: { type: "number", description: "How many sides the dice has. Default 6." },
      },
    },
    run: async ({ sides = 6 }) => ({ rolled: Math.floor(Math.random() * sides) + 1, sides }),
  },

  // ─── 4. ENGINEER: write code / text to a workspace file ───
  {
    name: "write_file",
    description:
      "ENGINEER tool. Write code or text to a file in the workspace (e.g. app.py, report.md, notes.txt). Use this when the user asks you to write code, a script, or a document. Overwrites if the file exists.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name inside the workspace, e.g. hello.py" },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["filename", "content"],
    },
    run: async ({ filename, content }) => {
      const file = safePath(filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
      return { saved: path.relative(process.cwd(), file), bytes: Buffer.byteLength(content, "utf8") };
    },
  },

  // ─── 5. ENGINEER: read a workspace file ───
  {
    name: "read_file",
    description: "ENGINEER tool. Read a file from the workspace and return its content.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name inside the workspace, e.g. hello.py" },
      },
      required: ["filename"],
    },
    run: async ({ filename }) => {
      const file = safePath(filename);
      if (!fs.existsSync(file)) throw new Error(`File not found: ${filename}`);
      const content = fs.readFileSync(file, "utf8");
      return { filename, content: content.slice(0, 20000) };
    },
  },

  // ─── 6. ENGINEER: list workspace files ───
  {
    name: "list_files",
    description: "ENGINEER tool. List files in the agent workspace.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      if (!fs.existsSync(WORKSPACE)) return { files: [] };
      const files = fs.readdirSync(WORKSPACE, { recursive: true }) as string[];
      return { files: files.slice(0, 100) };
    },
  },

  // ─── 7. RESEARCH: fetch a URL ───
  {
    name: "fetch_url",
    description:
      "RESEARCH tool. Fetch a public URL and return its text content (HTML stripped to text, truncated). Use for docs, articles, or JSON APIs.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full https URL to fetch." },
      },
      required: ["url"],
    },
    run: async ({ url }) => {
      const res = await fetch(url, { headers: { "User-Agent": "agentmaxxin/1.0" } });
      const text = await res.text();
      const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { status: res.status, url, content: stripped.slice(0, 12000) };
    },
  },

  // ─── 8. ANALYST: safe calculator ───
  {
    name: "calculate",
    description: "ANALYST tool. Evaluate a math expression (numbers, + - * / % **, parentheses). No variables or code.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression, e.g. (1200 * 1.18) / 12" },
      },
      required: ["expression"],
    },
    run: async ({ expression }) => {
      if (!/^[\d\s+\-*/%().]+$/.test(expression)) throw new Error("Only numbers and + - * / % ** ( ) allowed.");
      const value = Function(`"use strict"; return (${expression})`)() as number;
      if (typeof value !== "number" || !isFinite(value)) throw new Error("Expression did not produce a number.");
      return { expression, value };
    },
  },

  // ─── 9. ANALYST: summarize numbers ───
  {
    name: "analyze_numbers",
    description:
      "BUSINESS ANALYST tool. Given a list of numbers (revenue, costs, metrics), return count, sum, avg, min, max. Use for quick business/data analysis.",
    parameters: {
      type: "object",
      properties: {
        values: { type: "array", items: { type: "number" }, description: "List of numbers to analyze." },
        label: { type: "string", description: "What the numbers represent, e.g. monthly revenue USD." },
      },
      required: ["values"],
    },
    run: async ({ values, label = "values" }) => {
      if (!Array.isArray(values) || values.length === 0) throw new Error("Provide a non-empty array of numbers.");
      const sum = values.reduce((a: number, b: number) => a + b, 0);
      return {
        label,
        count: values.length,
        sum,
        avg: sum / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
      };
    },
  },

  // ─── 10. Utility: current time ───
  {
    name: "get_time",
    description: "Get the current date and time (UTC + server local). Use when the user asks what time it is.",
    parameters: { type: "object", properties: {} },
    run: async () => ({ utc: new Date().toISOString(), local: new Date().toString() }),
  },
];
