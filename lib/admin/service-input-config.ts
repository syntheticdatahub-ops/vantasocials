import { VANTA_INPUT_TYPES, type ValidationConfig, type ServiceInputField } from "../inputs/contracts";
import { getInputTypeDefinition } from "../inputs/registry";
import { resolveTransform } from "../inputs/transforms";
import { validateProviderInputMapping, validateServiceInputField } from "../inputs/validation";
import { getTargetContractForService } from "../targets/contracts";
import { assessProviderEligibility } from "../targets/eligibility";
import { assertAllowedProviderParameterKey, isReservedProviderTransportKey } from "../fulfillment/reliablesmm/reserved-keys";
import { matchesApprovedProviderOperation, resolveProviderCompatibility, resolveProviderPlatformCompatibility } from "./provider-compatibility";
import { providerCatalogMatches } from "./provider-category";

export type NormalizedFieldDraft = ReturnType<typeof validateServiceInputField>;

const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeText(value: unknown, fieldName: string, maxLength = 200) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error(`${fieldName} is required.`);
    if (trimmed.length > maxLength) throw new Error(`${fieldName} is too long.`);
    return trimmed;
  }
  throw new Error(`${fieldName} is required.`);
}

export function extractApprovedProviderParameters(rawMetadata: unknown): string[] {
  const metadata = isPlainObject(rawMetadata) ? rawMetadata : null;
  const candidates: unknown[] = [];
  if (metadata && Array.isArray(metadata.parameters)) candidates.push(...metadata.parameters);
  if (metadata && Array.isArray(metadata.parameter_options)) candidates.push(...metadata.parameter_options);
  if (metadata && Array.isArray(metadata.parameterKeys)) candidates.push(...metadata.parameterKeys);
  if (metadata && Array.isArray(metadata.parameter_schema)) candidates.push(...metadata.parameter_schema);
  if (metadata && Array.isArray(metadata.fields)) candidates.push(...metadata.fields);
  if (metadata?.parameter_map && typeof metadata.parameter_map === "object") {
    for (const [key, value] of Object.entries(metadata.parameter_map as Record<string, unknown>)) {
      candidates.push({ key, label: typeof value === "string" ? value : key });
    }
  }
  const seen = new Set<string>();
  const parsed: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const key = candidate.trim();
      if (key && (!isReservedProviderTransportKey(key) || key === "link") && !seen.has(key)) {
        seen.add(key);
        parsed.push(key);
      }
      continue;
    }
    if (isPlainObject(candidate)) {
      const key = (typeof candidate.key === "string" ? candidate.key.trim() : typeof candidate.parameterKey === "string" ? candidate.parameterKey.trim() : typeof candidate.name === "string" ? candidate.name.trim() : "");
      if (key && (!isReservedProviderTransportKey(key) || key === "link") && !seen.has(key)) {
        seen.add(key);
        parsed.push(key);
      }
    }
  }
  if (!seen.has("link")) parsed.push("link");
  if (
    metadata &&
    (
      metadata.type === "Custom Comments" ||
      (typeof metadata.category === "string" && /comments/i.test(metadata.category)) ||
      (typeof metadata.name === "string" && /comments/i.test(metadata.name))
    ) &&
    !seen.has("comments")
  ) {
    seen.add("comments");
    parsed.push("comments");
  }
  return parsed;
}

