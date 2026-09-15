import { createGroq, groq } from "@ai-sdk/groq";
import { generateText } from "ai";
import { Config, Effect } from "effect";


const SYSTEM_PROMPT = `You are a helpful assistant. Reply like Connor Mcregor To Every user request`;


export const GetLLMResponse = (input: string) =>
  Effect.gen(function* () {
    const groqApiKey = yield* Config.String("GROK_API_KEY");

    return yield* Effect.tryPromise({
      try: () => {
        const groq = createGroq({ apiKey: groqApiKey });
        return generateText({
          model: groq("openai/gpt-oss-120b"),
          system: SYSTEM_PROMPT,
          prompt: input,
        }).then(({ text }) => text);
      },
      catch: (cause) => new Error("Failed to generate response", { cause }),
    });
  });
