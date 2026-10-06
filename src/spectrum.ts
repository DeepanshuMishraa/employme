import { Spectrum, markdown, typing } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { GetLLMResponse } from "./ai-service";

export const SpectrumService = async () => {
  const projectId = process.env.SPECTRUM_PROJECT_ID as string
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET as string
  try {
    const app = await Spectrum({
      projectId,
      projectSecret,
      providers: [imessage.config()]
    });

    const handled = new Set<string>();

    for await (const [space, message] of app.messages) {
      console.log("incoming", message.content.type, message.direction, message.id);
      if (message.content.type != "text" || message.direction != "inbound") continue;
      if (handled.has(message.id)) continue;
      handled.add(message.id);
      try {
        const response = await GetLLMResponse(message.content.text, message.id, space.id);

        await space.send(markdown(response))
      } catch (err) {
        console.error("Failed to handle message", err);
      }
    }

  } catch (err) {
    console.error("SpectrumService stopped", err);
    return err;
  }
}
