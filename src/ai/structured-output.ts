export type StructuredOutputMode = "auto" | "json_schema" | "json_object" | "prompt_only";
type OutputFormat = Exclude<StructuredOutputMode, "auto">;

export class ModelHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class StructuredResponseError extends Error {}

const capabilities = new Map<string, { format: OutputFormat; expiresAt: number }>();
const capabilityTtl = 10 * 60 * 1000;

export function rejectsStructuredFormat(error: unknown): boolean {
  return error instanceof ModelHttpError && [400, 422].includes(error.status) &&
    /response[_ ]format|json[_ ](?:schema|object)|structured.output|guided.grammar/i.test(error.message) &&
    /unsupported|not supported|does not support|unknown|unrecognized|unexpected|invalid|不支持/i.test(error.message);
}

export async function structuredCompletion<T>(input: {
  mode: StructuredOutputMode;
  capabilityKey: string;
  schema?: Record<string, unknown>;
  call: (responseFormat: Record<string, unknown> | undefined, format: OutputFormat) => Promise<string>;
  parse: (response: string) => T;
  signal?: AbortSignal;
}): Promise<T> {
  const modes: OutputFormat[] = input.schema
    ? ["json_schema", "json_object", "prompt_only"]
    : ["json_object", "prompt_only"];
  const known = capabilities.get(input.capabilityKey);
  const start = known && known.expiresAt > Date.now() ? Math.max(0, modes.indexOf(known.format)) : 0;
  const selected = input.mode === "auto" ? modes.slice(start) : [input.mode];
  for (const [index, format] of selected.entries()) {
    input.signal?.throwIfAborted();
    try {
      const responseFormat = format === "prompt_only" ? undefined :
        format === "json_schema" ? {
          type: "json_schema",
          json_schema: { name: "sag_plan", strict: true, schema: input.schema }
        } : { type: "json_object" };
      const response = await input.call(responseFormat, format);
      let result: T;
      try {
        result = input.parse(response);
      } catch {
        throw new StructuredResponseError("LLM did not return valid structured output");
      }
      if (input.mode === "auto" && (format === "json_schema" || index !== 0)) {
        if (capabilities.size >= 128) capabilities.clear();
        capabilities.set(input.capabilityKey, { format, expiresAt: Date.now() + capabilityTtl });
      }
      return result;
    } catch (error) {
      if (input.signal?.aborted || index === selected.length - 1 ||
          (!rejectsStructuredFormat(error) && !(error instanceof StructuredResponseError))) {
        throw error;
      }
    }
  }
  throw new StructuredResponseError("No structured output format is available");
}
