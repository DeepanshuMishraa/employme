import { createMem0 } from "@mem0/vercel-ai-provider";

/** Gideon serves one person, so all memories share one stable id across chats and threads. */
const MEMORY_USER_ID = process.env.MEM0_USER_ID ?? "deepanshu";

export function buildMemoryModel(){
    const mem0 = createMem0({
    provider: "openai",
    mem0ApiKey: process.env.MEM0_API_KEY,
    apiKey: process.env.OPENAI_API_KEY,
    mem0Config: {
      user_id: MEMORY_USER_ID,
    },
    });

  return mem0;
}