export function normalizeFieldDraft(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error("Field configuration is required.");
  const body = raw as Record<string, unknown>;
  const key = normalizeText(body.key, "Field key", 64).replace(/^_+|_+$/g, "");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new Error("Field key must be lowercase letters, numbers, or underscores.");
  const label = normalizeText(body.label, "Field label", 120);
  const inputTypeRaw = typeof body.inputType === "string" ? body.inputType : typeof body.input_type === "string" ? body.input_type : "";
  const inputType = inputTypeRaw.trim();
  if (!(VANTA_INPUT_TYPES as readonly string[]).includes(inputType)) throw new Error("Unsupported VANTA input type.");
  const required = body.required === undefined ? true : Boolean(body.required);
  const displayOrder = Number(body.displayOrder ?? body.display_order ?? 0);
  if (!Number.isSafeInteger(displayOrder) || displayOrder < 0) throw new Error("Display order must be a non-negative integer.");
  const placeholder = typeof body.placeholder === "string" ? body.placeholder.trim() : undefined;
  const helpText = typeof body.helpText === "string" ? body.helpText.trim() : typeof body.help_text === "string" ? body.help_text.trim() : undefined;
  const validationConfig = isPlainObject(body.validationConfig) ? body.validationConfig : isPlainObject(body.validation_config) ? body.validation_config : {};
  const schemaVersion = Number(body.schemaVersion ?? body.schema_version ?? 1);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Schema version must be a positive integer.");
  const active = body.active === undefined ? true : Boolean(body.active);
  const definition = getInputTypeDefinition(inputType);
  if (!definition) throw new Error("Unsupported VANTA input type.");
  const field: ServiceInputField = {
    key,
    label,
    inputType: inputType as ServiceInputField["inputType"],
    required,
    displayOrder,
    placeholder: placeholder && placeholder.length ? placeholder : undefined,
    helpText: helpText && helpText.length ? helpText : undefined,
    validation: { rule: definition.validationRule, config: validationConfig as ValidationConfig },
    schemaVersion,
    active,
  };
  return validateServiceInputField(field);
}

export function normalizeMappingDraft(raw: unknown, field: ServiceInputField | (Record<string, unknown> & { key: string }), expectedTargetType?: string | null) {
  if (!raw || typeof raw !== "object") throw new Error("Provider mapping configuration is required.");
  const body = raw as Record<string, unknown>;
  const serviceId = normalizeText(body.serviceId ?? body.service_id, "Service ID", 64);
  const provider = normalizeText(body.provider, "Provider", 80);
  const providerServiceId = normalizeText(body.providerServiceId ?? body.provider_service_id, "Provider service ID", 128);
  const providerParameterKey = normalizeText(body.providerParameterKey ?? body.provider_parameter_key, "Provider parameter key", 128);
  const transformId = normalizeText(body.transformId ?? body.transform_id, "Transform ID", 80);
  const transformVersion = Number(body.transformVersion ?? body.transform_version ?? 1);
  if (!Number.isSafeInteger(transformVersion) || transformVersion < 1) throw new Error("Transform version must be a positive integer.");
  const providerRequired = body.providerRequired === undefined ? false : Boolean(body.providerRequired ?? body.provider_required);
  const omitWhenBlank = body.omitWhenBlank === undefined ? false : Boolean(body.omitWhenBlank ?? body.omit_when_blank);
  const schemaVersion = Number(body.schemaVersion ?? body.schema_version ?? 1);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Schema version must be a positive integer.");
  const active = body.active === undefined ? true : Boolean(body.active);
  const transform = resolveTransform(transformId, transformVersion);
  if (!transform) throw new Error("Unknown or unsupported transform.");
  const dbField = field as ServiceInputField & {
    input_type?: string;
    validation_config?: ValidationConfig;
    schema_version?: number;
    display_order?: number;
  };
  const inputType = dbField.inputType ?? dbField.input_type;
  const definition = inputType ? getInputTypeDefinition(inputType) : null;
  if (!definition) throw new Error("VANTA input type is missing or unsupported.");
  if (providerParameterKey === "link") {
    const urlTargetCompatible = Boolean(
      inputType === "url" ||
      inputType === "username" ||
      inputType === "post_url" ||
      String(inputType) === String(expectedTargetType)
    );
    if (!urlTargetCompatible || transform.id !== "normalize_url") {
      throw new Error("ReliableSMM 'link' requires a URL field compatible with the VANTA service target and the normalize_url transform.");
    }
  } else {
    assertAllowedProviderParameterKey(providerParameterKey);
  }
  const normalizedField: ServiceInputField = {
    key: dbField.key,
    label: typeof dbField.label === "string" ? dbField.label : dbField.key,
    inputType: inputType as ServiceInputField["inputType"],
    required: typeof dbField.required === "boolean" ? dbField.required : true,
    displayOrder: Number(dbField.displayOrder ?? dbField.display_order ?? 0),
    validation: {
      rule: definition.validationRule,
      config: dbField.validation?.config ?? (isPlainObject(dbField.validation_config) ? dbField.validation_config as ValidationConfig : {}),
    },
    schemaVersion: Number(dbField.schemaVersion ?? dbField.schema_version ?? 1),
    active: typeof dbField.active === "boolean" ? dbField.active : true,
  };
  const mapping = {
    serviceId,
    vantaInputFieldKey: field.key,
    provider,
    providerServiceId,
    providerParameterKey,
    transform: { id: transformId, version: transformVersion },
    providerRequired,
    omitWhenBlank,
    mappingSchemaVersion: schemaVersion,
    active,
  };
  return validateProviderInputMapping(mapping, normalizedField);
}

