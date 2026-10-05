import { createMem0 } from "@mem0/vercel-ai-provider";

export function buildMemoryModel(userId: string){
    const mem0 = createMem0({
    provider: "openai",
    mem0ApiKey: process.env.MEM0_API_KEY,
    apiKey: process.env.OPENAI_API_KEY,
    mem0Config: {
      user_id: userId,
    },
    });

  return mem0;
}
