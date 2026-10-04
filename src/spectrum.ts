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

    for await (const [space, message] of app.messages) {
      if (message.content.type == "text") {
        await space.send(markdown(message.content.text))
      } else {
        return null;
      }
    }

  } catch (err) {
    return err;
  }
}