export function ensureProviderMappingEligibility(service: { slug: string; target_type?: string | null; min_quantity?: number | null; max_quantity?: number | null; platforms?: { slug?: string | null; name?: string | null } | null }, catalogRow: { provider?: string | null; provider_service_id?: string | number | null; name?: string | null; provider_status?: string | null; provider_rate?: number | string | null; provider_currency?: string | null; rate_unit?: string | null; min_quantity?: number | null; max_quantity?: number | null; raw_metadata?: unknown }, allowExplicitAdminReview = false, targetFieldValidated = false) {
  const targetContract = getTargetContractForService({
    slug: service.slug,
    targetType: service.target_type ?? null,
    platformSlug: service.platforms?.slug ?? null,
  });
  const compatibility = resolveProviderCompatibility(catalogRow.raw_metadata ?? null, catalogRow.name ?? undefined);
  const platform = service.platforms ? { slug: service.platforms.slug ?? undefined, name: service.platforms.name ?? undefined } : null;
  const platformCompatibility = resolveProviderPlatformCompatibility(catalogRow.raw_metadata ?? null, platform, catalogRow.name ?? undefined);
  const eligibility = assessProviderEligibility({
    serviceSlug: service.slug,
    targetContract,
    operationCompatibilityVerified: Boolean(
      catalogRow.name &&
      typeof (catalogRow.raw_metadata as { category?: unknown } | null)?.category === "string" &&
      matchesApprovedProviderOperation(
        service.slug,
        String(catalogRow.provider_service_id ?? ""),
        catalogRow.name,
        String((catalogRow.raw_metadata as { category?: unknown }).category),
      )
    ),
    expectedTargetType: service.target_type,
    providerTargetType: compatibility.compatibility?.targetType,
    platformCompatibilityState: platformCompatibility.state,
    vantaMin: Number(service.min_quantity ?? 0),
    vantaMax: Number(service.max_quantity ?? 0),
    provider: {
      provider: String(catalogRow.provider ?? "reliablesmm"),
      provider_service_id: String(catalogRow.provider_service_id ?? ""),
      name: String(catalogRow.name ?? ""),
      provider_status: String(catalogRow.provider_status ?? ""),
      provider_rate: catalogRow.provider_rate ?? "",
      provider_currency: String(catalogRow.provider_currency ?? ""),
      rate_unit: String(catalogRow.rate_unit ?? ""),
      min_quantity: Number(catalogRow.min_quantity ?? 0),
      max_quantity: Number(catalogRow.max_quantity ?? 0),
      raw_metadata: catalogRow.raw_metadata,
    },
  });
  if (eligibility.status === "MANUAL_REVIEW" && allowExplicitAdminReview) {
    return {
      ...eligibility,
      status: "ELIGIBLE" as const,
      reason: "Administrator explicitly selected and reviewed this provider service mapping.",
    };
  }
  if (eligibility.status !== "ELIGIBLE") { throw new Error(eligibility.status === "MANUAL_REVIEW" ? "This provider service requires manual review before mapping." : eligibility.reason); }
  return eligibility;
}

export function getServiceFieldInsertPayload(field: ReturnType<typeof validateServiceInputField>, serviceId: string) {
  return {
    service_id: serviceId,
    key: field.key,
    label: field.label,
    input_type: field.inputType,
    required: field.required,
    display_order: field.displayOrder,
    placeholder: field.placeholder ?? null,
    help_text: field.helpText ?? null,
    validation_config: field.validation.config ?? {},
    schema_version: field.schemaVersion,
    active: field.active,
  };
}

