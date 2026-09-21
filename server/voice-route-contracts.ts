import { z } from "zod";

export const prepareSpeechInputSchema = z.object({
  text: z.string().max(100_000),
  voiceId: z.string().trim().min(1).max(200).optional(),
}).strict();

export const speakSpeechInputSchema = z.object({
  text: z.string().trim().min(1).max(500),
  voiceId: z.string().trim().min(1).max(200).optional(),
}).strict();

export function voiceInputError(error: z.ZodError): { status: 400 | 413; message: string } {
  const tooLarge = error.issues.some((issue) => issue.code === "too_big" && issue.path[0] === "text");
  return tooLarge
    ? { status: 413, message: "voice utterances are limited to 500 characters" }
    : { status: 400, message: "invalid voice request" };
}
