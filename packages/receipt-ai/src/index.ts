import { z } from "zod";

export const extractionRequestSchema = z.object({
  documentId: z.string().min(1),
  pageImagePaths: z.array(z.string().min(1)).min(1),
});

export const extractionResultSchema = z.object({
  documentId: z.string().min(1),
  provider: z.string().min(1),
  rawText: z.string(),
});

export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export type ReceiptExtractor = {
  readonly name: string;
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
};

export function createFakeReceiptExtractor(
  result: ExtractionResult,
): ReceiptExtractor {
  const validated = extractionResultSchema.parse(result);
  return {
    name: "fake",
    async extract(request) {
      const validRequest = extractionRequestSchema.parse(request);
      if (validRequest.documentId !== validated.documentId) {
        throw new Error("Fake result does not match the requested document");
      }
      return validated;
    },
  };
}
