import { z } from "zod"


export const JobSchema = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  description: z.string(),
  location: z.string().nullable(),
  workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  compensation: z.object({
    min: z.number().nullable(),
    max: z.number().nullable(),
    currency: z.string().nullable()
  }),
  applyUrl: z.string(),
  sourceUrl: z.string(),
  postedAt: z.string().nullable(),
  fetchedAt: z.string(),
  technologies: z.array(z.string())
})

export type Job = z.infer<typeof JobSchema>
