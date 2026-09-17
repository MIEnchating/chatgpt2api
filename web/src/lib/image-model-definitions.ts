export type ImageAdapterProtocol = "openai-image" | "google-gemini-image" | "xai-image";

export const imageProtocolLabels: Record<ImageAdapterProtocol, string> = {
  "openai-image": "OpenAI Images",
  "google-gemini-image": "Gemini Chat Completions",
  "xai-image": "Grok Images",
};

export type ImageModelDefinition = {
  protocol: ImageAdapterProtocol;
  aspect_ratios: string[];
  resolutions: string[];
  quality_values: string[];
  max_reference_images: number;
  max_output_count: number;
  streaming: boolean;
  mask: boolean;
  output_controls: boolean;
  exact_dimensions: boolean;
};

export type ImageModelDefinitions = Record<string, ImageModelDefinition>;

let definitions: ImageModelDefinitions = {};

export function installImageModelDefinitions(value?: ImageModelDefinitions) {
  definitions = value || {};
}

export function configuredImageModel(model: string): ImageModelDefinition | undefined {
  return Object.hasOwn(definitions, model.trim()) ? definitions[model.trim()] : undefined;
}

export function imageAdapterDefaults(protocol: ImageAdapterProtocol): ImageModelDefinition {
  return {
    protocol,
    aspect_ratios: protocol === "xai-image"
      ? ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"]
      : ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    resolutions: protocol === "xai-image" ? ["1k", "2k"] : ["1k", "2k", "4k"],
    quality_values: protocol === "openai-image" ? ["low", "medium", "high"] : [],
    max_reference_images: protocol === "google-gemini-image" ? 14 : 4,
    max_output_count: 15,
    streaming: protocol === "openai-image",
    mask: protocol === "openai-image",
    output_controls: protocol === "openai-image",
    exact_dimensions: protocol === "openai-image",
  };
}