export function getServiceMappingInsertPayload(mapping: ReturnType<typeof validateProviderInputMapping>, serviceId: string, serviceInputFieldId: string) {
  return {
    service_id: serviceId,
    service_input_field_id: serviceInputFieldId,
    provider: mapping.provider,
    provider_service_id: mapping.providerServiceId,
    provider_parameter_key: mapping.providerParameterKey,
    transform_id: mapping.transform.id,
    transform_version: mapping.transform.version,
    provider_required: mapping.providerRequired,
    omit_when_blank: mapping.omitWhenBlank,
    schema_version: mapping.mappingSchemaVersion,
    active: mapping.active,
  };
}

/**
 * Returns the standard default input field and mapping configuration for a newly created service.
 * Used for 1-click automatic provisioning so the admin does not need to visit the inputs page.
 */
export function getDefaultServiceFieldAndMapping(options: {
  targetType: string;
  platformSlug?: string;
  providerServiceId?: string;
}) {
  const { targetType, platformSlug, providerServiceId } = options;
  const inputType = (VANTA_INPUT_TYPES as readonly string[]).includes(targetType) ? targetType : "url";
  
  const examples: Record<string, Partial<Record<string, string>>> = {
    instagram: {
      url: "https://www.instagram.com/username/",
      post_url: "https://www.instagram.com/p/POST_ID/",
      video_url: "https://www.instagram.com/reel/REEL_ID/",
    },
    tiktok: {
      url: "https://www.tiktok.com/@username",
      post_url: "https://www.tiktok.com/@username/video/VIDEO_ID",
      video_url: "https://www.tiktok.com/@username/video/VIDEO_ID",
    },
    youtube: {
      url: "https://www.youtube.com/@CHANNEL_HANDLE",
      channel: "https://www.youtube.com/@CHANNEL_HANDLE",
      video_url: "https://www.youtube.com/watch?v=VIDEO_ID",
    },
    facebook: {
      url: "https://www.facebook.com/username",
      page: "https://www.facebook.com/page_name",
      post_url: "https://www.facebook.com/username/posts/POST_ID",
    },
    x: {
      url: "https://x.com/username",
      post_url: "https://x.com/username/status/POST_ID",
    },
    telegram: {
      url: "https://t.me/channel_name",
      channel: "https://t.me/channel_name",
      post_url: "https://t.me/channel_name/POST_ID",
    },
  };

  const platformName = platformSlug ? platformSlug.charAt(0).toUpperCase() + platformSlug.slice(1) : "Target";
  const targetExample = examples[platformSlug ?? ""]?.[inputType] || "https://...";

  let key = "target_url";
  let label = `${platformName} URL`;
  let placeholder = targetExample;
  let helpText = "Enter the target URL.";

  if (inputType === "post_url") {
    key = "post_url";
    label = `${platformName} Post URL`;
    helpText = `Paste the URL of the ${platformName} post.`;
  } else if (inputType === "video_url") {
    key = "video_url";
    label = `${platformName} Video URL`;
    helpText = `Paste the URL of the ${platformName} video.`;
  } else if (inputType === "channel") {
    key = "channel_url";
    label = `${platformName} Channel URL`;
    helpText = `Paste the URL of the ${platformName} channel.`;
  } else if (inputType === "page") {
    key = "page_url";
    label = `${platformName} Page URL`;
    helpText = `Paste the URL of the ${platformName} page.`;
  } else if (inputType === "username") {
    key = "username";
    label = `${platformName} Username`;
    placeholder = "@username";
    helpText = "Enter the account username.";
  } else if (inputType === "comments") {
    key = "comments";
    label = "Comments";
    placeholder = "Enter one comment per line";
    helpText = "Enter one comment per line.";
  }

  const fieldDraft = {
    key,
    label,
    inputType,
    required: true,
    displayOrder: 1,
    placeholder,
    helpText,
    validationConfig: inputType === "comments" ? { maxLength: 10000, maxLines: 100, maxLineLength: 500 } : { maxLength: 2048 },
    schemaVersion: 1,
    active: true,
  };

  const mappingDraft = providerServiceId
    ? {
        provider: "reliablesmm",
        providerServiceId,
        providerParameterKey: inputType === "comments" ? "comments" : "link",
        transformId: inputType === "comments" ? "normalize_comments" : "normalize_url",
        transformVersion: 1,
        providerRequired: true,
        omitWhenBlank: false,
        schemaVersion: 1,
        active: true,
      }
    : null;

  return { fieldDraft, mappingDraft };
}

