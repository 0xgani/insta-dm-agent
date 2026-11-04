// Run test questions through the reply engine (no Instagram) to check answer quality.
//
//   bun run eval                                  # model from CLAUDE_MODEL
//   bun run eval --model claude-sonnet-5-5
//   bun run eval --compare                        # Haiku vs Sonnet side by side
//   bun run eval --file my-questions.txt
//
// Questions file: one question per line; "#" lines are comments. Put several
// messages on one line separated by " || " to simulate a multi-message conversation
// (each part becomes a user turn, with the bot's replies in between).

import { parseArgs } from "node:util";
import { MemoryFile } from "../src/memory";
import { ReplyEngine, type HistoryMessage } from "../src/reply-engine";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    compare: { type: "boolean", default: false },
    file: { type: "string", default: "scripts/test-questions.txt" },
  },
});

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

const models = values.compare
  ? ["claude-haiku-5-5", "claude-sonnet-5-5"]
  : [values.model ?? process.env.CLAUDE_MODEL ?? "claude-haiku-5-5"];

const memory = await new MemoryFile(process.env.MEMORY_PATH ?? "./MEMORY.md").read();
const lines = (await Bun.file(values.file!).text())
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const totals = new Map(models.map((m) => [m, { ms: 0, input: 0, output: 0, handoffs: 0 }]));

for (const line of lines) {
  const turns = line.split(" || ");
  console.log(`\n${"=".repeat(80)}\nQ: ${turns.join("\n   ")}`);
  await Promise.all(
    models.map(async (model) => {
      const engine = new ReplyEngine(apiKey, model, process.env.ANTHROPIC_WORKSPACE_ID);
      const history: HistoryMessage[] = [];
      const out: string[] = [];
      const start = performance.now();
      try {
        for (const turn of turns) {
          history.push({ role: "user", text: turn });
          let handoff = "";
          const res = await engine.reply(memory, history, async (reason) => {
            handoff = ` [request_human: ${reason}]`;
          });
          history.push({ role: "assistant", text: res.text });
          out.push(res.text + handoff);
          const t = totals.get(model)!;
          t.input += res.usage.input;
          t.output += res.usage.output;
          if (handoff) t.handoffs++;
        }
      } catch (err) {
        out.push(`ERROR: ${(err as Error).message}`);
      }
      const ms = performance.now() - start;
      totals.get(model)!.ms += ms;
      return { model, out, ms };
    }),
  ).then((results) => {
    for (const r of results) {
      console.log(`\n--- ${r.model} (${Math.round(r.ms)} ms)`);
      for (const o of r.out) console.log(`A: ${o}`);
    }
  });
}

console.log(`\n${"=".repeat(80)}\nSummary over ${lines.length} questions:`);
for (const [model, t] of totals) {
  console.log(
    `  ${model.padEnd(20)} avg ${Math.round(t.ms / lines.length)} ms/question, ` +
      `${t.input} input + ${t.output} output tokens, ${t.handoffs} handoffs`,
  );
}
